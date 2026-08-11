const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startStatusServer } = require('../services/statusServer');

let server;
let port;

function startTestServer() {
    return new Promise(resolve => {
        server = startStatusServer({ port: 0 });
        server.once('listening', () => {
            port = server.address().port;
            resolve();
        });
    });
}

before(() => startTestServer());

test('GET /status devuelve métricas completas del gateway', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(typeof data.uptime_seconds, 'number');
    assert.ok(data.pid > 0);
    assert.ok(data.runtime, 'objeto runtime');
    assert.strictEqual(data.runtime.connection, 'starting');
    assert.ok(data.bot, 'estado del bot');
    assert.strictEqual(typeof data.bot.profile, 'string');
    assert.ok(data.database, 'db');
    assert.strictEqual(typeof data.database.contacts, 'number');
    assert.ok(data.counters, 'contadores');
    assert.strictEqual(typeof data.counters.sentMessages, 'number');
    assert.ok(data.brain, 'métricas del brain');
    assert.strictEqual(typeof data.brain.aiCalls, 'number');
    assert.ok(data.commands, 'métricas de comandos');
    assert.ok(data.commands.rateLimit, 'rate limit admin');
    assert.ok(data.runtimeStats, 'métricas de runtime');
    assert.strictEqual(typeof data.runtimeStats.receivedMessages, 'number');
    assert.strictEqual(typeof data.runtimeStats.buffers, 'number');
    assert.ok(data.runtimeStats.aiPool, 'pool de IA');
    assert.strictEqual(data.runtimeStats.aiPool.max, 3);
    assert.ok(data.queue, 'cola persistente');
    assert.strictEqual(typeof data.queue.pending, 'number');
    assert.strictEqual(typeof data.queue.max, 'number');
    assert.ok(data.memory, 'memoria');
    assert.ok(data.memory.heapUsed > 0);
});

test('GET /health es un healthcheck simple', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(typeof data.uptime_seconds, 'number');
});

test('rutas desconocidas responden 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.strictEqual(res.status, 404);
});

after(() => {
    if (server) server.close();
});
