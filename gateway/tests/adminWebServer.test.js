const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startAdminWebServer, runAdminCommand } = require('../services/adminWebServer');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const t = withTempDbPaths();

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
after(() => {
    server.close();
    t.restore();
});

test('GET / sirve el front estático', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('SDK-Bot'));
});

test('GET /api/status reutiliza las métricas del statusServer', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
    assert.ok(data.bot, 'estado del bot');
    assert.ok(data.broadcast, 'métrica de broadcast');
});

test('POST /api/command ejecuta un comando admin con sock virtual', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: '/estado' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.replies.length > 0, 'el comando responde algo');
    assert.strictEqual(data.replies[0].type, 'text');
    assert.ok(data.replies[0].text.length > 0);
});

test('comandos sin barra se normalizan (estado → /estado)', async () => {
    const data = await runAdminCommand('estado');
    assert.strictEqual(data.ok, true);
    assert.ok(/estado/i.test(data.replies[0].text));
});

test('comando desconocido responde el aviso del dispatcher', async () => {
    const data = await runAdminCommand('/comandoinexistente');
    assert.ok(data.replies[0].text.includes('no reconocido'));
});

test('comando vacío no cae en el dispatcher', async () => {
    const data = await runAdminCommand('   ');
    assert.strictEqual(data.ok, false);
});

test('path traversal fuera del front se bloquea', async () => {
    for (const path of ['/../package.json', '/..%2fpackage.json']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.strictEqual(res.status, 404, `traversal bloqueado: ${path}`);
    }
});

test('POST inválido devuelve 404 (no existe la ruta)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/foo`, { method: 'POST' });
    assert.strictEqual(res.status, 404);
});
