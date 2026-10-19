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

function normalize(message, session, source) {
    const remote = individualJid(message?.key?.remoteJid);
    if (!message?.message) return { scope: 'empty' };
    if (!remote) return { scope: 'non_individual' };
    if (session.self.includes(remote)) return { scope: 'administration' };
    const body = unwrap(message.message);
    const text = body.conversation ?? body.extendedTextMessage?.text
        ?? body.imageMessage?.caption ?? body.documentMessage?.caption ?? body.videoMessage?.caption;
    if (typeof text === 'string' && !text.isWellFormed()) throw failure('WA_CONTENT_INVALID');
    const providerMessageId = message.key.id ?? null;
    if (providerMessageId !== null && (typeof providerMessageId !== 'string'
        || !providerMessageId.length || Array.from(providerMessageId).length > 512)) throw failure('WA_MESSAGE_ID_INVALID');
    const type = ['audio', 'image', 'video', 'document'].find(name => body[`${name}Message`]) || 'unsupported';
    const content = typeof text === 'string' && text.length
        ? { type: 'text', text }
        : { type, availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' };
    // Long from protobuf has a decimal toString; never coerce a 64-bit ID.
    const seconds = String(message.messageTimestamp ?? '');
    if (!/^\d+$/.test(seconds) || BigInt(seconds) > 253402300799n) throw failure('WA_TIMESTAMP_INVALID');
    const occurredAt = new Date(Number(BigInt(seconds) * 1000n)).toISOString();
    const alt = individualJid(message.key.remoteJidAlt);
    if (alt && session.self.includes(alt)) throw failure('WA_IDENTITY_CONFLICT');
    return { scope: 'individual', remote, content, occurredAt,
        // Only the provider's paired remoteJid/remoteJidAlt is alias evidence.
        // Participants, names and matching digits are never evidence.
        alt: alt && alt.endsWith('@lid') !== remote.endsWith('@lid') ? alt : null,
        providerMessageId,
        source, direction: message.key.fromMe ? 'outbound' : 'inbound',
        authorKind: message.key.fromMe ? (source === 'live' ? 'external_self' : 'unknown') : 'customer' };
}

function key(accountId, jid) {
    return { accountId, channel: 'whatsapp', kind: jid.endsWith('@lid') ? 'whatsapp_lid' : 'whatsapp_jid', exactValue: jid };
}

/** Single FIFO, including in-flight work. Raw observations retained for the
 * legacy consumer count toward admission bytes. No blind write retry on error. */
function createWhatsappCapture(archive) {
    let tail = Promise.resolve(), elements = 0, bytes = 0, closed = false, failed = null;
    function enqueue(message, session, source, knownOwnEcho = false) {
        if (closed || failed) return Promise.reject(failure(failed || 'WA_CAPTURE_CLOSED'));
        let observation, size;
        try {
            observation = normalize(message, session, source);
            if (observation.scope !== 'individual') return Promise.resolve(observation);
            // The volatile adapter correlation proves a local echo, but does
            // not prove ai/operator authorship. Durable attribution is F5.
            if (knownOwnEcho && observation.direction === 'outbound') observation.authorKind = 'unknown';
            size = Buffer.byteLength(JSON.stringify(message, (_k, v) => typeof v === 'bigint' ? String(v) : v));
        } catch (error) { return Promise.reject(error); }
        if (elements >= 1000 || bytes + size > 32 * 1024 * 1024) return Promise.reject(failure('WA_CAPTURE_SATURATED'));
        elements++; bytes += size;
        const operation = tail.then(async () => {
            if (failed) throw failure(failed);
            const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: session.providerKey });
            const identity = key(account.id, observation.remote);
            if (observation.alt) await archive.bindAlias({ canonical: identity, alias: key(account.id, observation.alt),
                evidence: { kind: 'adapter', reference: 'baileys:key.remoteJidAlt' } });
            const [result] = await archive.ingestBatch([{ identity,
                providerMessageId: observation.providerMessageId, source, direction: observation.direction,
                authorKind: observation.authorKind, occurredAt: observation.occurredAt, content: observation.content }]);
            const resolved = await archive.resolve(identity);
            const conversation = await archive.conversation(resolved.conversation_id);
            return { ...observation, result, requiresReview: Boolean(conversation.requires_review) };
        }).catch(error => {
            // An RPC timeout may have committed. Stop new admission until restart;
            // redelivery then consults durable fingerprints instead of resending.
            failed = error.code || 'WA_CAPTURE_FAILED';
            throw error;
        }).finally(() => { elements--; bytes -= size; });
        tail = operation.catch(() => {});
        return operation;
    }
    return { enqueue, idle: () => tail, queue: () => ({ elements, bytes, failed }),
        async close() { closed = true; await tail; } };
}

module.exports = { individualJid, socketIdentity, normalize, createWhatsappCapture };
