process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bus = require('../services/internalBus');

test('POST /notify requires a stable key and routes through the common adapter send port', async t => {
    const calls = [];
    bus.setSock({ async sendMessage(...args) { calls.push(args); return { _outbox: { state: 'accepted', id: 'intent-id' } }; } });
    const server = bus.startInternalBus({ port: 0 });
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/notify`;
    t.after(async () => {
        bus.setSock(null);
        await new Promise(resolve => server.close(resolve));
    });

    const missingKey = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jid: 'whatsapp:569111@s.whatsapp.net', message: 'aviso' }) });
    assert.equal(missingKey.status, 400);
    assert.equal((await missingKey.json()).code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(calls.length, 0);

    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
        'idempotency-key': 'notify:test-1' }, body: JSON.stringify({ jid: 'whatsapp:569111@s.whatsapp.net', message: 'aviso' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, outbound: { state: 'accepted', id: 'intent-id' } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['whatsapp:569111@s.whatsapp.net', 'aviso', {
        source: 'notice', idempotencyKey: 'notify:test-1', policy: { kind: 'internal_notify' }
    }]);
});
