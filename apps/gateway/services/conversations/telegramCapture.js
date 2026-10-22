// Bot API IDs cross JSON, HTTP and SQLite; keep them canonical decimal text.
const BOT_ID_MAX = 18446744073709551615n;
const UPDATE_MAX = 18446744073709551615n;
const MESSAGE_MAX = 18446744073709551615n;
const MAX_BATCH = 100;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;

function failure(code) { return Object.assign(new Error('Captura Telegram no confirmada.'), { code }); }

function decimalId(value, { signed = false, allowZero = false, max = MESSAGE_MAX } = {}) {
    let text;
    if (typeof value === 'string') text = value;
    else if (Number.isSafeInteger(value)) text = String(value);
    else return null;
    const pattern = signed ? /^-?(0|[1-9]\d{0,19})$/ : /^(0|[1-9]\d{0,19})$/;
    if (!pattern.test(text) || text === '-0') return null;
    const unsigned = text.startsWith('-') ? text.slice(1) : text;
    const parsed = BigInt(unsigned);
    if (!allowZero && parsed === 0n || parsed > max) return null;
    return text;
}

function verifiedBotId(response) {
    if (response?.ok !== true || response.result?.is_bot !== true) return null;
    return decimalId(response.result.id, { max: BOT_ID_MAX });
}

function telegramIdentity(accountId, chatId) {
    return { accountId, channel: 'telegram', kind: 'telegram_chat_id', exactValue: chatId };
}

/** Bot API send results are the only live observation of bot-authored output:
 * getUpdates does not return the bot's own messages. */
function normalizeSentMessage(message, accountId, targetChatId, adminChatId = '') {
    const target = decimalId(targetChatId, { signed: true, max: MESSAGE_MAX });
    const chatId = decimalId(message?.chat?.id, { signed: true, max: MESSAGE_MAX });
    const admin = decimalId(adminChatId, { signed: true, max: MESSAGE_MAX });
    const providerMessageId = decimalId(message?.message_id, { max: MESSAGE_MAX });
    const occurredAt = timestamp(message?.date);
    if (!accountId || !target || !chatId || chatId !== target || message?.chat?.type !== 'private'
        || chatId === admin || !providerMessageId || !occurredAt) return null;
    return { identity: telegramIdentity(accountId, chatId), providerMessageId, source: 'live',
        direction: 'outbound', authorKind: 'external_self', occurredAt, content: normalizedContent(message) };
}

function timestamp(value) {
    const seconds = decimalId(value, { allowZero: true, max: 253402300799n });
    if (seconds === null) return null;
    return new Date(Number(BigInt(seconds) * 1000n)).toISOString();
}

function normalizedContent(message) {
    const media = message.voice || message.audio ? 'audio'
        : message.photo ? 'image'
            : message.video || message.video_note || message.animation ? 'video'
                : message.document ? 'document' : null;
    const bodyText = media ? message.caption : message.text;
    if (typeof bodyText === 'string' && !bodyText.isWellFormed()) throw failure('TG_CONTENT_INVALID');
    const caption = media && typeof bodyText === 'string' && bodyText.length ? bodyText : undefined;
    if (!media && typeof bodyText === 'string' && bodyText.length) return { type: 'text', text: bodyText };
    return { type: media || 'unsupported', availability: 'not_stored', transcript: null,
        transcriptionStatus: 'not_requested', ...(caption ? { caption } : {}) };
}

function replyToProviderMessageId(message) {
    const id = message?.reply_to_message?.message_id;
    return id == null ? null : decimalId(id);
}

function replyPreview(message) {
    const source = message?.reply_to_message;
    const text = typeof source?.text === 'string' ? source.text : source?.caption;
    if (typeof text !== 'string' || !text.isWellFormed() || !text.trim()) return null;
    return Array.from(text).slice(0, 512).join('');
}

function normalizeEdit(message, accountId, adminChatId = '') {
    const chatId = decimalId(message?.chat?.id, { signed: true, max: MESSAGE_MAX });
    const providerMessageId = decimalId(message?.message_id, { max: MESSAGE_MAX });
    const editedAt = timestamp(message?.edit_date);
    if (!chatId || chatId === adminChatId || message?.chat?.type !== 'private'
        || !providerMessageId || !editedAt) return null;
    const replyId = replyToProviderMessageId(message);
    return { identity: telegramIdentity(accountId, chatId), providerMessageId,
        content: normalizedContent(message), editedAt,
        ...(replyId ? { replyToProviderMessageId: replyId } : {}),
        ...(replyPreview(message) ? { replyPreview: replyPreview(message) } : {}) };
}

/** Build one durable message or mark the update as an intentionally excluded
 * Telegram event. Admin delivery remains a legacy pipeline action after commit. */
function normalizeUpdate(update, accountId, adminChatId = '', { includeAudio = false } = {}) {
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw failure('TG_UPDATE_INVALID');
    const updateId = decimalId(update.update_id, { allowZero: true, max: UPDATE_MAX });
    if (updateId === null) throw failure('TG_UPDATE_ID_INVALID');
    if (update.edited_message !== undefined && update.edited_message !== null) {
        const edit = normalizeEdit(update.edited_message, accountId, adminChatId);
        return { updateId, message: null, edit, legacy: null };
    }
    if (update.message === undefined || update.message === null) return { updateId, message: null, edit: null, legacy: null };
    const message = update.message;
    if (typeof message !== 'object' || Array.isArray(message)) throw failure('TG_MESSAGE_INVALID');
    const chat = message.chat;
    const chatId = decimalId(chat?.id, { signed: true, max: MESSAGE_MAX });
    const messageId = decimalId(message.message_id, { max: MESSAGE_MAX });
    const occurredAt = timestamp(message.date);
    if (chatId === null) throw failure('TG_CHAT_ID_INVALID');
    if (messageId === null) throw failure('TG_MESSAGE_ID_INVALID');
    if (!occurredAt) throw failure('TG_TIMESTAMP_INVALID');
    if (typeof chat.type !== 'string' || !chat.type.length || chat.type.length > 32) throw failure('TG_CHAT_TYPE_INVALID');

    const isAdmin = Boolean(adminChatId && chatId === adminChatId);
    if (isAdmin) {
        const content = normalizedContent(message);
        const text = content.type === 'text' ? content.text : content.caption || '';
        const adminInbox = text && !(content.type === 'audio' && includeAudio) ? { chatId, providerMessageId: messageId, occurredAt,
            message: { channel: 'telegram', remoteId: `telegram:${chatId}`, rawId: chatId, text,
                metadata: { pushName: message.from?.username
                    ? `${message.from?.first_name || 'Desconocido'} (@${message.from.username})`
                    : message.from?.first_name || 'Desconocido',
                savedName: null, phoneNumber: null, lid: chatId, isBusiness: false,
                country: 'Desconocido', isFromMe: false, isAdminChannel: true } } } : null;
        return { updateId, message: null, edit: null, legacy: { message, chatId, text, isAdminChannel: true,
            audio: content.type === 'audio' }, ...(adminInbox ? { adminInbox } : {}) };
    }
    if (chat.type !== 'private') return { updateId, message: null, edit: null, legacy: null };

    const content = normalizedContent(message);
    const text = content.type === 'text' ? content.text : content.caption || '';
    const waitForTranscription = content.type === 'audio' && includeAudio;
    const archiveInput = { identity: telegramIdentity(accountId, chatId), providerMessageId: messageId,
        source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt, content,
        ...(replyToProviderMessageId(message) ? { replyToProviderMessageId: replyToProviderMessageId(message) } : {}),
        ...(replyPreview(message) ? { replyPreview: replyPreview(message) } : {}) };
    if ((text && Buffer.byteLength(text) <= 65536 && !waitForTranscription) || waitForTranscription) {
        const firstName = message.from?.first_name || 'Desconocido';
        const username = message.from?.username;
        archiveInput.legacyDispatch = { waitForTranscription, message: {
            channel: 'telegram', remoteId: `telegram:${chatId}`, rawId: chatId,
            text: waitForTranscription ? '' : text, transcript: '', isAudio: waitForTranscription,
            metadata: { pushName: username ? `${firstName} (@${username})` : firstName,
                savedName: null, phoneNumber: null, lid: chatId, isBusiness: false,
                country: 'Desconocido', isFromMe: false, isAdminChannel: false }
        } };
    }
    return { updateId, message: archiveInput, edit: null, legacy: { message, chatId, text, isAdminChannel: false,
        audio: content.type === 'audio' } };
}

function normalizeUpdates(updates, accountId, adminChatId = '', options = {}) {
    if (!Array.isArray(updates) || updates.length > MAX_BATCH) throw failure('TG_BATCH_INVALID');
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(updates)); }
    catch { throw failure('TG_BATCH_INVALID'); }
    if (bytes > MAX_BATCH_BYTES) throw failure('TG_BATCH_TOO_LARGE');
    return updates.map(update => normalizeUpdate(update, accountId, adminChatId, options));
}

function createTelegramCapture(archive) {
    if (!archive) throw failure('TG_ARCHIVE_UNAVAILABLE');
    return {
        async openBot(botId) {
            const verifiedId = decimalId(botId, { max: BOT_ID_MAX });
            if (!verifiedId) throw failure('TG_ACCOUNT_UNVERIFIED');
            const account = await archive.registerAccount({ channel: 'telegram', providerKey: `telegram_bot:${verifiedId}` });
            const lastUpdateId = await archive.telegramCursor(account.id);
            return { accountId: account.id, lastUpdateId };
        },
        commitBatch(accountId, updates) {
            return archive.captureTelegramBatch({ accountId, updates: updates.map(({ updateId, message, edit, adminInbox }) => ({
                updateId, message, edit, ...(adminInbox ? { adminInbox } : {})
            })) });
        }
    };
}

module.exports = { decimalId, verifiedBotId, telegramIdentity, normalizeSentMessage, normalizeUpdate,
    normalizeEdit, normalizeUpdates, createTelegramCapture };
