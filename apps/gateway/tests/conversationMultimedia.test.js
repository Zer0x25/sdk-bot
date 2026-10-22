process.env.SDK_BOT_TEST = '1';
process.env.AUDIO_STT_ENABLED = '0';
const { test, after } = require('node:test');
const FetchResponse = globalThis.Response;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths();
after(() => temporary.restore());
const { createArchive } = require('../services/conversations');
const { createAttachmentStore } = require('../services/conversations/attachments');
const { normalizeUpdates, createTelegramCapture } = require('../services/conversations/telegramCapture');
const { createWhatsappCapture, normalize, socketIdentity } = require('../services/conversations/whatsappCapture');
const WhatsappAdapter = require('../adapters/whatsappAdapter');
const TelegramAdapter = require('../adapters/telegramAdapter');
const { saveSettingsDB } = require('../services/db');
const { WAMessageStubType } = require('@whiskeysockets/baileys');

const own = { id: '100:7@s.whatsapp.net', lid: '900:7@lid' };
const waSession = socketIdentity(own);
const waIdentity = (accountId, exactValue = '200@s.whatsapp.net') => ({ accountId,
    channel: 'whatsapp', kind: 'whatsapp_jid', exactValue });
const waMessage = (id, message, extra = {}) => ({ key: { id, remoteJid: '200@s.whatsapp.net', fromMe: false },
    messageTimestamp: '1792368000', message, ...extra });

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-multimedia-'));
    const archive = createArchive({ path: path.join(directory, 'archive.db') });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'multimedia-fixture' });
    const store = createAttachmentStore({ archive, directory: path.join(directory, 'attachments') });
    await store.init();
    t.after(async () => {
        await store.close();
        await archive.close();
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { archive, account, store, directory };
}

async function findMessage(archive, identity, providerMessageId) {
    const resolved = await archive.resolve(identity);
    const messages = await archive.messages({ conversationId: resolved.conversation_id });
    return messages.find(message => message.providerMessageId === providerMessageId) || null;
}

async function until(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('condition completed within deadline');
}

test('WhatsApp archive resolves replies, keeps bounded orphan quote previews, edits, and redacts revocations', async t => {
    const { archive, account, store, directory } = await fixture(t);
    const targetObservation = normalize(waMessage('wa-target', { conversation: 'mensaje citado' }), waSession, 'live');
    const replyObservation = normalize(waMessage('wa-reply', { extendedTextMessage: { text: 'respuesta', contextInfo: {
        stanzaId: 'wa-target', quotedMessage: { conversation: 'mensaje citado' }
    } } }), waSession, 'live');
    const orphanObservation = normalize(waMessage('wa-orphan', { extendedTextMessage: { text: 'otra respuesta', contextInfo: {
        stanzaId: 'already-purged', quotedMessage: { conversation: 'cita conservada' }
    } } }), waSession, 'live');
    const capture = createWhatsappCapture(archive);
    const target = await capture.enqueue(waMessage('wa-target', { conversation: 'mensaje citado' }), waSession, 'live');
    const reply = await capture.enqueue(waMessage('wa-reply', { extendedTextMessage: { text: 'respuesta', contextInfo: {
        stanzaId: 'wa-target', quotedMessage: { conversation: 'mensaje citado' }
    } } }), waSession, 'live');
    const orphan = await capture.enqueue(waMessage('wa-orphan', { extendedTextMessage: { text: 'otra respuesta', contextInfo: {
        stanzaId: 'already-purged', quotedMessage: { conversation: 'cita conservada' }
    } } }), waSession, 'live');
    await capture.close();
    assert.equal(targetObservation.content.text, 'mensaje citado');
    assert.equal(replyObservation.replyToProviderMessageId, 'wa-target');
    assert.equal(reply.result.message.replyToId, target.result.message.id);
    assert.equal(orphanObservation.replyPreview, 'cita conservada');
    assert.equal(orphan.result.message.replyToId, null);
    assert.equal(orphan.result.message.replyPreview, 'cita conservada');

    const image = await archive.ingestBatch([{ identity: waIdentity(account.id), providerMessageId: 'wa-image', source: 'live',
        direction: 'inbound', authorKind: 'customer', occurredAt: '2026-10-22T00:00:00.000Z',
        content: { type: 'image', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' } }]);
    const saved = await store.store({ messageId: image[0].message.id, source: Buffer.from('private image bytes'),
        fileName: 'captura.png', contentType: 'image/png' });
    const beforeEdit = await archive.conversation(image[0].message.conversationId);
    const editedAt = '2026-10-22T01:00:00.000Z';
    const edited = await archive.editProviderMessage({ identity: waIdentity(account.id), providerMessageId: 'wa-image',
        content: { type: 'image', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested', caption: 'caption editada' },
        editedAt });
    assert.equal(edited.status, 'updated');
    assert.equal(edited.event.type, 'message.updated');
    assert.equal(edited.message.content.attachmentId, saved.attachment.id);
    assert.equal(edited.message.content.availability, 'available');
    assert.equal((await archive.conversation(image[0].message.conversationId)).context_version,
        String(BigInt(beforeEdit.context_version) + 1n));
    assert.equal((await archive.editProviderMessage({ identity: waIdentity(account.id), providerMessageId: 'wa-image',
        content: { type: 'image', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested', caption: 'antigua' },
        editedAt: '2026-10-22T00:59:59.000Z' })).status, 'unchanged');

    const deletion = await archive.deleteProviderMessage({ identity: waIdentity(account.id), providerMessageId: 'wa-image',
        deletedAt: '2026-10-22T02:00:00.000Z' });
    assert.equal(deletion.status, 'deleted');
    assert.equal(deletion.message.deletedAt, '2026-10-22T02:00:00.000Z');
    assert.equal(deletion.message.content.type, 'unsupported');
    await store.sweepExpired();
    assert.equal(await archive.attachment({ id: saved.attachment.id }), null);
    await assert.rejects(fs.stat(path.join(directory, 'attachments', `${saved.attachment.id}.blob`)), { code: 'ENOENT' });
    assert.equal((await archive.deleteProviderMessage({ identity: waIdentity(account.id), providerMessageId: 'wa-image' })).status,
        'unchanged');
    assert.equal((await archive.editProviderMessage({ identity: waIdentity(account.id), providerMessageId: 'wa-image',
        content: { type: 'image', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested', caption: 'resurrección' },
        editedAt: '2026-10-22T03:00:00.000Z' })).status, 'deleted');
    const persisted = await findMessage(archive, waIdentity(account.id), 'wa-image');
    assert.equal(persisted.deletedAt, deletion.message.deletedAt);
    assert.equal(persisted.content.caption, undefined);

    const [plain] = await archive.ingestBatch([{ identity: waIdentity(account.id), providerMessageId: 'wa-text-to-image',
        source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt: '2026-10-22T00:00:00.000Z',
        content: { type: 'text', text: 'antes era texto' } }]);
    const transformed = await archive.editProviderMessage({ identity: waIdentity(account.id), providerMessageId: 'wa-text-to-image',
        content: { type: 'image', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' },
        editedAt: '2026-10-22T03:00:00.000Z' });
    assert.equal(transformed.message.id, plain.message.id);
    assert.equal(transformed.captureAttachment, true);
});

test('WhatsApp adapter archives a live image, provider edits, and revoke events without recording receipts', async t => {
    const { archive, store } = await fixture(t);
    const socket = { user: own, ev: new EventEmitter(), end() {}, async sendPresenceUpdate() {} };
    let downloadCount = 0;
    const adapter = new WhatsappAdapter({ archive, attachmentStore: store,
        loadAuth: async () => ({ state: { creds: { registered: true } }, saveCreds: async () => {} }),
        makeSocket: () => socket, download: async () => Buffer.from(`image-${++downloadCount}`) });
    adapter.getKnownAdminPhone = () => '';
    adapter.setKnownAdminPhone = () => {};
    t.after(async () => { await adapter.disconnect(); });
    await adapter.connect();
    const identity = waIdentity((await archive.registerAccount({ channel: 'whatsapp', providerKey: waSession.providerKey })).id);
    const raw = waMessage('wa-live-media', { imageMessage: { mimetype: 'image/png', fileName: 'foto.png' } });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [raw] });
    let stored = await until(async () => {
        const message = await findMessage(archive, identity, 'wa-live-media');
        return message?.content.availability === 'available' ? message : null;
    });
    assert.equal(stored.content.type, 'image');
    assert.equal(downloadCount, 1);
    const oldAttachmentId = stored.content.attachmentId;

    socket.ev.emit('messages.update', [{ key: raw.key, update: { message: { editedMessage: { message: {
        imageMessage: { caption: 'foto editada', mimetype: 'image/png' }
    } } }, messageTimestamp: 1792371600 } }]);
    stored = await until(async () => {
        const message = await findMessage(archive, identity, 'wa-live-media');
        return message?.editedAt ? message : null;
    });
    assert.equal(stored.content.caption, 'foto editada');
    assert.equal(stored.content.attachmentId, oldAttachmentId);
    assert.equal(downloadCount, 1, 'caption-only edit keeps the captured blob');

    socket.ev.emit('messages.update', [{ key: raw.key, update: {
        message: null, messageStubType: WAMessageStubType.REVOKE
    } }]);
    stored = await until(async () => {
        const message = await findMessage(archive, identity, 'wa-live-media');
        return message?.deletedAt ? message : null;
    });
    assert.equal(stored.content.type, 'unsupported');
    await until(async () => await archive.attachment({ id: oldAttachmentId }) === null);

    const text = waMessage('wa-text-to-image', { conversation: 'antes era texto' });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [text] });
    await until(async () => await findMessage(archive, identity, 'wa-text-to-image'));
    socket.ev.emit('messages.update', [{ key: text.key, update: { message: { editedMessage: { message: {
        imageMessage: { caption: 'edición con medio', mimetype: 'image/png' }
    } } }, messageTimestamp: 1792375200 } }]);
    const transformed = await until(async () => {
        const message = await findMessage(archive, identity, 'wa-text-to-image');
        return message?.content.availability === 'available' ? message : null;
    });
    assert.equal(transformed.content.type, 'image');
    assert.equal(transformed.content.caption, 'edición con medio');
    assert.equal(downloadCount, 2, 'an edit introducing media captures a new blob');
    assert.equal((await archive.events({ limit: 100 })).filter(event => event.type === 'message.updated').length >= 3, true);
    assert.equal((await archive.diagnostics()).messages, 2);
});

test('Telegram Bot API edits, replies and cursor commit are durable; unsupported events add no delivery receipts', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-telegram-multimedia-'));
    const archive = createArchive({ path: path.join(directory, 'archive.db') });
    await archive.ready;
    t.after(async () => { await archive.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const capture = createTelegramCapture(archive);
    const session = await capture.openBot('42');
    const baseUpdate = { update_id: 1, message: { message_id: 50, date: 1792368000, text: 'texto inicial',
        chat: { id: 700, type: 'private' }, from: { id: 7, first_name: 'Fixture' } } };
    const replyUpdate = { update_id: 2, message: { message_id: 51, date: 1792368001, text: 'respuesta',
        chat: { id: 700, type: 'private' }, reply_to_message: { message_id: 50, text: 'texto inicial' } } };
    const editUpdate = { update_id: 3, edited_message: { message_id: 50, date: 1792368000, edit_date: 1792368100,
        text: 'texto corregido', chat: { id: 700, type: 'private' } } };
    const excludedUpdate = { update_id: 4, deleted_business_messages: { chat: { id: 700 }, message_ids: [50] } };
    const normalized = normalizeUpdates([baseUpdate, replyUpdate, editUpdate, excludedUpdate], session.accountId, '555');
    await capture.commitBatch(session.accountId, normalized);
    const identity = { accountId: session.accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' };
    const thread = await archive.resolve(identity);
    const messages = await archive.messages({ conversationId: thread.conversation_id });
    assert.equal(messages[0].content.text, 'texto corregido');
    assert.equal(messages[0].editedAt, '2026-10-19T00:01:40.000Z');
    assert.equal(messages[1].replyToId, messages[0].id);
    assert.equal(await archive.telegramCursor(session.accountId), '4');
    assert.equal((await archive.events({ limit: 100 })).every(event => event.type !== 'delivery.updated'), true);
    assert.equal((await archive.diagnostics()).messages, 2);
});

test('Telegram adapter archives mocked private media bytes within the file boundary', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-telegram-media-'));
    const archive = createArchive({ path: path.join(directory, 'archive.db') });
    await archive.ready;
    const store = createAttachmentStore({ archive, directory: path.join(directory, 'attachments') });
    await store.init();
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
    const originalFetch = global.fetch;
    const downloaded = Buffer.from('mock telegram image bytes');
    global.fetch = async url => {
        const target = String(url);
        if (target.endsWith('/getFile?file_id=file_fixture')) {
            return new FetchResponse(JSON.stringify({ ok: true, result: { file_path: 'photos/file_fixture.jpg' } }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (target.endsWith('/photos/file_fixture.jpg')) return new FetchResponse(downloaded, { status: 200 });
        throw new Error('unexpected mocked Telegram URL');
    };
    saveSettingsDB({ telegramToken: 'token_fixture_multimedia', telegramChatId: '555', globalMode: 'ignored_all' });
    const adapter = new TelegramAdapter({ archive, attachmentStore: store,
        getMe: async () => ({ ok: true, result: { id: 42, is_bot: true } }), getUpdates,
        updateMenu: async () => {} });
    t.after(async () => {
        const closing = adapter.disconnect();
        for (const call of calls) call.finish();
        await closing;
        await adapter.idleAttachments();
        await store.close();
        await archive.close();
        global.fetch = originalFetch;
        await fs.rm(directory, { recursive: true, force: true });
    });
    await adapter.connect();
    await until(() => calls.length === 1);
    calls[0].finish({ ok: true, result: [{ update_id: 1, message: { message_id: 25, date: 1792368000,
        photo: [{ file_id: 'file_fixture', width: 640, height: 480 }],
        chat: { id: 700, type: 'private' }, from: { id: 7, first_name: 'Fixture' } } }] });
    await until(() => calls.length === 2);
    await adapter.idleAttachments();
    const identity = { accountId: adapter.accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '700' };
    const thread = await archive.resolve(identity);
    const [message] = await archive.messages({ conversationId: thread.conversation_id });
    assert.equal(message.content.type, 'image');
    assert.equal(message.content.availability, 'available');
    const attachment = await archive.attachment({ id: message.content.attachmentId });
    assert.equal(attachment.fileName, 'image-25.jpg');
    assert.equal(attachment.contentType, 'image/jpeg');
    assert.deepEqual(await fs.readFile(path.join(directory, 'attachments', `${attachment.id}.blob`)), downloaded);
});
