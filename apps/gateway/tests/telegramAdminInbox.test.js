process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createArchive } = require('../services/conversations');
const { normalizeUpdates, createTelegramCapture } = require('../services/conversations/telegramCapture');
const { createTelegramAdminInboxPump } = require('../services/conversations/telegramAdminInbox');

const UPDATE_ID = '9007199254740993';
const adminUpdate = (updateId = UPDATE_ID, text = '/permitir 700') => ({
    update_id: updateId,
    message: { message_id: '9007199254740995', date: 1792368000, text,
        chat: { id: '-9007199254740997', type: 'private' },
        from: { id: '7001', first_name: 'Admin', username: 'operator' } }
});

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-tg-admin-inbox-'));
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

async function captureAdmin(archive, accountId, update = adminUpdate()) {
    const observations = normalizeUpdates([update], accountId, '-9007199254740997');
    return createTelegramCapture(archive).commitBatch(accountId, observations);
}

test('BUG-046: admin update and cursor commit atomically; restart before dispatch delivers once', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const committed = await captureAdmin(archive, account.id);
    assert.equal(committed.lastUpdateId, UPDATE_ID);
    assert.equal(committed.results[0].status, 'admin_queued');
    assert.equal((await archive.telegramCursor(account.id)), UPDATE_ID);
    assert.equal((await archive.diagnostics()).messages, 0);
    assert.equal((await archive.pendingTelegramAdminInbox()).length, 1);
    assert.equal((await captureAdmin(archive, account.id)).results[0].status, 'stale');
    assert.equal((await archive.pendingTelegramAdminInbox()).length, 1);

    // Crash after capture but before claim: the committed command is replayable.
    await archive.close();
    archive = await f.open();
    let mutations = 0;
    let ready = false;
    const waitingPump = createTelegramAdminInboxPump({ archive, isReady: () => ready,
        dispatch: async () => { mutations += 1; } });
    await waitingPump.trigger();
    assert.equal(mutations, 0);
    ready = true;
    await waitingPump.trigger();
    assert.equal(mutations, 1);
    assert.equal((await archive.pendingTelegramAdminInbox()).length, 0);
    assert.deepEqual((await archive.telegramAdminInboxStatus()), { pending: 0, processing: 0, completed: 1, uncertain: 0 });
    await waitingPump.close();
    await archive.close();

    archive = await f.open();
    const laterPump = createTelegramAdminInboxPump({ archive, isReady: () => true,
        dispatch: async () => { mutations += 1; } });
    await laterPump.trigger();
    assert.equal(mutations, 1);
    await laterPump.close();
});

test('BUG-046: restart after effect marks the claim uncertain and never repeats its mutation', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    await captureAdmin(archive, account.id, adminUpdate('9007199254740994', '/permitir 701'));
    let mutations = 0;
    let releaseDispatch;
    let dispatchStarted;
    const started = new Promise(resolve => { dispatchStarted = resolve; });
    const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
    const interruptedPump = createTelegramAdminInboxPump({ archive, isReady: () => true,
        dispatch: async message => {
            assert.equal(message.text, '/permitir 701');
            mutations += 1;
            dispatchStarted();
            await dispatchGate;
        } });
    const running = interruptedPump.trigger();
    await started;
    assert.equal((await archive.telegramAdminInboxStatus()).processing, 1);

    // The mutation happened, but the result receipt has not been committed.
    // Closing the archive simulates process loss in that exact window.
    await archive.close();
    releaseDispatch();
    await running;
    await interruptedPump.close();

    archive = await f.open();
    assert.equal((await archive.pendingTelegramAdminInbox()).length, 0);
    assert.deepEqual((await archive.telegramAdminInboxStatus()), { pending: 0, processing: 0, completed: 0, uncertain: 1 });
    const restartedPump = createTelegramAdminInboxPump({ archive, isReady: () => true,
        dispatch: async () => { mutations += 1; } });
    await restartedPump.trigger();
    assert.equal(mutations, 1);
    assert.equal((await archive.telegramAdminInboxStatus()).uncertain, 1);
    await restartedPump.close();
});

test('BUG-046: same update identity cannot be rebound to different admin content', async t => {
    const f = await fixture(t);
    let archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    await captureAdmin(archive, account.id);
    // Force the cursor behind the test row to exercise the durable uniqueness guard.
    await archive.close();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(f.dbPath);
    db.prepare('DELETE FROM telegram_cursors WHERE account_id=?').run(account.id);
    db.close();
    archive = await f.open();
    await assert.rejects(captureAdmin(archive, account.id, adminUpdate(UPDATE_ID, '/permitir 999')),
        { code: 'TELEGRAM_ADMIN_IDENTITY_CONFLICT' });
    assert.equal(await archive.telegramCursor(account.id), null);
    assert.equal((await archive.pendingTelegramAdminInbox()).length, 1);
});

test('BUG-046: a later invalid update rolls back the earlier admin inbox row and cursor', async t => {
    const f = await fixture(t);
    const archive = await f.open();
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const admin = normalizeUpdates([adminUpdate('901')], account.id, '-9007199254740997')[0];
    const invalidCustomerMessage = { identity: { accountId: 'wrong-account', channel: 'telegram',
        kind: 'telegram_chat_id', exactValue: '700' }, providerMessageId: '1', source: 'live',
    direction: 'inbound', authorKind: 'customer', occurredAt: '2026-10-22T00:00:00.000Z',
    content: { type: 'text', text: 'invalid account' } };
    await assert.rejects(archive.captureTelegramBatch({ accountId: account.id, updates: [
        { updateId: admin.updateId, message: null, adminInbox: admin.adminInbox },
        { updateId: '902', message: invalidCustomerMessage }
    ] }), { code: 'INVALID_TELEGRAM_CAPTURE' });
    assert.equal(await archive.telegramCursor(account.id), null);
    assert.equal((await archive.pendingTelegramAdminInbox()).length, 0);
    assert.equal((await archive.diagnostics()).messages, 0);
    assert.equal((await archive.snapshot()).seq, '0');
});

test('admin text captions use the inbox while audio still follows its existing STT path', () => {
    const caption = normalizeUpdates([{ update_id: '903', message: { message_id: '904', date: 1792368000,
        caption: '/estado', photo: [{ file_id: 'fixture-photo' }], chat: { id: '-9007199254740997', type: 'private' } } }],
    'fixture-account', '-9007199254740997')[0];
    assert.equal(caption.adminInbox.message.text, '/estado');
    assert.equal(caption.adminInbox.message.raw, undefined);

    const audio = normalizeUpdates([{ update_id: '905', message: { message_id: '906', date: 1792368000,
        caption: '/estado', voice: { file_id: 'fixture-voice' },
        chat: { id: '-9007199254740997', type: 'private' } } }], 'fixture-account', '-9007199254740997',
    { includeAudio: true })[0];
    assert.equal(audio.adminInbox, undefined);
    assert.equal(audio.legacy.audio, true);
});
