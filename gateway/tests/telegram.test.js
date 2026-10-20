const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { withTempDbPaths } = require('./helpers/tmpPaths');
withTempDbPaths();

const { startInternalBus } = require('../services/internalBus');
const { saveSettingsDB, getSettingsDB } = require('../services/db');
const telegramService = require('../services/telegramService');

// Mockear https para no pegar a Telegram real
const https = require('https');
const originalRequest = https.request;
const originalGet = https.get;
const { EventEmitter } = require('events');

let busServer;
let API_BASE;

before(async () => {
    // Inicializar BD temporal limpia
    saveSettingsDB({ globalMode: 'ignored_all' });

    busServer = startInternalBus({ port: 0 });
    await new Promise(r => busServer.once("listening", r));
    API_BASE = `http://127.0.0.1:${busServer.address().port}`;
});

after(() => {
    https.request = originalRequest;
    https.get = originalGet;
    if (busServer) busServer.close();
});

test('GET /telegram/settings - devuelve config vacía inicialmente', async () => {
    const r = await fetch(`${API_BASE}/telegram/settings`);
    const j = await r.json();
    assert.strictEqual(j.token, '');
    assert.strictEqual(j.chatId, '');
});

test('POST /telegram/settings - guarda config correctamente', async () => {
    const r = await fetch(`${API_BASE}/telegram/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '12345:ABC', chatId: '98765' })
    });
    const j = await r.json();
    assert.strictEqual(j.success, true);

    const s = getSettingsDB();
    assert.strictEqual(s.telegramToken, '12345:ABC');
    assert.strictEqual(s.telegramChatId, '98765');
});

test('POST /telegram/test - falla si no hay token', async () => {
    const r = await fetch(`${API_BASE}/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const j = await r.json();
    assert.strictEqual(j.success, false);
    assert.strictEqual(j.message, 'Se requiere el token del bot');
});

test('POST /telegram/test - funciona con mock de Telegram', async () => {
    // Con Chat ID explícito no se abre un lector para descubrirlo.
    https.get = () => assert.fail('la prueba manual no debe consultar getUpdates');

    let sendMessageBody = '';
    https.request = (opts, cb) => {
        const req = new EventEmitter();
        req.write = (data) => { sendMessageBody += data; };
        req.end = data => {
            if (data) sendMessageBody += data;
            const res = new EventEmitter();
            res.statusCode = 200;
            if (cb) cb(res);
            process.nextTick(() => {
                res.emit('data', JSON.stringify({ ok: true }));
                res.emit('end');
                req.emit('close');
            });
        };
        return req;
    };

    const r = await fetch(`${API_BASE}/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'mockToken', chatId: '112233' })
    });
    const j = await r.json();
    assert.strictEqual(j.success, true);
    assert.strictEqual(j.chatId, '112233');
    
    const parsedBody = JSON.parse(sendMessageBody);
    assert.strictEqual(parsedBody.chat_id, '112233');
    assert.ok(parsedBody.text.includes('Test de notificaciones'));
});

test('TELEGRAM_MENU_COMMANDS es la única fuente del menú del bot', () => {
    const menu = telegramService.TELEGRAM_MENU_COMMANDS;
    assert.ok(Array.isArray(menu) && menu.length >= 10, 'menú con comandos suficientes');
    const names = menu.map(c => c.command);
    for (const cmd of ['estado', 'pausar', 'reanudar', 'broadcast']) {
        assert.ok(names.includes(cmd), `comando ${cmd} en el menú`);
    }
    // El adaptador reutiliza la misma lista (sin duplicado propio)
    const TelegramAdapter = require('../adapters/telegramAdapter');
    const adapter = new TelegramAdapter();
    assert.strictEqual(adapter.MENU_COMMANDS, undefined, 'el adaptador no define su propio menú');
});

test('classifyPollResponse distingue ok / auth (401/404) / error', () => {
    assert.strictEqual(telegramService.classifyPollResponse({ ok: true, result: [] }), 'ok');
    assert.strictEqual(telegramService.classifyPollResponse({ ok: false, error_code: 401 }), 'auth');
    assert.strictEqual(telegramService.classifyPollResponse({ ok: false, error_code: 404, description: 'Not Found' }), 'auth');
    assert.strictEqual(telegramService.classifyPollResponse({ ok: false, error_code: 500 }), 'error');
    assert.strictEqual(telegramService.classifyPollResponse(null), 'error');
});

test('el polling de getUpdates tiene un único dueño: el adaptador (sin poller en el bus)', () => {
    // Regresión: dos loops competían por getUpdates y cada update caía en
    // uno u otro según carrera. El bus ya no expone maquinaria de polling.
    for (const fn of ['startTelegramPoller', 'stopTelegramPoller', 'setTelegramCommandCallback', 'pollTelegram', 'testAndGetChatId']) {
        assert.strictEqual(telegramService[fn], undefined, `telegramService.${fn} eliminado`);
    }
});

test('POST /telegram/settings informa conexión en caliente y desconexión clara', async () => {
    const r = await fetch(`${API_BASE}/telegram/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '12345:ABC', chatId: '98765' })
    });
    const j = await r.json();
    assert.strictEqual(j.success, true);
    assert.strictEqual(j.connected, true);
    // Sin gateway real registrado como reloader en tests → false pero informado
    assert.strictEqual(j.reloaded, false);
    assert.ok(typeof j.message === 'string' && j.message.length > 0);

    // Desconectar borra la config y responde con mensaje claro
    const off = await (await fetch(`${API_BASE}/telegram/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '', chatId: '' })
    })).json();
    assert.strictEqual(off.success, true);
    assert.strictEqual(off.connected, false);
    assert.match(off.message, /desconectado/i);
});

test('TelegramAdapter sin token arranca en standby con motivo sin_token y reconecta sin dejar loops', async () => {
    saveSettingsDB({});
    const TelegramAdapter = require('../adapters/telegramAdapter');
    const adapter = new TelegramAdapter();
    /** @type {any[]} */
    const events = [];
    adapter.on('connection', ev => events.push(ev));

    await adapter.connect();
    assert.strictEqual(adapter.status, 'standby');
    assert.strictEqual(adapter.pollerActive, false, 'sin token no hay polling ni red');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].detail, 'sin_token');

    // Reconectar (hot-reload de settings) avanza la generación: el loop viejo
    // queda invalidado aunque no hubiera token con el que arrancar.
    await adapter.connect();
    assert.strictEqual(adapter.status, 'standby');
    assert.strictEqual(adapter.pollGeneration, 2);
});

test('TelegramAdapter es el único dueño de getUpdates y emite el mensaje del admin', async () => {
    // Config con token+chatId; el update llega del chat admin
    saveSettingsDB({ globalMode: 'ignored_all', telegramToken: 'mockTok', telegramChatId: '555' });
    const TelegramAdapter = require('../adapters/telegramAdapter');
    const { createTelegramArchive } = require('./helpers/telegramArchive');
    const adapter = new TelegramAdapter({ archive: createTelegramArchive(),
        getMe: async () => ({ ok: true, result: { id: 42, is_bot: true } }) });
    /** @type {any[]} */
    const seen = [];
    adapter.on('message', m => seen.push(m));

    // Mock: https.get SOLO lo usa getUpdates en el adaptador; la primera
    // llamada entrega un update del admin, las siguientes quedan vacías.
    const gets = [];
    let pollCalls = 0;
    https.get = (opts, cb) => {
        gets.push(opts.path);
        pollCalls += 1;
        const req = new EventEmitter();
        req.destroy = () => process.nextTick(() => req.emit('close'));
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
            if (pollCalls === 1) {
                res.emit('data', JSON.stringify({ ok: true, result: [
                    { update_id: 7, message: { message_id: 7, date: 1792368000, text: '/estado',
                        chat: { id: 555, type: 'private' }, from: { first_name: 'Admin' } } }
                ] }));
            } else {
                res.emit('data', JSON.stringify({ ok: true, result: [] }));
            }
            res.emit('end'); req.emit('close');
        });
        if (cb) cb(res);
        return req;
    };
    // setMyCommands (menú al conectar)
    https.request = (opts, cb) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {
            const r = new EventEmitter();
            if (cb) cb(r);
            process.nextTick(() => { r.emit('data', '{}'); r.emit('end'); });
        };
        return req;
    };

    try {
        await adapter.connect();
        const deadline = Date.now() + 2000;
        while (seen.length === 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 10));
        }
    } finally {
        await adapter.disconnect(); // aborta y espera cierre del request activo
        https.get = originalGet;
        https.request = originalRequest;
    }

    assert.strictEqual(seen.length, 1, 'un solo StandardMessage emitido');
    assert.strictEqual(seen[0].channel, 'telegram');
    assert.strictEqual(seen[0].remoteId, 'telegram:555');
    assert.strictEqual(seen[0].text, '/estado');
    assert.strictEqual(seen[0].metadata.isAdminChannel, true);

    // Un único loop: offsets consecutivos sobre la MISMA fuente de updates
    const gu = gets.filter(p => p.includes('getUpdates'));
    assert.ok(gu.length >= 2, `hubo polling (${gu.length} llamadas)`);
    assert.match(gu[0], /offset=0&/);
    assert.match(gu[1], /offset=8&/, 'offset = update_id + 1 tras confirmar el archivo');
});
