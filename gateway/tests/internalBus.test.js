// @ts-check
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { withTempDbPaths } = require('./helpers/tmpPaths');
const t = withTempDbPaths();

const { startInternalBus } = require('../services/internalBus');
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

test('POST /contacts/:key/estado cambia el estado', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/contacts/56911111111/estado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'permitido' })
    });
    assert.strictEqual(res.status, 200);
    const d = /** @type {any} */ (await res.json());
    assert.strictEqual(d.success, true);
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
