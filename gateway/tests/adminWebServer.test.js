const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startAdminWebServer, runAdminCommand } = require('../services/adminWebServer');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const { saveContactsDB } = require('../services/db');

const t = withTempDbPaths();

// Libreta de prueba para los tests de agenda (F6-P2)
const agenda = {
    '56911111111': { phone: '56911111111', lid: null, savedName: 'Ana', isContact: true, estado: 'neutro', firstSeen: '2026-01-01T00:00:00Z' },
    '56922222222': { phone: '56922222222', lid: null, savedName: 'Bruno', isContact: true, estado: 'ignorado' },
    '56933333333': { phone: '56933333333', lid: '123400000003', savedName: 'Carla invaded', isContact: true, estado: 'permitido', perfil: 'lucia' },
    '999999999999': { phone: null, lid: '999999999999', savedName: 'Solo LID', isContact: true, estado: 'handoff' },
    '56944444444': { phone: '56944444444', lid: null, savedName: 'No agenda', isContact: false, estado: 'neutro' }
};
saveContactsDB(agenda);

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

// ─── Agenda (F6-P2) ───

test('GET /api/contacts lista la agenda con paginación', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/contacts?limit=2`);
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.strictEqual(d.total, 5);
    assert.strictEqual(d.contacts.length, 2);
    assert.strictEqual(d.page, 1);
    // Orden por savedName: Ana, Bruno, Carla…, No agenda, Solo LID
    assert.strictEqual(d.contacts[0].savedName, 'Ana');
});

test('GET /api/contacts filtra por búsqueda y estado', async () => {
    const byName = await (await fetch(`http://127.0.0.1:${port}/api/contacts?q=bruno`)).json();
    assert.strictEqual(byName.total, 1);
    assert.strictEqual(byName.contacts[0].phone, '56922222222');

    const byDigits = await (await fetch(`http://127.0.0.1:${port}/api/contacts?q=123400000003`)).json();
    assert.strictEqual(byDigits.total, 1);
    assert.strictEqual(byDigits.contacts[0].savedName, 'Carla invaded');

    const ignored = await (await fetch(`http://127.0.0.1:${port}/api/contacts?estado=ignorado`)).json();
    assert.strictEqual(ignored.total, 1);
    assert.strictEqual(ignored.contacts[0].phone, '56922222222');
});

test('GET /api/contacts/<key> devuelve el detalle y 404 si no existe', async () => {
    const ok = await (await fetch(`http://127.0.0.1:${port}/api/contacts/56911111111`)).json();
    assert.strictEqual(ok.savedName, 'Ana');
    assert.strictEqual(ok.estado, 'neutro');
    assert.strictEqual(ok.isContact, true);

    const notFound = await fetch(`http://127.0.0.1:${port}/api/contacts/56999999999`);
    assert.strictEqual(notFound.status, 404);
});

test('POST /api/contacts/<key>/estado cambia el estado del contacto', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/contacts/56911111111/estado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'ignorado' })
    });
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.strictEqual(d.success, true);
    assert.strictEqual(d.state, 'ignorado');

    const detail = await (await fetch(`http://127.0.0.1:${port}/api/contacts/56911111111`)).json();
    assert.strictEqual(detail.estado, 'ignorado');
});

test('estado inválido rechaza con 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/contacts/56911111111/estado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'superpermitido' })
    });
    assert.strictEqual(res.status, 400);
});

test('POST /api/contacts/<key>/perfil asigna un perfil por contacto', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/contacts/56922222222/perfil`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perfil: 'ventas' })
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).success, true);

    const detail = await (await fetch(`http://127.0.0.1:${port}/api/contacts/56922222222`)).json();
    assert.strictEqual(detail.perfil, 'ventas');
});
