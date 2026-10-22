// Baileys stays in the adapter. Only verified socket identity and observations
// enter this boundary; no settings, permissions, STT or provider credentials.
function individualJid(value) {
    if (typeof value !== 'string' || value.length > 256) return null;
    const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value);
    return match ? `${match[1]}@${match[2]}` : null;
}

function socketIdentity(user) {
    const providerKey = individualJid(user?.id);
    // A LID alone cannot establish the stable account key used by this version.
    if (!providerKey?.endsWith('@s.whatsapp.net')) throw failure('WA_ACCOUNT_UNVERIFIED');
    return { providerKey, self: [providerKey, individualJid(user.lid)].filter(Boolean) };
}

function failure(code) {
    return Object.assign(new Error('Captura WhatsApp no confirmada.'), { code });
}

function unwrap(message) {
    for (let i = 0; i < 8; i++) {
        const nested = message?.ephemeralMessage?.message || message?.viewOnceMessage?.message
            || message?.viewOnceMessageV2?.message || message?.documentWithCaptionMessage?.message;
        if (!nested) break;
        message = nested;
    }
    return message || {};
}

function normalizedContent(body) {
    const type = ['audio', 'image', 'video', 'document'].find(name => body?.[`${name}Message`]);
    const media = type && body[`${type}Message`];
    const caption = media?.caption;
    const text = type ? caption : body?.conversation ?? body?.extendedTextMessage?.text;
    if (typeof text === 'string' && !text.isWellFormed()) throw failure('WA_CONTENT_INVALID');
    return !type && typeof text === 'string' && text.length
        ? { type: 'text', text }
        : { type: type || 'unsupported', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested',
            ...(typeof caption === 'string' && caption.length ? { caption } : {}) };
}

function replyToProviderMessageId(body) {
    const context = Object.values(body || {}).find(value => value && typeof value === 'object' && value.contextInfo)?.contextInfo;
    const id = context?.stanzaId;
    if (id == null) return null;
    if (typeof id !== 'string' || !id.length || Array.from(id).length > 512) throw failure('WA_REPLY_ID_INVALID');
    return id;
}

function replyPreview(body) {
    const context = Object.values(body || {}).find(value => value && typeof value === 'object' && value.contextInfo)?.contextInfo;
    if (!context?.quotedMessage) return null;
    const content = normalizedContent(unwrap(context.quotedMessage));
    const text = content.type === 'text' ? content.text : content.caption;
    return typeof text === 'string' && text.trim() ? Array.from(text).slice(0, 512).join('') : null;
}

function providerTimestamp(value) {
    const seconds = String(value ?? '');
    if (!/^\d+$/.test(seconds) || BigInt(seconds) > 253402300799n) return null;
    return new Date(Number(BigInt(seconds) * 1000n)).toISOString();
}

function normalize(message, session, source) {
    const remote = individualJid(message?.key?.remoteJid);
    if (!message?.message) return { scope: 'empty' };
    if (!remote) return { scope: 'non_individual' };
    if (session.self.includes(remote)) return { scope: 'administration' };
    const body = unwrap(message.message);
    const content = normalizedContent(body);
    const providerMessageId = message.key.id ?? null;
    if (providerMessageId !== null && (typeof providerMessageId !== 'string'
        || !providerMessageId.length || Array.from(providerMessageId).length > 512)) throw failure('WA_MESSAGE_ID_INVALID');
    // Long from protobuf has a decimal toString; never coerce a 64-bit ID.
    const seconds = String(message.messageTimestamp ?? '');
    if (!/^\d+$/.test(seconds) || BigInt(seconds) > 253402300799n) throw failure('WA_TIMESTAMP_INVALID');
    const occurredAt = new Date(Number(BigInt(seconds) * 1000n)).toISOString();
    const alt = individualJid(message.key.remoteJidAlt);
    if (alt && session.self.includes(alt)) throw failure('WA_IDENTITY_CONFLICT');
    const replyId = replyToProviderMessageId(body), preview = replyPreview(body);
    return { scope: 'individual', remote, content, occurredAt,
        replyToProviderMessageId: replyId, ...(preview ? { replyPreview: preview } : {}),
        // Only the provider's paired remoteJid/remoteJidAlt is alias evidence.
        // Participants, names and matching digits are never evidence.
        alt: alt && alt.endsWith('@lid') !== remote.endsWith('@lid') ? alt : null,
        providerMessageId,
        source, direction: message.key.fromMe ? 'outbound' : 'inbound',
        authorKind: message.key.fromMe ? (source === 'live' ? 'external_self' : 'unknown') : 'customer' };
}

function normalizeProviderEdit(keyValue, update, session) {
    const remote = individualJid(keyValue?.remoteJid);
    const providerMessageId = keyValue?.id;
    if (!remote || session.self.includes(remote) || typeof providerMessageId !== 'string'
        || !providerMessageId.length || Array.from(providerMessageId).length > 512) return null;
    const editedBody = update?.message?.editedMessage?.message;
    if (!editedBody || typeof editedBody !== 'object') return null;
    const content = normalizedContent(unwrap(editedBody));
    if (content.type === 'unsupported') return null;
    const editedAt = providerTimestamp(update.messageTimestamp);
    if (!editedAt) return null;
    const alt = individualJid(keyValue.remoteJidAlt);
    if (alt && session.self.includes(alt)) throw failure('WA_IDENTITY_CONFLICT');
    const editedContent = unwrap(editedBody);
    const replyId = replyToProviderMessageId(editedContent), preview = replyPreview(editedContent);
    return { remote, alt: alt && alt.endsWith('@lid') !== remote.endsWith('@lid') ? alt : null,
        providerMessageId, content, editedAt,
        ...(replyId ? { replyToProviderMessageId: replyId } : {}), ...(preview ? { replyPreview: preview } : {}) };
}

function normalizeProviderDelete(keyValue, session) {
    const remote = individualJid(keyValue?.remoteJid);
    const providerMessageId = keyValue?.id;
    if (!remote || session.self.includes(remote) || typeof providerMessageId !== 'string'
        || !providerMessageId.length || Array.from(providerMessageId).length > 512) return null;
    const alt = individualJid(keyValue.remoteJidAlt);
    if (alt && session.self.includes(alt)) throw failure('WA_IDENTITY_CONFLICT');
    return { remote, alt: alt && alt.endsWith('@lid') !== remote.endsWith('@lid') ? alt : null, providerMessageId };
}

function key(accountId, jid) {
    return { accountId, channel: 'whatsapp', kind: jid.endsWith('@lid') ? 'whatsapp_lid' : 'whatsapp_jid', exactValue: jid };
}

function outboundContent(payload) {
    const mediaType = ['audio', 'image', 'video', 'document'].find(type => payload?.[type] != null);
    if (mediaType) {
        const media = payload[mediaType];
        const caption = typeof payload.caption === 'string' ? payload.caption
            : typeof media?.caption === 'string' ? media.caption : null;
        return { type: mediaType, availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested',
            ...(caption ? { caption } : {}) };
    }
    if (typeof payload === 'string' && payload.length) return { type: 'text', text: payload };
    if (typeof payload?.text === 'string' && payload.text.length) return { type: 'text', text: payload.text };
    return { type: 'unsupported', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' };
}

/** A successful provider response is a durable observation of an outbound
 * message. Use the provider's ID so a later Baileys echo deduplicates with it. */
function acceptedOutbound(input, session, targetJid, sentContent) {
    const remote = individualJid(input?.key?.remoteJid) || individualJid(targetJid);
    const providerMessageId = input?.key?.id;
    if (!remote || session.self.includes(remote) || typeof providerMessageId !== 'string'
        || !providerMessageId.length || Array.from(providerMessageId).length > 512) return null;
    const seconds = String(input?.messageTimestamp ?? '');
    const occurredAt = /^\d+$/.test(seconds) && BigInt(seconds) <= 253402300799n
        ? new Date(Number(BigInt(seconds) * 1000n)).toISOString() : new Date().toISOString();
    return { identity: null, providerMessageId, source: 'live', direction: 'outbound', authorKind: 'external_self',
        occurredAt, content: outboundContent(sentContent), remote };
}

/** Single FIFO, including in-flight work. Raw observations retained for the
 * legacy consumer count toward admission bytes. No blind write retry on error. */
function createWhatsappCapture(archive, { buildLegacyDispatch } = {}) {
    let tail = Promise.resolve(), elements = 0, bytes = 0, closed = false, failed = null;
    function enqueue(message, session, source) {
        if (closed || failed) return Promise.reject(failure(failed || 'WA_CAPTURE_CLOSED'));
        let observation, size;
        try {
            observation = normalize(message, session, source);
            if (observation.scope !== 'individual') return Promise.resolve(observation);
            // A live fromMe message stays external_self regardless of whether a
            // local send response raced ahead of the provider echo. F5 will add
            // durable intent IDs for AI/operator attribution.
            size = Buffer.byteLength(JSON.stringify(message, (_k, v) => typeof v === 'bigint' ? String(v) : v));
        } catch (error) { return Promise.reject(error); }
        if (elements >= 1000 || bytes + size > 32 * 1024 * 1024) return Promise.reject(failure('WA_CAPTURE_SATURATED'));
        elements++; bytes += size;
        const operation = tail.then(async () => {
            if (failed) throw failure(failed);
            const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: session.providerKey });
            const identity = key(account.id, observation.remote);
            let aliasConflict = false;
            if (observation.alt) {
                const aliasResult = await archive.bindAlias({ canonical: identity, alias: key(account.id, observation.alt),
                    evidence: { kind: 'adapter', reference: 'baileys:key.remoteJidAlt' } });
                aliasConflict = aliasResult.status === 'quarantined';
            }
            const legacyDispatch = !aliasConflict && buildLegacyDispatch ? buildLegacyDispatch(message, observation) : null;
            const [result] = await archive.ingestBatch([{ identity,
                providerMessageId: observation.providerMessageId, source, direction: observation.direction,
                authorKind: observation.authorKind, occurredAt: observation.occurredAt, content: observation.content,
                ...(observation.replyToProviderMessageId ? { replyToProviderMessageId: observation.replyToProviderMessageId } : {}),
                ...(observation.replyPreview ? { replyPreview: observation.replyPreview } : {}),
                ...(legacyDispatch ? { legacyDispatch } : {}) }]);
            const resolved = await archive.resolve(identity);
            const conversation = await archive.conversation(resolved.conversation_id);
            return { ...observation, result, legacyDispatch, requiresReview: Boolean(conversation.requires_review) };
        }).catch(error => {
            // An RPC timeout may have committed. Stop new admission until restart;
            // redelivery then consults durable fingerprints instead of resending.
            failed = error.code || 'WA_CAPTURE_FAILED';
            throw error;
        }).finally(() => { elements--; bytes -= size; });
        tail = operation.catch(() => {});
        return operation;
    }
    function mutate(method, observation, session) {
        if (!['editProviderMessage', 'deleteProviderMessage'].includes(method)) return Promise.reject(failure('WA_MUTATION_UNSUPPORTED'));
        if (closed || failed) return Promise.reject(failure(failed || 'WA_CAPTURE_CLOSED'));
        const operation = tail.then(async () => {
            if (failed) throw failure(failed);
            const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: session.providerKey });
            const identity = key(account.id, observation.remote);
            let aliasConflict = false;
            if (observation.alt) {
                const aliasResult = await archive.bindAlias({ canonical: identity, alias: key(account.id, observation.alt),
                    evidence: { kind: 'adapter', reference: 'baileys:key.remoteJidAlt' } });
                aliasConflict = aliasResult.status === 'quarantined';
            }
            if (aliasConflict) return { status: 'quarantined' };
            return await archive[method]({ ...observation, identity });
        }).catch(error => {
            failed = error.code || 'WA_CAPTURE_FAILED';
            throw error;
        });
        tail = operation.catch(() => {});
        return operation;
    }
    return { enqueue, idle: () => tail, queue: () => ({ elements, bytes, failed }),
        edit: (observation, session) => mutate('editProviderMessage', observation, session),
        remove: (observation, session) => mutate('deleteProviderMessage', observation, session),
        async close() { closed = true; await tail; } };
}

module.exports = { individualJid, socketIdentity, normalize, normalizeProviderEdit, normalizeProviderDelete,
    normalizedContent, unwrap, outboundContent, acceptedOutbound, createWhatsappCapture };
