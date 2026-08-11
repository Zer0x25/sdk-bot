// Tests del proxy de perfiles SOUL del panel (F6-P5): /api/profiles*.
// El brain NO corre en CI → los fetch fallan y los servicios devuelven
// listas vacías/null; aquí se verifica el contrato HTTP del proxy.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { withTempDbPaths } = require('./helpers/tmpPaths');
const t = withTempDbPaths();

const { startAdminWebServer } = require('../services/adminWebServer');

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
});

test('GET /api/profiles lista los perfiles (brain apagado → lista vacía)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`);
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.ok(Array.isArray(d.profiles), 'profiles es un array');
});

test('GET /api/profiles/<key>/file → 404 si el brain no responde', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/ventas/file`);
    assert.strictEqual(res.status, 404);
});

test('GET /api/profiles/<key> (detalle) → 404 si el brain no responde', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/ventas`);
    assert.strictEqual(res.status, 404);
});

test('DELETE /api/profiles/<key> → 400/502 si el brain rechaza o no responde', async () => {
    // Con brain corriendo: 400 (rechazo real de un perfil inexistente);
    // en CI sin brain: 502 (sin respuesta). Ambos con success:false.
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/ventas`, { method: 'DELETE' });
    assert.ok([400, 502].includes(res.status), `status ${res.status} ∈ {400, 502}`);
    const d = await res.json();
    assert.strictEqual(d.success, false);
});

test('POST /api/profiles/import valida key y content (400 sin body)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.strictEqual(res.status, 400);
    const d = await res.json();
    assert.match(d.message, /key y content/);
});
