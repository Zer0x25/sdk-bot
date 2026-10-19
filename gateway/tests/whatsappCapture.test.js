process.env.SDK_BOT_TEST = '1';
process.env.AUDIO_STT_ENABLED = '0';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths();
after(() => temporary.restore());
const WhatsappAdapter = require('../adapters/whatsappAdapter');
const { createArchive } = require('../services/conversations');
const { createWhatsappCapture, normalize, socketIdentity } = require('../services/conversations/whatsappCapture');
const { startRetention } = require('../services/conversations/retention');
const { state, registerSentMessage } = require('../config');
const chatStore = require('../store/chatStore');

const own = { id: '100:7@s.whatsapp.net', lid: '900:7@lid' };
const session = socketIdentity(own);
const msg = (id, jid = '200@s.whatsapp.net', message = { conversation: 'hola' }, extra = {}) => ({
    key: { id, remoteJid: jid, fromMe: false }, messageTimestamp: '1792368000', message, ...extra
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(adapter) { await adapter.capture.idle(); await tick(); }

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-wa-capture-'));
    const db = path.join(dir, 'archive.db');
    const archive = createArchive({ path: db });
    await archive.ready;
    const adapters = [];
    async function adapter(options = {}, user = own) {
        const sockets = [], messages = [], archived = [], failures = [], effects = [];
        const instance = new WhatsappAdapter({ archive,
            loadAuth: async () => ({ state: { creds: { registered: true } }, saveCreds: async () => effects.push('creds') }),
            makeSocket: () => {
                const sock = { user, ev: new EventEmitter(),
                    end() { effects.push('end'); this.ev.emit('connection.update', { connection: 'close' }); },
                    async sendMessage(jid, content) { effects.push(['send', jid, content]); return { key: { id: 'sent-1' } }; },
                    async sendPresenceUpdate(status) { effects.push(['presence', status]); } };
                sockets.push(sock); return sock;
            }, ...options });
        instance.getKnownAdminPhone = () => '';
        instance.setKnownAdminPhone = () => {};
        instance.on('message', m => messages.push(m));
        instance.on('archived_message', e => { archived.push(e); if (e.source === 'live') chatStore.upsertMessage(e.raw); });
        instance.on('capture_status', e => failures.push(e));
        instance.on('contact_sync', e => effects.push(['contacts', e]));
        instance.on('presence_update', e => effects.push(['presence-event', e]));
        await instance.connect(); adapters.push(instance);
        return { instance, sockets, messages, archived, failures, effects };
    }
    t.after(async () => {
        for (const a of adapters) await a.disconnect();
        await archive.close(); chatStore._store.clear();
        await fs.rm(dir, { recursive: true, force: true });
    });
    return { archive, db, adapter };
}

test('WA boundary: verified account, exact device normalization, scope, wrappers, dates and unsupported media', () => {
    assert.equal(session.providerKey, '100@s.whatsapp.net');
    assert.throws(() => socketIdentity({ id: '100@lid' }), { code: 'WA_ACCOUNT_UNVERIFIED' });
    assert.throws(() => socketIdentity({ id: '100+@s.whatsapp.net' }));
    for (const jid of ['100@s.whatsapp.net', '100:2@s.whatsapp.net', '900@lid'])
        assert.equal(normalize(msg('1', jid), session, 'live').scope, 'administration');
    for (const jid of ['200@g.us', 'status@broadcast', '200@broadcast', '200@newsletter', '200'])
        assert.equal(normalize(msg('1', jid), session, 'live').scope, 'non_individual');
    const wrapped = normalize(msg(null, '200:9@lid', { ephemeralMessage: { message: { viewOnceMessageV2: {
        message: { imageMessage: {} } } } } }), session, 'history');
    assert.equal(wrapped.remote, '200@lid'); assert.equal(wrapped.content.type, 'image');
    assert.equal(wrapped.providerMessageId, null); assert.equal(wrapped.occurredAt, '2026-10-19T00:00:00.000Z');
    assert.equal(normalize(msg('x', undefined, { stickerMessage: {} }), session, 'live').content.type, 'unsupported');
    assert.throws(() => normalize(msg('x', undefined, {}, { messageTimestamp: 'bad' }), session, 'live'), { code: 'WA_TIMESTAMP_INVALID' });
    assert.throws(() => normalize(msg('x', undefined, {}, { messageTimestamp: '8640000000001' }), session, 'live'));
    assert.throws(() => normalize(msg('x'.repeat(513)), session, 'live'), { code: 'WA_MESSAGE_ID_INVALID' });
    assert.throws(() => normalize(msg('x', undefined, { conversation: '\ud800' }), session, 'live'), { code: 'WA_CONTENT_INVALID' });
    const snapshot = normalize(msg('x'), session, 'live');
    assert.equal(snapshot.alt, null);
});

test('BUG-001/002: full live batch, marker before STT, ignored/paused/handoff capture and restart without duplicates', async t => {
    const f = await fixture(t); const a = await f.adapter();
    const previousPause = state.IS_BOT_PAUSED; state.IS_BOT_PAUSED = true;
    t.after(() => { state.IS_BOT_PAUSED = previousPause; });
    const contacts = require('../services/db').getContactsDB();
    contacts['200'] = { estado: 'ignorado' }; contacts['201'] = { estado: 'handoff' };
    const batch = [msg('a'), msg('b', '201@s.whatsapp.net'), msg('c', '202@s.whatsapp.net', { audioMessage: { seconds: 1 } }),
        msg('d', '203@s.whatsapp.net', { imageMessage: {} }), msg('e', '204@s.whatsapp.net', undefined,
            { key: { id: 'e', remoteJid: '204@s.whatsapp.net', fromMe: true } })];
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: batch });
    await settled(a.instance);
    assert.equal((await f.archive.diagnostics()).messages, 5);
    assert.equal(a.archived.length, 5); assert.equal(a.messages.length, 2);
    assert.equal(chatStore.getRecent('200@s.whatsapp.net').length, 1);
    const audio = a.archived.find(e => e.raw.key.id === 'c').observation.result.message;
    assert.deepEqual(audio.content, { type: 'audio', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' });
    const conversation = await f.archive.conversation(audio.conversationId);
    assert.equal(conversation.inbound_seq, '1');
    await a.instance.disconnect(); await f.archive.close();
    const reopened = createArchive({ path: f.db }); await reopened.ready;
    t.after(() => reopened.close());
    const capture = createWhatsappCapture(reopened);
    for (const item of batch) assert.equal((await capture.enqueue(item, socketIdentity({ ...own, id: '100:99@s.whatsapp.net' }), 'history')).result.status, 'duplicate');
    assert.equal((await reopened.diagnostics()).messages, 5);
    assert.equal((await reopened.conversation(audio.conversationId)).inbound_seq, '1');
    assert.equal((await reopened.messages({ conversationId: audio.conversationId }))[0].id, audio.id);
    await capture.close(); await reopened.close();
});

test('append/history never automate, live redelivery stays inert, same remote ID is scoped by chat and account', async t => {
    const f = await fixture(t); const a = await f.adapter();
    // A legacy global ID from any channel must not suppress another WA input.
    registerSentMessage({ message_id: 'shared' });
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('shared'), msg('shared', '201@s.whatsapp.net')] });
    await settled(a.instance); assert.equal(a.messages.length, 2);
    a.sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [msg('old')] });
    a.sockets[0].ev.emit('messaging-history.set', { messages: [msg('history'), msg('shared')] });
    await settled(a.instance); assert.equal(a.messages.length, 2);
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('old'), msg('shared')] });
    await settled(a.instance); assert.equal(a.messages.length, 2);
    const b = await f.adapter({}, { id: '101:3@s.whatsapp.net' });
    b.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('shared')] });
    await settled(b.instance); assert.equal(b.messages.length, 1);
    assert.equal((await f.archive.diagnostics()).messages, 5);
    assert.equal((await f.archive.diagnostics()).provenance, 7);
});

test('verified remoteJidAlt deduplicates aliases; conflicting histories quarantine without merging or future dispatch', async t => {
    const f = await fixture(t); const a = await f.adapter(); const sock = a.sockets[0];
    const withAlt = msg('proof'); withAlt.key.remoteJidAlt = '800@lid';
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [withAlt, msg('proof', '800@lid')] });
    await settled(a.instance); assert.equal(a.messages.length, 1);
    assert.equal((await f.archive.diagnostics()).messages, 1); assert.equal((await f.archive.diagnostics()).aliases, 1);
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg('independent', '801@lid')] });
    await settled(a.instance);
    const conflict = msg('conflict'); conflict.key.remoteJidAlt = '801@lid';
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [conflict] });
    await settled(a.instance); const before = a.messages.length;
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg('blocked'), msg('blocked', '801@lid')] });
    await settled(a.instance); assert.equal(a.messages.length, before);
    for (const jid of ['200@s.whatsapp.net', '801@lid'])
        await assert.rejects(a.instance.sendMessage(`whatsapp:${jid}`, 'unsafe'), { code: 'WA_IDENTITY_REVIEW_REQUIRED' });
    assert.equal(a.effects.filter(e => Array.isArray(e) && e[0] === 'send').length, 0);
    assert.equal((await f.archive.diagnostics()).quarantine, 1);
});

test('BUG-003: stale messages, history, contacts, presence and credentials produce no effects', async t => {
    const f = await fixture(t); const a = await f.adapter(); const old = a.sockets[0];
    await a.instance.connect(); const baseline = [...a.effects];
    old.ev.emit('messages.upsert', { type: 'notify', messages: [msg('stale')] });
    old.ev.emit('messaging-history.set', { messages: [msg('stale-history')], contacts: [{ id: '200@s.whatsapp.net' }] });
    old.ev.emit('contacts.upsert', [{ id: '200@s.whatsapp.net' }]);
    old.ev.emit('contacts.update', [{ id: '200@s.whatsapp.net' }]);
    old.ev.emit('presence.update', { id: '200@s.whatsapp.net', presences: {} });
    old.ev.emit('creds.update', {}); old.ev.emit('connection.update', { connection: 'open' });
    await settled(a.instance);
    assert.deepEqual(a.effects, baseline); assert.equal((await f.archive.diagnostics()).messages, 0);
    a.sockets[1].ev.emit('messages.upsert', { type: 'notify', messages: [msg('current')] });
    await settled(a.instance); assert.equal(a.messages.length, 1);
});

test('socket replacement during STT suppresses late transcription and presence on the new socket', async t => {
    const f = await fixture(t); const transcript = deferred(), started = deferred();
    const a = await f.adapter({ download: async () => Buffer.from('fixture'), transcribe: async () => { started.resolve(); return transcript.promise; } });
    process.env.AUDIO_STT_ENABLED = '1';
    t.after(() => { process.env.AUDIO_STT_ENABLED = '0'; });
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('voice', undefined, { audioMessage: { seconds: 1 } })] });
    await started.promise;
    assert.equal((await f.archive.diagnostics()).messages, 1); // base already durable
    await a.instance.connect(); const baseline = [...a.effects];
    transcript.resolve('late text'); await tick(); await tick();
    assert.equal(a.messages.length, 0); assert.deepEqual(a.effects, baseline);
});

test('capture commit gates automation; unknown write outcome stops admission and restart deduplicates', async t => {
    const f = await fixture(t); const release = deferred();
    const a = await f.adapter({ archive: { ...f.archive, async ingestBatch(input) {
        const result = await f.archive.ingestBatch(input); await release.promise;
        throw Object.assign(new Error('fixture timeout after commit'), { code: 'ARCHIVE_TIMEOUT', result });
    } } });
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('uncertain')] });
    await tick(); assert.equal(a.messages.length, 0);
    release.resolve(); await settled(a.instance);
    assert.equal(a.messages.length, 0); assert.equal(a.failures[0].code, 'ARCHIVE_TIMEOUT');
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('not-admitted')] });
    await settled(a.instance); assert.equal((await f.archive.diagnostics()).messages, 1);
    const restarted = await f.adapter();
    restarted.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('uncertain')] });
    await settled(restarted.instance); assert.equal(restarted.messages.length, 0);
    assert.equal((await f.archive.diagnostics()).messages, 1);
});

test('FIFO admission includes active records, enforces 1000 items and 32MiB, and snapshots normalized payload', async () => {
    const release = deferred(); const inputs = [];
    const account = { id: 'fixture' };
    const archive = { registerAccount: async () => { await release.promise; return account; },
        ingestBatch: async input => { inputs.push(input[0]); return [{ status: 'duplicate' }]; },
        resolve: async () => ({ conversation_id: 'fixture' }), conversation: async () => ({ requires_review: 0 }) };
    const capture = createWhatsappCapture(archive);
    const first = msg('0'); const jobs = [capture.enqueue(first, session, 'live')];
    first.message.conversation = 'changed after admission';
    for (let n = 1; n < 1000; n++) jobs.push(capture.enqueue(msg(String(n)), session, 'live'));
    await assert.rejects(capture.enqueue(msg('overflow'), session, 'live'), { code: 'WA_CAPTURE_SATURATED' });
    assert.equal(capture.queue().elements, 1000); release.resolve(); await Promise.all(jobs);
    assert.equal(inputs[0].content.text, 'hola'); assert.equal(inputs.length, 1000);
    assert.deepEqual(capture.queue(), { elements: 0, bytes: 0, failed: null }); await capture.close();
    await assert.rejects(capture.enqueue(msg('closed'), session, 'live'), { code: 'WA_CAPTURE_CLOSED' });
    const bytes = createWhatsappCapture(archive);
    const large = msg('large', undefined, { conversation: 'x'.repeat(17 * 1024 * 1024) });
    const admitted = bytes.enqueue(large, session, 'history');
    await assert.rejects(bytes.enqueue(large, session, 'history'), { code: 'WA_CAPTURE_SATURATED' });
    await admitted; await bytes.close();
});

test('oversized content is archived as a marker and malformed/unverified input reports degradation without automation', async t => {
    const f = await fixture(t); const a = await f.adapter();
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [
        msg('large', undefined, { conversation: 'x'.repeat(65537) }),
        msg('bad', undefined, {}, { messageTimestamp: 'NaN' }), msg('good')
    ] });
    await settled(a.instance); assert.equal(a.messages.length, 1);
    assert.equal(a.failures[0].code, 'WA_TIMESTAMP_INVALID');
    assert.equal(a.archived[0].observation.result.message.content.type, 'oversized');
    const b = await f.adapter({}, {});
    b.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('unknown-account')] });
    await settled(b.instance); assert.equal(b.failures[0].code, 'WA_ACCOUNT_UNVERIFIED');
    assert.equal((await f.archive.diagnostics()).messages, 2);
});

test('self/admin stays outside customer archive, scoped local echoes do not execute commands twice', async t => {
    const f = await fixture(t); const a = await f.adapter(); const sock = a.sockets[0];
    await a.instance.sendMessage('whatsapp:100@s.whatsapp.net', '/danger');
    const echo = msg('sent-1', '100@s.whatsapp.net', { conversation: '/danger' }); echo.key.fromMe = true;
    const otherChat = msg('sent-1', '201@s.whatsapp.net');
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [echo, otherChat, msg('admin-command', '100@s.whatsapp.net', { conversation: '/help' })] });
    await settled(a.instance);
    assert.deepEqual(a.messages.map(m => m.text), ['/help', 'hola']);
    assert.equal((await f.archive.diagnostics()).messages, 1);
});

test('known local outbound echo is retained with unknown author until durable attribution; no provider ID remains explicitly unknown', async t => {
    const f = await fixture(t); const a = await f.adapter();
    await a.instance.sendMessage('whatsapp:200@s.whatsapp.net', 'sent text');
    const echo = msg('sent-1', undefined, { conversation: 'sent text' }); echo.key.fromMe = true;
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [echo, msg(null), msg(null)] });
    await settled(a.instance);
    assert.equal(a.archived[0].observation.result.message.authorKind, 'unknown');
    assert.equal(a.archived[0].observation.result.message.direction, 'outbound');
    assert.equal((await f.archive.diagnostics()).messages, 3); assert.equal(a.messages.length, 2);
    for (const item of a.archived.slice(1)) assert.equal(item.observation.result.message.deduplicationQuality, 'unknown');
});

test('overlapping connect attempts cannot install a socket from older asynchronous auth', async t => {
    const f = await fixture(t); const a = await f.adapter(); const auth = deferred(); let calls = 0;
    a.instance.loadAuth = async () => { if (++calls === 1) await auth.promise;
        return { state: { creds: { registered: true } }, saveCreds: async () => {} }; };
    const older = a.instance.connect(); const newer = a.instance.connect(); await newer;
    const current = a.instance.sock; auth.resolve(); await older;
    assert.equal(a.instance.sock, current); assert.equal(a.sockets.length, 2);
});

test('real SQLite burst keeps transport ticks responsive, reports saturation and admits redelivery after draining', { timeout: 20000 }, async t => {
    const f = await fixture(t); const a = await f.adapter();
    let ticks = 0; const heartbeat = setInterval(() => { ticks++; }, 5);
    t.after(() => clearInterval(heartbeat));
    const batch = Array.from({ length: 1001 }, (_, n) => msg(`burst-${n}`));
    a.sockets[0].ev.emit('messaging-history.set', { messages: batch });
    await settled(a.instance);
    assert.ok(ticks > 0); assert.equal(a.messages.length, 0);
    assert.equal((await f.archive.diagnostics()).messages, 1000);
    assert.deepEqual(a.failures.map(e => e.code), ['WA_CAPTURE_SATURATED']);
    a.sockets[0].ev.emit('messaging-history.set', { messages: [batch[1000]] });
    await settled(a.instance); assert.equal((await f.archive.diagnostics()).messages, 1001);
});

test('retention before admission uses bounded batches and yields; startup failure propagates', async () => {
    const calls = []; let yielded = false;
    setImmediate(() => { yielded = true; });
    const retention = await startRetention({ async purge(input) {
        calls.push(input); return { remaining: calls.length < 3 };
    } }, () => assert.fail('unexpected daily error'));
    assert.equal(yielded, true); assert.equal(calls.length, 3);
    assert.equal(calls[0].limit, 500); assert.equal(new Set(calls.map(c => c.now)).size, 1);
    await retention.close();
    await assert.rejects(startRetention({ purge: async () => { throw new Error('fixture purge failure'); } }, () => {}), /fixture purge failure/);
});

test('disconnect still drains admitted archive work when transport end throws', async t => {
    const f = await fixture(t); const a = await f.adapter();
    a.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg('drain')] });
    a.sockets[0].end = () => { throw new Error('fixture close error'); };
    await assert.rejects(a.instance.disconnect(), /fixture close error/);
    assert.equal((await f.archive.diagnostics()).messages, 1);
    assert.equal(a.instance.capture.queue().elements, 0);
    assert.equal(a.instance.sock, null); assert.equal(a.messages.length, 0);
});
