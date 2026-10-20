const { parentPort, workerData, isMainThread } = require('node:worker_threads');
if (isMainThread) throw new Error('Archive SQL requires a worker.');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { assertValid } = require('@sdk-bot/contracts');
const { retentionCutoff } = require('./eventRetention');
const schema = require('./schema');
let db;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function one(sql, ...params) { return db.prepare(sql).get(...params); }
function run(sql, ...params) { return db.prepare(sql).run(...params); }
function all(sql, ...params) { return db.prepare(sql).all(...params); }
function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}
function snapshot() {
    const row = one('SELECT epoch,seq FROM archive_meta WHERE id=1');
    return { dataEpoch: row.epoch, seq: row.seq };
}
function initialize() {
    const requested = path.resolve(workerData.path);
    fs.mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
    const file = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) fail('UNSAFE_PATH');
    }
    db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    // SQLite owns the OS lock for the full connection lifetime; crash releases it.
    db.exec('BEGIN IMMEDIATE; COMMIT;');
    const version = one('PRAGMA user_version').user_version;
    if (version > 5) fail('SCHEMA_TOO_NEW');
    if (version === 0) transaction(() => {
        db.exec(schema);
        run('INSERT INTO archive_meta VALUES(1,?,?)', randomUUID(), '0');
    });
    if (one('PRAGMA user_version').user_version === 1) transaction(() => {
        db.exec(`CREATE TABLE telegram_cursors (
            account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
            last_update_id TEXT CHECK(last_update_id IS NULL OR last_update_id='0' OR
                (length(last_update_id)<=20 AND last_update_id NOT GLOB '*[^0-9]*' AND substr(last_update_id,1,1) BETWEEN '1' AND '9')),
            updated_at TEXT NOT NULL
        ); PRAGMA user_version=2;`);
    });
    if (one('PRAGMA user_version').user_version === 2) transaction(() => {
        db.exec(`CREATE TABLE legacy_dispatch (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK(status IN ('waiting','pending','dispatched','skipped')),
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
            last_error TEXT,
            created_at TEXT NOT NULL,
            dispatched_at TEXT
        ); CREATE INDEX legacy_dispatch_pending ON legacy_dispatch(status,seq); PRAGMA user_version=3;`);
    });
    if (one('PRAGMA user_version').user_version === 3) transaction(() => {
        db.exec(`CREATE TABLE read_cursors (
            actor_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            through_inbound_seq TEXT NOT NULL CHECK(through_inbound_seq='0' OR (through_inbound_seq NOT GLOB '*[^0-9]*' AND substr(through_inbound_seq,1,1) BETWEEN '1' AND '9')),
            updated_at TEXT NOT NULL,
            PRIMARY KEY(actor_id,conversation_id)
        ); CREATE INDEX messages_unread ON messages(conversation_id,inbound_seq) WHERE inbound_seq IS NOT NULL;
        PRAGMA user_version=4;`);
    });
    if (one('PRAGMA user_version').user_version === 4) transaction(() => {
        db.exec(`ALTER TABLE conversations ADD COLUMN access_policy TEXT NOT NULL DEFAULT 'neutral' CHECK(access_policy IN ('allowed','ignored','neutral'));
        ALTER TABLE conversations ADD COLUMN automation_mode TEXT NOT NULL DEFAULT 'off' CHECK(automation_mode IN ('ai','human','off'));
        ALTER TABLE conversations ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','resolved'));
        ALTER TABLE conversations ADD COLUMN owner_id TEXT;
        ALTER TABLE conversations ADD COLUMN control_version TEXT NOT NULL DEFAULT '1' CHECK(control_version NOT GLOB '*[^0-9]*' AND substr(control_version,1,1) BETWEEN '1' AND '9');
        ALTER TABLE conversations ADD COLUMN context_version TEXT NOT NULL DEFAULT '1' CHECK(context_version NOT GLOB '*[^0-9]*' AND substr(context_version,1,1) BETWEEN '1' AND '9');
        ALTER TABLE conversations ADD COLUMN control_status TEXT NOT NULL DEFAULT 'confirmed' CHECK(control_status IN ('confirmed','taking_control'));
        ALTER TABLE conversations ADD COLUMN taken_at TEXT;
        ALTER TABLE conversations ADD COLUMN handoff_reason TEXT CHECK(handoff_reason IS NULL OR handoff_reason IN ('operator','customer_request','external_self','legacy_import','identity_conflict'));
        ALTER TABLE events ADD COLUMN actor_id TEXT;
        PRAGMA user_version=5;`);
    });
    if (one('PRAGMA integrity_check').integrity_check !== 'ok' || all('PRAGMA foreign_key_check').length) fail('ARCHIVE_CORRUPT');
    if (workerData.restore) transaction(() => {
        while (purge({ now: new Date().toISOString(), limit: 1000 }).remaining) { /* bounded SQL batches before exposure */ }
        run('DELETE FROM events');
        run('UPDATE archive_meta SET epoch=? WHERE id=1', randomUUID());
    });
    // No STT work survives the sole owner's restart. Do not resume/replay it.
    // Keyset batches avoid retaining the entire pending set in memory.
    let after = '';
    for (;;) {
        const pending = all("SELECT id FROM messages WHERE id>? AND json_extract(payload,'$.content.type')='audio' AND json_extract(payload,'$.content.transcriptionStatus')='pending' ORDER BY id LIMIT 500", after);
        if (!pending.length) break;
        transaction(() => pending.forEach(row => updateTranscription({ messageId: row.id, expectedStatus: 'pending', status: 'failed' })));
        after = pending[pending.length - 1].id;
    }
    return { ...snapshot(), schemaVersion: 5, journalMode: one('PRAGMA journal_mode').journal_mode,
        synchronous: one('PRAGMA synchronous').synchronous, threadId: require('node:worker_threads').threadId };
}
function registerAccount(input) {
    if (input.id !== undefined) assertValid('Id', input.id);
    if (!['telegram','whatsapp'].includes(input.channel) || typeof input.providerKey !== 'string' || !input.providerKey.length || input.providerKey.length > 256) fail('INVALID_ACCOUNT');
    const remote = one('SELECT * FROM accounts WHERE channel=? AND provider_key=?', input.channel, input.providerKey);
    if (remote) {
        if (input.id !== undefined && remote.id !== input.id) fail('ACCOUNT_CONFLICT');
        return remote;
    }
    const id = input.id ?? randomUUID();
    if (one('SELECT id FROM accounts WHERE id=?', id)) fail('ACCOUNT_CONFLICT');
    run('INSERT INTO accounts VALUES(?,?,?)', id, input.channel, input.providerKey);
    return one('SELECT * FROM accounts WHERE id=?', id);
}
function telegramCursor(accountId) {
    assertValid('Id', accountId);
    const account = one('SELECT channel FROM accounts WHERE id=?', accountId);
    if (!account || account.channel !== 'telegram') fail('ACCOUNT_MISMATCH');
    return one('SELECT last_update_id FROM telegram_cursors WHERE account_id=?', accountId)?.last_update_id ?? null;
}
function canonicalUpdateId(value) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) fail('INVALID_TELEGRAM_UPDATE_ID');
    if (BigInt(value) > 18446744073709551615n) fail('INVALID_TELEGRAM_UPDATE_ID');
    return value;
}
function captureTelegramBatch(input) {
    assertValid('Id', input.accountId);
    if (!Array.isArray(input.updates) || input.updates.length > 100) fail('INVALID_TELEGRAM_BATCH');
    const account = one('SELECT channel FROM accounts WHERE id=?', input.accountId);
    if (!account || account.channel !== 'telegram') fail('ACCOUNT_MISMATCH');
    const row = one('SELECT last_update_id FROM telegram_cursors WHERE account_id=?', input.accountId);
    let cursor = row?.last_update_id ?? null;
    let previousInBatch = null;
    const results = [];
    for (const update of input.updates) {
        const updateId = canonicalUpdateId(update?.updateId);
        const value = BigInt(updateId);
        if (previousInBatch !== null && value <= previousInBatch) fail('INVALID_TELEGRAM_BATCH');
        previousInBatch = value;
        if (cursor !== null && value <= BigInt(cursor)) {
            results.push({ updateId, status: 'stale' });
            continue;
        }
        if (update.message !== null) {
            const message = update.message;
            if (message.identity?.accountId !== input.accountId || message.identity?.channel !== 'telegram'
                || message.identity?.kind !== 'telegram_chat_id' || message.source !== 'live'
                || message.direction !== 'inbound' || message.authorKind !== 'customer') fail('INVALID_TELEGRAM_CAPTURE');
            const result = ingest(message);
            results.push({ updateId, status: result.status, result });
        } else results.push({ updateId, status: 'excluded' });
        cursor = updateId;
    }
    if (cursor !== null && cursor !== (row?.last_update_id ?? null)) {
        run(`INSERT INTO telegram_cursors(account_id,last_update_id,updated_at) VALUES(?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET last_update_id=excluded.last_update_id,updated_at=excluded.updated_at`,
        input.accountId, cursor, new Date().toISOString());
    }
    pruneRetainedEvents();
    return { lastUpdateId: cursor, results };
}
function lookup(key) {
    assertValid('IdentityKey', key);
    const account = one('SELECT channel FROM accounts WHERE id=?', key.accountId);
    if (!account || account.channel !== key.channel) fail('ACCOUNT_MISMATCH');
    return one('SELECT * FROM identities WHERE account_id=? AND kind=? AND exact_value=?', key.accountId, key.kind, key.exactValue);
}
function resolve(key) {
    const existing = lookup(key);
    if (existing) return existing;
    const id = randomUUID(), contact = randomUUID(), conversation = randomUUID();
    run('INSERT INTO contacts VALUES(?,?)', contact, key.accountId);
    run('INSERT INTO conversations(id,account_id,contact_id,canonical_id) VALUES(?,?,?,?)', conversation, key.accountId, contact, id);
    run('INSERT INTO identities VALUES(?,?,?,?,?,?,?)', id, key.accountId, key.channel, key.kind, key.exactValue, id, conversation);
    return lookup(key);
}
function quarantine(reason, conversation, other = null) {
    const id = randomUUID();
    run('INSERT INTO quarantine VALUES(?,?,?,?,?)', id, reason, conversation, other, new Date().toISOString());
    run('UPDATE conversations SET requires_review=1 WHERE id=? OR id=?', conversation, other);
    return { status: 'quarantined', quarantineId: id };
}
function bindAlias(input) {
    if (!input.evidence || !['adapter','admin'].includes(input.evidence.kind) || typeof input.evidence.reference !== 'string' || !input.evidence.reference.length || input.evidence.reference.length > 256) fail('UNVERIFIED_ALIAS');
    assertValid('IdentityKey', input.alias);
    if (input.canonical.accountId !== input.alias.accountId || input.canonical.channel !== input.alias.channel) fail('ACCOUNT_MISMATCH');
    const canonical = resolve(input.canonical), alias = lookup(input.alias);
    if (alias && alias.canonical_id !== canonical.canonical_id) return quarantine('ALIAS_CONFLICT', canonical.conversation_id, alias.conversation_id);
    if (alias) return { status: 'existing', identity: alias };
    const id = randomUUID();
    run('INSERT INTO identities VALUES(?,?,?,?,?,?,?)', id, input.alias.accountId, input.alias.channel, input.alias.kind, input.alias.exactValue, canonical.canonical_id, canonical.conversation_id);
    run('INSERT INTO aliases VALUES(?,?,?,?,?)', id, canonical.canonical_id, input.evidence.kind, input.evidence.reference, new Date().toISOString());
    // All aliases reference the existing canonical key, including old fingerprints.
    // Two already independent histories are quarantined, never silently merged.
    return { status: 'linked', identity: lookup(input.alias) };
}
function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}
const LEGACY_METADATA = new Set(['pushName','savedName','phoneNumber','lid','isBusiness','country','isFromMe','isAdminChannel']);
function legacyDispatch(input, message) {
    const value = input.legacyDispatch;
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.message
        || typeof value.message !== 'object' || Array.isArray(value.message)) fail('INVALID_LEGACY_DISPATCH');
    const envelope = value.message, metadata = envelope.metadata;
    if (envelope.channel !== input.identity.channel || !['whatsapp','telegram'].includes(envelope.channel)
        || envelope.rawId !== input.identity.exactValue
        || envelope.channel === 'whatsapp' && !['whatsapp_jid','whatsapp_lid'].includes(input.identity.kind)
        || envelope.channel === 'telegram' && input.identity.kind !== 'telegram_chat_id'
        || typeof envelope.rawId !== 'string' || !envelope.rawId.length || envelope.rawId.length > 256
        || envelope.remoteId !== `${envelope.channel}:${envelope.rawId}`
        || typeof envelope.text !== 'string' || !envelope.text.isWellFormed() || Buffer.byteLength(envelope.text) > 65536
        || typeof envelope.transcript !== 'string' || !envelope.transcript.isWellFormed() || Buffer.byteLength(envelope.transcript) > 65536
        || typeof envelope.isAudio !== 'boolean' || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).some(key => !LEGACY_METADATA.has(key))
        || metadata.isFromMe !== false || metadata.isAdminChannel !== false
        || typeof value.waitForTranscription !== 'boolean') fail('INVALID_LEGACY_DISPATCH');
    for (const key of ['pushName','savedName','phoneNumber','lid','country']) {
        if (metadata[key] != null && (typeof metadata[key] !== 'string' || !metadata[key].isWellFormed() || metadata[key].length > 256)) fail('INVALID_LEGACY_DISPATCH');
    }
    for (const key of ['isBusiness','isFromMe','isAdminChannel']) if (metadata[key] !== undefined && typeof metadata[key] !== 'boolean') fail('INVALID_LEGACY_DISPATCH');
    if (input.source !== 'live' || input.direction !== 'inbound' || input.authorKind !== 'customer'
        || message.content.type === 'oversized' || message.content.type === 'unsupported') fail('INVALID_LEGACY_DISPATCH');
    const waiting = value.waitForTranscription;
    if (waiting && (message.content.type !== 'audio' || !envelope.isAudio || envelope.text || envelope.transcript)) fail('INVALID_LEGACY_DISPATCH');
    if (!waiting) {
        const storedText = message.content.type === 'text' ? message.content.text : message.content.caption || '';
        if (!storedText || envelope.text !== storedText || envelope.transcript) fail('INVALID_LEGACY_DISPATCH');
    }
    // Message text/transcript already live in messages.payload. Keep only the
    // small StandardMessage routing and contact envelope in this outbox.
    const routing = { channel: envelope.channel, remoteId: envelope.remoteId, rawId: envelope.rawId,
        isAudio: envelope.isAudio, metadata };
    return { status: waiting ? 'waiting' : 'pending', payload: JSON.stringify(routing) };
}
function ingest(input) {
    const identity = resolve(input.identity);
    const c = one('SELECT * FROM conversations WHERE id=?', identity.conversation_id);
    const now = new Date().toISOString();
    const providerId = input.providerMessageId ?? null;
    if (providerId !== null) assertValid('ProviderMessageId', providerId);
    if (!['live','history','import'].includes(input.source)) fail('INVALID_SOURCE');
    let content = input.content;
    const storedText = content?.type === 'text' ? content.text : content?.caption;
    if (typeof storedText === 'string' && Buffer.byteLength(storedText) > 65536) {
        content = { type: 'oversized', originalBytes: Buffer.byteLength(storedText), reason: 'text_limit' };
    }
    const draft = {
        id: randomUUID(), conversationId: c.id, providerMessageId: providerId, clientMessageId: null,
        inboundSeq: input.direction === 'inbound' && input.source === 'live' ? String(BigInt(c.inbound_seq) + 1n) : null,
        direction: input.direction, authorKind: input.direction === 'outbound' && input.source !== 'live' ? 'unknown' : input.authorKind, actorId: null, content,
        occurredAt: input.occurredAt, ingestedAt: now, deliveryStatus: input.direction === 'inbound' ? 'received' : 'sent',
        replyToId: null, source: input.source, deduplicationQuality: providerId === null ? 'unknown' : 'provider_id'
    };
    assertValid('Message', draft);
    draft.occurredAt = new Date(draft.occurredAt).toISOString();
    const dispatch = legacyDispatch(input, draft);
    const digest = createHash('sha256').update(draft.direction + ':' + stable(input.content)).digest('hex');
    const previous = providerId === null ? null : one('SELECT * FROM fingerprints WHERE account_id=? AND canonical_id=? AND provider_id=?', input.identity.accountId, identity.canonical_id, providerId);
    if (previous) {
        if (previous.digest !== digest) return quarantine('MESSAGE_CONFLICT', c.id);
        if (one('SELECT id FROM messages WHERE id=?', previous.message_id)) run('INSERT OR IGNORE INTO provenance VALUES(?,?,?)', previous.message_id, identity.id, input.source);
        return { status: 'duplicate', messageId: previous.message_id, conversationId: c.id };
    }
    run('INSERT INTO messages VALUES(?,?,?,?,?,?,?)', draft.id, c.id, draft.occurredAt, now, draft.inboundSeq, draft.source, JSON.stringify(draft));
    run('INSERT INTO provenance VALUES(?,?,?)', draft.id, identity.id, draft.source);
    if (providerId !== null) run('INSERT INTO fingerprints VALUES(?,?,?,?,?,?)', input.identity.accountId, identity.canonical_id, providerId, draft.id, digest, now);
    const aggregate = String(BigInt(c.aggregate_version) + 1n);
    run(`UPDATE conversations SET aggregate_version=?,inbound_seq=?,last_activity_at=MAX(COALESCE(last_activity_at,''),?),
        capturing_since=CASE WHEN ?='live' THEN COALESCE(capturing_since,?) ELSE capturing_since END,
        history_observed=CASE WHEN ? IN ('history','import') THEN 1 ELSE history_observed END WHERE id=?`,
    aggregate, draft.inboundSeq ?? c.inbound_seq, draft.occurredAt, draft.source, now, draft.source, c.id);
    const event = appendMessageEvent(draft, aggregate, 'message.created', now);
    if (dispatch && c.requires_review === 0) {
        run('INSERT INTO legacy_dispatch(message_id,status,payload,created_at) VALUES(?,?,?,?)', draft.id, dispatch.status, dispatch.payload, now);
    }
    return { status: 'created', message: draft, event };
}
function appendMessageEvent(message, aggregate, type, now) {
    const cursor = snapshot();
    cursor.seq = String(BigInt(cursor.seq) + 1n);
    const event = assertValid('Event', { schemaVersion: 1, cursor, type, occurredAt: now,
        data: { conversationId: message.conversationId, messageId: message.id, aggregateVersion: aggregate } });
    run('INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload) VALUES(?,?,?,?,?,?)',
        cursor.seq, message.conversationId, message.id, now, null, JSON.stringify(event));
    run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
    return event;
}
function controlStateFromRow(row) {
    return { accessPolicy: row.access_policy, automationMode: row.automation_mode,
        lifecycle: row.lifecycle, ownerId: row.owner_id, controlVersion: row.control_version,
        contextVersion: row.context_version, status: row.control_status, takenAt: row.taken_at,
        handoffReason: row.handoff_reason };
}
function controlState(conversationId) {
    assertValid('Id', conversationId);
    const row = one('SELECT * FROM conversations WHERE id=?', conversationId);
    return row ? controlStateFromRow(row) : null;
}
function writeControlState(input) {
    assertValid('Id', input?.conversationId);
    assertValid('Id', input?.actorId);
    assertValid('Version', input?.expectedVersion);
    if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) fail('INVALID_CONTROL_STATE');
    const row = one('SELECT * FROM conversations WHERE id=?', input.conversationId);
    if (!row) return { status: 'missing' };
    const current = controlStateFromRow(row);
    if (input.expectedVersion !== current.controlVersion) return { status: 'conflict', control: current };
    const nextVersion = String(BigInt(current.controlVersion) + 1n);
    const next = { ...input.state, controlVersion: nextVersion, contextVersion: current.contextVersion };
    assertValid('ConversationControl', next);
    const keys = ['accessPolicy','automationMode','lifecycle','ownerId','status','takenAt','handoffReason'];
    if (keys.every(key => next[key] === current[key])) return { status: 'unchanged', control: current };
    const aggregate = String(BigInt(row.aggregate_version) + 1n);
    const now = new Date().toISOString();
    run(`UPDATE conversations SET access_policy=?,automation_mode=?,lifecycle=?,owner_id=?,control_version=?,
        control_status=?,taken_at=?,handoff_reason=?,aggregate_version=? WHERE id=? AND control_version=?`,
    next.accessPolicy, next.automationMode, next.lifecycle, next.ownerId, next.controlVersion,
    next.status, next.takenAt, next.handoffReason, aggregate, input.conversationId, current.controlVersion);
    const cursor = snapshot();
    cursor.seq = String(BigInt(cursor.seq) + 1n);
    const event = assertValid('Event', { schemaVersion: 1, cursor, type: 'control.changed', occurredAt: now,
        data: { conversationId: input.conversationId, aggregateVersion: aggregate, controlVersion: nextVersion } });
    run('INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload) VALUES(?,?,?,?,?,?)',
        cursor.seq, input.conversationId, null, now, input.actorId, JSON.stringify(event));
    run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
    pruneRetainedEvents();
    return { status: 'updated', control: next, event };
}
function pruneRetainedEvents() {
    const cutoff = retentionCutoff(snapshot().seq);
    if (cutoff !== null) {
        run(`DELETE FROM events WHERE length(seq)<length(?) OR (length(seq)=length(?) AND seq<=?)`, cutoff, cutoff, cutoff);
    }
}
function updateTranscription(input) {
    assertValid('Id', input.messageId);
    if (!['not_requested','pending'].includes(input.expectedStatus)
        || !(input.expectedStatus === 'not_requested' ? ['pending','failed'] : ['completed','failed']).includes(input.status)
        || input.status !== 'completed' && input.transcript != null) fail('INVALID_TRANSCRIPTION');
    if (input.status === 'completed') {
        assertValid('StoredText', input.transcript);
        if (!input.transcript.trim()) fail('INVALID_TRANSCRIPTION');
    }
    const row = one('SELECT payload FROM messages WHERE id=?', input.messageId);
    if (!row) return { status: 'missing' }; // Purge never resurrects a body.
    const message = JSON.parse(row.payload);
    if (message.content.type !== 'audio') fail('INVALID_TRANSCRIPTION');
    if (message.content.transcriptionStatus !== input.expectedStatus) return { status: 'unchanged' };
    message.content = { ...message.content, transcriptionStatus: input.status, transcript: input.transcript ?? null };
    assertValid('Message', message);
    const c = one('SELECT aggregate_version FROM conversations WHERE id=?', message.conversationId);
    const aggregate = String(BigInt(c.aggregate_version) + 1n);
    run('UPDATE messages SET payload=? WHERE id=?', JSON.stringify(message), message.id);
    run('UPDATE conversations SET aggregate_version=? WHERE id=?', aggregate, message.conversationId);
    const pendingDispatch = one("SELECT status FROM legacy_dispatch WHERE message_id=? AND status='waiting'", message.id);
    if (pendingDispatch) {
        if (input.status === 'completed') {
            run("UPDATE legacy_dispatch SET status='pending' WHERE message_id=? AND status='waiting'", message.id);
        } else if (input.status === 'failed') {
            run("UPDATE legacy_dispatch SET status='skipped',payload='{}' WHERE message_id=? AND status='waiting'", message.id);
        }
    }
    // Fingerprint, inboundSeq, activity and capture time refer to the original.
    const event = appendMessageEvent(message, aggregate, 'message.updated', new Date().toISOString());
    pruneRetainedEvents();
    return { status: 'updated', message, event };
}
function pendingLegacyDispatches(input = {}) {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_LIMIT');
    return all(`SELECT d.message_id,d.status,d.payload,d.attempts,d.last_error,m.payload message_payload
        FROM legacy_dispatch d JOIN messages m ON m.id=d.message_id
        WHERE d.status='pending' ORDER BY d.seq LIMIT ?`, limit).map(row => {
        const message = JSON.parse(row.payload), stored = JSON.parse(row.message_payload);
        const text = message.isAudio ? stored.content.transcript || ''
            : stored.content.type === 'text' ? stored.content.text : stored.content.caption || '';
        return { messageId: row.message_id, status: row.status,
            message: { ...message, text, transcript: message.isAudio ? text : '' },
            attempts: row.attempts, lastError: row.last_error };
    });
}
function markLegacyDispatched(input) {
    assertValid('Id', input.messageId);
    const now = new Date().toISOString();
    const changed = run("UPDATE legacy_dispatch SET status='dispatched',payload='{}',dispatched_at=?,last_error=NULL WHERE message_id=? AND status='pending'", now, input.messageId).changes;
    return { status: changed ? 'dispatched' : one('SELECT status FROM legacy_dispatch WHERE message_id=?', input.messageId)?.status ?? 'missing' };
}
function retryLegacyDispatch(input) {
    assertValid('Id', input.messageId);
    const code = typeof input.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(input.code) ? input.code : 'HANDLER_FAILED';
    const changed = run("UPDATE legacy_dispatch SET attempts=attempts+1,last_error=? WHERE message_id=? AND status='pending'", code, input.messageId).changes;
    return { status: changed ? 'pending' : one('SELECT status FROM legacy_dispatch WHERE message_id=?', input.messageId)?.status ?? 'missing' };
}
function page(input) {
    assertValid('Id', input.conversationId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT');
    let rows;
    if (input.before) {
        assertValid('Timestamp', input.before.occurredAt); assertValid('Id', input.before.id);
        const beforeTime = new Date(input.before.occurredAt).toISOString();
        rows = all('SELECT payload FROM messages WHERE conversation_id=? AND (occurred_at<? OR (occurred_at=? AND id<?)) ORDER BY occurred_at DESC,id DESC LIMIT ?', input.conversationId, beforeTime, beforeTime, input.before.id, limit);
    } else rows = all('SELECT payload FROM messages WHERE conversation_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?', input.conversationId, limit);
    return rows.reverse().map(row => JSON.parse(row.payload));
}
function conversationPage(input = {}) {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT');
    if (input.before) {
        assertValid('Timestamp', input.before.lastActivityAt);
        assertValid('Id', input.before.id);
        const beforeTime = new Date(input.before.lastActivityAt).toISOString();
        return all(`SELECT * FROM conversations
            WHERE last_activity_at<? OR (last_activity_at=? AND id<?)
            ORDER BY last_activity_at DESC,id DESC LIMIT ?`, beforeTime, beforeTime, input.before.id, limit);
    }
    return all('SELECT * FROM conversations ORDER BY last_activity_at DESC,id DESC LIMIT ?', limit);
}
function conversationRows(input = {}) {
    if (input.actorId !== undefined) assertValid('Id', input.actorId);
    if (input.accountId !== undefined && input.accountId !== null) assertValid('Id', input.accountId);
    if (input.channel !== undefined && input.channel !== null && !['whatsapp', 'telegram'].includes(input.channel)) fail('INVALID_CHANNEL');
    const limit = input.limit ?? 250;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT');
    const params = [input.actorId ?? ''];
    let where = [];
    if (input.accountId) { where.push('c.account_id=?'); params.push(input.accountId); }
    if (input.channel) { where.push('a.channel=?'); params.push(input.channel); }
    if (input.before) {
        assertValid('Id', input.before.id);
        if (input.before.lastActivityAt === null) {
            where.push('c.last_activity_at IS NULL AND c.id<?'); params.push(input.before.id);
        } else {
            assertValid('Timestamp', input.before.lastActivityAt);
            const beforeTime = new Date(input.before.lastActivityAt).toISOString();
            where.push('(c.last_activity_at<? OR (c.last_activity_at=? AND c.id<?) OR c.last_activity_at IS NULL)');
            params.push(beforeTime, beforeTime, input.before.id);
        }
    }
    params.push(limit);
    const rows = all(`SELECT c.*, a.channel,
            (SELECT json_group_array(json_object('kind',i.kind,'exactValue',i.exact_value))
                FROM identities i WHERE i.conversation_id=c.id) AS identity_keys,
            (SELECT MIN(m.ingested_at) FROM messages m WHERE m.conversation_id=c.id) AS first_ingested_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.inbound_seq IS NOT NULL
                AND (length(m.inbound_seq) > length(COALESCE(rc.through_inbound_seq,'0'))
                    OR (length(m.inbound_seq) = length(COALESCE(rc.through_inbound_seq,'0'))
                        AND m.inbound_seq > COALESCE(rc.through_inbound_seq,'0')))) AS unread_count
        FROM conversations c JOIN accounts a ON a.id=c.account_id
        LEFT JOIN read_cursors rc ON rc.conversation_id=c.id AND rc.actor_id=?
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.last_activity_at DESC,c.id DESC LIMIT ?`,
    ...params);
    return rows.map(row => ({ ...row, identity_keys: JSON.parse(row.identity_keys) }));
}
function conversationView(input) {
    assertValid('Id', input?.conversationId);
    assertValid('Id', input?.actorId);
    // The list method is cursor-ordered; details must be looked up by ID without
    // returning other conversations, so use a constrained query with the same DTO.
    const row = one(`SELECT c.*, a.channel,
            (SELECT json_group_array(json_object('kind',i.kind,'exactValue',i.exact_value))
                FROM identities i WHERE i.conversation_id=c.id) AS identity_keys,
            (SELECT MIN(m.ingested_at) FROM messages m WHERE m.conversation_id=c.id) AS first_ingested_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.inbound_seq IS NOT NULL AND (
                length(m.inbound_seq) > length(COALESCE(rc.through_inbound_seq,'0'))
                OR (length(m.inbound_seq) = length(COALESCE(rc.through_inbound_seq,'0'))
                    AND m.inbound_seq > COALESCE(rc.through_inbound_seq,'0')))) AS unread_count
        FROM conversations c JOIN accounts a ON a.id=c.account_id
        LEFT JOIN read_cursors rc ON rc.conversation_id=c.id AND rc.actor_id=? WHERE c.id=?`,
    input.actorId, input.conversationId);
    if (!row) return null;
    row.identity_keys = JSON.parse(row.identity_keys);
    return row;
}
function listAccounts() {
    return all('SELECT id,channel FROM accounts ORDER BY channel,id');
}
function messagePage(input) {
    assertValid('Id', input.conversationId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT');
    let rows;
    if (input.before) {
        assertValid('Timestamp', input.before.occurredAt); assertValid('Id', input.before.id);
        const beforeTime = new Date(input.before.occurredAt).toISOString();
        rows = all('SELECT payload FROM messages WHERE conversation_id=? AND (occurred_at<? OR (occurred_at=? AND id<?)) ORDER BY occurred_at DESC,id DESC LIMIT ?',
            input.conversationId, beforeTime, beforeTime, input.before.id, limit + 1);
    } else rows = all('SELECT payload FROM messages WHERE conversation_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?', input.conversationId, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse().map(row => JSON.parse(row.payload));
    return { items, hasMore };
}
function markRead(input) {
    assertValid('Id', input.conversationId); assertValid('Id', input.actorId);
    assertValid('Sequence', input.throughInboundSeq);
    const conversation = one('SELECT inbound_seq FROM conversations WHERE id=?', input.conversationId);
    if (!conversation) return null;
    const requested = BigInt(input.throughInboundSeq), latest = BigInt(conversation.inbound_seq);
    if (requested > latest) fail('INVALID_READ_CURSOR');
    const existing = one('SELECT through_inbound_seq FROM read_cursors WHERE actor_id=? AND conversation_id=?', input.actorId, input.conversationId);
    const next = requested > BigInt(existing?.through_inbound_seq ?? '0') ? requested : BigInt(existing?.through_inbound_seq ?? '0');
    if (!existing || next > BigInt(existing.through_inbound_seq)) {
        run(`INSERT INTO read_cursors(actor_id,conversation_id,through_inbound_seq,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(actor_id,conversation_id) DO UPDATE SET through_inbound_seq=excluded.through_inbound_seq,updated_at=excluded.updated_at`,
        input.actorId, input.conversationId, String(next), new Date().toISOString());
    }
    return { throughInboundSeq: String(next) };
}
function purge(input) {
    const now = input.now ?? new Date().toISOString();
    assertValid('Timestamp', now);
    const limit = input.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_LIMIT');
    const cutoff = days => new Date(Date.parse(now) - days * 86400000).toISOString();
    const bodies = run('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE ingested_at<? LIMIT ?)', cutoff(90), limit).changes;
    const events = run('DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE created_at<? LIMIT ?)', cutoff(7), limit).changes;
    const fingerprints = run('DELETE FROM fingerprints WHERE rowid IN (SELECT rowid FROM fingerprints WHERE ingested_at<? LIMIT ?)', cutoff(180), limit).changes;
    return { bodies, events, fingerprints, remaining: bodies === limit || events === limit || fingerprints === limit };
}
function eventPage(input) {
    const after = input.after ?? '0';
    assertValid('Sequence', after);
    const current = snapshot();
    const through = input.through ?? current.seq;
    assertValid('Sequence', through);
    const afterValue = BigInt(after), throughValue = BigInt(through), currentValue = BigInt(current.seq);
    if (afterValue > throughValue || throughValue > currentValue) fail('INVALID_EVENT_RANGE');
    const limit = input.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_LIMIT');
    const oldestSeq = one('SELECT seq FROM events ORDER BY length(seq),seq LIMIT 1')?.seq ?? null;
    const items = all(`SELECT payload FROM events
        WHERE (length(seq)>length(?) OR (length(seq)=length(?) AND seq>?))
        AND (length(seq)<length(?) OR (length(seq)=length(?) AND seq<=?))
        ORDER BY length(seq),seq LIMIT ?`, after, after, after, through, through, through, limit)
        .map(row => JSON.parse(row.payload));
    return { items, snapshot: current, oldestSeq };
}
function dispatch(method, input) {
    switch (method) {
        case 'purge': return transaction(() => purge(input));
        case 'snapshot': return snapshot();
        case 'registerAccount': return transaction(() => registerAccount(input));
        case 'telegramCursor': return telegramCursor(input);
        case 'captureTelegramBatch': {
            if (!input || !Array.isArray(input.updates) || !input.updates.length) fail('INVALID_TELEGRAM_BATCH');
            return transaction(() => captureTelegramBatch(input));
        }
        case 'resolve': return transaction(() => resolve(input));
        case 'bindAlias': return transaction(() => bindAlias(input));
        case 'ingestBatch': {
            if (!Array.isArray(input) || !input.length || input.length > 1000) fail('INVALID_BATCH');
            return transaction(() => {
                const results = input.map(ingest);
                pruneRetainedEvents();
                return results;
            });
        }
        case 'updateTranscription': return transaction(() => updateTranscription(input));
        case 'pendingLegacyDispatches': return pendingLegacyDispatches(input);
        case 'markLegacyDispatched': return transaction(() => markLegacyDispatched(input));
        case 'retryLegacyDispatch': return transaction(() => retryLegacyDispatch(input));
        case 'controlState': return controlState(input);
        case 'writeControlState': return transaction(() => writeControlState(input));
        case 'conversation': assertValid('Id', input); return one('SELECT * FROM conversations WHERE id=?', input) ?? null;
        case 'conversations': return conversationPage(input);
        case 'conversationRows': return conversationRows(input);
        case 'conversationView': return conversationView(input);
        case 'accounts': return listAccounts();
        case 'messages': return page(input);
        case 'messagePage': return messagePage(input);
        case 'markRead': return transaction(() => markRead(input));
        case 'events': {
            const after = input.after ?? '0'; assertValid('Sequence', after);
            const limit = input.limit ?? 100;
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_LIMIT');
            return all('SELECT payload FROM events WHERE length(seq)>length(?) OR (length(seq)=length(?) AND seq>?) ORDER BY length(seq),seq LIMIT ?', after, after, after, limit).map(r => JSON.parse(r.payload));
        }
        case 'eventsPage': return eventPage(input ?? {});
        case 'diagnostics': return { ...snapshot(), messages: one('SELECT COUNT(*) n FROM messages').n,
            events: one('SELECT COUNT(*) n FROM events').n, quarantine: one('SELECT COUNT(*) n FROM quarantine').n,
            aliases: one('SELECT COUNT(*) n FROM aliases').n, provenance: one('SELECT COUNT(*) n FROM provenance').n,
            legacyDispatchPending: one("SELECT COUNT(*) n FROM legacy_dispatch WHERE status='pending'").n,
            legacyDispatchWaiting: one("SELECT COUNT(*) n FROM legacy_dispatch WHERE status='waiting'").n,
            integrity: one('PRAGMA integrity_check').integrity_check, foreignKeys: all('PRAGMA foreign_key_check').length };
        case 'backup': {
            if (typeof input !== 'string' || !path.isAbsolute(input)) fail('INVALID_BACKUP_PATH');
            // SQLite rejects an existing/nonempty target; never overwrite snapshots.
            if (fs.existsSync(input)) fail('BACKUP_EXISTS');
            run('VACUUM INTO ?', input); fs.chmodSync(input, 0o600); return snapshot();
        }
        case 'close': db.close(); db = null; return true;
        default: fail('UNKNOWN_OPERATION');
    }
}
function committedEvents(method, value) {
    if (method === 'ingestBatch' && Array.isArray(value)) return value.map(result => result?.event).filter(Boolean);
    if (method === 'captureTelegramBatch' && Array.isArray(value?.results)) {
        return value.results.map(result => result?.result?.event).filter(Boolean);
    }
    if (method === 'updateTranscription' && value?.event) return [value.event];
    if (method === 'writeControlState' && value?.event) return [value.event];
    return [];
}
try {
    parentPort.postMessage({ ready: initialize() });
    parentPort.on('message', ({ id, method, input }) => {
        try {
            const value = dispatch(method, input);
            parentPort.postMessage({ id, value });
            // dispatch() commits each write transaction before returning. Publish
            // only those committed event rows, after the RPC result is queued.
            for (const event of committedEvents(method, value)) parentPort.postMessage({ committedEvent: event });
            if (method === 'close') parentPort.close();
        } catch (error) {
            parentPort.postMessage({ id, error: { code: error.code || 'ARCHIVE_OPERATION_FAILED' } });
        }
    });
} catch (error) {
    try { db?.close(); } catch { /* preserve initial failure */ }
    parentPort.postMessage({ startupError: { code: error.code || 'ARCHIVE_START_FAILED' } });
    parentPort.close();
}
