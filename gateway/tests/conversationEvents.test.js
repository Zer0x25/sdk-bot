process.env.SDK_BOT_TEST = '1';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { assertValid } = require('@sdk-bot/contracts');
const { createArchive } = require('../services/conversations');
const { signContext, actorId } = require('../lib/panelContext');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths();
after(() => temporary.restore());
const { startInternalBus } = require('../services/internalBus');

const secret = 'test-only-event-stream-boundary-secret-32bytes';
const accountId = randomUUID();
const operator = { id: actorId('operator:event-stream'), displayName: 'Operador', capabilities: ['conversations:read'] };
let nextChatId = 5500000000n;
const identity = (exactValue, account = accountId) => ({
    accountId: account, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue
});
const message = (providerMessageId, exactValue = `${nextChatId++}@s.whatsapp.net`) => ({
    identity: identity(exactValue), providerMessageId, source: 'live', direction: 'inbound', authorKind: 'customer',
    occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: 'private message body' }
});

async function setup(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-events-'));
    const archive = createArchive({ path: path.join(dir, 'archive.db') });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'event-stream-fixture' });
    const oldSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    process.env.SDK_PANEL_GATEWAY_SECRET = secret;
    t.after(() => {
        if (oldSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = oldSecret;
    });
    const bus = startInternalBus({ port: 0, archive });
    await once(bus, 'listening');
    t.after(async () => { bus.closeAllConnections(); await new Promise(resolve => bus.close(resolve)); });
    const base = `http://127.0.0.1:${bus.address().port}`;
    async function request(pathname = '/v1/events', { actor = operator, lastEventId, signed = true } = {}) {
        const headers = signed ? signContext({ secret, actor, requestId: randomUUID(), method: 'GET', target: pathname, body: Buffer.alloc(0) }) : {};
        if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
        return fetch(base + pathname, { headers });
    }
    return { archive, request };
}

async function nextEvent(reader, state) {
    for (;;) {
        const separator = state.buffer.indexOf('\n\n');
        if (separator >= 0) {
            const frame = state.buffer.slice(0, separator);
            state.buffer = state.buffer.slice(separator + 2);
            if (!frame.includes('data: ')) continue;
            const id = frame.match(/^id: (.+)$/m)?.[1];
            const type = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            assert.ok(id && type && data, `invalid SSE frame: ${frame}`);
            return { id, type, data: JSON.parse(data) };
        }
        const part = await reader.read();
        assert.equal(part.done, false, 'stream closed before expected event');
        state.buffer += new TextDecoder().decode(part.value, { stream: true });
    }
}

test('durable events publish only after commit and duplicate ingests stay silent', async t => {
    const { archive } = await setup(t);
    const published = [];
    const visibleAfterCommit = [];
    const unsubscribe = archive.onEvent(event => {
        published.push(event);
        visibleAfterCommit.push(archive.eventsPage({ after: String(BigInt(event.cursor.seq) - 1n), through: event.cursor.seq })
            .then(page => page.items.some(item => item.cursor.seq === event.cursor.seq)));
    });
    t.after(unsubscribe);
    const input = message('committed');
    const [created] = await archive.ingestBatch([input]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await Promise.all(visibleAfterCommit), [true]);
    assert.equal(published.length, 1);
    assert.deepEqual(await archive.ingestBatch([input]), [{
        status: 'duplicate', messageId: created.message.id, conversationId: created.message.conversationId
    }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(published.length, 1);
});

test('signed SSE replays without a snapshot/subscribe gap, validates minimal events, and releases subscribers', async t => {
    const { archive, request } = await setup(t);
    await archive.ingestBatch([message('before-1'), message('before-2')]);
    const watermark = await archive.snapshot();
    let subscribers = 0;
    let resolveSubscriberClosed;
    const subscriberClosed = new Promise(resolve => { resolveSubscriberClosed = resolve; });
    const onEvent = archive.onEvent.bind(archive);
    archive.onEvent = listener => {
        subscribers += 1;
        const unsubscribe = onEvent(listener);
        return () => { subscribers -= 1; unsubscribe(); if (subscribers === 0) resolveSubscriberClosed(); };
    };

    // Force two committed events after the route has subscribed and captured its
    // watermark, but before replay begins. They must arrive once after replay.
    const readSnapshot = archive.snapshot.bind(archive);
    let injectRace = true;
    archive.snapshot = async () => {
        const snapshot = await readSnapshot();
        if (injectRace) {
            injectRace = false;
            await archive.ingestBatch([message('race-1'), message('race-2')]);
        }
        return snapshot;
    };

    const response = await request('/v1/events', { lastEventId: `${watermark.dataEpoch}:0` });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const state = { buffer: '' };
    const events = [];
    for (let index = 0; index < 4; index += 1) events.push(await nextEvent(reader, state));
    assert.deepEqual(events.map(event => event.data.cursor.seq), ['1', '2', '3', '4']);
    assert.deepEqual(events.map(event => event.id), events.map(event => `${event.data.cursor.dataEpoch}:${event.data.cursor.seq}`));
    for (const { type, data } of events) {
        assertValid('Event', data);
        assert.equal(type, 'message.created');
        assert.ok(!JSON.stringify(data).includes('private message body'));
    }
    assert.equal(new Set(events.map(event => event.id)).size, 4);
    await reader.cancel();
    await subscriberClosed;
    assert.equal(subscribers, 0);
});

test('a new SSE subscriber receives an id-only checkpoint before live invalidations', async t => {
    const { archive, request } = await setup(t);
    await archive.ingestBatch([message('snapshot-before-connect')]);
    const watermark = await archive.snapshot();
    const response = await request('/v1/events');
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const state = { buffer: '' };
    while (!state.buffer.includes(`id: ${watermark.dataEpoch}:${watermark.seq}\n\n`)) {
        const part = await reader.read();
        assert.equal(part.done, false);
        state.buffer += new TextDecoder().decode(part.value, { stream: true });
    }
    assert.ok(!state.buffer.includes('data: '));
    await archive.ingestBatch([message('after-checkpoint')]);
    const live = await nextEvent(reader, state);
    assert.equal(live.type, 'message.created');
    assert.equal(live.data.cursor.seq, '2');
    await reader.cancel();
});

test('expired and changed-epoch cursors emit resync.required at a current watermark', async t => {
    const { archive, request } = await setup(t);
    await archive.ingestBatch([message('will-expire')]);
    const current = await archive.snapshot();
    const expiry = new Date(Date.now() + 8 * 86400000).toISOString();
    assert.equal((await archive.purge({ now: expiry })).events, 1);

    const expired = await request('/v1/events', { lastEventId: `${current.dataEpoch}:0` });
    assert.equal(expired.status, 200);
    const expiredReader = expired.body.getReader();
    const expiredEvent = await nextEvent(expiredReader, { buffer: '' });
    assert.equal(expiredEvent.type, 'resync.required');
    assertValid('Event', expiredEvent.data);
    assert.deepEqual(expiredEvent.data.data, { reason: 'cursor_expired' });
    assert.deepEqual(expiredEvent.data.cursor, current);
    await expiredReader.cancel();

    const changed = await request('/v1/events', { lastEventId: `${randomUUID()}:0` });
    assert.equal(changed.status, 200);
    const changedReader = changed.body.getReader();
    const changedEvent = await nextEvent(changedReader, { buffer: '' });
    assert.equal(changedEvent.type, 'resync.required');
    assert.deepEqual(changedEvent.data.data, { reason: 'epoch_changed' });
    assert.deepEqual(changedEvent.data.cursor, current);
    await changedReader.cancel();
});

test('events route rejects invalid, future and unauthorized resume requests and sanitizes an unavailable archive', async t => {
    const { archive, request } = await setup(t);
    const current = await archive.snapshot();
    for (const lastEventId of ['bad', `${current.dataEpoch}:01`, `${current.dataEpoch}:2`]) {
        const response = await request('/v1/events', { lastEventId });
        assert.equal(response.status, 422);
        assertValid('ErrorResponse', await response.json());
    }
    const query = await request('/v1/events?unsupported=true');
    assert.equal(query.status, 422);
    assertValid('ErrorResponse', await query.json());
    const denied = await request('/v1/events', { actor: { ...operator, capabilities: [] } });
    assert.equal(denied.status, 403);
    assertValid('ErrorResponse', await denied.json());
    const anonymous = await request('/v1/events', { signed: false });
    assert.equal(anonymous.status, 401);
    assertValid('ErrorResponse', await anonymous.json());
    await archive.close();
    const unavailable = await request('/v1/events');
    assert.equal(unavailable.status, 503);
    assertValid('ErrorResponse', await unavailable.json());
});
