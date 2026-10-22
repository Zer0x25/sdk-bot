const { randomUUID } = require('node:crypto');

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000002';
const OUTBOUND_OPTIONS = new Set(['source', 'actorId', 'idempotencyKey', 'conversationId',
    'controlSnapshot', 'policy', 'generationId', 'bubbleIndex', 'isCurrent', '_outboundAccountId', 'useMarkdown']);

function withoutOutboundOptions(options = {}) {
    return Object.fromEntries(Object.entries(options).filter(([key]) => !OUTBOUND_OPTIONS.has(key)));
}

function providerMessageId(channel, result) {
    if (channel === 'whatsapp') return result?.key?.id == null ? null : String(result.key.id);
    const id = result?.result?.message_id;
    return id == null ? null : String(id);
}

function isAdminDestination(adapter, channel, destination) {
    if (channel === 'telegram') return String(adapter.adminChatId || '') === destination;
    if (channel === 'whatsapp') {
        try {
            const { individualJid, socketIdentity } = require('../conversations/whatsappCapture');
            const remote = individualJid(destination);
            return Boolean(remote && socketIdentity(adapter.sock?.user).self.includes(remote));
        } catch { return false; }
    }
    return false;
}

function responseWithIntent(result, intent, replayed = false) {
    const outbox = { id: intent.id, idempotencyKey: intent.idempotencyKey, state: intent.state,
        providerMessageId: intent.providerMessageId, replayed };
    if (result && typeof result === 'object' && !Array.isArray(result)) return { ...result, _outbox: outbox };
    return { value: result, _outbox: outbox };
}

function outboundError(code, intent, state = undefined) {
    const error = Object.assign(new Error(code), { code, outboundIntentId: intent?.id,
        idempotencyKey: intent?.idempotencyKey, outboundState: state || intent?.state });
    return error;
}

async function sendMessage(adapter, normalizedJid, text, options = {}) {
    if (typeof adapter.sendMessageRaw !== 'function') throw new Error('CHANNEL_SEND_NOT_IMPLEMENTED');
    if (!adapter.archive) return adapter.sendMessageRaw(normalizedJid, text, options);

    const channel = adapter.channelName;
    const prefix = `${channel}:`;
    if (typeof normalizedJid !== 'string' || !normalizedJid.trim()) throw Object.assign(new Error('INVALID_OUTBOUND_DESTINATION'), { code: 'INVALID_OUTBOUND_DESTINATION' });
    if (normalizedJid.includes(':') && !normalizedJid.startsWith(prefix)) throw Object.assign(new Error('OUTBOUND_CHANNEL_MISMATCH'), { code: 'OUTBOUND_CHANNEL_MISMATCH' });
    const destination = normalizedJid.startsWith(prefix) ? normalizedJid.slice(prefix.length) : normalizedJid;
    if (!destination || destination.length > 512) throw Object.assign(new Error('INVALID_OUTBOUND_DESTINATION'), { code: 'INVALID_OUTBOUND_DESTINATION' });

    let accountId = adapter.accountId || null;
    if (!accountId && typeof adapter.ensureOutboundAccountId === 'function') accountId = await adapter.ensureOutboundAccountId();
    if (!accountId) throw Object.assign(new Error('OUTBOUND_ACCOUNT_UNAVAILABLE'), { code: 'OUTBOUND_ACCOUNT_UNAVAILABLE' });

    const controlSnapshot = options.controlSnapshot || null;
    let conversationId = options.conversationId || controlSnapshot?.conversationId || null;
    if (!conversationId && typeof adapter.archive.controlByIdentity === 'function') {
        let kind = null;
        if (channel === 'telegram' && /^-?[1-9][0-9]*$/.test(destination)) kind = 'telegram_chat_id';
        else if (channel === 'whatsapp' && destination.endsWith('@lid')) kind = 'whatsapp_lid';
        else if (channel === 'whatsapp' && destination.endsWith('@s.whatsapp.net')) kind = 'whatsapp_jid';
        if (kind) {
            try {
                const target = await adapter.archive.controlByIdentity({ accountId, channel, kind, exactValue: destination });
                conversationId = target?.conversationId || null;
            } catch { /* Admin/self destinations and legacy archives may have no conversation. */ }
        }
    }
    if (adapter.accountId !== accountId) throw Object.assign(new Error('La cuenta del canal cambió antes del envío.'), {
        code: 'OUTBOUND_ACCOUNT_CHANGED'
    });

    const source = options.source || 'system';
    const adminSelfChat = source === 'ai' && isAdminDestination(adapter, channel, destination);
    if (source === 'ai' && !controlSnapshot && !adminSelfChat) {
        const authority = await adapter.archive.controlAuthority();
        if (authority.mode === 'sqlite') throw Object.assign(new Error('La salida IA no trae una captura de control vigente.'), {
            code: 'OUTBOUND_CONTROL_REQUIRED'
        });
    }
    const idempotencyKey = options.idempotencyKey || randomUUID();
    const payload = typeof text === 'string' ? { text, options: withoutOutboundOptions(options) }
        : { content: text, options: withoutOutboundOptions(options) };
    const actorId = options.actorId || SYSTEM_ACTOR;
    const basePolicy = options.policy && typeof options.policy === 'object' && !Array.isArray(options.policy)
        ? options.policy : {};
    const policy = adminSelfChat ? { ...basePolicy, scope: 'admin_self_chat' }
        : source === 'ai' && options.generationId
            ? { ...basePolicy, generationId: options.generationId, bubbleIndex: options.bubbleIndex ?? null }
            : options.policy || null;
    const begun = await adapter.archive.beginOutboundIntent({ idempotencyKey, accountId, conversationId,
        channel, destination, actorId, source, payload, controlSnapshot, policy });
    let intent = begun.intent;

    if (begun.status === 'existing') {
        if (intent.resultExpired && ['accepted','rejected'].includes(intent.state)) {
            throw outboundError('IDEMPOTENCY_RESULT_EXPIRED', intent, intent.state);
        }
        if (intent.state === 'accepted') return responseWithIntent(intent.providerResult, intent, true);
        if (intent.state === 'rejected') throw outboundError(intent.errorCode || 'OUTBOUND_REJECTED', intent, 'rejected');
        if (intent.state === 'delivery_unknown') throw outboundError('OUTBOUND_DELIVERY_UNKNOWN', intent, 'delivery_unknown');
        if (intent.state === 'sending') throw outboundError('OUTBOUND_IN_PROGRESS', intent, 'sending');
    }

    let claimed;
    try { claimed = await adapter.archive.claimOutboundIntent({ idempotencyKey }); }
    catch (error) {
        throw outboundError('OUTBOUND_CLAIM_UNCERTAIN', intent, 'sending');
    }
    intent = claimed.intent || intent;
    if (claimed.status !== 'claimed') {
        const code = claimed.errorCode || (claimed.status === 'delivery_unknown' ? 'OUTBOUND_DELIVERY_UNKNOWN'
            : claimed.status === 'sending' ? 'OUTBOUND_IN_PROGRESS'
                : claimed.status === 'accepted' ? null : 'OUTBOUND_REJECTED');
        if (!code && claimed.status === 'accepted') return responseWithIntent(intent.providerResult, intent, true);
        throw outboundError(code, intent, claimed.status);
    }

    if (source === 'ai' && typeof options.isCurrent === 'function') {
        let current = false;
        try { current = await options.isCurrent(); } catch { /* fail closed before provider I/O */ }
        if (!current) {
            try {
                intent = await adapter.archive.finishOutboundIntent({ idempotencyKey, state: 'rejected',
                    errorCode: 'OUTBOUND_CONTROL_STALE' });
            } catch { /* The intent remains sending and startup recovery will mark it uncertain. */ }
            throw outboundError('OUTBOUND_CONTROL_STALE', intent, 'rejected');
        }
    }

    let result;
    try {
        result = await adapter.sendMessageRaw(normalizedJid, text, { ...options, _outboundAccountId: accountId });
    } catch (error) {
        const definite = error?.outboundOutcome === 'rejected';
        const state = definite ? 'rejected' : 'delivery_unknown';
        try {
            intent = await adapter.archive.finishOutboundIntent({ idempotencyKey, state,
                errorCode: error?.code || (definite ? 'OUTBOUND_REJECTED' : 'OUTBOUND_DELIVERY_UNKNOWN') });
        } catch { /* A failed local ACK leaves 'sending' for startup recovery. */ }
        error.outboundIntentId ||= intent?.id || begun.intent.id;
        error.idempotencyKey ||= idempotencyKey;
        error.outboundState = state;
        if (!error.code) error.code = definite ? 'OUTBOUND_REJECTED' : 'OUTBOUND_DELIVERY_UNKNOWN';
        throw error;
    }

    try {
        intent = await adapter.archive.finishOutboundIntent({ idempotencyKey, state: 'accepted',
            providerMessageId: providerMessageId(channel, result), providerResult: result ?? null });
    } catch {
        throw outboundError('OUTBOUND_DELIVERY_UNKNOWN', begun.intent, 'sending');
    }
    return responseWithIntent(result, intent);
}

module.exports = { sendMessage, withoutOutboundOptions, SYSTEM_ACTOR };
