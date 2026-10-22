// @ts-check
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { assertValid, validate } = require('@sdk-bot/contracts');
const { BoundaryError } = require('../lib/httpBoundary');
const { requireCapability } = require('../lib/panelContext');
const { isHandoffActive } = require('./contactsRepository');
const { executeAssistantTool } = require('./assistantTools');
const { normalizeSearchQuery } = require('./conversations/searchQuery');

const PAGE_SCAN = 250;
const PAGE_SCAN_MAX = 5000;
const CAPABILITIES = {
    whatsapp: { historySync: true, attachments: true, reply: true, edit: false, deliveryReceipt: false, readReceipt: false },
    telegram: { historySync: false, attachments: true, reply: true, edit: false, deliveryReceipt: false, readReceipt: false }
};

function capabilityFor(method, pathname) {
    if (method === 'GET' && (/^\/v1\/(session|accounts|profiles|summary|conversations(?:\/[^/]+(?:\/(?:messages|pending-resume|outbound-reconciliations|search))?)?|operations\/[^/]+|events)$/.test(pathname)
        || /^\/v1\/attachments\/[0-9a-f-]{36}$/.test(pathname))) return 'conversations:read';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/(takeover|release)$/.test(pathname)) return 'control:write';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/assistance$/.test(pathname)) return 'admin:write';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/messages$/.test(pathname)) return 'messages:send';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/outbound-intents\/[^/]+\/reconcile$/.test(pathname)) return 'messages:send';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/read$/.test(pathname)) return 'conversations:read';
    if (method === 'PATCH' && /^\/v1\/conversations\/[^/]+$/.test(pathname)) return 'conversations:write';
    return null;
}

function invalid(message = 'Parámetros inválidos.') {
    return new BoundaryError(422, 'VALIDATION_ERROR', message);
}

function contentDisposition(fileName) {
    const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="attachment"; filename*=UTF-8''${encoded}`;
}

function currentUrl(req) {
    try { return new URL(req.url || '/', 'http://gateway.local'); }
    catch { throw invalid('URL inválida.'); }
}

function parseQuery(req, contract) {
    const url = currentUrl(req);
    const allowed = contract === 'ConversationsQuery'
        ? new Set(['cursor', 'limit', 'channel', 'accountId', 'automationMode', 'lifecycle', 'unreadOnly', 'search'])
        : contract === 'SummaryQuery' ? new Set(['from', 'to'])
            : contract === 'MessageSearchQuery' ? new Set(['query', 'cursor', 'limit']) : new Set(['cursor', 'limit']);
    const values = new Map();
    for (const [key, value] of url.searchParams) {
        if (!allowed.has(key) || values.has(key)) throw invalid();
        values.set(key, value);
    }
    const result = {};
    if (contract === 'SummaryQuery') {
        if (values.has('from')) result.from = values.get('from');
        if (values.has('to')) result.to = values.get('to');
    }
    if (values.has('cursor')) result.cursor = values.get('cursor');
    if (values.has('limit')) {
        const raw = values.get('limit');
        if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalid();
        result.limit = Number(raw);
    }
    for (const key of ['channel', 'accountId', 'automationMode', 'lifecycle', 'search', 'query']) {
        if (values.has(key)) result[key] = values.get(key);
    }
    if (values.has('unreadOnly')) {
        const value = values.get('unreadOnly');
        if (value !== 'true' && value !== 'false') throw invalid();
        result.unreadOnly = value === 'true';
    }
    if (!validate(contract, result).valid) throw invalid();
    return result;
}

function rejectQuery(req) {
    if ([...currentUrl(req).searchParams].length) throw invalid();
}

function conversationPathId(segment) {
    let value;
    try { value = decodeURIComponent(segment); }
    catch { throw invalid('Identificador inválido.'); }
    if (!validate('Id', value).valid) throw invalid('Identificador inválido.');
    return value;
}

function stableHash(value) {
    const secret = process.env.SDK_PANEL_GATEWAY_SECRET;
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
        throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Frontera del panel sin configurar.');
    }
    return crypto.createHmac('sha256', secret).update('sdk-bot/page-scope/v1\0')
        .update(JSON.stringify(value)).digest('base64url');
}

function cursorMac(body) {
    const secret = process.env.SDK_PANEL_GATEWAY_SECRET;
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
        throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Frontera del panel sin configurar.');
    }
    return crypto.createHmac('sha256', secret).update('sdk-bot/page-cursor/v1\0').update(body).digest();
}

function encodeCursor(payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = cursorMac(body);
    const token = Buffer.concat([body, signature]).toString('base64url');
    if (token.length > 2048) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'No se pudo crear el cursor.');
    return token;
}

function decodeCursor(token, expectedKind) {
    if (!validate('PageCursor', token).valid) throw invalid('Cursor inválido.');
    let bytes;
    try {
        bytes = Buffer.from(token, 'base64url');
        if (bytes.toString('base64url') !== token || bytes.length <= 32) throw new Error('invalid');
    } catch { throw invalid('Cursor inválido.'); }
    const body = bytes.subarray(0, -32);
    const signature = bytes.subarray(-32);
    const expected = cursorMac(body);
    if (!crypto.timingSafeEqual(signature, expected)) {
        throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El cursor venció; vuelve a cargar la vista.');
    }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch { throw invalid('Cursor inválido.'); }
    if (!payload || payload.v !== 1 || payload.kind !== expectedKind) throw invalid('Cursor inválido.');
    return payload;
}

function requireEpoch(payload, snapshot) {
    if (payload.epoch !== snapshot.dataEpoch) {
        throw new BoundaryError(409, 'DATA_EPOCH_MISMATCH', 'El archivo cambió de época; vuelve a cargar la vista.');
    }
}

function lastEventCursor(req) {
    const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
    let occurrences = 0;
    for (let index = 0; index < rawHeaders.length; index += 2) {
        if (String(rawHeaders[index]).toLowerCase() === 'last-event-id') occurrences += 1;
    }
    const value = req.headers['last-event-id'];
    if (occurrences > 1 || value !== undefined && typeof value !== 'string') throw invalid('Last-Event-ID inválido.');
    if (value === undefined) return null;
    if (!validate('EventId', value).valid) throw invalid('Last-Event-ID inválido.');
    const separator = value.indexOf(':');
    const cursor = { dataEpoch: value.slice(0, separator), seq: value.slice(separator + 1) };
    if (!validate('EventCursor', cursor).valid) throw invalid('Last-Event-ID inválido.');
    return cursor;
}

const LIVE_QUEUE_MAX_EVENTS = 1000;
const LIVE_QUEUE_MAX_BYTES = 1024 * 1024;
const EVENT_REPLAY_PAGE_SIZE = 1000;

function sseFrame(event) {
    assertValid('Event', event);
    const id = `${event.cursor.dataEpoch}:${event.cursor.seq}`;
    return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function resyncEvent(snapshot, reason) {
    return assertValid('Event', { schemaVersion: 1, cursor: snapshot,
        type: 'resync.required', occurredAt: new Date().toISOString(), data: { reason } });
}

function streamEvents(req, res, context, archive) {
    rejectQuery(req);
    const resume = lastEventCursor(req);
    if (!archive || typeof archive.onEvent !== 'function' || typeof archive.eventsPage !== 'function') {
        throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Stream de conversaciones no disponible.');
    }

    return startEventStream(req, res, context, archive, resume);
}

async function startEventStream(req, res, context, archive, resume) {
    let closed = false;
    let replaying = true;
    let draining = false;
    let queue = [];
    let queueBytes = 0;
    let epoch = null;
    let lastSent = 0n;
    /** @type {ReturnType<typeof setInterval>|null} */
    let heartbeat = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let authExpiry = null;
    let unsubscribe = () => {};

    function cleanup() {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (authExpiry) clearTimeout(authExpiry);
        unsubscribe();
        queue = [];
        queueBytes = 0;
    }
    function end() {
        cleanup();
        if (!res.destroyed && !res.writableEnded) res.end();
    }
    function abort() {
        cleanup();
        if (!res.destroyed) res.destroy();
    }
    function writeText(text) {
        if (closed || res.destroyed || res.writableEnded) return Promise.reject(new Error('SSE_CLOSED'));
        if (res.write(text)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const done = () => { cleanupWait(); resolve(undefined); };
            const failed = () => { cleanupWait(); reject(new Error('SSE_CLOSED')); };
            const cleanupWait = () => {
                res.off('drain', done); res.off('close', failed); res.off('error', failed);
            };
            res.once('drain', done); res.once('close', failed); res.once('error', failed);
        });
    }
    async function writeEvent(event) {
        const frame = sseFrame(event);
        await writeText(frame);
        epoch = event.cursor.dataEpoch;
        lastSent = BigInt(event.cursor.seq);
    }
    async function writeResync(snapshot, reason) {
        await writeEvent(resyncEvent(snapshot, reason));
        queue = queue.filter(event => event.cursor.dataEpoch === epoch && BigInt(event.cursor.seq) > lastSent);
        queueBytes = queue.reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event)), 0);
    }
    async function resyncAtLatest(reason) {
        const current = await archive.snapshot();
        assertValid('EventCursor', current);
        await writeResync(current, current.dataEpoch === epoch ? reason : 'epoch_changed');
    }
    function queueLive(event) {
        if (closed) return;
        let bytes;
        try { bytes = Buffer.byteLength(JSON.stringify(event)); }
        catch { abort(); return; }
        if (queue.length >= LIVE_QUEUE_MAX_EVENTS || queueBytes + bytes > LIVE_QUEUE_MAX_BYTES) {
            // Reconnect replays from the last frame that reached the response.
            // Closing is safer than letting a slow client grow memory without bound.
            abort();
            return;
        }
        queue.push(event);
        queueBytes += bytes;
        if (!replaying) void drainLive();
    }
    async function drainLive() {
        if (closed || replaying || draining) return;
        draining = true;
        try {
            while (!closed && queue.length) {
                const event = queue.shift();
                queueBytes -= Buffer.byteLength(JSON.stringify(event));
                assertValid('Event', event);
                if (event.cursor.dataEpoch !== epoch) {
                    await resyncAtLatest('epoch_changed');
                    continue;
                }
                const sequence = BigInt(event.cursor.seq);
                if (sequence <= lastSent) continue;
                if (sequence !== lastSent + 1n) {
                    await resyncAtLatest('cursor_expired');
                    continue;
                }
                await writeEvent(event);
            }
        } catch {
            if (!closed) abort();
        } finally {
            draining = false;
            if (!closed && !replaying && queue.length) void drainLive();
        }
    }

    res.on('close', cleanup);
    res.on('error', cleanup);
    try {
        // Subscribe before reading the watermark. Events committed during the
        // snapshot/replay window queue here and are drained after durable replay.
        unsubscribe = archive.onEvent(queueLive);
        const watermark = await archive.snapshot();
        assertValid('EventCursor', watermark);
        if (resume && resume.dataEpoch === watermark.dataEpoch && BigInt(resume.seq) > BigInt(watermark.seq)) {
            throw invalid('Last-Event-ID está por delante del archivo.');
        }
        if (res.destroyed) { cleanup(); return; }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Request-Id': context.requestId
        });
        const authLifetime = Number.isSafeInteger(context.expiresAt)
            ? Math.max(1, context.expiresAt - Date.now()) : 25000;
        heartbeat = setInterval(() => {
            if (!closed && !res.writableNeedDrain) res.write(': ping\n\n');
        }, 15000);
        heartbeat.unref?.();
        // The proxy signs each reconnect again. Ending no later than this signed
        // grant makes permission revocation effective on the next connection.
        authExpiry = setTimeout(end, authLifetime);
        authExpiry.unref?.();
        await writeText('retry: 3000\n\n');

        if (resume && resume.dataEpoch !== watermark.dataEpoch) {
            await writeResync(watermark, 'epoch_changed');
        } else if (resume) {
            epoch = watermark.dataEpoch;
            lastSent = BigInt(resume.seq);
            const through = BigInt(watermark.seq);
            let replayed = lastSent;
            let expired = false;
            while (!closed && replayed < through) {
                const page = await archive.eventsPage({ after: String(replayed), through: watermark.seq, limit: EVENT_REPLAY_PAGE_SIZE });
                assertValid('EventCursor', page.snapshot);
                if (page.snapshot.dataEpoch !== watermark.dataEpoch) {
                    await resyncAtLatest('epoch_changed');
                    expired = true;
                    break;
                }
                if (page.oldestSeq === null || BigInt(page.oldestSeq) > replayed + 1n) {
                    await resyncAtLatest('cursor_expired');
                    expired = true;
                    break;
                }
                if (!page.items.length) {
                    await resyncAtLatest('cursor_expired');
                    expired = true;
                    break;
                }
                for (const event of page.items) {
                    assertValid('Event', event);
                    const sequence = BigInt(event.cursor.seq);
                    if (event.cursor.dataEpoch !== watermark.dataEpoch || sequence !== replayed + 1n) {
                        await resyncAtLatest(event.cursor.dataEpoch !== watermark.dataEpoch ? 'epoch_changed' : 'cursor_expired');
                        expired = true;
                        break;
                    }
                    await writeEvent(event);
                    replayed = sequence;
                }
                if (expired) break;
                if (replayed < through && page.items.length < EVENT_REPLAY_PAGE_SIZE) {
                    await resyncAtLatest('cursor_expired');
                    expired = true;
                    break;
                }
            }
        } else {
            // The id-only checkpoint lets EventSource preserve this watermark
            // even if the connection drops before the first domain event. The
            // client loads a fresh snapshot after opening the stream.
            epoch = watermark.dataEpoch;
            lastSent = BigInt(watermark.seq);
            await writeText(`id: ${epoch}:${lastSent}\n\n`);
        }
        if (closed) return;
        replaying = false;
        void drainLive();
    } catch (error) {
        cleanup();
        if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
        throw error;
    }
}

function safeString(value) {
    if (typeof value !== 'string') return null;
    const input = value.trim().normalize('NFC');
    let cleaned = '';
    for (let i = 0; i < input.length; i += 1) {
        const unit = input.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = input.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) { cleaned += input[i] + input[i + 1]; i += 1; }
            else cleaned += '\ufffd';
        } else if (unit >= 0xdc00 && unit <= 0xdfff) cleaned += '\ufffd';
        else cleaned += input[i];
    }
    if (!cleaned) return null;
    return Array.from(cleaned).slice(0, 200).join('');
}

function phoneDigits(value) {
    if (typeof value !== 'string' || !/^\+?[0-9 ()-]+$/.test(value)) return null;
    const digits = value.replace(/\D/g, '');
    return digits || null;
}

function contactProjection(contacts, nowMs = Date.now()) {
    const exact = new Map();
    const fingerprints = [];
    for (const [key, record] of Object.entries(contacts && typeof contacts === 'object' ? contacts : {})) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const safe = {
            key,
            phone: typeof record.phone === 'string' ? record.phone : null,
            lid: typeof record.lid === 'string' ? record.lid : null,
            savedName: safeString(record.savedName),
            verifiedName: safeString(record.verifiedName),
            pushName: safeString(record.pushName),
            estado: typeof record.estado === 'string' ? record.estado : null,
            handoffAt: typeof record.handoffAt === 'string' ? record.handoffAt : null,
            handoffActive: isHandoffActive(record, nowMs)
        };
        fingerprints.push(safe);
        const candidates = new Set();
        const phone = phoneDigits(safe.phone);
        const lid = phoneDigits(safe.lid);
        if (phone) for (const suffix of ['@s.whatsapp.net', '@c.us', '@hosted']) candidates.add(`${phone}${suffix}`);
        if (lid) for (const suffix of ['@lid', '@hosted.lid']) candidates.add(`${lid}${suffix}`);
        for (const candidate of candidates) {
            const owners = exact.get(candidate) || [];
            owners.push({ key, record, displayName: safe.savedName || safe.verifiedName || safe.pushName || null });
            exact.set(candidate, owners);
        }
    }
    fingerprints.sort((a, b) => a.key.localeCompare(b.key));
    return { exact, revision: stableHash(fingerprints) };
}

function matchingContact(row, projection) {
    const matches = new Map();
    for (const identity of row.identity_keys || []) {
        if (identity.kind !== 'whatsapp_jid' && identity.kind !== 'whatsapp_lid') continue;
        for (const owner of projection.exact.get(identity.exactValue) || []) matches.set(owner.key, owner);
    }
    return { contact: matches.size === 1 ? [...matches.values()][0] : null, conflict: matches.size > 1 };
}

function projectedControl(row, contact, globalPolicy, nowMs, identityConflict) {
    const record = contact?.record;
    const review = row.requires_review === 1 || identityConflict;
    let accessPolicy = 'neutral';
    let automationMode = globalPolicy.globalPaused || globalPolicy.globalMode !== 'allowed_all' ? 'off' : 'ai';
    /** @type {string|null} */
    let takenAt = null;
    /** @type {'operator'|'customer_request'|'external_self'|'legacy_import'|'identity_conflict'|null} */
    let handoffReason = null;
    if (record?.estado === 'permitido') {
        accessPolicy = 'allowed';
        automationMode = globalPolicy.globalPaused ? 'off' : 'ai';
    } else if (record?.estado === 'ignorado') {
        accessPolicy = 'ignored';
        automationMode = 'off';
    } else if (record?.estado === 'handoff' && isHandoffActive(record, nowMs)) {
        accessPolicy = 'allowed';
        automationMode = 'human';
        const parsed = typeof record.handoffAt === 'string' ? Date.parse(record.handoffAt) : NaN;
        takenAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
        handoffReason = 'legacy_import';
    }
    if (review) automationMode = 'off';
    return {
        control: { accessPolicy, automationMode, lifecycle: 'open', ownerId: null,
            controlVersion: '1', contextVersion: '1', status: 'confirmed', takenAt, handoffReason,
            profileKey: null, requiresReview: Boolean(review), reviewReasons: [] },
        requiresReview: Boolean(review)
    };
}

function sqliteProjectedControl(row, globalPolicy) {
    const reviewReasons = row.control_review_reason ? row.control_review_reason.split(',').filter(Boolean) : [];
    const requiresReview = row.requires_review === 1 || Boolean(globalPolicy.requiresReview);
    let automationMode = row.automation_mode;
    if (requiresReview || row.lifecycle === 'resolved' || row.access_policy === 'ignored') automationMode = 'off';
    else if (row.automation_mode !== 'human' && row.access_policy === 'neutral') {
        automationMode = globalPolicy.globalMode === 'allowed_all' ? 'ai' : 'off';
    }
    if (globalPolicy.globalPaused && automationMode === 'ai') automationMode = 'off';
    return { control: { accessPolicy: row.access_policy, automationMode, lifecycle: row.lifecycle,
        ownerId: row.owner_id, controlVersion: row.control_version, contextVersion: row.context_version,
        status: row.control_status, takenAt: row.taken_at, handoffReason: row.handoff_reason,
        profileKey: row.profile_key ?? null, requiresReview, reviewReasons }, requiresReview };
}

function projectConversation(row, projection, globalPolicy, nowMs, authority = 'legacy') {
    const match = matchingContact(row, projection);
    const control = authority === 'sqlite'
        ? sqliteProjectedControl(row, globalPolicy)
        : projectedControl(row, match.contact, globalPolicy, nowMs, match.conflict);
    const historyCoverage = row.capturing_since
        ? { kind: 'capturing_since', capturingSince: row.capturing_since }
        : row.history_observed
            ? { kind: 'provider_sync_observed', capturingSince: row.first_ingested_at || null }
            : { kind: 'partial_import', capturingSince: row.first_ingested_at || null };
    return assertValid('Conversation', {
        id: row.id, accountId: row.account_id, contactId: row.contact_id,
        displayName: match.contact?.displayName || null,
        canonicalIdentityId: row.canonical_id, control: control.control,
        aggregateVersion: row.aggregate_version, lastActivityAt: row.last_activity_at,
        historyCoverage, unreadCount: row.unread_count,
        requiresReview: Boolean(control.requiresReview || match.conflict)
    });
}

function matchesConversation(conversation, filters, search) {
    if (filters.automationMode && conversation.control.automationMode !== filters.automationMode) return false;
    if (filters.lifecycle && conversation.control.lifecycle !== filters.lifecycle) return false;
    if (filters.unreadOnly && conversation.unreadCount === 0) return false;
    if (search && !search.test(conversation.displayName || '')) return false;
    return true;
}

function searchExpression(value) {
    if (!value) return null;
    const escaped = value.normalize('NFKC').toLocaleLowerCase('es-CL').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'iu');
}

function accountStatus(statusValue) {
    const status = typeof statusValue === 'string' ? statusValue : statusValue?.status;
    const detail = statusValue && typeof statusValue === 'object' ? statusValue.detail : null;
    if (status === 'open' || status === 'connected') return 'connected';
    if (status === 'reconnecting' || status === 'connecting') return 'connecting';
    if (status === 'standby') {
        if (typeof detail === 'string' && /auth|token|session|credencial|sin_sesion/i.test(detail)) return 'requires_auth';
        return 'error';
    }
    return 'disconnected';
}

function archiveBoundary(error) {
    if (error instanceof BoundaryError) return error;
    if (['INVALID_LIMIT', 'INVALID_CHANNEL', 'INVALID_READ_CURSOR', 'INVALID_INPUT', 'INVALID_SUMMARY_PERIOD',
        'INVALID_SEARCH_QUERY', 'SEARCH_TOO_COMPLEX'].includes(error?.code)) return invalid('La búsqueda debe incluir entre 1 y 32 términos de texto.');
    if (error?.code === 'CURSOR_EXPIRED') return new BoundaryError(410, 'CURSOR_EXPIRED', 'El archivo cambió durante la búsqueda; inicia la búsqueda de nuevo.');
    if (error?.code === 'DATA_EPOCH_MISMATCH') return new BoundaryError(409, 'DATA_EPOCH_MISMATCH', 'El archivo cambió de época; inicia la búsqueda de nuevo.');
    const pendingResumeErrors = {
        PENDING_RESUME_NOT_AVAILABLE: 'La conversación no está disponible para reanudar entradas pendientes.',
        PENDING_RESUME_SELECTION_STALE: 'La lista cambió. Actualiza las entradas pendientes y vuelve a seleccionarlas.',
        PENDING_RESUME_MESSAGE_NOT_ELIGIBLE: 'Una entrada seleccionada ya no es elegible. Actualiza la lista.'
    };
    if (pendingResumeErrors[error?.code]) return new BoundaryError(409, error.code, pendingResumeErrors[error.code]);
    if (error?.name === 'ControlServiceError') {
        const status = error.status || 409;
        const code = status === 422 ? 'VALIDATION_ERROR' : error.code || 'CONTROL_CONFLICT';
        const messages = {
            CONTROL_AUTHORITY_NOT_ACTIVE: 'El control de conversaciones aún no está activo.',
            CONTROL_SERVICE_NOT_READY: 'El servicio de control no está listo.',
            CONTROL_VERSION_CONFLICT: 'La conversación cambió; vuelve a cargarla.',
            CONTROL_OWNER_CONFLICT: 'La conversación pertenece a otro operador.',
            CONTROL_HUMAN_SEND_IN_FLIGHT: 'Espera a que termine el envío humano antes de cambiar el control.',
            PENDING_RESUME_NOT_AVAILABLE: 'La conversación no está disponible para reanudar entradas pendientes.',
            PENDING_RESUME_SELECTION_STALE: 'La lista cambió. Actualiza las entradas pendientes y vuelve a seleccionarlas.',
            PENDING_RESUME_MESSAGE_NOT_ELIGIBLE: 'Una entrada seleccionada ya no es elegible. Actualiza la lista.',
            IDENTITY_AMBIGUOUS: 'La identidad tiene más de una coincidencia; revisa canal y cuenta.',
            CONVERSATION_NOT_FOUND: 'Conversación no encontrada.',
            CONTROL_TARGET_NOT_FOUND: 'No se encontró una identidad exacta para ese contacto.'
        };
        return new BoundaryError(status, code, messages[error.code] || 'No se pudo cambiar el control de la conversación.');
    }
    const outbound = {
        OUTBOUND_CONTROL_STALE: [409, 'CONTROL_VERSION_CONFLICT', 'El control cambió antes de iniciar el envío. Actualiza el chat.'],
        OUTBOUND_CONTROL_OWNER_CONFLICT: [409, 'CONTROL_OWNER_CONFLICT', 'La conversación pertenece a otro operador.'],
        OUTBOUND_DELIVERY_UNKNOWN: [409, 'OUTBOUND_DELIVERY_UNKNOWN', 'El proveedor pudo haber recibido el mensaje. Revisa el chat antes de intentar enviarlo de nuevo.'],
        OUTBOUND_CLAIM_UNCERTAIN: [409, 'OUTBOUND_DELIVERY_UNKNOWN', 'El proveedor pudo haber recibido el mensaje. Revisa el chat antes de intentar enviarlo de nuevo.'],
        OUTBOUND_IN_PROGRESS: [409, 'OUTBOUND_IN_PROGRESS', 'El envío sigue pendiente de confirmación.'],
        OUTBOUND_CONTROL_REQUIRED: [409, 'CONTROL_VERSION_CONFLICT', 'La solicitud no incluye un estado de control válido.'],
        OUTBOUND_ACCOUNT_CHANGED: [409, 'CHANNEL_NOT_READY', 'La cuenta del canal cambió antes del envío.'],
        OUTBOUND_ACCOUNT_UNAVAILABLE: [409, 'CHANNEL_NOT_READY', 'La cuenta del canal no está disponible.'],
        OUTBOUND_IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_KEY_REUSED', 'El identificador del mensaje ya se usó con otro contenido.'],
        OUTBOUND_INTENT_MISSING: [404, 'NOT_FOUND', 'No se encontró la salida incierta de esta conversación.'],
        OUTBOUND_INTENT_NOT_RECONCILABLE: [409, 'OUTBOUND_RECONCILIATION_CONFLICT', 'Esta salida no admite conciliación desde la conversación.'],
        OUTBOUND_RECONCILIATION_CONFLICT: [409, 'OUTBOUND_RECONCILIATION_CONFLICT', 'La salida ya cambió. Actualiza el hilo antes de conciliarla.'],
        OUTBOUND_MESSAGE_CORRELATION_REQUIRED: [409, 'OUTBOUND_MESSAGE_CORRELATION_REQUIRED', 'Marca aceptado solo con un ID remoto que pueda archivarse.'],
        OUTBOUND_IDENTITY_MISMATCH: [409, 'OUTBOUND_ARCHIVE_RECONCILIATION_FAILED', 'La salida no coincide con la identidad archivada de la conversación.'],
        OUTBOUND_ARCHIVE_RECONCILIATION_FAILED: [409, 'OUTBOUND_ARCHIVE_RECONCILIATION_FAILED', 'El ID remoto no coincide con una salida archivada. Verifica el canal y el mensaje.'],
        OUTBOUND_REJECTED: [409, 'OUTBOUND_REJECTED', 'El canal rechazó el envío. Conservamos el borrador.']
    };
    if (outbound[error?.code]) {
        const [status, code, message] = outbound[error.code];
        return new BoundaryError(status, code, message);
    }
    return new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.');
}

/** @param {() => any} getPolicy @param {any} archive @param {() => any} [getContacts] @param {(channel:string,accountId:string) => any} [getChannelStatus] @param {any} [controlService] @param {(channel:string,accountId:string) => any} [getAdapter] @param {() => Promise<any[]>} [getProfiles] @param {any} [attachmentStore] @param {((input:any) => Promise<any>) | null} [assistConversation] */
function createSessionApi(getPolicy, archive, getContacts = () => ({}), getChannelStatus = (_channel, _accountId) => 'disconnected', controlService = null, getAdapter = () => null, getProfiles = async () => [], attachmentStore = null, assistConversation = null) {
    const readRevisions = new Map();
    return async function route(req, res, context, pathname, requestBody = Buffer.alloc(0)) {
        const capability = capabilityFor(req.method, pathname);
        if (!capability) throw new BoundaryError(404, 'NOT_FOUND', 'Ruta no disponible.');
        requireCapability(context.actor, capability);
        try {
            if (req.method === 'GET' && pathname === '/v1/session') {
                rejectQuery(req);
                const snapshot = await archive.snapshot();
                const body = assertValid('SessionResponse', { actor: context.actor, policy: getPolicy(), snapshot });
                return send(res, 200, body, context.requestId);
            }
            if (req.method === 'GET' && pathname === '/v1/accounts') {
                rejectQuery(req);
                const rows = await archive.accounts();
                const body = assertValid('AccountsResponse', { items: rows.map(row => ({
                    id: row.id, channel: row.channel,
                    displayName: `${row.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} · ${row.id.slice(0, 8)}`,
                    status: accountStatus(getChannelStatus(row.channel, row.id)), capabilities: CAPABILITIES[row.channel]
                })) });
                return send(res, 200, body, context.requestId);
            }
            if (req.method === 'GET' && pathname === '/v1/profiles') {
                rejectQuery(req);
                const profiles = await getProfiles();
                const items = (Array.isArray(profiles) ? profiles : []).flatMap(profile => {
                    if (!profile || typeof profile !== 'object' || typeof profile.key !== 'string'
                        || !/^[A-Za-z0-9_.-]{1,80}$/.test(profile.key)) return [];
                    const name = safeString(typeof profile.nombre === 'string' ? profile.nombre
                        : typeof profile.name === 'string' ? profile.name : profile.key) || profile.key;
                    return [{ key: profile.key, name: Array.from(name).slice(0, 100).join('') }];
                }).sort((left, right) => left.key.localeCompare(right.key)).slice(0, 200);
                return send(res, 200, assertValid('AutomationProfilesResponse', { items }), context.requestId);
            }
            if (req.method === 'GET' && pathname === '/v1/summary') {
                const query = parseQuery(req, 'SummaryQuery');
                const body = assertValid('SummaryResponse', await archive.summary(query));
                return send(res, 200, body, context.requestId);
            }
            const attachmentMatch = /^\/v1\/attachments\/([^/]+)$/.exec(pathname);
            if (req.method === 'GET' && attachmentMatch) {
                rejectQuery(req);
                if (!attachmentStore) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Almacenamiento de adjuntos no disponible.');
                const id = attachmentMatch[1];
                try { assertValid('Id', id); } catch { throw invalid('ID de adjunto inválido.'); }
                const metadata = await archive.attachment({ id });
                if (!metadata) throw new BoundaryError(404, 'NOT_FOUND', 'Adjunto no encontrado o expirado.');
                const conversation = await archive.conversationView({ conversationId: metadata.conversationId, actorId: context.actor.id });
                if (!conversation) throw new BoundaryError(404, 'NOT_FOUND', 'Adjunto no encontrado o expirado.');
                const opened = await attachmentStore.open(id);
                if (!opened) throw new BoundaryError(404, 'NOT_FOUND', 'Adjunto no disponible.');
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': contentDisposition(metadata.fileName),
                    'Content-Length': String(metadata.size),
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'X-Request-Id': context.requestId
                });
                try { await pipeline(opened.stream, res); }
                catch {
                    if (!res.destroyed) res.destroy();
                }
                return;
            }
            if (req.method === 'GET' && pathname === '/v1/events') {
                return await streamEvents(req, res, context, archive);
            }
            if (req.method === 'GET' && pathname === '/v1/conversations') {
                const query = parseQuery(req, 'ConversationsQuery');
                const limit = query.limit ?? 50;
                const filters = {
                    channel: query.channel ?? null, accountId: query.accountId ?? null,
                    automationMode: query.automationMode ?? null, lifecycle: query.lifecycle ?? null,
                    unreadOnly: query.unreadOnly ?? false, search: query.search ?? null
                };
                const nowMs = Date.now();
                const contacts = contactProjection(getContacts(), nowMs);
                const policy = getPolicy();
                const authority = await archive.controlAuthority();
                const readRevision = readRevisions.get(context.actor.id) ?? 0;
                const scope = stableHash({ actorId: context.actor.id, filters, contacts: contacts.revision,
                    policyVersion: policy.policyVersion, readRevision });
                const startSnapshot = await archive.snapshot();
                /** @type {{lastActivityAt:string|null,id:string}|null} */
                let position = null;
                if (query.cursor) {
                    const cursor = decodeCursor(query.cursor, 'conversations');
                    requireEpoch(cursor, startSnapshot);
                    if (cursor.scope !== scope || !cursor.snapshot || cursor.snapshot.seq !== startSnapshot.seq) {
                        throw new BoundaryError(410, 'CURSOR_EXPIRED', 'La bandeja cambió; vuelve a cargar la primera página.');
                    }
                    assertValid('EventCursor', cursor.snapshot);
                    position = cursor.position;
                    if (!position || (position.lastActivityAt !== null && !validate('Timestamp', position.lastActivityAt).valid)
                        || !validate('Id', position.id).valid) throw invalid('Cursor inválido.');
                }
                const search = searchExpression(filters.search);
                const items = [];
                let lastScanned = position;
                /** @type {{lastActivityAt:string|null,id:string}|null} */
                let nextPosition = null;
                let scanned = 0;
                let exhausted = false;
                let moreMatches = false;
                while (scanned < PAGE_SCAN_MAX && !exhausted && !moreMatches) {
                    const batchLimit = Math.min(PAGE_SCAN, PAGE_SCAN_MAX - scanned);
                    const rows = await archive.conversationRows({ actorId: context.actor.id,
                        accountId: filters.accountId, channel: filters.channel, before: lastScanned, limit: batchLimit });
                    if (!rows.length) { exhausted = true; break; }
                    for (const row of rows) {
                        lastScanned = { lastActivityAt: row.last_activity_at, id: row.id };
                        scanned += 1;
                        const conversation = projectConversation(row, contacts, policy, nowMs, authority.mode);
                        if (!matchesConversation(conversation, filters, search)) continue;
                        if (items.length === limit) { moreMatches = true; break; }
                        items.push({ conversation, position: lastScanned });
                    }
                    if (!moreMatches && rows.length < batchLimit) exhausted = true;
                }
                const endSnapshot = await archive.snapshot();
                const endPolicy = getPolicy();
                const endContacts = contactProjection(getContacts(), Date.now());
                if (endSnapshot.dataEpoch !== startSnapshot.dataEpoch) {
                    throw new BoundaryError(409, 'DATA_EPOCH_MISMATCH', 'El archivo cambió de época; vuelve a cargar la vista.');
                }
                if (endSnapshot.seq !== startSnapshot.seq) {
                    throw new BoundaryError(410, 'CURSOR_EXPIRED', 'La bandeja cambió durante la lectura; vuelve a cargarla.');
                }
                if (endPolicy.policyVersion !== policy.policyVersion || endContacts.revision !== contacts.revision
                    || (readRevisions.get(context.actor.id) ?? 0) !== readRevision) {
                    throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El estado de la bandeja cambió durante la lectura; vuelve a cargarla.');
                }
                if (moreMatches && items.length) nextPosition = items[items.length - 1].position;
                else if (!exhausted && lastScanned) nextPosition = lastScanned;
                const nextCursor = nextPosition ? encodeCursor({ v: 1, kind: 'conversations', epoch: startSnapshot.dataEpoch,
                    snapshot: startSnapshot, scope, position: nextPosition }) : null;
                const body = assertValid('ConversationsResponse', {
                    items: items.map(item => item.conversation), nextCursor, snapshot: startSnapshot
                });
                return send(res, 200, body, context.requestId);
            }
            const assistance = /^\/v1\/conversations\/([^/]+)\/assistance$/.exec(pathname);
            if (req.method === 'POST' && assistance) {
                rejectQuery(req);
                requireCapability(context.actor, 'conversations:read');
                if (!archive || typeof assistConversation !== 'function') {
                    throw new BoundaryError(503, 'ASSISTANCE_UNAVAILABLE', 'La asistencia del operador no está disponible.');
                }
                const conversationId = conversationPathId(assistance[1]);
                let request;
                try { request = JSON.parse(requestBody.toString('utf8')); }
                catch { throw invalid('Cuerpo JSON inválido.'); }
                if (!validate('ConversationAssistanceRequest', request).valid) throw invalid('Solicitud de asistencia inválida.');
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                if (row.channel !== 'whatsapp') {
                    throw new BoundaryError(409, 'ASSISTANCE_CHANNEL_UNAVAILABLE', 'La asistencia de cliente solo está habilitada para conversaciones de WhatsApp.');
                }
                const isAssistanceAllowed = (value, activePolicy) => {
                    const allowed = value?.accessPolicy === 'allowed'
                        || value?.accessPolicy === 'neutral' && activePolicy.globalMode === 'allowed_all';
                    return allowed && value?.lifecycle === 'open' && !value.requiresReview && value.status === 'confirmed';
                };
                const authority = await archive.controlAuthority();
                if (authority.mode !== 'sqlite' || !authority.serviceReady) {
                    throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'El servicio de control de conversaciones no está listo.');
                }
                const control = await archive.controlState(conversationId);
                if (!control) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const policy = getPolicy();
                if (!isAssistanceAllowed(control, policy)) {
                    throw new BoundaryError(409, 'ASSISTANCE_NOT_ALLOWED', 'La política o el estado de esta conversación no permite preparar una respuesta.');
                }
                const matchesExpectedSnapshot = value => value.dataEpoch === request.expectedSnapshot.dataEpoch
                    && value.seq === request.expectedSnapshot.seq;
                const startSnapshot = await archive.snapshot();
                if (!matchesExpectedSnapshot(startSnapshot)) {
                    throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El chat cambió; actualiza el historial antes de preparar la asistencia.');
                }
                let archiveContext;
                try {
                    archiveContext = await archive.aiContext({ conversationId,
                        expectedContextVersion: request.expectedContextVersion, limit: 80 });
                } catch (error) {
                    const errorCode = /** @type {{code?: string}} */ (error)?.code;
                    if (errorCode === 'AI_CONTEXT_VERSION_STALE') {
                        throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El contexto del chat cambió; actualízalo antes de preparar la asistencia.');
                    }
                    throw error;
                }
                if (!archiveContext?.throughMessageId) {
                    throw new BoundaryError(409, 'ASSISTANCE_CONTEXT_EMPTY', 'Todavía no hay mensajes disponibles para preparar la asistencia.');
                }
                const sourceMessages = [];
                for (const message of archiveContext.messages) {
                    if (message.deletedAt || !['customer', 'ai', 'operator'].includes(message.authorKind)) continue;
                    const content = message.content;
                    const text = content.type === 'text' ? content.text
                        : content.type === 'oversized' ? '' : content.transcript || content.caption || '';
                    if (typeof text !== 'string' || !text.trim()) continue;
                    sourceMessages.push({ messageId: message.id, authorKind: message.authorKind,
                        occurredAt: message.occurredAt, content: text.trim() });
                }
                const boundedContext = [];
                let remainingChars = 24000;
                for (const message of sourceMessages.slice(-40).reverse()) {
                    if (remainingChars <= 0) break;
                    const content = message.content.slice(0, Math.min(4000, remainingChars));
                    if (!content.trim()) continue;
                    boundedContext.push({ ...message, content });
                    remainingChars -= content.length;
                }
                boundedContext.reverse();
                if (!boundedContext.length) {
                    throw new BoundaryError(409, 'ASSISTANCE_CONTEXT_EMPTY', 'El hilo reciente no contiene texto o transcripciones para resumir.');
                }
                const contextSnapshot = await archive.snapshot();
                if (!matchesExpectedSnapshot(contextSnapshot)) {
                    throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El chat cambió; actualiza el historial antes de preparar la asistencia.');
                }
                let generated;
                const brainRequest = { actorId: context.actor.id, conversationId,
                    contextVersion: archiveContext.contextVersion, throughMessageId: archiveContext.throughMessageId,
                    botProfile: control.profileKey || policy.globalProfileKey || 'default',
                    context: boundedContext.map(({ messageId, authorKind, content }) => ({ messageId, authorKind, content })) };
                const toolResults = [];
                try {
                    generated = await assistConversation({ ...brainRequest, phase: 'plan', toolResults });
                    if (generated?.kind === 'tool_request') {
                        const result = await executeAssistantTool({ archive, actor: context.actor, conversationId,
                            expectedSnapshot: contextSnapshot, request: generated });
                        toolResults.push(result);
                        generated = await assistConversation({ ...brainRequest, phase: 'final', toolResults });
                    }
                } catch (error) {
                    if (error instanceof BoundaryError) throw error;
                    const toolFailure = /** @type {{status?:number,code?:string}} */ (error);
                    if (typeof toolFailure?.status === 'number' && typeof toolFailure?.code === 'string') {
                        const status = toolFailure.status === 504 ? 503 : toolFailure.status;
                        throw new BoundaryError(status, toolFailure.code, toolFailure.code === 'TOOL_TIMEOUT'
                            ? 'La búsqueda de contexto excedió su tiempo límite. No se creó ningún mensaje.'
                            : 'No se pudo ejecutar la herramienta solicitada. No se creó ningún mensaje.');
                    }
                    throw new BoundaryError(503, 'ASSISTANCE_UNAVAILABLE', 'No se pudo generar la asistencia. No se creó ningún mensaje.');
                }
                const endSnapshot = await archive.snapshot();
                if (!matchesExpectedSnapshot(endSnapshot)) {
                    throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El chat cambió durante la generación; descarta el resultado y vuelve a intentarlo.');
                }
                const endAuthority = await archive.controlAuthority();
                if (endAuthority.mode !== 'sqlite' || !endAuthority.serviceReady) {
                    throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'El servicio de control de conversaciones no está listo.');
                }
                const endControl = await archive.controlState(conversationId);
                const endPolicy = getPolicy();
                if (!endControl || !isAssistanceAllowed(endControl, endPolicy)) {
                    throw new BoundaryError(409, 'ASSISTANCE_NOT_ALLOWED', 'La política o el estado de esta conversación cambió durante la generación.');
                }
                if (endControl.contextVersion !== archiveContext.contextVersion
                    || endControl.controlVersion !== control.controlVersion
                    || endPolicy.policyVersion !== policy.policyVersion) {
                    throw new BoundaryError(410, 'CURSOR_EXPIRED', 'El control o la política cambiaron durante la generación; actualiza el chat y vuelve a intentarlo.');
                }
                const referenceSources = [...boundedContext];
                for (const result of toolResults) {
                    if (!matchesExpectedSnapshot(result.snapshot)) {
                        throw new BoundaryError(410, 'CURSOR_EXPIRED', 'La búsqueda de contexto quedó ligada a otro snapshot.');
                    }
                    for (const hit of result.hits) {
                        referenceSources.push({ messageId: hit.messageId, occurredAt: hit.occurredAt,
                            authorKind: hit.authorKind, content: hit.snippet });
                    }
                }
                const byId = new Map(referenceSources.map(message => [message.messageId, message]));
                const references = ids => {
                    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length
                        || ids.some(id => typeof id !== 'string' || !byId.has(id))) {
                        throw new BoundaryError(503, 'ASSISTANCE_RESPONSE_INVALID', 'El servicio de asistencia devolvió referencias que no pertenecen a este hilo.');
                    }
                    return ids.map(messageId => {
                        const source = byId.get(messageId);
                        return { messageId, occurredAt: source.occurredAt, authorKind: source.authorKind };
                    });
                };
                if (!generated || generated.kind && generated.kind !== 'final'
                    || !Array.isArray(generated.summaryPoints) || generated.summaryPoints.length < 1
                    || generated.summaryPoints.length > 6 || typeof generated.draft !== 'string') {
                    throw new BoundaryError(503, 'ASSISTANCE_RESPONSE_INVALID', 'El servicio de asistencia devolvió una respuesta inválida.');
                }
                const body = assertValid('ConversationAssistanceResponse', {
                    conversationId, contextVersion: archiveContext.contextVersion, throughMessageId: archiveContext.throughMessageId,
                    snapshot: contextSnapshot,
                    summaryPoints: generated.summaryPoints.map(point => ({ text: point.text, references: references(point.messageIds) })),
                    draft: generated.draft, draftReferences: references(generated.draftMessageIds)
                });
                return send(res, 200, body, context.requestId);
            }
            const detail = /^\/v1\/conversations\/([^/]+)$/.exec(pathname);
            if (req.method === 'GET' && detail) {
                rejectQuery(req);
                const conversationId = conversationPathId(detail[1]);
                const snapshot = await archive.snapshot();
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const contacts = contactProjection(getContacts());
                const authority = await archive.controlAuthority();
                const conversation = projectConversation(row, contacts, getPolicy(), Date.now(), authority.mode);
                return send(res, 200, assertValid('ConversationResponse', {
                    conversation, channelCapabilities: CAPABILITIES[row.channel], snapshot
                }), context.requestId);
            }
            const pendingResume = /^\/v1\/conversations\/([^/]+)\/pending-resume$/.exec(pathname);
            if (req.method === 'GET' && pendingResume) {
                rejectQuery(req);
                if (!archive) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.');
                const conversationId = conversationPathId(pendingResume[1]);
                const authority = await archive.controlAuthority();
                if (authority.mode !== 'sqlite') throw new BoundaryError(503, 'CONTROL_AUTHORITY_NOT_ACTIVE', 'El control de conversaciones aún no está activo.');
                if (!authority.serviceReady) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'El servicio de control no está listo.');
                const result = await archive.pendingResumeMessages({ conversationId });
                if (!result) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                return send(res, 200, assertValid('PendingResumeResponse', result), context.requestId);
            }
            const outboundReconciliations = /^\/v1\/conversations\/([^/]+)\/outbound-reconciliations$/.exec(pathname);
            if (req.method === 'GET' && outboundReconciliations) {
                if (!archive) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.');
                const conversationId = conversationPathId(outboundReconciliations[1]);
                const query = parseQuery(req, 'OutboundReconciliationQuery');
                const limit = query.limit ?? 50;
                const authority = await archive.controlAuthority();
                if (authority.mode !== 'sqlite') throw new BoundaryError(503, 'CONTROL_AUTHORITY_NOT_ACTIVE', 'El control de conversaciones aún no está activo.');
                if (!authority.serviceReady) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'El servicio de control no está listo.');
                const scope = stableHash({ actorId: context.actor.id, conversationId,
                    state: 'delivery_unknown', sources: ['ai','human'], limit, order: 'createdAt,id:asc' });
                /** @type {{createdAt:string;id:string} | undefined} */
                let after;
                if (query.cursor) {
                    const cursor = decodeCursor(query.cursor, 'outbound-reconciliation');
                    if (cursor.scope !== scope) throw invalid('El cursor pertenece a otra conversación o sesión.');
                    if (!cursor.position || !validate('Timestamp', cursor.position.createdAt).valid
                        || !validate('Id', cursor.position.id).valid) throw invalid('Cursor de conciliación inválido.');
                    after = cursor.position;
                }
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const page = await archive.outboundIntents({ conversationId, state: 'delivery_unknown',
                    sources: ['ai','human'], ...(after ? { after } : {}), limit: limit + 1 });
                const hasMore = page.length > limit;
                const items = page.slice(0, limit).map(intent => ({
                    id: intent.id, conversationId: intent.conversationId, channel: intent.channel, source: intent.source,
                    text: intent.payload?.text, clientMessageId: intent.policy?.clientMessageId ?? null,
                    createdAt: intent.createdAt, sendingAt: intent.sendingAt, updatedAt: intent.updatedAt,
                    errorCode: intent.errorCode
                }));
                const last = items.at(-1);
                const nextCursor = hasMore && last ? encodeCursor({ v: 1, kind: 'outbound-reconciliation', scope,
                    position: { createdAt: last.createdAt, id: last.id } }) : null;
                return send(res, 200, assertValid('OutboundReconciliationResponse', { items, nextCursor }), context.requestId);
            }
            const reconcileOutbound = /^\/v1\/conversations\/([^/]+)\/outbound-intents\/([^/]+)\/reconcile$/.exec(pathname);
            if (req.method === 'POST' && reconcileOutbound) {
                rejectQuery(req);
                if (!archive) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.');
                const conversationId = conversationPathId(reconcileOutbound[1]);
                const intentId = conversationPathId(reconcileOutbound[2]);
                let request;
                try { request = JSON.parse(requestBody.toString('utf8')); }
                catch { throw invalid('Cuerpo JSON inválido.'); }
                if (!validate('ReconcileOutboundIntentRequest', request).valid) throw invalid('Solicitud de conciliación inválida.');
                if (!request.note.trim()) throw invalid('La nota de conciliación es obligatoria.');
                if (request.state === 'accepted' && !request.providerMessageId) {
                    throw invalid('Selecciona o indica el ID remoto de la salida aceptada.');
                }
                if (request.state === 'rejected' && request.providerMessageId !== undefined) {
                    throw invalid('Una salida rechazada no puede incluir un ID remoto.');
                }
                const authority = await archive.controlAuthority();
                if (authority.mode !== 'sqlite') throw new BoundaryError(503, 'CONTROL_AUTHORITY_NOT_ACTIVE', 'El control de conversaciones aún no está activo.');
                if (!authority.serviceReady) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'El servicio de control no está listo.');
                const conversation = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!conversation) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const control = await archive.controlState(conversationId);
                if (control?.ownerId && control.ownerId !== context.actor.id
                    && !context.actor.capabilities.includes('control:override')) {
                    throw new BoundaryError(409, 'CONTROL_OWNER_CONFLICT', 'La conversación pertenece a otro operador.');
                }
                let result;
                try {
                    result = await archive.reconcileConversationOutboundIntent({ conversationId, intentId,
                        actorId: context.actor.id, state: request.state, note: request.note,
                        ...(request.providerMessageId ? { providerMessageId: request.providerMessageId } : {}) });
                } catch (error) { throw archiveBoundary(error); }
                return send(res, 200, assertValid('ReconcileOutboundIntentResponse', {
                    status: result.status, intentId: result.intent.id, state: result.intent.state,
                    reconciledAt: result.intent.reconciledAt
                }), context.requestId);
            }
            const messageSearch = /^\/v1\/conversations\/([^/]+)\/search$/.exec(pathname);
            if (req.method === 'GET' && messageSearch) {
                if (!archive) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.');
                const conversationId = conversationPathId(messageSearch[1]);
                const query = parseQuery(req, 'MessageSearchQuery');
                const limit = query.limit ?? 20;
                const normalized = normalizeSearchQuery(query.query);
                const scope = stableHash({ actorId: context.actor.id, conversationId, terms: normalized.terms, limit,
                    order: 'occurredAt,id:desc' });
                /** @type {{occurredAt:string;id:string} | undefined} */
                let searchAfter;
                /** @type {import('@sdk-bot/contracts').Contract<'EventCursor'> | undefined} */
                let expectedSnapshot;
                if (query.cursor) {
                    const cursor = decodeCursor(query.cursor, 'message-search');
                    if (cursor.scope !== scope) throw invalid('El cursor pertenece a otra búsqueda o conversación.');
                    if (!cursor.snapshot || !validate('EventCursor', cursor.snapshot).valid
                        || cursor.epoch !== cursor.snapshot.dataEpoch) throw invalid('Cursor de búsqueda inválido.');
                    if (!cursor.position || !validate('Timestamp', cursor.position.occurredAt).valid
                        || !validate('Id', cursor.position.id).valid) throw invalid('Cursor de búsqueda inválido.');
                    searchAfter = cursor.position;
                    expectedSnapshot = cursor.snapshot;
                }
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const page = await archive.searchMessages({ conversationId, query: normalized.terms.join(' '), limit,
                    ...(searchAfter && expectedSnapshot ? { after: searchAfter, expectedSnapshot } : {}) });
                const nextCursor = page.nextPosition ? encodeCursor({ v: 1, kind: 'message-search',
                    epoch: page.snapshot.dataEpoch, snapshot: page.snapshot, scope, position: page.nextPosition }) : null;
                return send(res, 200, assertValid('MessageSearchResponse', {
                    items: page.items, nextCursor, snapshot: page.snapshot
                }), context.requestId);
            }
            const messages = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(pathname);
            if (req.method === 'GET' && messages) {
                const conversationId = conversationPathId(messages[1]);
                const query = parseQuery(req, 'MessagesQuery');
                const limit = query.limit ?? 50;
                const snapshot = await archive.snapshot();
                let before;
                const scope = stableHash({ actorId: context.actor.id, conversationId, order: 'occurredAt,id:asc' });
                if (query.cursor) {
                    const cursor = decodeCursor(query.cursor, 'messages');
                    requireEpoch(cursor, snapshot);
                    if (cursor.scope !== scope) throw invalid('Cursor de mensajes de otra conversación o sesión.');
                    before = cursor.position;
                    if (!before || !validate('Timestamp', before.occurredAt).valid || !validate('Id', before.id).valid) throw invalid('Cursor inválido.');
                }
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const page = await archive.messagePage({ conversationId, before, limit });
                const oldest = page.items[0];
                const nextCursor = page.hasMore && oldest ? encodeCursor({ v: 1, kind: 'messages', epoch: snapshot.dataEpoch,
                    scope, position: { occurredAt: oldest.occurredAt, id: oldest.id } }) : null;
                return send(res, 200, assertValid('MessagesResponse', {
                    items: page.items, nextCursor, snapshot
                }), context.requestId);
            }
            if (req.method === 'POST' && messages) {
                rejectQuery(req);
                if (!controlService) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'Servicio de control no disponible.');
                if (!archive || typeof getAdapter !== 'function') throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Envío desde el panel no disponible.');
                const conversationId = conversationPathId(messages[1]);
                let request;
                try { request = JSON.parse(requestBody.toString('utf8')); }
                catch { throw invalid('Cuerpo JSON inválido.'); }
                if (!validate('SendMessageRequest', request).valid) throw invalid('Solicitud de mensaje inválida.');
                const idempotencyKey = `panel_${context.actor.id}_${conversationId}_${request.clientMessageId}`;
                const existing = await archive.outboundIntent(idempotencyKey);
                if (existing) {
                    if (existing.source !== 'human' || existing.actorId !== context.actor.id
                        || existing.conversationId !== conversationId || existing.payload?.text !== request.text
                        || existing.policy?.clientMessageId !== request.clientMessageId) {
                        throw new BoundaryError(409, 'IDEMPOTENCY_KEY_REUSED', 'El identificador del mensaje ya se usó con otro contenido.');
                    }
                    if (existing.state === 'accepted') {
                        const message = existing.providerMessageId
                            ? await archive.messageByProviderId({ conversationId, providerMessageId: existing.providerMessageId }) : null;
                        if (!message) throw new BoundaryError(409, 'OUTBOUND_DELIVERY_UNKNOWN', 'El envío se aceptó, pero el mensaje no pudo reconciliarse con el historial. Revisa el chat antes de volver a enviarlo.');
                        return send(res, 202, assertValid('SendMessageResponse', {
                            messageId: message.id, clientMessageId: request.clientMessageId
                        }), context.requestId);
                    }
                    if (existing.state === 'delivery_unknown') {
                        throw new BoundaryError(409, 'OUTBOUND_DELIVERY_UNKNOWN', 'El proveedor pudo haber recibido el mensaje. Revisa el chat antes de intentar enviarlo de nuevo.');
                    }
                    if (existing.state === 'sending') {
                        throw new BoundaryError(409, 'OUTBOUND_IN_PROGRESS', 'El envío sigue pendiente de confirmación.');
                    }
                    if (existing.state === 'rejected') {
                        throw archiveBoundary(Object.assign(new Error(existing.errorCode || 'OUTBOUND_REJECTED'), {
                            code: existing.errorCode || 'OUTBOUND_REJECTED'
                        }));
                    }
                }
                const authority = await archive.controlAuthority();
                if (authority.mode !== 'sqlite') throw new BoundaryError(503, 'CONTROL_AUTHORITY_NOT_ACTIVE', 'El control de conversaciones aún no está activo.');
                if (!authority.serviceReady) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'El servicio de control no está listo.');
                const state = await archive.controlState(conversationId);
                if (!state) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                if (state.controlVersion !== request.expectedVersion || state.status !== 'confirmed'
                    || state.automationMode !== 'human' || state.lifecycle !== 'open' || state.requiresReview
                    || state.accessPolicy === 'ignored') {
                    throw new BoundaryError(409, 'CONTROL_VERSION_CONFLICT', 'El control cambió o la conversación aún no está disponible para responder. Actualiza el chat.');
                }
                const overrideOwner = Boolean(state.ownerId && state.ownerId !== context.actor.id
                    && context.actor.capabilities.includes('control:override'));
                if (state.ownerId && state.ownerId !== context.actor.id && !overrideOwner) {
                    throw new BoundaryError(409, 'CONTROL_OWNER_CONFLICT', 'La conversación pertenece a otro operador.');
                }
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                const address = await archive.conversationAddress({ conversationId });
                if (!row || !address || address.accountId !== row.account_id || address.channel !== row.channel) {
                    throw new BoundaryError(409, 'IDENTITY_AMBIGUOUS', 'No hay una identidad canónica segura para enviar a este chat.');
                }
                if (request.handledThroughInboundSeq !== undefined
                    && BigInt(request.handledThroughInboundSeq) > BigInt(row.inbound_seq)) {
                    throw new BoundaryError(409, 'CONTROL_VERSION_CONFLICT', 'Los mensajes visibles cambiaron. Actualiza el chat antes de responder.');
                }
                if (!CAPABILITIES[address.channel].reply || accountStatus(getChannelStatus(address.channel, address.accountId)) !== 'connected') {
                    throw new BoundaryError(409, 'CHANNEL_NOT_READY', 'Conecta la cuenta del canal antes de enviar.');
                }
                const adapter = getAdapter(address.channel, address.accountId);
                if (!adapter || adapter.accountId !== address.accountId) {
                    throw new BoundaryError(409, 'CHANNEL_NOT_READY', 'La conexión del canal cambió. Actualiza su estado e inténtalo de nuevo.');
                }
                const policy = await archive.controlPolicy();
                const controlSnapshot = { conversationId, controlVersion: state.controlVersion,
                    contextVersion: state.contextVersion, policyVersion: policy.policyVersion };
                let result;
                try {
                    result = await adapter.sendMessage(`${address.channel}:${address.exactValue}`, request.text, {
                        source: 'human', actorId: context.actor.id, idempotencyKey, conversationId,
                        controlSnapshot, policy: { clientMessageId: request.clientMessageId, overrideOwner,
                            ...(request.handledThroughInboundSeq !== undefined
                                ? { handledThroughInboundSeq: request.handledThroughInboundSeq } : {}) }, useMarkdown: false
                    });
                } catch (error) { throw archiveBoundary(error); }
                const intent = result?._outbox;
                if (!intent?.id || intent.state !== 'accepted') {
                    throw new BoundaryError(409, 'OUTBOUND_IN_PROGRESS', 'El envío quedó guardado y espera confirmación.');
                }
                const message = intent.providerMessageId
                    ? await archive.messageByProviderId({ conversationId, providerMessageId: intent.providerMessageId }) : null;
                if (!message) throw new BoundaryError(409, 'OUTBOUND_DELIVERY_UNKNOWN', 'El envío se aceptó, pero el mensaje no pudo reconciliarse con el historial. Revisa el chat antes de volver a enviarlo.');
                if (request.handledThroughInboundSeq !== undefined) {
                    try {
                        const read = await archive.markRead({ conversationId, actorId: context.actor.id,
                            throughInboundSeq: request.handledThroughInboundSeq });
                        if (read) readRevisions.set(context.actor.id, (readRevisions.get(context.actor.id) ?? 0) + 1);
                    } catch { /* A successful provider send stays successful if the local read cursor needs a retry. */ }
                }
                return send(res, 202, assertValid('SendMessageResponse', {
                    messageId: message.id, clientMessageId: request.clientMessageId
                }), context.requestId);
            }
            const read = /^\/v1\/conversations\/([^/]+)\/read$/.exec(pathname);
            if (req.method === 'POST' && read) {
                rejectQuery(req);
                const conversationId = conversationPathId(read[1]);
                let request;
                try { request = JSON.parse(requestBody.toString('utf8')); }
                catch { throw invalid('Cuerpo JSON inválido.'); }
                if (!validate('ReadRequest', request).valid) throw invalid('Cursor de lectura inválido.');
                const result = await archive.markRead({ conversationId, actorId: context.actor.id,
                    throughInboundSeq: request.throughInboundSeq });
                if (!result) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                readRevisions.set(context.actor.id, (readRevisions.get(context.actor.id) ?? 0) + 1);
                return send(res, 200, assertValid('ReadResponse', result), context.requestId);
            }
            const takeover = /^\/v1\/conversations\/([^/]+)\/(takeover|release)$/.exec(pathname);
            if (req.method === 'POST' && takeover) {
                rejectQuery(req);
                if (!controlService) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'Servicio de control no disponible.');
                const conversationId = conversationPathId(takeover[1]);
                let request;
                try { request = JSON.parse(requestBody.toString('utf8')); }
                catch { throw invalid('Cuerpo JSON inválido.'); }
                const contract = takeover[2] === 'takeover' ? 'TakeoverRequest' : 'ReleaseRequest';
                if (!validate(contract, request).valid) throw invalid('Solicitud de control inválida.');
                const idempotencyKey = req.headers?.['idempotency-key'];
                if (!validate('IdempotencyKey', idempotencyKey).valid) {
                    throw invalid('Falta Idempotency-Key válido.');
                }
                if (request.overrideOwner === true) requireCapability(context.actor, 'control:override');
                if (takeover[2] === 'takeover') {
                    const result = await controlService.takeover({ conversationId, actorId: context.actor.id,
                        expectedVersion: request.expectedVersion, overrideOwner: request.overrideOwner === true, idempotencyKey });
                    if (result.status === 'pending') {
                        return send(res, 202, assertValid('TakeoverPendingResponse', { operation: result.operation }), context.requestId);
                    }
                } else {
                    await controlService.release({ conversationId, actorId: context.actor.id,
                        expectedVersion: request.expectedVersion, overrideOwner: request.overrideOwner === true,
                        resumePolicy: request.resumePolicy || 'future_only',
                        pendingInboundIds: request.pendingInboundIds || [], selectionVersion: request.selectionVersion });
                }
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const authority = await archive.controlAuthority();
                const conversation = projectConversation(row, contactProjection(getContacts()), getPolicy(), Date.now(), authority.mode);
                return send(res, 200, assertValid('TakeoverConfirmedResponse', { conversation }), context.requestId);
            }
            const update = /^\/v1\/conversations\/([^/]+)$/.exec(pathname);
            if (req.method === 'PATCH' && update) {
                rejectQuery(req);
                if (!controlService) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'Servicio de control no disponible.');
                const conversationId = conversationPathId(update[1]);
                if (!validate('IdempotencyKey', req.headers?.['idempotency-key']).valid) {
                    throw invalid('Falta Idempotency-Key válido.');
                }
                let request;
                try { request = JSON.parse(requestBody.toString('utf8')); }
                catch { throw invalid('Cuerpo JSON inválido.'); }
                if (!validate('UpdateConversationRequest', request).valid) throw invalid('Solicitud de actualización inválida.');
                await controlService.updateConversation({ conversationId, actorId: context.actor.id,
                    expectedVersion: request.expectedVersion, lifecycle: request.lifecycle,
                    accessPolicy: request.accessPolicy, profileKey: request.profileKey });
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const authority = await archive.controlAuthority();
                const conversation = projectConversation(row, contactProjection(getContacts()), getPolicy(), Date.now(), authority.mode);
                return send(res, 200, assertValid('TakeoverConfirmedResponse', { conversation }), context.requestId);
            }
            const operation = /^\/v1\/operations\/([^/]+)$/.exec(pathname);
            if (req.method === 'GET' && operation) {
                rejectQuery(req);
                if (!controlService) throw new BoundaryError(503, 'CONTROL_SERVICE_NOT_READY', 'Servicio de control no disponible.');
                const operationId = conversationPathId(operation[1]);
                const result = await controlService.operation(operationId);
                if (!result) throw new BoundaryError(404, 'NOT_FOUND', 'Operación no encontrada.');
                return send(res, 200, assertValid('Operation', result), context.requestId);
            }
            throw new BoundaryError(404, 'NOT_FOUND', 'Ruta todavía no disponible.');
        } catch (error) {
            throw archiveBoundary(error);
        }
    };
}

function send(res, status, body, requestId) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Request-Id': requestId });
    res.end(JSON.stringify(body));
}

module.exports = { createSessionApi, capabilityFor, contactProjection, projectConversation };
