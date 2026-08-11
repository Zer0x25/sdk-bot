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

// DB temporal ANTES de los requires (config.js lee las env vars al cargar)
const { withTempDbPaths } = require('./helpers/tmpPaths');

const t = withTempDbPaths();

const { startAdminWebServer, setSock, handleConnectionUpdate, resetInProgressForTests, setQrTtlForTests, resetQrForTests } = require('../services/adminWebServer');

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
        server = startAdminWebServer({ port: 0 });
        server.once('listening', () => {
            port = server.address().port;
            resolve();
        });
    });
}

before(() => startTestServer());
after(async () => {
    server.close();
    t.restore();
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    delete process.env.SDK_AUTH_DIR;
    delete process.env.SDK_RESET_NO_EXIT;
});

// Lee el stream SSE acumulando eventos hasta que alguno cumple `predicate`.
// Devuelve { events, hit, reader } para inspección/limpieza.
function parseSseEvents(acc) {
    return acc.split('data: ')
        .map(s => s.trim())
        .filter(s => s.startsWith('{'))
        .map(s => JSON.parse(s));
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

test('GET /api/qr abre un SSE y emite el estado actual (null sin QR)', async () => {
    resetQrForTests();
    const res = await fetch(`http://127.0.0.1:${port}/api/qr`);
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
    const res = await fetch(`http://127.0.0.1:${port}/api/qr`);

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

test('POST /api/pairing pide el código de enlace al socket', async () => {
    resetQrForTests();
    setSock(fakeSock);
    const res = await fetch(`http://127.0.0.1:${port}/api/pairing`, {
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

test('POST /api/pairing valida el número y lanza el gateway sin socket', async () => {
    resetQrForTests();
    // Número inválido (se escribió pero <9 dígitos)
    const short = await (await fetch(`http://127.0.0.1:${port}/api/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '123' })
    })).json();
    assert.strictEqual(short.success, false);

    // Sin socket activo: primera vez / anti-loop → pide relanzar el gateway
    setSock(null);
    const noSock = await (await fetch(`http://127.0.0.1:${port}/api/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '56912345678' })
    })).json();
    assert.strictEqual(noSock.success, false);
    assert.strictEqual(noSock.needsRestart, true);
});

test('POST /api/pairing con socket cerrado (anti-loop) también relanza el gateway', async () => {
    resetQrForTests();
    // Socket que Baileys cerró sin sesión: ws.readyState CLOSED=3 → el QR
    // no va a llegar solo, hay que relanzar como si no hubiera socket.
    const deadSock = { ws: { readyState: 3 }, async requestPairingCode() { throw new Error('noop'); } };
    setSock(deadSock);
    const d = await (await fetch(`http://127.0.0.1:${port}/api/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' })
    })).json();
    assert.strictEqual(d.success, false);
    assert.strictEqual(d.needsRestart, true);
    resetQrForTests();
});

test('POST /api/pairing sin teléfono abre la ventana del QR', async () => {
    resetQrForTests();
    setSock(fakeSock);
    const r = await fetch(`http://127.0.0.1:${port}/api/pairing`, {
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
    const res = await fetch(`http://127.0.0.1:${port}/api/qr`);
    handleConnectionUpdate({ qr: '2@ventana' });
    const { hit, reader } = await readSse(res, ev => ev.qr && ev.qr.startsWith('data:image/png;base64,'), 5000);
    assert.ok(hit, 'QR emitido dentro de la ventana');
    const diff = hit.expiresAt - Date.now();
    assert.ok(diff > 55000 && diff <= 60000, `ventana ~60s desde el pairing (${diff}ms)`);
    reader.cancel();
    resetQrForTests();
});

test('POST /api/pairing con QR vigente NO permite otro hasta que expire', async () => {
    resetQrForTests();
    setSock(fakeSock);
    handleConnectionUpdate({ qr: '2@vigente' });
    const d = await (await fetch(`http://127.0.0.1:${port}/api/pairing`, {
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
    const res = await fetch(`http://127.0.0.1:${port}/api/qr`);
    handleConnectionUpdate({ qr: '2@expira' });

    const { hit, reader } = await readSse(res, ev => ev.expired === true, 3000);
    assert.ok(hit, 'evento de expiración emitido');
    assert.strictEqual(hit.qr, null);

    // Tras expirar, un pairing nuevo ya no está bloqueado por QR vigente
    const d = await (await fetch(`http://127.0.0.1:${port}/api/pairing`, {
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

test('POST /api/restart lanza el gateway sin borrar la sesión', async () => {
    resetInProgressForTests(); // liberar flag dejado por tests previos (módulo compartido)
    // Sin confirmación → 400
    const noConfirm = await fetch(`http://127.0.0.1:${port}/api/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: false })
    });
    assert.strictEqual(noConfirm.status, 400);

    // Con confirmación → 200 (SDK_RESET_NO_EXIT evita el exit del runner)
    const ok = await fetch(`http://127.0.0.1:${port}/api/restart`, {
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

test('POST /api/reset exige confirm:true y borra auth_info_baileys', async () => {
    resetInProgressForTests();
    // Sin confirmación → 400
    const noConfirm = await fetch(`http://127.0.0.1:${port}/api/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: false })
    });
    assert.strictEqual(noConfirm.status, 400);

    // Con confirmación → borra el dir (SDK_RESET_NO_EXIT evita el exit del runner)
    fs.mkdirSync(path.join(tmpAuthDir, 'creds.json'));
    const ok = await fetch(`http://127.0.0.1:${port}/api/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
    });
    assert.strictEqual(ok.status, 200);
    const d = await ok.json();
    assert.strictEqual(d.success, true);
    assert.ok(!fs.existsSync(tmpAuthDir), 'auth dir eliminado');

    // Reset repetido en curso → mensaje claro
    const again = await (await fetch(`http://127.0.0.1:${port}/api/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
    })).json();
    assert.strictEqual(again.success, false);
    resetInProgressForTests();
});
