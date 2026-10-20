// @ts-check
const crypto = require('node:crypto');
const { assertValid, validate } = require('@sdk-bot/contracts');
const { BoundaryError } = require('../lib/httpBoundary');
const { requireCapability } = require('../lib/panelContext');
const { isHandoffActive } = require('./contactsRepository');

const PAGE_SCAN = 250;
const PAGE_SCAN_MAX = 5000;
const CAPABILITIES = {
    whatsapp: { historySync: true, attachments: true, reply: true, edit: false, deliveryReceipt: false, readReceipt: false },
    telegram: { historySync: false, attachments: true, reply: true, edit: false, deliveryReceipt: false, readReceipt: false }
};

function capabilityFor(method, pathname) {
    if (method === 'GET' && /^\/v1\/(session|accounts|conversations(?:\/[^/]+(?:\/messages)?)?|operations\/[^/]+|events)$/.test(pathname)) return 'conversations:read';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/(takeover|release)$/.test(pathname)) return 'control:write';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/messages$/.test(pathname)) return 'messages:send';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/read$/.test(pathname)) return 'conversations:read';
    if (method === 'PATCH' && /^\/v1\/conversations\/[^/]+$/.test(pathname)) return 'conversations:write';
    return null;
}

function invalid(message = 'Parámetros inválidos.') {
    return new BoundaryError(422, 'VALIDATION_ERROR', message);
}

function currentUrl(req) {
    try { return new URL(req.url || '/', 'http://gateway.local'); }
    catch { throw invalid('URL inválida.'); }
}

function parseQuery(req, contract) {
    const url = currentUrl(req);
    const allowed = contract === 'ConversationsQuery'
        ? new Set(['cursor', 'limit', 'channel', 'accountId', 'automationMode', 'lifecycle', 'unreadOnly', 'search'])
        : new Set(['cursor', 'limit']);
    const values = new Map();
    for (const [key, value] of url.searchParams) {
        if (!allowed.has(key) || values.has(key)) throw invalid();
        values.set(key, value);
    }
    const result = {};
    if (values.has('cursor')) result.cursor = values.get('cursor');
    if (values.has('limit')) {
        const raw = values.get('limit');
        if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalid();
        result.limit = Number(raw);
    }
    for (const key of ['channel', 'accountId', 'automationMode', 'lifecycle', 'search']) {
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
            controlVersion: '1', contextVersion: '1', status: 'confirmed', takenAt, handoffReason },
        requiresReview: Boolean(review)
    };
}

function projectConversation(row, projection, globalPolicy, nowMs) {
    const match = matchingContact(row, projection);
    const control = projectedControl(row, match.contact, globalPolicy, nowMs, match.conflict);
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
    if (['INVALID_LIMIT', 'INVALID_CHANNEL', 'INVALID_READ_CURSOR', 'INVALID_INPUT'].includes(error?.code)) return invalid();
    return new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.');
}

function createSessionApi(getPolicy, archive, getContacts = () => ({}), getChannelStatus = (_channel, _accountId) => 'disconnected') {
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
                        const conversation = projectConversation(row, contacts, policy, nowMs);
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
            const detail = /^\/v1\/conversations\/([^/]+)$/.exec(pathname);
            if (req.method === 'GET' && detail) {
                rejectQuery(req);
                const conversationId = conversationPathId(detail[1]);
                const snapshot = await archive.snapshot();
                const row = await archive.conversationView({ conversationId, actorId: context.actor.id });
                if (!row) throw new BoundaryError(404, 'NOT_FOUND', 'Conversación no encontrada.');
                const contacts = contactProjection(getContacts());
                const conversation = projectConversation(row, contacts, getPolicy(), Date.now());
                return send(res, 200, assertValid('ConversationResponse', {
                    conversation, channelCapabilities: CAPABILITIES[row.channel], snapshot
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
