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
    metadata: { pushName: 'Persona', savedName: null, phoneNumber: null, lid: '-77',
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
    oldVersion.exec('DROP TABLE legacy_dispatch; PRAGMA user_version=2;');
    oldVersion.close();

    archive = await f.open();
    assert.equal((await archive.ready).schemaVersion, 3);
    assert.equal((await archive.diagnostics()).messages, 1);
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
});

test('outbox waits for completed audio transcription and skips failed transcription', async t => {
    const { open } = await fixture(t);
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
