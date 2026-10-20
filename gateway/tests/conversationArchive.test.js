process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { assertValid } = require('@sdk-bot/contracts');
const { createArchive } = require('../services/conversations');
const { retentionCutoff } = require('../services/conversations/eventRetention');
const { signContext, actorId } = require('../lib/panelContext');
const { saveContactsDB } = require('../services/db');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths();
require('node:test').after(() => temporary.restore());
const { startInternalBus } = require('../services/internalBus');
const account = randomUUID();
const key = (exactValue = '12345@s.whatsapp.net', accountId = account) => ({ accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue });
const telegram = (exactValue, accountId) => ({ accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue });
const message = (identity = key(), providerMessageId = '1', extra = {}) => ({ identity, providerMessageId,
    source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt: '2026-01-01T00:00:00.000Z',
    content: { type: 'text', text: "private '); DROP TABLE messages; --" }, ...extra });
async function fixture(t, options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-archive-'));
    const dbPath = path.join(dir, 'archive.db');
    const archive = createArchive({ path: dbPath, ...options });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    await archive.registerAccount({ id: account, channel: 'whatsapp', providerKey: 'test-wa-account' });
    return { archive, dir, dbPath };
}

test('conversation page uses a stable timestamp/id cursor and bounds page size', async t => {
    const { archive } = await fixture(t);
    for (const [providerId, jid, occurredAt] of [
        ['page-a', '100@s.whatsapp.net', '2026-01-01T00:00:00.000Z'],
        ['page-b', '101@s.whatsapp.net', '2026-01-02T00:00:00.000Z'],
        ['page-c', '102@s.whatsapp.net', '2026-01-02T00:00:00.000Z'],
    ]) await archive.ingestBatch([message(key(jid), providerId, { occurredAt })]);
    const full = await archive.conversations({ limit: 100 });
    const paged = [];
    let before;
    do {
        const [row] = await archive.conversations({ limit: 1, before });
        if (!row) break;
        paged.push(row);
        before = { lastActivityAt: row.last_activity_at, id: row.id };
    } while (paged.length < 4);
    assert.deepEqual(paged.map(row => row.id), full.map(row => row.id));
    assert.deepEqual(full.map(row => row.last_activity_at), [
        '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    ]);
    await assert.rejects(archive.conversations({ limit: 101 }), { code: 'INVALID_LIMIT' });
});

test('event retention computes an exact 50,000-event replay window after each commit', () => {
    assert.equal(retentionCutoff('50000'), null);
    assert.equal(retentionCutoff('50001'), '1');
    assert.equal(retentionCutoff('51000'), '1000');
    assert.equal(retentionCutoff('1000000'), '950000');
    assert.equal(retentionCutoff('1000001'), '950001');
});

test('worker: migration, WAL FULL, transaction, minimal event and durable session watermark after reopen', async t => {
    const { archive, dbPath } = await fixture(t);
    const info = await archive.ready;
    assert.equal(info.schemaVersion, 4); assert.equal(info.journalMode, 'wal'); assert.equal(info.synchronous, 2);
    assert.ok(info.threadId > 0);
    const [created] = await archive.ingestBatch([message()]);
    assertValid('Message', created.message); assertValid('Event', created.event);
    assert.equal(created.message.content.text, message().content.text);
    assert.ok(!JSON.stringify(created.event).includes('private'));
    const before = await archive.snapshot();
    assert.equal(before.seq, '1');
    await archive.close();
    const reopened = createArchive({ path: dbPath }); t.after(() => reopened.close());
    assert.deepEqual(await reopened.snapshot(), before);
    assert.equal((await reopened.registerAccount({ channel: 'whatsapp', providerKey: 'test-wa-account' })).id, account);
    const other = await reopened.registerAccount({ channel: 'whatsapp', providerKey: 'different-remote-account' });
    assert.notEqual(other.id, account);
    assert.equal((await reopened.messages({ conversationId: created.message.conversationId }))[0].id, created.message.id);
    assert.equal((await reopened.diagnostics()).foreignKeys, 0);
    assert.deepEqual(await reopened.ingestBatch([message()]), [{ status: 'duplicate', messageId: created.message.id, conversationId: created.message.conversationId }]);
    await reopened.close();
    await assert.rejects(reopened.snapshot());
});

test('full batch rollback also removes new identities, events, fingerprints and sequence changes', async t => {
    const { archive } = await fixture(t);
    const before = await archive.snapshot();
    await assert.rejects(archive.ingestBatch([message(), message(key('999@s.whatsapp.net'), '2', { content: { type: 'bad' } })]));
    assert.deepEqual(await archive.snapshot(), before);
    const d = await archive.diagnostics(); assert.equal(d.messages, 0); assert.equal(d.events, 0);
    const [result] = await archive.ingestBatch([message()]); assert.equal(result.status, 'created');
    assert.equal(result.message.inboundSeq, '1');
});

test('DEDUP-01/BUG-016: verified JID/LID alias deduplicates old keys, preserves provenance and reimport is inert', async t => {
    const { archive } = await fixture(t);
    const [first] = await archive.ingestBatch([message()]);
    const lid = { ...key(), kind: 'whatsapp_lid', exactValue: '777@lid' };
    await assert.rejects(archive.bindAlias({ canonical: key(), alias: lid }));
    assert.equal((await archive.bindAlias({ canonical: key(), alias: lid, evidence: { kind: 'adapter', reference: 'fixture-proof' } })).status, 'linked');
    assert.equal((await archive.resolve(lid)).conversation_id, first.message.conversationId);
    const [duplicate] = await archive.ingestBatch([message(lid, '1', { source: 'history' })]);
    assert.equal(duplicate.messageId, first.message.id); assert.equal(duplicate.status, 'duplicate');
    assert.equal((await archive.snapshot()).seq, '1');
    const d = await archive.diagnostics(); assert.equal(d.provenance, 2); assert.equal(d.aliases, 1);
    const conversation = await archive.conversation(first.message.conversationId);
    assert.equal(conversation.inbound_seq, '1');
    assert.equal(conversation.history_observed, 0); // duplicate does not rewrite projection
});

test('alias collision and conflicting content quarantine both histories without merging; review flag gates future dispatch', async t => {
    const { archive } = await fixture(t);
    const alias = { ...key(), kind: 'whatsapp_lid', exactValue: '777@lid' };
    const [a, b] = await archive.ingestBatch([message(), message(alias)]);
    const result = await archive.bindAlias({ canonical: key(), alias, evidence: { kind: 'admin', reference: 'review' } });
    assert.equal(result.status, 'quarantined');
    for (const row of [a,b]) {
        assert.equal((await archive.conversation(row.message.conversationId)).requires_review, 1);
        assert.equal((await archive.messages({ conversationId: row.message.conversationId })).length, 1);
    }
    const [conflict] = await archive.ingestBatch([message(key(), '1', { content: { type: 'text', text: 'different' } })]);
    assert.equal(conflict.status, 'quarantined'); assert.equal((await archive.diagnostics()).messages, 2);
    assert.equal((await archive.diagnostics()).quarantine, 2);
    assert.equal((await archive.snapshot()).seq, '2');
});

test('exact namespace: Telegram signed >2^53 text, other account/channel/chat, and unknown deduplication', async t => {
    const { archive } = await fixture(t);
    const tg = randomUUID(), wa2 = randomUUID();
    await archive.registerAccount({ id: tg, channel: 'telegram', providerKey: 'test-bot' });
    await archive.registerAccount({ id: wa2, channel: 'whatsapp', providerKey: 'test-other-phone' });
    await assert.rejects(archive.registerAccount({ id: account, channel: 'telegram', providerKey: 'replacement' }));
    await assert.rejects(archive.registerAccount({ id: randomUUID(), channel: 'whatsapp', providerKey: 'test-wa-account' }));
    const identities = [key(), key('999@s.whatsapp.net'), key(undefined, wa2), telegram('-9007199254740993', tg), telegram('9007199254740993', tg)];
    const results = await archive.ingestBatch(identities.map(k => message(k)));
    assert.equal(new Set(results.map(r => r.message.id)).size, 5);
    assert.equal(new Set(results.map(r => r.message.conversationId)).size, 5);
    assert.equal((await archive.resolve(identities[3])).exact_value, '-9007199254740993');
    for (const invalid of [telegram(Number('-9007199254740993'), tg), telegram('-01', tg), { ...key(), accountId: tg }]) {
        await assert.rejects(archive.resolve(invalid));
    }
    const noId = await archive.ingestBatch([message(key(), null), message(key(), null)]);
    assert.notEqual(noId[0].message.id, noId[1].message.id);
    assert.equal(noId[0].message.deduplicationQuality, 'unknown');
});

test('history coverage, pagination ties, literal Unicode, audio and oversized marker survive without automation', async t => {
    const { archive } = await fixture(t);
    const content = { type: 'audio', availability: 'not_stored', transcript: null, transcriptionStatus: 'failed' };
    const results = await archive.ingestBatch([
        message(key(), '1', { source: 'history', direction: 'outbound', authorKind: 'external_self' }),
        message(key(), '2', { source: 'history', content }),
        message(key(), '3', { source: 'history', content: { type: 'text', text: '😀'.repeat(16385) } })
    ]);
    const id = results[0].message.conversationId;
    const c = await archive.conversation(id);
    assert.equal(c.inbound_seq, '0'); assert.equal(c.capturing_since, null); assert.equal(c.history_observed, 1);
    assert.equal(results[0].message.authorKind, 'unknown');
    assert.equal(results[2].message.content.type, 'oversized');
    const page = await archive.messages({ conversationId: id, limit: 2 });
    const previous = await archive.messages({ conversationId: id, before: page[0], limit: 2 });
    assert.equal(new Set([...previous, ...page].map(m => m.id)).size, 3);
    assert.deepEqual([...previous, ...page].map(m => m.id), results.map(r => r.message.id).sort());
    await archive.ingestBatch([message(key(), '4', { occurredAt: '2025-01-01T00:00:00.000Z' })]);
    assert.equal((await archive.conversation(id)).last_activity_at, '2026-01-01T00:00:00.000Z');
    assert.ok((await archive.conversation(id)).capturing_since);
});

test('single SQLite owner survives terminated process; committed data stays and uncommitted transaction is rolled back', async t => {
    const { archive, dbPath, dir } = await fixture(t);
    await archive.ingestBatch([message()]);
    const competing = createArchive({ path: dbPath }); t.after(() => competing.close());
    await assert.rejects(competing.ready); await competing.close();
    await archive.close();
    const script = path.join(dir, 'crash.cjs');
    await fs.writeFile(script, `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);db.exec("PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;UPDATE archive_meta SET seq='999';");process.send('written');setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, [script, dbPath], { stdio: ['ignore','ignore','ignore','ipc'] });
    t.after(() => child.kill('SIGKILL'));
    await once(child, 'message'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const reopened = createArchive({ path: dbPath }); t.after(() => reopened.close());
    assert.equal((await reopened.snapshot()).seq, '1');
    assert.equal((await reopened.diagnostics()).messages, 1);
    await reopened.close();
});

test('backup includes WAL commits; restore rotates epoch before readiness and leaves source timeline independent', async t => {
    const { archive, dir } = await fixture(t);
    await archive.ingestBatch([message()]);
    const destination = path.join(dir, 'snapshot.db');
    const snapshot = await archive.backup(destination);
    await assert.rejects(archive.backup(destination));
    await archive.ingestBatch([message(key(), '2')]);
    const restored = createArchive({ path: destination, restore: true }); t.after(() => restored.close());
    await restored.ready;
    assert.notEqual((await restored.snapshot()).dataEpoch, snapshot.dataEpoch);
    assert.equal((await restored.snapshot()).seq, '1'); assert.equal((await restored.events()).length, 0);
    assert.equal((await restored.diagnostics()).messages, 1); assert.equal((await restored.diagnostics()).integrity, 'ok');
    assert.equal((await archive.diagnostics()).messages, 2);
    await restored.close();
});

test('bounded concurrent queue, FIFO commits and main event loop remains responsive during fixture import', async t => {
    const { archive } = await fixture(t);
    const batch = Array.from({ length: 1000 }, (_, i) => message(key(), String(i)));
    const started = process.hrtime.bigint();
    let ticks = 0; const timer = setInterval(() => ticks++, 1);
    try {
        const pending = archive.ingestBatch(batch);
        assert.equal(archive.queue().elements, 1000);
        await assert.rejects(archive.snapshot(), { code: 'ARCHIVE_SATURATED' });
        await pending;
        assert.ok(ticks > 0);
    } finally { clearInterval(timer); }
    t.diagnostic(JSON.stringify({ sample: '1000-fixture-messages', elapsedMs: Number(process.hrtime.bigint() - started)/1e6, mainThreadTimerTicks: ticks, rssBytes: process.memoryUsage().rss, node: process.version }));
    const snapshot = await archive.snapshot(); assert.equal(snapshot.seq, '1000');
    const tasks = Array.from({ length: 20 }, (_, i) => archive.ingestBatch([message(key(), String(1000+i))]));
    const result = await Promise.all(tasks);
    assert.deepEqual(result.map(r => r[0].event.cursor.seq), Array.from({ length: 20 }, (_, i) => String(1001+i)));
    const ordered = await archive.events({ after: '998', limit: 4 });
    assert.deepEqual(ordered.map(e => e.cursor.seq), ['999','1000','1001','1002']);
    await assert.rejects(archive.ingestBatch([message(key(), 'too-big', { content: { type: 'text', text: 'a'.repeat(32*1024*1024) } })]), { code: 'ARCHIVE_SATURATED' });
});

test('retention uses captured timestamp strictly, keeps fingerprints after body purge and forbids resurrection', async t => {
    const { archive } = await fixture(t);
    const [created] = await archive.ingestBatch([message()]);
    const boundary = new Date(Date.parse(created.message.ingestedAt) + 90*86400000).toISOString();
    assert.equal((await archive.purge({ now: boundary })).bodies, 0);
    const after = new Date(Date.parse(boundary) + 1).toISOString();
    assert.equal((await archive.purge({ now: after })).bodies, 1);
    assert.equal((await archive.ingestBatch([message()]))[0].status, 'duplicate');
    assert.equal((await archive.diagnostics()).messages, 0);
    assert.equal((await archive.resolve(key())).conversation_id, created.message.conversationId);
    const expiry = new Date(Date.parse(created.message.ingestedAt) + 180*86400000 + 1).toISOString();
    assert.equal((await archive.purge({ now: expiry })).fingerprints, 1);
    assert.equal((await archive.ingestBatch([message()]))[0].status, 'created');
});

test('real signed session reads archive snapshot; unavailable archive fails with sanitized 503 and no bootstrap fallback', async t => {
    const { archive } = await fixture(t);
    await archive.ingestBatch([message()]);
    const old = process.env.SDK_PANEL_GATEWAY_SECRET;
    process.env.SDK_PANEL_GATEWAY_SECRET = 'test-only-archive-boundary-secret-32bytes';
    const bus = startInternalBus({ port: 0, archive });
    await once(bus, 'listening');
    try {
        const actor = { id: actorId('dev:archive-test'), displayName: 'Test', capabilities: ['conversations:read'] };
        const headers = () => signContext({ secret: process.env.SDK_PANEL_GATEWAY_SECRET, actor, requestId: randomUUID(), method: 'GET', target: '/v1/session', body: Buffer.alloc(0) });
        const url = `http://127.0.0.1:${bus.address().port}/v1/session`;
        const response = await fetch(url, { headers: headers() });
        assert.equal(response.status, 200); assert.deepEqual((await response.json()).snapshot, await archive.snapshot());
        await archive.close();
        const failed = await fetch(url, { headers: headers() }); assert.equal(failed.status, 503);
        assertValid('ErrorResponse', await failed.json());
    } finally {
        bus.closeAllConnections(); await new Promise(resolve => bus.close(resolve));
        if (old === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET; else process.env.SDK_PANEL_GATEWAY_SECRET = old;
    }
});

test('v1 conversation reads project safe contacts, filter/paginate stably, and keep read cursors actor-local', async t => {
    const { archive, dbPath } = await fixture(t);
    const at = '2026-01-03T00:00:00.000Z';
    const [alice1] = await archive.ingestBatch([message(key('111@s.whatsapp.net'), 'alice-1', { occurredAt: at })]);
    await archive.ingestBatch([message(key('111@s.whatsapp.net'), 'alice-2', { occurredAt: at })]);
    await archive.ingestBatch([message(key('222@s.whatsapp.net'), 'bea-1', { occurredAt: at })]);
    await archive.ingestBatch([message(key('333@s.whatsapp.net'), 'unknown-1', { occurredAt: at, source: 'history' })]);
    const empty = await archive.resolve(key('444@s.whatsapp.net'));
    const historicalTelegram = await archive.registerAccount({ channel: 'telegram', providerKey: 'old-telegram-account' });
    saveContactsDB({
        alice: { phone: '111', lid: null, savedName: 'Ana', estado: 'permitido' },
        bea: { phone: '222', lid: null, savedName: 'Bea', estado: 'handoff', handoffAt: new Date().toISOString() }
    });
    const oldSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    const secret = 'test-session-api-boundary-secret-with-32-bytes';
    process.env.SDK_PANEL_GATEWAY_SECRET = secret;
    const bus = startInternalBus({ port: 0, archive, getChannelStatus: (_channel, id) => id === account ? { status: 'open' } : 'disconnected' });
    await once(bus, 'listening');
    const base = `http://127.0.0.1:${bus.address().port}`;
    const actor = { id: actorId('operator:read-contract'), displayName: 'Operador', capabilities: ['conversations:read'] };
    const otherActor = { id: actorId('operator:other-read-contract'), displayName: 'Otra persona', capabilities: ['conversations:read'] };
    async function request(path, { method = 'GET', signedActor = actor, body = '' } = {}) {
        const bytes = Buffer.from(body);
        const headers = signContext({ secret, actor: signedActor, requestId: randomUUID(), method,
            target: path, body: bytes });
        if (body) headers['content-type'] = 'application/json';
        return fetch(base + path, { method, headers, ...(body ? { body } : {}) });
    }
    try {
        const listed = await request('/v1/conversations?limit=20');
        assert.equal(listed.status, 200);
        const response = assertValid('ConversationsResponse', await listed.json());
        assert.equal(response.items.length, 4);
        const ana = response.items.find(item => item.displayName === 'Ana');
        const bea = response.items.find(item => item.displayName === 'Bea');
        assert.ok(ana && bea);
        assert.equal(ana.unreadCount, 2);
        assert.equal(bea.control.automationMode, 'human');
        assert.equal(response.items.find(item => item.id === empty.conversation_id).historyCoverage.capturingSince, null);
        assert.ok(!JSON.stringify(response).includes('111@s.whatsapp.net'));
        assert.ok(!JSON.stringify(response).includes('test-wa-account'));

        const accounts = assertValid('AccountsResponse', await (await request('/v1/accounts')).json());
        assert.equal(accounts.items.find(item => item.id === account).status, 'connected');
        assert.equal(accounts.items.find(item => item.id === historicalTelegram.id).status, 'disconnected');
        assert.equal(accounts.items.find(item => item.id === account).capabilities.readReceipt, false);

        const named = assertValid('ConversationsResponse', await (await request('/v1/conversations?search=ana')).json());
        assert.deepEqual(named.items.map(item => item.displayName), ['Ana']);
        const noTextSearch = assertValid('ConversationsResponse', await (await request('/v1/conversations?search=private')).json());
        assert.equal(noTextSearch.items.length, 0);
        const human = assertValid('ConversationsResponse', await (await request('/v1/conversations?automationMode=human')).json());
        assert.deepEqual(human.items.map(item => item.displayName), ['Bea']);

        const first = assertValid('ConversationsResponse', await (await request('/v1/conversations?limit=1')).json());
        assert.ok(first.nextCursor);
        const tamperedCursor = `${first.nextCursor[0] === 'A' ? 'B' : 'A'}${first.nextCursor.slice(1)}`;
        assert.equal((await request(`/v1/conversations?limit=1&cursor=${tamperedCursor}`)).status, 410);
        assert.equal((await request(`/v1/conversations?limit=1&cursor=${first.nextCursor}`, { signedActor: otherActor })).status, 410);
        const allIds = [...first.items.map(item => item.id)];
        let cursor = first.nextCursor;
        while (cursor) {
            const page = assertValid('ConversationsResponse', await (await request(`/v1/conversations?limit=1&cursor=${cursor}`)).json());
            allIds.push(...page.items.map(item => item.id));
            cursor = page.nextCursor;
        }
        assert.equal(allIds.length, 4);
        assert.equal(new Set(allIds).size, 4);

        const detail = assertValid('ConversationResponse', await (await request(`/v1/conversations/${alice1.message.conversationId}`)).json());
        assert.equal(detail.conversation.displayName, 'Ana');
        assert.equal(detail.channelCapabilities.attachments, true);
        const messagePage = assertValid('MessagesResponse', await (await request(`/v1/conversations/${alice1.message.conversationId}/messages?limit=1`)).json());
        assert.equal(messagePage.items.length, 1);
        assert.ok(messagePage.nextCursor);
        const older = assertValid('MessagesResponse', await (await request(`/v1/conversations/${alice1.message.conversationId}/messages?limit=1&cursor=${messagePage.nextCursor}`)).json());
        assert.equal(older.items.length, 1);
        assert.notEqual(older.items[0].id, messagePage.items[0].id);

        const mark = async (signedActor, seq) => request(`/v1/conversations/${alice1.message.conversationId}/read`, {
            method: 'POST', signedActor, body: JSON.stringify({ throughInboundSeq: seq })
        });
        const marked = assertValid('ReadResponse', await (await mark(actor, '1')).json());
        assert.equal(marked.throughInboundSeq, '1');
        assert.equal(assertValid('ReadResponse', await (await mark(actor, '0')).json()).throughInboundSeq, '1');
        const afterRead = assertValid('ConversationResponse', await (await request(`/v1/conversations/${alice1.message.conversationId}`)).json());
        assert.equal(afterRead.conversation.unreadCount, 1);
        const otherRead = assertValid('ConversationResponse', await (await request(`/v1/conversations/${alice1.message.conversationId}`, { signedActor: otherActor })).json());
        assert.equal(otherRead.conversation.unreadCount, 2);
        assert.equal((await mark(actor, '99')).status, 422);
        assert.equal((await request(`/v1/conversations/${alice1.message.conversationId}/read?ignored=true`, {
            method: 'POST', body: JSON.stringify({ throughInboundSeq: '1' })
        })).status, 422);
        assert.equal((await request('/v1/conversations/%25')).status, 422);

        const stale = assertValid('ConversationsResponse', await (await request('/v1/conversations?limit=1')).json());
        await archive.ingestBatch([message(key('555@s.whatsapp.net'), 'new-after-list', { occurredAt: '2026-01-04T00:00:00.000Z' })]);
        assert.equal((await request(`/v1/conversations?limit=1&cursor=${stale.nextCursor}`)).status, 410);
        assert.equal((await request('/v1/conversations?limit=0')).status, 422);
        assert.equal((await request('/v1/conversations?limit=1&limit=2')).status, 422);
        assert.equal((await request('/v1/conversations', { signedActor: { ...actor, capabilities: [] } })).status, 403);
        await archive.close();
        const reopened = createArchive({ path: dbPath }); t.after(() => reopened.close());
        await reopened.ready;
        const persisted = await reopened.conversationRows({ actorId: actor.id, accountId: account, channel: 'whatsapp' });
        assert.equal(persisted.find(row => row.id === alice1.message.conversationId).unread_count, 1);
        const otherPersisted = await reopened.conversationRows({ actorId: otherActor.id });
        assert.equal(otherPersisted.find(row => row.id === alice1.message.conversationId).unread_count, 2);
    } finally {
        bus.closeAllConnections(); await new Promise(resolve => bus.close(resolve));
        if (oldSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = oldSecret;
    }
});

test('startup failure rejects readiness and queued calls, never creates placeholder snapshots', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-bad-archive-'));
    const bad = path.join(dir, 'not-a-directory'); await fs.writeFile(bad, 'fixture');
    const archive = createArchive({ path: path.join(bad, 'db') });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await assert.rejects(archive.ready); await assert.rejects(archive.snapshot());
});

test('RPC freezes caller input before readiness and preserves sequence precision above 2^53', async t => {
    const { archive, dbPath } = await fixture(t);
    const record = message();
    const pending = archive.ingestBatch([record]);
    record.content.text = 'mutated after admission';
    const [created] = await pending;
    assert.equal(created.message.content.text, message().content.text);
    await archive.close();
    const script = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec("UPDATE archive_meta SET seq='9007199254740992';UPDATE conversations SET inbound_seq='9007199254740992',aggregate_version='9007199254740992';");d.close();`;
    const child = spawn(process.execPath, ['-e', script, dbPath], { stdio: 'ignore' });
    assert.deepEqual(await once(child, 'exit'), [0, null]);
    const reopened = createArchive({ path: dbPath }); t.after(() => reopened.close());
    const [next] = await reopened.ingestBatch([message(key(), 'next')]);
    assert.equal(next.message.inboundSeq, '9007199254740993');
    assert.equal(next.event.data.aggregateVersion, '9007199254740993');
    assert.equal(next.event.cursor.seq, '9007199254740993');
    await reopened.close();
});

test('dedup hash ignores object property order and distinguishes oversized bodies with identical byte counts', async t => {
    const { archive } = await fixture(t);
    const [created] = await archive.ingestBatch([message()]);
    const [duplicate] = await archive.ingestBatch([message(key(), '1', { content: { text: message().content.text, type: 'text' } })]);
    assert.equal(duplicate.messageId, created.message.id);
    await archive.ingestBatch([message(key(), 'huge', { content: { type: 'text', text: 'a'.repeat(65537) } })]);
    const [conflict] = await archive.ingestBatch([message(key(), 'huge', { content: { type: 'text', text: 'b'.repeat(65537) } })]);
    assert.equal(conflict.status, 'quarantined');
});
