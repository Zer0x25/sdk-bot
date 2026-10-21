process.env.SDK_BOT_TEST = '1';
process.env.AUDIO_STT_ENABLED = '0';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createArchive } = require('../services/conversations');
const schema = require('../services/conversations/schema');
const { parseTelegramJson } = require('../services/telegramHttp');
const { normalizeUpdates, normalizeSentMessage } = require('../services/conversations/telegramCapture');
const TelegramAdapter = require('../adapters/telegramAdapter');
const { saveSettingsDB } = require('../services/db');
const { registerSentMessage } = require('../config');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths(); after(() => temporary.restore());

const CHAT_BIG = '-9007199254740993';
const UPDATE_BIG = '9007199254740993';
const MESSAGE_BIG = '9007199254740995';
const messageUpdate = (updateId, chatId, messageId, text = 'hola', type = 'private') => ({
    update_id: updateId,
    message: { message_id: messageId, date: 1792368000, text,
        chat: { id: chatId, type }, from: { id: 7, first_name: 'Synthetic' } }
});

async function until(predicate, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(predicate(), 'condition completed within deadline');
}

async function archiveFixture(t, dbPath) {
    const dir = dbPath ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-telegram-archive-'));
    const target = dbPath || path.join(dir, 'archive.db');
    const archive = createArchive({ path: target });
    await archive.ready;
    t.after(async () => {
        await archive.close();
        if (dir) await fs.rm(dir, { recursive: true, force: true });
    });
    return { archive, dbPath: target };
}

function transport() {
    const calls = [];
    function getUpdates(input) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const call = { ...input, finish(value = { ok: true, result: [] }, error) {
                if (settled) return;
                settled = true;
                input.signal.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(value);
            } };
            const abort = () => call.finish(undefined, Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
            input.signal.addEventListener('abort', abort, { once: true });
            calls.push(call);
        });
    }
    return { calls, getUpdates };
}

async function runAdapter(t, archive, { token = 'token_fixture_A', botId = 42, network = transport(), sendHttpRequest, getMe } = {}) {
    saveSettingsDB({ telegramToken: token, telegramChatId: '555', globalMode: 'ignored_all' });
    const adapter = new TelegramAdapter({ archive, getMe: getMe || (async () => ({ ok: true,
        result: { id: botId, is_bot: true } })), getUpdates: network.getUpdates,
    updateMenu: async () => {}, retryMs: 10, sendHttpRequest });
    const seen = [];
    adapter.on('message', msg => seen.push(msg));
    await adapter.connect();
    await until(() => network.calls.length === 1 || adapter.status === 'standby');
    t.after(async () => {
        const closing = adapter.disconnect();
        for (const call of network.calls) call.finish();
        await closing;
    });
    return { adapter, seen, network };
}

function sendTransport(body, statusCode = 200) {
    const calls = [];
    let responseBody = body, responseStatus = statusCode, splitByteAt = 0;
    return { calls, setResponse(nextBody, nextStatus = 200, splitAt = 0) {
        responseBody = nextBody; responseStatus = nextStatus; splitByteAt = splitAt;
    }, request(options, callback) {
        let payload = '';
        const req = new EventEmitter();
        req.write = chunk => { payload += chunk; };
        req.end = chunk => {
            if (chunk) payload += chunk;
            calls.push({ options, payload: JSON.parse(payload) });
            const res = new EventEmitter(); res.statusCode = responseStatus; callback(res);
            process.nextTick(() => {
                const bytes = Buffer.from(responseBody);
                if (splitByteAt > 0) {
                    res.emit('data', bytes.subarray(0, splitByteAt)); res.emit('data', bytes.subarray(splitByteAt));
                } else res.emit('data', bytes);
                res.emit('end'); req.emit('close');
            });
        };
        return req;
    } };
}

function controlledSendTransport() {
    const calls = [];
    return { calls, request(options, callback) {
        let payload = '';
        const req = new EventEmitter();
        req.write = chunk => { payload += chunk; };
        req.end = chunk => {
            if (chunk) payload += chunk;
            const call = { options, payload: JSON.parse(payload), respond(statusCode, body) {
                const res = new EventEmitter(); res.statusCode = statusCode; callback(res);
                process.nextTick(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
            } };
            calls.push(call);
            // A broken mutable-token retry must settle too, so the regression fails promptly.
            if (calls.length > 1) process.nextTick(() => call.respond(200, '{"ok":false,"error_code":500}'));
        };
        return req;
    } };
}

test('send result normalization requires the exact private chat and excludes admin/group destinations', () => {
    const result = { message_id: MESSAGE_BIG, date: 1792368000, text: 'sent', chat: { id: '700', type: 'private' } };
    assert.deepEqual(normalizeSentMessage(result, 'account', '700', '555'), {
        identity: { accountId: 'account', channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' },
        providerMessageId: MESSAGE_BIG, source: 'live', direction: 'outbound', authorKind: 'external_self',
        occurredAt: '2026-10-19T00:00:00.000Z', content: { type: 'text', text: 'sent' }
    });
    assert.equal(normalizeSentMessage(result, 'account', '555', '555'), null);
    assert.equal(normalizeSentMessage({ ...result, chat: { id: '700', type: 'supergroup' } }, 'account', '700'), null);
    assert.equal(normalizeSentMessage(result, 'account', '701'), null);
});

test('accepted Telegram Bot API sends enter the archive; HTTP 200 ok:false is rejected without a message', async t => {
    const { archive } = await archiveFixture(t);
    const acceptedBody = `{"ok":true,"result":{"message_id":${MESSAGE_BIG},"date":1792368000,"text":"respuesta 😀","chat":{"id":700,"type":"private"}}}`;
    const sender = sendTransport(acceptedBody);
    sender.setResponse(acceptedBody, 200, Buffer.from(acceptedBody).indexOf(Buffer.from('😀')) + 2);
    const { adapter } = await runAdapter(t, archive, { sendHttpRequest: sender.request });
    const accepted = await adapter.sendMessage('telegram:700', 'respuesta 😀');
    assert.equal(accepted.ok, true);
    const identity = await archive.resolve({ accountId: adapter.accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' });
    const [stored] = await archive.messages({ conversationId: identity.conversation_id });
    assert.equal(stored.direction, 'outbound'); assert.equal(stored.authorKind, 'external_self');
    assert.equal(stored.providerMessageId, MESSAGE_BIG); assert.equal(stored.content.text, 'respuesta 😀');

    sender.setResponse('{"ok":false,"error_code":500}');
    await assert.rejects(adapter.sendMessage('telegram:701', 'no enviado'), { code: 'TG_SEND_REJECTED' });
    assert.equal((await archive.diagnostics()).messages, 1);

    const previousCalls = sender.calls.length;
    sender.setResponse("Bad Request: can't parse entities", 400);
    await assert.rejects(adapter.sendMessage('telegram:702', 'markdown'), { code: 'TG_SEND_RESPONSE_INVALID' });
    assert.equal(sender.calls.length - previousCalls, 2);
    assert.equal(sender.calls[previousCalls].payload.parse_mode, 'Markdown');
    assert.equal('parse_mode' in sender.calls[previousCalls + 1].payload, false);
});

test('BUG-043: a Markdown retry is blocked after Telegram rotates to another account', async t => {
    const { archive } = await archiveFixture(t);
    const sender = controlledSendTransport();
    const network = transport();
    const { adapter } = await runAdapter(t, archive, { network, sendHttpRequest: sender.request,
        getMe: async ({ token }) => ({ ok: true, result: { id: token === 'token_fixture_A' ? 42 : 43, is_bot: true } }) });
    const originalAccountId = adapter.accountId;
    const sending = adapter.sendMessage('telegram:700', 'texto para cuenta A');
    await until(() => sender.calls.length === 1);
    assert.equal(sender.calls[0].options.path, '/bottoken_fixture_A/sendMessage');

    saveSettingsDB({ telegramToken: 'token_fixture_B', telegramChatId: '555', globalMode: 'ignored_all' });
    await adapter.connect();
    await until(() => network.calls.length === 2);
    assert.notEqual(adapter.accountId, originalAccountId);

    sender.calls[0].respond(400, "Bad Request: can't parse entities");
    await assert.rejects(sending, { code: 'TG_CONNECTION_CHANGED' });
    assert.equal(sender.calls.length, 1, 'the retry must not use the replacement bot token');
});

test('BUG-043: an accepted send is archived under the account captured at dispatch', async t => {
    const { archive } = await archiveFixture(t);
    const sender = controlledSendTransport();
    const network = transport();
    const { adapter } = await runAdapter(t, archive, { network, sendHttpRequest: sender.request,
        getMe: async ({ token }) => ({ ok: true, result: { id: token === 'token_fixture_A' ? 42 : 43, is_bot: true } }) });
    const originalAccountId = adapter.accountId;
    const sending = adapter.sendMessage('telegram:700', 'texto aceptado por A');
    await until(() => sender.calls.length === 1);

    saveSettingsDB({ telegramToken: 'token_fixture_B', telegramChatId: '700', globalMode: 'ignored_all' });
    await adapter.connect();
    await until(() => network.calls.length === 2);
    const replacementAccountId = adapter.accountId;
    assert.notEqual(replacementAccountId, originalAccountId);

    sender.calls[0].respond(200, JSON.stringify({ ok: true, result: { message_id: 77, date: 1792368000,
        text: 'texto aceptado por A', chat: { id: 700, type: 'private' } } }));
    await sending;
    const identity = await archive.resolve({ accountId: originalAccountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' });
    const messages = await archive.messages({ conversationId: identity.conversation_id });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content.text, 'texto aceptado por A');
    const replacementIdentity = await archive.resolve({ accountId: replacementAccountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' });
    assert.equal((await archive.messages({ conversationId: replacementIdentity.conversation_id })).length, 0);
});

test('F2C.2 migrates v1 archives and persists Telegram cursor per verified bot through reopen', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-telegram-migrate-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'archive.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA foreign_keys=ON;'); legacy.exec(schema);
    legacy.exec(`ALTER TABLE conversations DROP COLUMN handoff_reason;
        ALTER TABLE conversations DROP COLUMN taken_at;
        ALTER TABLE conversations DROP COLUMN control_status;
        ALTER TABLE conversations DROP COLUMN context_version;
        ALTER TABLE conversations DROP COLUMN control_version;
        ALTER TABLE conversations DROP COLUMN owner_id;
        ALTER TABLE conversations DROP COLUMN lifecycle;
        ALTER TABLE conversations DROP COLUMN automation_mode;
        ALTER TABLE conversations DROP COLUMN access_policy;
        ALTER TABLE events DROP COLUMN actor_id;
        DROP TABLE legacy_dispatch; DROP TABLE read_cursors; DROP TABLE telegram_cursors;
        DROP INDEX messages_unread; PRAGMA user_version=1;`);
    legacy.prepare('INSERT INTO archive_meta VALUES(1,?,?)').run(randomUUID(), '0');
    legacy.close();
    const { archive } = await archiveFixture(t, dbPath);
    assert.equal((await archive.ready).schemaVersion, 10);
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    assert.equal(await archive.telegramCursor(account.id), null);
    const durableMessage = { identity: { accountId: account.id, channel: 'telegram', kind: 'telegram_chat_id', exactValue: CHAT_BIG },
        providerMessageId: MESSAGE_BIG, source: 'live', direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-20T00:00:00.000Z', content: { type: 'text', text: 'durable' } };
    const captured = await archive.captureTelegramBatch({ accountId: account.id, updates: [{ updateId: UPDATE_BIG,
        message: durableMessage }] });
    assert.equal(captured.lastUpdateId, UPDATE_BIG);
    assert.equal(captured.results[0].result.status, 'created');
    assert.equal((await archive.captureTelegramBatch({ accountId: account.id, updates: [{ updateId: UPDATE_BIG, message: durableMessage }] })).results[0].status, 'stale');
    assert.equal((await archive.telegramCursor(account.id)), UPDATE_BIG);
    await archive.close();
    const reopened = createArchive({ path: dbPath }); t.after(() => reopened.close());
    await reopened.ready;
    assert.equal(await reopened.telegramCursor(account.id), UPDATE_BIG);
    assert.equal((await reopened.diagnostics()).messages, 1);
    assert.equal((await reopened.captureTelegramBatch({ accountId: account.id, updates: [{ updateId: UPDATE_BIG, message: durableMessage }] })).results[0].status, 'stale');
    assert.equal((await reopened.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:43' })).id === account.id, false);
    const network = transport();
    saveSettingsDB({ telegramToken: 'rotated_fixture_token', telegramChatId: '555' });
    const adapter = new TelegramAdapter({ archive: reopened, getMe: async () => ({ ok: true,
        result: { id: 42, is_bot: true } }), getUpdates: network.getUpdates, updateMenu: async () => {} });
    t.after(async () => { const stopping = adapter.disconnect(); for (const call of network.calls) call.finish(); await stopping; });
    await adapter.connect(); await until(() => network.calls.length === 1);
    assert.equal(network.calls[0].offset, '9007199254740994');
    const stopping = adapter.disconnect(); for (const call of network.calls) call.finish(); await stopping;
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
});

test('batch rollback leaves messages, events and cursor unchanged when one captured update is invalid', async t => {
    const { archive } = await archiveFixture(t);
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' });
    const valid = { identity: { accountId: account.id, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' },
        providerMessageId: '1', source: 'live', direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-20T00:00:00.000Z', content: { type: 'text', text: 'first' } };
    const invalid = { ...valid, identity: { ...valid.identity, exactValue: '701' }, providerMessageId: '2', content: { type: 'not-a-message' } };
    await assert.rejects(archive.captureTelegramBatch({ accountId: account.id, updates: [
        { updateId: '1', message: valid }, { updateId: '2', message: invalid }
    ] }));
    assert.equal(await archive.telegramCursor(account.id), null);
    assert.equal((await archive.diagnostics()).messages, 0);
    assert.equal((await archive.snapshot()).seq, '0');
});

test('lossless Bot API integer parsing keeps unsafe IDs as decimal strings and malformed batches cannot advance', async t => {
    const decoded = parseTelegramJson(`{"update_id":${UPDATE_BIG},"message":{"message_id":${MESSAGE_BIG},"date":1792368000,"text":"lossless","chat":{"id":${CHAT_BIG},"type":"private"}}}`);
    assert.equal(decoded.update_id, UPDATE_BIG); assert.equal(decoded.message.message_id, MESSAGE_BIG);
    assert.equal(decoded.message.chat.id, CHAT_BIG); assert.equal(decoded.message.date, 1792368000);
    const { archive } = await archiveFixture(t);
    const { adapter, network, seen } = await runAdapter(t, archive);
    network.calls[0].finish({ ok: true, result: [decoded] });
    await until(() => network.calls.length === 2);
    assert.equal(network.calls[1].offset, '9007199254740994');
    assert.equal(adapter.lastUpdateId, UPDATE_BIG);
    assert.equal((await archive.diagnostics()).messages, 1);
    assert.equal((await archive.telegramCursor(adapter.accountId)), UPDATE_BIG);
    assert.equal(seen[0].rawId, CHAT_BIG);
    assert.equal((await archive.messages({ conversationId: (await archive.resolve({ accountId: adapter.accountId,
        channel: 'telegram', kind: 'telegram_chat_id', exactValue: CHAT_BIG })).conversation_id }))[0].providerMessageId, MESSAGE_BIG);

    network.calls[1].finish({ ok: true, result: [{ update_id: Number.MAX_SAFE_INTEGER + 1,
        message: { message_id: 9, date: 1792368000, text: 'bad', chat: { id: 9, type: 'private' } } }] });
    await until(() => adapter.status === 'standby');
    assert.equal(network.calls.length, 2); assert.equal(seen.length, 1);
    assert.equal(await archive.telegramCursor(adapter.accountId), UPDATE_BIG);
});

test('updates are archived before legacy delivery; message IDs are scoped by exact chat and account, excluded updates still advance', async t => {
    const { archive } = await archiveFixture(t);
    const { adapter, network, seen } = await runAdapter(t, archive);
    const accountId = adapter.accountId;
    registerSentMessage({ message_id: 7 }); // A global ID from another channel must not filter Telegram input.
    const observedCursors = [];
    adapter.on('message', () => observedCursors.push(archive.telegramCursor(accountId)));
    network.calls[0].finish({ ok: true, result: [
        messageUpdate(1, '101', 7, 'one'), messageUpdate(2, '202', 7, 'two'),
        messageUpdate(3, '101', 7, 'one'), messageUpdate(4, '-10088', 8, 'group', 'supergroup'),
        { update_id: 5, callback_query: { id: 'fixture' } }, messageUpdate(6, '555', 9, '/estado')
    ] });
    await until(() => network.calls.length === 2);
    assert.equal(network.calls[1].offset, '7');
    assert.equal(await archive.telegramCursor(accountId), '6');
    const diagnostics = await archive.diagnostics();
    assert.equal(diagnostics.messages, 2); assert.equal(diagnostics.events, 2);
    assert.equal(seen.length, 3);
    assert.equal(seen[0].remoteId, 'telegram:101'); assert.equal(seen[1].remoteId, 'telegram:202');
    assert.equal(seen[2].metadata.isAdminChannel, true);
    assert.ok((await Promise.all(observedCursors)).every(cursor => cursor === '6'));
    network.calls[1].finish({ ok: true, result: [messageUpdate(6, '555', 9, '/estado')] });
    await until(() => network.calls.length === 3);
    assert.equal(seen.length, 3, 'a stale admin update must not run its legacy command twice');
    const keys = await Promise.all(['101','202'].map(async exactValue => {
        const identity = await archive.resolve({ accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue });
        return (await archive.messages({ conversationId: identity.conversation_id }))[0].providerMessageId;
    }));
    assert.deepEqual(keys, ['7','7']);
});

test('same verified bot keeps its durable offset after token rotation; a different bot starts a separate cursor', async t => {
    const { archive } = await archiveFixture(t);
    const network = transport();
    saveSettingsDB({ telegramToken: 'token_A', telegramChatId: '555' });
    const adapter = new TelegramAdapter({ archive, getMe: async ({ token }) => ({ ok: true,
        result: { id: token === 'token_C' ? 43 : 42, is_bot: true } }), getUpdates: network.getUpdates, updateMenu: async () => {} });
    await adapter.connect(); await until(() => network.calls.length === 1);
    network.calls[0].finish({ ok: true, result: [messageUpdate(55, '800', 2, 'saved')] });
    await until(() => network.calls.length === 2);
    saveSettingsDB({ telegramToken: 'token_B' }); await adapter.connect();
    await until(() => network.calls.length === 3);
    assert.equal(network.calls[2].offset, '56');
    saveSettingsDB({ telegramToken: 'token_C' }); await adapter.connect();
    await until(() => network.calls.length === 4);
    assert.equal(network.calls[3].offset, '0');
    assert.notEqual(adapter.accountId, await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' }).then(a => a.id));
    const accounts = [await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:42' }),
        await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:43' })];
    assert.equal(accounts[0].provider_key, 'telegram_bot:42');
    assert.equal(accounts[0].provider_key.includes('token_'), false);
    assert.notEqual(accounts[0].id, accounts[1].id);
    assert.equal((await archive.diagnostics()).messages, 1);
    await adapter.disconnect();
});

test('a token without a verified Bot API identity cannot start polling', async t => {
    const { archive } = await archiveFixture(t);
    const network = transport();
    saveSettingsDB({ telegramToken: 'token_not_a_bot', telegramChatId: '555' });
    const adapter = new TelegramAdapter({ archive, getMe: async () => ({ ok: true,
        result: { id: 42, is_bot: false } }), getUpdates: network.getUpdates, updateMenu: async () => {} });
    await adapter.connect();
    assert.equal(adapter.status, 'standby'); assert.equal(adapter.pollerActive, false); assert.equal(network.calls.length, 0);
    await adapter.disconnect();
});

test('Telegram audio is archived first, bounded during download, and a skipped transcript is durable', async t => {
    const originalFetch = global.fetch;
    const oldAudio = process.env.AUDIO_STT_ENABLED, oldLimit = process.env.STT_MAX_UPLOAD_BYTES;
    t.after(() => {
        global.fetch = originalFetch;
        if (oldAudio === undefined) delete process.env.AUDIO_STT_ENABLED; else process.env.AUDIO_STT_ENABLED = oldAudio;
        if (oldLimit === undefined) delete process.env.STT_MAX_UPLOAD_BYTES; else process.env.STT_MAX_UPLOAD_BYTES = oldLimit;
    });
    process.env.AUDIO_STT_ENABLED = '1'; process.env.STT_MAX_UPLOAD_BYTES = '4';
    let transcribed = 0;
    global.fetch = async url => String(url).includes('getFile')
        ? { ok: true, json: async () => ({ ok: true, result: { file_path: 'fixture.oga' } }) }
        : { ok: true, headers: { get: () => null }, body: new globalThis.ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array([1,2,3,4,5])); controller.close();
        } }) };
    const { archive } = await archiveFixture(t);
    const { adapter, network, seen } = await runAdapter(t, archive);
    adapter.sendPresenceUpdate = async () => {};
    adapter.transcribe = async () => { transcribed++; return 'should not run'; };
    network.calls[0].finish({ ok: true, result: [{ update_id: 1, message: { message_id: 8, date: 1792368000,
        chat: { id: '700', type: 'private' }, from: { id: 7, first_name: 'Synthetic' }, voice: { file_id: 'fixture', duration: 1 } } }] });
    await until(() => network.calls.length === 2);
    const identity = await archive.resolve({ accountId: adapter.accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' });
    const [audio] = await archive.messages({ conversationId: identity.conversation_id });
    assert.equal(audio.content.type, 'audio'); assert.equal(audio.content.transcriptionStatus, 'failed');
    assert.equal(await archive.telegramCursor(adapter.accountId), '1');
    assert.equal(transcribed, 0); assert.equal(seen.length, 0);
});

test('updates and bytes are bounded before the durable cursor API is called', async () => {
    const accountId = randomUUID();
    assert.throws(() => normalizeUpdates(Array.from({ length: 101 }, (_, i) => ({ update_id: i })), accountId), { code: 'TG_BATCH_INVALID' });
    assert.throws(() => normalizeUpdates([{ update_id: 1, message: { message_id: 1, date: 1,
        chat: { id: 1, type: 'private' }, text: 'x'.repeat(33 * 1024 * 1024) } }], accountId), { code: 'TG_BATCH_TOO_LARGE' });
});
