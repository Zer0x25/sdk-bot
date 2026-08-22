const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { withTempDbPaths } = require('./helpers/tmpPaths');
withTempDbPaths();

const { startInternalBus } = require('../services/internalBus');
const { saveSettingsDB, getSettingsDB } = require('../services/db');

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
    require("../services/telegramService").stopTelegramPoller();
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
    // Mock getUpdates (para autodescubrir chatId) y sendMessage
    https.get = (url, cb) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
            res.emit('data', JSON.stringify({
                ok: true,
                result: [ { message: { chat: { id: 112233 } } } ]
            }));
            res.emit('end');
        });
        if (cb) cb(res);
        return { on: () => {} };
    };

    let sendMessageBody = '';
    https.request = (opts, cb) => {
        const req = new EventEmitter();
        req.write = (data) => { sendMessageBody += data; };
        req.end = () => {
            const res = new EventEmitter();
            res.statusCode = 200;
            if (cb) cb(res);
            process.nextTick(() => {
                res.emit('data', JSON.stringify({ ok: true }));
                res.emit('end');
            });
        };
        return req;
    };

    const r = await fetch(`${API_BASE}/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'mockToken' })
    });
    const j = await r.json();
    assert.strictEqual(j.success, true);
    assert.strictEqual(j.chatId, 112233);
    
    const parsedBody = JSON.parse(sendMessageBody);
    assert.strictEqual(parsedBody.chat_id, 112233);
    assert.ok(parsedBody.text.includes('Test de notificaciones'));
});
