const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startStatusServer, buildStatus, channels } = require('../services/statusServer');
const { state } = require('../config');
const { safeErrorLabel } = require('../services/logger');

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
    assert.ok(data.channels, 'objeto channels');
    assert.strictEqual(data.channels.whatsapp.connection, 'starting');
    assert.strictEqual(data.channels.telegram.connection, 'starting');
    assert.ok(data.bot, 'estado del bot');
    assert.strictEqual(typeof data.bot.profile, 'string');
    assert.ok(data.database, 'db');
    assert.strictEqual(typeof data.database.contacts, 'number');
    assert.ok(data.database.byState, 'conteos de contactos por estado');
    for (const state of ['neutro', 'permitido', 'ignorado', 'handoff']) {
        assert.strictEqual(typeof data.database.byState[state], 'number');
    }
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
    assert.ok(data.broadcast, 'broadcasts');
    assert.strictEqual(typeof data.broadcast.pending, 'number');
    assert.strictEqual(typeof data.broadcast.dailyLimit, 'number');
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

test('métricas omiten identidades directas y limitan motivos de desconexión a códigos conocidos', () => {
    const priorPhone = state.ADMIN_PHONE;
    const priorLid = state.ADMIN_LID;
    const priorWaReason = channels.whatsapp.lastDisconnectReason;
    const priorTgReason = channels.telegram.lastDisconnectReason;
    const priorWaCapture = channels.whatsapp.capture;
    try {
        state.ADMIN_PHONE = '56912345678';
        state.ADMIN_LID = '123456789012345';
        channels.whatsapp.lastDisconnectReason = 'customer-private-detail 56987654321';
        channels.whatsapp.capture = {
            status: 'degraded', code: 'PRIVATE_CUSTOMER_56987654321', at: '2026-10-22T00:00:00.000Z'
        };
        channels.telegram.lastDisconnectReason = 'error_captura';

        const data = buildStatus();
        assert.equal(data.bot.adminLinked, true);
        assert.equal(Object.hasOwn(data.bot, 'number'), false);
        assert.equal(Object.hasOwn(data.bot, 'lid'), false);
        assert.equal(data.channels.whatsapp.lastDisconnectReason, 'error');
        assert.equal(data.channels.whatsapp.capture.code, 'PRIVATE_CUSTOMER_[id]');
        assert.equal(data.channels.telegram.lastDisconnectReason, 'error_captura');
        assert.equal(JSON.stringify(data).includes('56912345678'), false);
        assert.equal(JSON.stringify(data).includes('56987654321'), false);
        assert.equal(JSON.stringify(data).includes('PRIVATE_CUSTOMER_56987654321'), false);
    } finally {
        state.ADMIN_PHONE = priorPhone;
        state.ADMIN_LID = priorLid;
        channels.whatsapp.lastDisconnectReason = priorWaReason;
        channels.telegram.lastDisconnectReason = priorTgReason;
        channels.whatsapp.capture = priorWaCapture;
    }
});

test('safeErrorLabel registra categorías acotadas sin el mensaje de error', () => {
    const error = Object.assign(new Error('private-customer-message-75b4'), {
        code: 'PRIVATE_CUSTOMER_569876543210'
    });
    assert.equal(safeErrorLabel(error), 'PRIVATE_CUSTOMER_[id]');
    assert.equal(safeErrorLabel(Object.assign(new Error('private detail'), { status: 502 })), 'HTTP_502');
    assert.equal(safeErrorLabel({ name: 'PrivateCustomer' }), 'UNCLASSIFIED');
});

test('rutas desconocidas responden 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.strictEqual(res.status, 404);
});

after(() => {
    if (server) server.close();
});
