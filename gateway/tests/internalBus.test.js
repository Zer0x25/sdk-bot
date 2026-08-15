// @ts-check
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { withTempDbPaths } = require('./helpers/tmpPaths');
const t = withTempDbPaths();

const { startInternalBus, handleConnectionUpdate, setSock, qrPayload } = require('../services/internalBus');
const { upsertContactMetadata } = require('../services/contactsRepository');

let server;
let port;

function startTestServer() {
    return new Promise(resolve => {
        server = startInternalBus({ port: 0 });
        server.once('listening', () => {
            const addr = server.address();
            port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve(undefined);
        });
    });
}

before(async () => {
    await startTestServer();
});

after(async () => {
    server.close();
    t.restore();
});

test('WebSocket abierto durante pairing no se marca como sesión vinculada', () => {
    setSock({ ws: { readyState: 1 } });
    assert.strictEqual(qrPayload().session, false);

    setSock({ ws: { readyState: 1 }, user: { id: '56942523669@s.whatsapp.net' } });
    assert.strictEqual(qrPayload().session, true);
});
test('QR de un socket reemplazado no puede aparecer en el estado del panel', async () => {
    const oldSock = {};
    const newSock = {};
    setSock(oldSock);

    const staleQr = handleConnectionUpdate({ qr: 'qr-del-socket-anterior' }, oldSock);
    setSock(newSock);
    await staleQr;

    assert.strictEqual(qrPayload().qr, null);
});
test('GET /status devuelve métricas en JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.strictEqual(res.status, 200);
    const d = /** @type {any} */ (await res.json());
    assert.strictEqual(d.status, 'ok');
    assert.ok(d.bot);
    assert.ok(d.database);
});

test('GET /contacts devuelve lista paginada de contactos', async () => {
    upsertContactMetadata({ phoneNumber: '56911111111', lid: null, savedName: 'Contacto Test Bus', isContact: true });
    const res = await fetch(`http://127.0.0.1:${port}/contacts?q=Test`);
    assert.strictEqual(res.status, 200);
    const d = /** @type {any} */ (await res.json());
    assert.ok(Array.isArray(d.contacts));
    assert.ok(d.total >= 1);
    assert.strictEqual(d.contacts[0].savedName, 'Contacto Test Bus');
});

test('GET /contacts/:key devuelve detalle del contacto', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/contacts/56911111111`);
    assert.strictEqual(res.status, 200);
    const d = /** @type {any} */ (await res.json());
    assert.strictEqual(d.phone, '56911111111');
});

test('POST /contacts/:key/estado cambia el estado (acepta permitido, permitir, ignorar, etc.)', async () => {
    const res1 = await fetch(`http://127.0.0.1:${port}/contacts/56911111111/estado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'permitir' })
    });
    assert.strictEqual(res1.status, 200);
    const d1 = /** @type {any} */ (await res1.json());
    assert.strictEqual(d1.success, true);
    assert.strictEqual(d1.state, 'permitido');

    const res2 = await fetch(`http://127.0.0.1:${port}/contacts/56911111111/estado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'ignorar' })
    });
    assert.strictEqual(res2.status, 200);
    const d2 = /** @type {any} */ (await res2.json());
    assert.strictEqual(d2.success, true);
    assert.strictEqual(d2.state, 'ignorado');
});

test('POST /contacts/:key/perfil asigna y resetea a default', async () => {
    const res1 = await fetch(`http://127.0.0.1:${port}/contacts/56911111111/perfil`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perfil: 'lucia' })
    });
    assert.strictEqual(res1.status, 200);
    const d1 = /** @type {any} */ (await res1.json());
    assert.strictEqual(d1.success, true);
    assert.strictEqual(d1.profile, 'lucia');

    const res2 = await fetch(`http://127.0.0.1:${port}/contacts/56911111111/perfil`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perfil: 'default' })
    });
    assert.strictEqual(res2.status, 200);
    const d2 = /** @type {any} */ (await res2.json());
    assert.strictEqual(d2.success, true);
    assert.strictEqual(d2.profile, null);
});

test('GET /profiles devuelve lista de perfiles', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/profiles`);
    assert.strictEqual(res.status, 200);
    const d = /** @type {any} */ (await res.json());
    assert.ok(Array.isArray(d.profiles));
});

test('POST /command ejecuta comando admin y devuelve respuestas', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: '/info' })
    });
    assert.strictEqual(res.status, 200);
    const d = /** @type {any} */ (await res.json());
    assert.strictEqual(d.ok, true);
    assert.ok(Array.isArray(d.replies));
});
