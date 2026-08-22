const { test, before, after } = require('node:test');
const { TextDecoder } = require('util');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Auth dir temporal para el reset: DEBE setearse ANTES del require (SDK_AUTH_DIR
// se resuelve en runtime, pero la disciplina evita apuntar al auth real).
const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-auth-'));
process.env.SDK_AUTH_DIR = tmpAuthDir;
// Los tests no deben matar el proceso del runner con el exit del reset
process.env.SDK_RESET_NO_EXIT = '1';
// Rutas de estado para el test de RESET LIMPIO (F7) — todas a temporales:
// el wipe NO debe tocar jamás los archivos reales del repo/instancia.
const tmpWipeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-wipe-'));
process.env.SDK_BROADCAST_DB_PATH = path.join(tmpWipeDir, 'broadcast_db.json');
process.env.SDK_MESSAGE_QUEUE_PATH = path.join(tmpWipeDir, 'queue', 'pending_messages.jsonl');
process.env.BRAIN_MEMORY_DB = path.join(tmpWipeDir, 'memory.db');
process.env.SDK_ADMIN_WEB_LOG_GATEWAY = path.join(tmpWipeDir, 'gwlogs');
process.env.SDK_ADMIN_WEB_LOG_BRAIN = path.join(tmpWipeDir, 'brlogs');
process.env.SDK_GATEWAY_LOCK_PATH = path.join(tmpWipeDir, '.gateway.lock');
process.env.SDK_BRAIN_LOCK_PATH = path.join(tmpWipeDir, '.brain.lock');

// DB temporal ANTES de los requires (config.js lee las env vars al cargar)
const { withTempDbPaths } = require('./helpers/tmpPaths');

const t = withTempDbPaths();

const { startInternalBus, setSock, handleConnectionUpdate, resetInProgressForTests, setQrTtlForTests, resetQrForTests } = require('../services/internalBus');

// Socket fake con las piezas que usa el panel (setSock/requestPairingCode)
const fakeSock = {
    receivedPhone: null,
    async requestPairingCode(phone) {
        fakeSock.receivedPhone = phone;
        return '12345678';
    }
};

let server;
let port;

function startTestServer() {
    return new Promise(resolve => {
        server = startInternalBus({ port: 0 });
        server.once('listening', () => {
            port = server.address().port;
            resolve();
        });
    });
}

before(() => {
    setQrTtlForTests(60000);
    return startTestServer();
});
after(async () => {
    server.close();
    t.restore();
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    fs.rmSync(tmpWipeDir, { recursive: true, force: true });
    delete process.env.SDK_AUTH_DIR;
    delete process.env.SDK_RESET_NO_EXIT;
    for (const k of [
        'SDK_BROADCAST_DB_PATH', 'SDK_MESSAGE_QUEUE_PATH', 'BRAIN_MEMORY_DB',
        'SDK_ADMIN_WEB_LOG_GATEWAY', 'SDK_ADMIN_WEB_LOG_BRAIN',
        'SDK_GATEWAY_LOCK_PATH', 'SDK_BRAIN_LOCK_PATH'
    ]) delete process.env[k];
});

// Lee el stream SSE acumulando eventos hasta que alguno cumple `predicate`.
// Devuelve { events, hit, reader } para inspección/limpieza.
function parseSseEvents(acc) {
    const events = [];
    const lines = acc.split('\n');
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (jsonStr.startsWith('{')) {
                try { events.push(JSON.parse(jsonStr)); } catch (e) {}
            }
        }
    }
    return events;
}

async function readSse(res, predicate, timeoutMs = 3000) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const hit = parseSseEvents(acc).find(predicate);
        if (hit) return { events: parseSseEvents(acc), hit, reader };
    }
    return { events: parseSseEvents(acc), hit: null, reader };
}

test('GET /qr abre un SSE y emite el estado actual (null sin QR)', async () => {
    resetQrForTests();
    const res = await fetch(`http://127.0.0.1:${port}/qr`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const { hit, reader } = await readSse(res, ev => ev.qr === null);
    assert.ok(hit, 'primer evento recibido (estado sin QR)');
    assert.strictEqual(hit.expired, false);
    assert.strictEqual(hit.expiresAt, null);
    reader.cancel();
});

test('handleConnectionUpdate renderiza el QR crudo a PNG y lo difunde por SSE', async () => {
    resetQrForTests();
    const res = await fetch(`http://127.0.0.1:${port}/qr`);

    // Lanzar el QR tras abrir el SSE (la suscripción ya existe)
    handleConnectionUpdate({ qr: '2@qr_string_de_prueba_123' });

    const { hit, reader } = await readSse(res, ev => ev.qr && ev.qr.startsWith('data:image/png;base64,'), 5000);
    assert.ok(hit, 'evento QR recibido');
    assert.strictEqual(hit.expired, false);
    const diff = hit.expiresAt - Date.now();
    assert.ok(diff > 50000 && diff <= 60000, `ventana de 60s activa (${diff}ms)`);
    const b64 = hit.qr.split(',')[1];
    assert.ok(b64.length > 100, 'PNG base64 no trivial');
    reader.cancel();
});

test('handleConnectionUpdate ignora updates sin QR', async () => {
    // No debe lanzar ni cambiar nada con updates de conexión normales
    handleConnectionUpdate({ connection: 'close', lastDisconnect: { error: new Error('x') } });
    handleConnectionUpdate({ connection: 'open' });
    assert.ok(true);
});

test('SSE /qr informa session (rc14 wrapper con getters y readyState clásico)', async () => {
    resetQrForTests();

    // rc14: sock.ws es un WebSocketClient con getters isOpen/isClosed (sin readyState numérico)
    setSock({ user: { id: '123' }, ws: { get isOpen() { return true; }, get isClosed() { return false; } } });
    let res = await fetch(`http://127.0.0.1:${port}/qr`);
    let { hit, reader } = await readSse(res, ev => ev.session === true);
    assert.ok(hit, 'session true con wrapper rc14 (getters)');
    reader.cancel();

    // API clásica: readyState numérico (sock fakes/tests)
    setSock({ user: { id: '123' }, ws: { readyState: 1 } });
    res = await fetch(`http://127.0.0.1:${port}/qr`);
    ({ hit, reader } = await readSse(res, ev => ev.session === true));
    assert.ok(hit, 'session true con readyState OPEN=1');
    reader.cancel();

    // Socket cerrado (deadSock del test de pairing) → session false
    setSock({ ws: { readyState: 3 } });
    res = await fetch(`http://127.0.0.1:${port}/qr`);
    ({ hit, reader } = await readSse(res, ev => ev.session === false));
    assert.ok(hit, 'session false con socket cerrado');
    reader.cancel();

    const rc14Sock = { ws: { isOpen: true, isClosed: false }, user: { id: '123' } };
    setSock(rc14Sock);
    await (await fetch(`http://127.0.0.1:${port}/qr`)).text();
    ({ hit, reader } = await readSse(res, ev => ev.session === false));
    assert.ok(hit, 'session false sin socket');
    reader.cancel();
});

test('POST /pairing pide el código de enlace al socket', async () => {
    resetQrForTests();
    setSock(fakeSock);
    const res = await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '56912345678' })
    });
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.strictEqual(d.success, true);
    assert.strictEqual(d.code, '12345678');
    assert.strictEqual(fakeSock.receivedPhone, '56912345678');
});

test('POST /pairing valida el número y lanza el gateway sin socket', async () => {
    resetQrForTests();
    // Número inválido (se escribió pero <9 dígitos)
    const short = await (await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '123' })
    })).json();
    assert.strictEqual(short.success, false);

    // Con número válido pero sin socket activo: debe pedir relanzar / fallar
    setSock(null);
    const noSock = await (await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '56912345678' })
    })).json();
    assert.strictEqual(noSock.success, false);
    assert.ok(noSock.message.includes('No hay socket activo'));
});

test('POST /pairing con socket cerrado y servicio activo NO relanza (evita matar el QR)', async () => {
    resetQrForTests();
    // Socket que Baileys cerró sin sesión: ws.readyState CLOSED=3. Con el
    // servicio vivo, el QR llegará por SSE; NO debe relanzar (eso mataba el QR).
    const deadSock = { ws: { readyState: 3 }, async requestPairingCode() { throw new Error('noop'); } };
    setSock(deadSock);
    const d = await (await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' })
    })).json();
    assert.strictEqual(d.success, true, 'con servicio activo no relanza: abre ventana QR');
    assert.notStrictEqual(d.needsRestart, true, 'no debe pedir reinicio si el servicio vive');
    resetQrForTests();
});

test('POST /pairing sin teléfono abre la ventana del QR', async () => {
    resetQrForTests();
    setSock(fakeSock);
    const r = await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' })
    });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.success, true);
    assert.ok(!d.code, 'sin código: es QR, no pairing por número');
    assert.match(d.message, /QR/i);

    // El QR siguiente entra en la ventana recién abierta (expiresAt ≈ now+60s)
    const res = await fetch(`http://127.0.0.1:${port}/qr`);
    handleConnectionUpdate({ qr: '2@ventana' });
    const { hit, reader } = await readSse(res, ev => ev.qr && ev.qr.startsWith('data:image/png;base64,'), 5000);
    assert.ok(hit, 'QR emitido dentro de la ventana');
    const diff = hit.expiresAt - Date.now();
    assert.ok(diff > 55000 && diff <= 60000, `ventana ~60s desde el pairing (${diff}ms)`);
    reader.cancel();
    resetQrForTests();
});

test('POST /pairing con QR vigente NO permite otro hasta que expire', async () => {
    resetQrForTests();
    setSock(fakeSock);
    handleConnectionUpdate({ qr: '2@vigente' });
    const d = await (await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' })
    })).json();
    assert.strictEqual(d.success, false);
    assert.match(d.message, /QR vigente/);
    resetQrForTests();
});

test('el QR expira solo y el panel vuelve a "no disponible"', async () => {
    setQrTtlForTests(60); // ventana de 60ms para probar la expiración rápido
    resetQrForTests();
    const res = await fetch(`http://127.0.0.1:${port}/qr`);
    handleConnectionUpdate({ qr: '2@expira' });

    const { hit, reader } = await readSse(res, ev => ev.expired === true, 3000);
    assert.ok(hit, 'evento de expiración emitido');
    assert.strictEqual(hit.qr, null);

    // Tras expirar, un pairing nuevo ya no está bloqueado por QR vigente
    const d = await (await fetch(`http://127.0.0.1:${port}/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' })
    })).json();
    assert.ok(d.success === true || d.needsRestart === true,
        `pairing permitido de nuevo (success=${d.success}, needsRestart=${d.needsRestart})`);

    reader.cancel();
    setQrTtlForTests(60000);
    resetQrForTests();
});

test('POST /restart lanza el gateway sin borrar la sesión', async () => {
    resetInProgressForTests(); // liberar flag dejado por tests previos (módulo compartido)
    // Sin confirmación → 400
    const noConfirm = await fetch(`http://127.0.0.1:${port}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: false })
    });
    assert.strictEqual(noConfirm.status, 400);

    // Con confirmación → 200 (SDK_RESET_NO_EXIT evita el exit del runner)
    const ok = await fetch(`http://127.0.0.1:${port}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
    });
    assert.strictEqual(ok.status, 200);
    const d = await ok.json();
    assert.strictEqual(d.success, true);
    assert.match(d.message, /lanzando/i);
    resetInProgressForTests();
});

test('POST /reset exige confirm:true y borra auth_info_baileys', async () => {
    resetInProgressForTests();
    // Sin confirmación → 400
    const noConfirm = await fetch(`http://127.0.0.1:${port}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: false })
    });
    assert.strictEqual(noConfirm.status, 400);

    // Con confirmación → borra el dir (SDK_RESET_NO_EXIT evita el exit del runner)
    fs.mkdirSync(path.join(tmpAuthDir, 'creds.json'));
    const ok = await fetch(`http://127.0.0.1:${port}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
    });
    assert.strictEqual(ok.status, 200);
    const d = await ok.json();
    assert.strictEqual(d.success, true);
    assert.ok(!fs.existsSync(tmpAuthDir), 'auth dir eliminado');

    // Reset repetido en curso → mensaje claro
    const again = await (await fetch(`http://127.0.0.1:${port}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
    })).json();
    assert.strictEqual(again.success, false);
    resetInProgressForTests();
});

test('POST /reset con clean:true borra TODO el estado (factory reset F7)', async () => {
    resetInProgressForTests();
    // Poblar todos los archivos de estado (apuntan a tmp por las env vars)
    const paths = [
        path.join(tmpAuthDir, 'creds.json'),
        process.env.SDK_CONTACTS_DB_PATH,
        process.env.SDK_SETTINGS_DB_PATH,
        process.env.SDK_BROADCAST_DB_PATH,
        process.env.SDK_MESSAGE_QUEUE_PATH,
        process.env.BRAIN_MEMORY_DB,
        path.join(process.env.SDK_ADMIN_WEB_LOG_GATEWAY, 'gateway.log'),
        path.join(process.env.SDK_ADMIN_WEB_LOG_BRAIN, 'brain.log'),
        process.env.SDK_GATEWAY_LOCK_PATH,
        process.env.SDK_BRAIN_LOCK_PATH
    ];
    for (const p of paths) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, 'x');
    }

    // Sin confirmación → 400
    const noConfirm = await fetch(`http://127.0.0.1:${port}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: false, clean: true })
    });
    assert.strictEqual(noConfirm.status, 400);

    // Con confirmación + clean:true → wipe total (SDK_RESET_NO_EXIT evita el exit)
    const ok = await fetch(`http://127.0.0.1:${port}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, clean: true })
    });
    assert.strictEqual(ok.status, 200);
    const d = await ok.json();
    assert.strictEqual(d.success, true);
    assert.match(d.message, /Reset limpio/);
    for (const p of paths) assert.ok(!fs.existsSync(p), `borrado: ${p}`);

    // Los perfiles SOUL jamás se tocan
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'brain', 'profiles', 'default.md')), 'perfil SOUL intacto');

    // Reset en curso → el segundo intento queda bloqueado
    const again = await (await fetch(`http://127.0.0.1:${port}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, clean: true })
    })).json();
    assert.strictEqual(again.success, false);
    resetInProgressForTests();
});
