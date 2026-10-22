process.env.SDK_BOT_TEST = '1';
process.env.AUDIO_STT_ENABLED = '0';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchive } = require('../services/conversations');
const { createLegacyDispatchPump } = require('../services/conversations/legacyDispatch');

const envelope = (text = 'mensaje durable') => ({ waitForTranscription: false, message: {
    channel: 'telegram', remoteId: 'telegram:-77', rawId: '-77', text, transcript: '', isAudio: false,
    metadata: { pushName: 'Persona', savedName: 'Nombre guardado', phoneNumber: 'secret-phone', lid: 'secret-lid',
        isBusiness: false, country: 'Desconocido', isFromMe: false, isAdminChannel: false }
} });
const telegramInput = (accountId, extra = {}) => ({ identity: { accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '-77' },
    providerMessageId: '41', source: 'live', direction: 'inbound', authorKind: 'customer',
    occurredAt: '2026-10-20T10:00:00.000Z', content: { type: 'text', text: 'mensaje durable' }, ...extra });

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-dispatch-'));
    const dbPath = path.join(dir, 'archive.db');
    const archives = new Set();
    const open = async () => {
        const archive = createArchive({ path: dbPath });
        archives.add(archive);
        await archive.ready;
        return archive;
    };
    t.after(async () => {
        for (const archive of archives) await archive.close().catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
    });
    return { dbPath, open };
}

test('BUG-045: archive commit survives crash before pipeline wake and replays once after restart', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const committed = await archive.captureTelegramBatch({ accountId: account.id, updates: [
        { updateId: '501', message: telegramInput(account.id, { legacyDispatch: envelope() }) }
    ] });
    const messageId = committed.results[0].result.message.id;
    assert.equal(committed.lastUpdateId, '501');
    assert.equal((await archive.pendingLegacyDispatches()).length, 1);

    // Simulate death immediately after SQLite commits, before the adapter event
    // can wake a consumer. Nothing has reached the callback in this process.
    await archive.close();
    const delivered = [];
    archive = await f.open();
    const pump = createLegacyDispatchPump({ archive, isReady: () => true,
        dispatch: async message => delivered.push(message) });
    await pump.trigger();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].archiveMessageId, messageId);
    assert.equal(delivered[0].text, 'mensaje durable');
    assert.equal(delivered[0].raw, undefined);
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
    await pump.close();
    await archive.close();

    // A later process sees the durable ACK and does not dispatch a second time.
    archive = await f.open();
    const replay = createLegacyDispatchPump({ archive, isReady: () => true,
        dispatch: async message => delivered.push(message) });
    await replay.trigger();
    assert.equal(delivered.length, 1);
    assert.equal((await archive.diagnostics()).legacyDispatchPending, 0);
    await replay.close();
});

test('v2 migration adds the outbox but leaves unreceipted historic rows untouched', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    await archive.ingestBatch([telegramInput(account.id)]);
    await archive.close();
    const oldVersion = new DatabaseSync(f.dbPath);
    oldVersion.exec(`DROP TRIGGER IF EXISTS messages_search_insert; DROP TRIGGER IF EXISTS messages_search_update;
        DROP TRIGGER IF EXISTS messages_search_delete; DROP TABLE IF EXISTS message_search;
        DROP TABLE attachments; DROP INDEX messages_summary_period; DROP TABLE outbound_intents; DROP INDEX messages_ai_context; DROP TABLE message_sequence;
        ALTER TABLE messages DROP COLUMN archive_seq; ALTER TABLE conversations DROP COLUMN context_through_seq;
        DROP TABLE control_operations; DROP TABLE control_import_entries; DROP TABLE control_import_snapshots;
        DROP TABLE control_policy_snapshots; DROP TABLE control_import_runs; DROP TABLE control_import_migrations;
        DROP TABLE control_policy; DROP TABLE control_authority;
        ALTER TABLE conversations DROP COLUMN control_review_reason;
        ALTER TABLE conversations DROP COLUMN profile_key;
        ALTER TABLE conversations DROP COLUMN handoff_reason;
        ALTER TABLE conversations DROP COLUMN taken_at;
        ALTER TABLE conversations DROP COLUMN control_status;
        ALTER TABLE conversations DROP COLUMN context_version;
        ALTER TABLE conversations DROP COLUMN control_version;
        ALTER TABLE conversations DROP COLUMN handled_inbound_seq;
        ALTER TABLE conversations DROP COLUMN resume_after_inbound_seq;
        ALTER TABLE conversations DROP COLUMN owner_id;
        ALTER TABLE conversations DROP COLUMN lifecycle;
        ALTER TABLE conversations DROP COLUMN automation_mode;
        ALTER TABLE conversations DROP COLUMN access_policy;
        ALTER TABLE events DROP COLUMN actor_id;
        DROP TABLE legacy_dispatch; DROP TABLE read_cursors; DROP INDEX messages_unread;
        DROP TABLE telegram_admin_inbox;
        DROP TABLE assistant_tool_invocations;
        PRAGMA user_version=2;`);
    oldVersion.close();

    archive = await f.open();
    assert.equal((await archive.ready).schemaVersion, 17);
    assert.equal((await archive.diagnostics()).messages, 1);
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
});

test('BUG-076 keeps only replay names and expires them after the 24-hour window', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const [created] = await archive.ingestBatch([telegramInput(account.id, { legacyDispatch: envelope() })]);
    const messageId = created.message.id;
    await archive.markLegacyDispatched({ messageId });
    await archive.close();

    const db = new DatabaseSync(f.dbPath);
    const stored = db.prepare(`SELECT d.payload,d.resume_metadata FROM legacy_dispatch d
        JOIN messages m ON m.id=d.message_id WHERE d.message_id=?`).get(messageId);
    assert.equal(stored.payload, '{}');
    assert.deepEqual(JSON.parse(stored.resume_metadata), { pushName: 'Persona', savedName: 'Nombre guardado' });
    assert.equal(stored.resume_metadata.includes('secret-phone'), false);
    assert.equal(stored.resume_metadata.includes('secret-lid'), false);
    db.prepare('UPDATE messages SET ingested_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z', messageId);
    db.close();

    archive = await f.open();
    assert.equal((await archive.ready).schemaVersion, 17);
    await archive.close();
    const expiredDb = new DatabaseSync(f.dbPath);
    assert.equal(expiredDb.prepare('SELECT resume_metadata FROM legacy_dispatch WHERE message_id=?').get(messageId).resume_metadata, null);
    expiredDb.close();
});

test('BUG-076 v15 migration backfills names only from recent pending route payloads', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const inputs = ['recent-pending','already-dispatched','expired-pending'].map((text, index) => telegramInput(account.id, {
        providerMessageId: String(41 + index), content: { type: 'text', text }, legacyDispatch: envelope(text)
    }));
    const [recent, dispatched, expired] = await archive.ingestBatch(inputs);
    await archive.markLegacyDispatched({ messageId: dispatched.message.id });
    await archive.close();

    const oldVersion = new DatabaseSync(f.dbPath);
    oldVersion.exec(`DROP INDEX legacy_dispatch_resume_metadata; ALTER TABLE legacy_dispatch DROP COLUMN resume_metadata;
        DROP INDEX outbound_intents_retention; ALTER TABLE outbound_intents DROP COLUMN redacted_at;
        ALTER TABLE outbound_intents DROP COLUMN payload_fingerprint;`);
    oldVersion.prepare('UPDATE messages SET ingested_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z', expired.message.id);
    oldVersion.exec('PRAGMA user_version=15;');
    oldVersion.close();

    archive = await f.open();
    assert.equal((await archive.ready).schemaVersion, 17);
    await archive.close();
    const migratedDb = new DatabaseSync(f.dbPath);
    const rows = migratedDb.prepare('SELECT message_id,resume_metadata FROM legacy_dispatch ORDER BY message_id').all();
    const metadataById = new Map(rows.map(row => [row.message_id, row.resume_metadata]));
    assert.deepEqual(JSON.parse(metadataById.get(recent.message.id)), { pushName: 'Persona', savedName: 'Nombre guardado' });
    assert.equal(metadataById.get(dispatched.message.id), null);
    assert.equal(metadataById.get(expired.message.id), null);
    migratedDb.close();
});

test('outbox waits for completed audio transcription and skips failed transcription', async t => {
    const { open, dbPath } = await fixture(t);
    const archive = await open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const message = telegramInput(account.id, { providerMessageId: '42',
        content: { type: 'audio', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' },
        legacyDispatch: { waitForTranscription: true, message: { ...envelope('').message, text: '', isAudio: true } } });
    const result = await archive.captureTelegramBatch({ accountId: account.id, updates: [{ updateId: '502', message }] });
    const messageId = result.results[0].result.message.id;
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
    await archive.updateTranscription({ messageId, expectedStatus: 'not_requested', status: 'pending' });
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
    await archive.updateTranscription({ messageId, expectedStatus: 'pending', status: 'completed', transcript: 'audio transcrito' });
    const [pending] = await archive.pendingLegacyDispatches();
    assert.equal(pending.message.text, 'audio transcrito');
    assert.equal(pending.message.transcript, 'audio transcrito');
    await archive.markLegacyDispatched({ messageId });

    const failedMessage = { ...message, providerMessageId: '43',
        legacyDispatch: { waitForTranscription: true, message: { ...envelope('').message, text: '', isAudio: true } } };
    const failedResult = await archive.captureTelegramBatch({ accountId: account.id, updates: [{ updateId: '503', message: failedMessage }] });
    const failedId = failedResult.results[0].result.message.id;
    await archive.updateTranscription({ messageId: failedId, expectedStatus: 'not_requested', status: 'pending' });
    await archive.updateTranscription({ messageId: failedId, expectedStatus: 'pending', status: 'failed' });
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
    assert.equal((await archive.diagnostics()).legacyDispatchWaiting, 0);
    await archive.close();
    const stored = new DatabaseSync(dbPath);
    assert.equal(stored.prepare('SELECT resume_metadata FROM legacy_dispatch WHERE message_id=?').get(failedId).resume_metadata, null);
    stored.close();
});

test('dispatch retries are bounded by durable ACK and channel readiness', async t => {
    const { open } = await fixture(t);
    const archive = await open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    await archive.ingestBatch([telegramInput(account.id, { legacyDispatch: envelope() })]);
    let ready = false, calls = 0;
    const pump = createLegacyDispatchPump({ archive, isReady: () => ready,
        dispatch: async () => { calls++; if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'TEMPORARY' }); } });
    await pump.trigger();
    assert.equal(calls, 0);
    ready = true;
    await pump.trigger();
    assert.equal(calls, 1);
    assert.equal((await archive.pendingLegacyDispatches())[0].attempts, 1);
    await pump.trigger();
    assert.equal(calls, 2);
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
    await pump.close();
});

test('responding messages stay pending until the debounce/AI branch confirms processing', async t => {
    const { open } = await fixture(t);
    const archive = await open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    await archive.ingestBatch([telegramInput(account.id, { legacyDispatch: envelope() })]);
    let calls = 0, complete;
    const pump = createLegacyDispatchPump({ archive, isReady: () => true, dispatch: async (_message, acknowledge) => {
        calls++;
        complete = acknowledge;
        return 'deferred';
    } });
    await pump.trigger();
    assert.equal(calls, 1);
    assert.equal((await archive.pendingLegacyDispatches()).length, 1);
    await pump.trigger();
    assert.equal(calls, 1);
    await complete();
    const deadline = Date.now() + 1000;
    while ((await archive.pendingLegacyDispatches()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
    await pump.close();
});
