const { parentPort, workerData, isMainThread } = require('node:worker_threads');
if (isMainThread) throw new Error('Archive SQL requires a worker.');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { assertValid } = require('@sdk-bot/contracts');
const { retentionCutoff } = require('./eventRetention');
const schema = require('./schema');
let db;
const READ_ONLY_METHODS = new Set(['snapshot','telegramCursor','pendingLegacyDispatches','controlState','controlAuthority','controlImportStatus','controlImportEntries',
    'controlPolicy','controlOperation','pendingControlOperations','controlTargets','controlByIdentity',
    'conversation','conversations','conversationRows','conversationView','accounts','messages','messagePage',
    'events','eventsPage','diagnostics','close']);
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
    if (workerData.readOnly) {
        if (!fs.existsSync(requested)) fail('ARCHIVE_NOT_FOUND');
        const parent = fs.realpathSync(path.dirname(requested));
        const file = path.join(parent, path.basename(requested));
        for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
            if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) fail('UNSAFE_PATH');
        }
        if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`) || fs.existsSync(`${file}-journal`)) {
            fail('ARCHIVE_NOT_QUIESCENT');
        }
        // immutable=1 reads only the closed main database and does not create
        // WAL/SHM companions. Refuse sidecars above rather than risk missing
        // committed WAL records or touching another process's snapshot.
        db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
        const schemaVersion = one('PRAGMA user_version').user_version;
        if (![6, 7].includes(schemaVersion)) fail('SCHEMA_VERSION_REQUIRED');
        if (one("SELECT migration_id FROM control_import_migrations WHERE status IN ('cutover_applying','rolling_back') LIMIT 1")) {
            fail('CONTROL_CUTOVER_RECOVERY_REQUIRED');
        }
        if (one('PRAGMA integrity_check').integrity_check !== 'ok' || all('PRAGMA foreign_key_check').length) fail('ARCHIVE_CORRUPT');
        return { ...snapshot(), schemaVersion, journalMode: one('PRAGMA journal_mode').journal_mode,
            synchronous: one('PRAGMA synchronous').synchronous, threadId: require('node:worker_threads').threadId,
            readOnly: true };
    }
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
    if (version > 7) fail('SCHEMA_TOO_NEW');
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
    if (one('PRAGMA user_version').user_version === 5) transaction(() => {
        db.exec(`ALTER TABLE conversations ADD COLUMN profile_key TEXT;
        ALTER TABLE conversations ADD COLUMN control_review_reason TEXT;
        CREATE TABLE control_policy (
            id INTEGER PRIMARY KEY CHECK(id=1),
            global_mode TEXT NOT NULL CHECK(global_mode IN ('allowed_all','ignored_all')),
            global_profile_key TEXT,
            policy_version TEXT NOT NULL DEFAULT '1' CHECK(policy_version NOT GLOB '*[^0-9]*' AND substr(policy_version,1,1) BETWEEN '1' AND '9'),
            requires_review INTEGER NOT NULL DEFAULT 0 CHECK(requires_review IN (0,1)),
            review_reason TEXT
        );
        INSERT INTO control_policy(id,global_mode,global_profile_key) VALUES(1,'ignored_all',NULL);
        CREATE TABLE control_authority (
            id INTEGER PRIMARY KEY CHECK(id=1),
            mode TEXT NOT NULL CHECK(mode IN ('legacy','sqlite')),
            migration_id TEXT,
            service_ready INTEGER NOT NULL DEFAULT 0 CHECK(service_ready IN (0,1)),
            changed_at TEXT
        );
        INSERT INTO control_authority(id,mode,migration_id,service_ready,changed_at) VALUES(1,'legacy',NULL,0,NULL);
        CREATE TABLE control_import_migrations (
            migration_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('staging','blocked','verified','cutover_applying','cutover','rolling_back','rolled_back')),
            base_epoch TEXT NOT NULL,
            base_seq TEXT NOT NULL,
            latest_run_id TEXT,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            cutover_at TEXT
        );
        CREATE TABLE control_import_runs (
            id TEXT PRIMARY KEY,
            migration_id TEXT NOT NULL REFERENCES control_import_migrations(migration_id),
            report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
            report_json TEXT NOT NULL CHECK(json_valid(report_json)),
            archive_epoch TEXT NOT NULL,
            archive_seq TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('staging','blocked','verified','cutover_applying','cutover','rolling_back','rolled_back')),
            created_at TEXT NOT NULL,
            verified_at TEXT
        );
        CREATE INDEX control_import_runs_order ON control_import_runs(migration_id,created_at,id);
        CREATE TABLE control_import_entries (
            run_id TEXT NOT NULL REFERENCES control_import_runs(id) ON DELETE CASCADE,
            source_key TEXT NOT NULL,
            disposition TEXT NOT NULL CHECK(disposition IN ('imported','quarantined','excluded')),
            status TEXT NOT NULL CHECK(status IN ('pending','applied','quarantined','excluded')),
            entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
            PRIMARY KEY(run_id,source_key)
        );
        CREATE INDEX control_import_entries_pending ON control_import_entries(run_id,status,source_key);
        CREATE TABLE control_import_snapshots (
            migration_id TEXT NOT NULL REFERENCES control_import_migrations(migration_id) ON DELETE CASCADE,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            before_state TEXT NOT NULL CHECK(json_valid(before_state)),
            applied_state TEXT NOT NULL CHECK(json_valid(applied_state)),
            applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
            PRIMARY KEY(migration_id,conversation_id)
        );
        CREATE TABLE control_policy_snapshots (
            migration_id TEXT PRIMARY KEY REFERENCES control_import_migrations(migration_id) ON DELETE CASCADE,
            before_state TEXT NOT NULL CHECK(json_valid(before_state)),
            applied_state TEXT NOT NULL CHECK(json_valid(applied_state)),
            applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1))
        );
        PRAGMA user_version=6;`);
    });
    if (one('PRAGMA user_version').user_version === 6) transaction(() => {
        db.exec(`ALTER TABLE events RENAME TO events_v6;
        CREATE TABLE events (
            seq TEXT PRIMARY KEY CHECK(seq NOT GLOB '*[^0-9]*' AND substr(seq,1,1) BETWEEN '1' AND '9'),
            conversation_id TEXT REFERENCES conversations(id),
            message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            actor_id TEXT,
            payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload)
            SELECT seq,conversation_id,message_id,created_at,actor_id,payload FROM events_v6;
        DROP TABLE events_v6;
        CREATE INDEX events_order ON events(length(seq),seq);
        CREATE INDEX events_retention ON events(created_at);
        CREATE TABLE control_operations (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            actor_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type='takeover'),
            status TEXT NOT NULL CHECK(status IN ('taking_control','completed','failed')),
            control_version TEXT NOT NULL CHECK(control_version NOT GLOB '*[^0-9]*' AND substr(control_version,1,1) BETWEEN '1' AND '9'),
            uncertain_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(uncertain_message_ids)),
            idempotency_key TEXT NOT NULL UNIQUE,
            request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
            created_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE INDEX control_operations_pending ON control_operations(status,created_at,id);
        PRAGMA user_version=7;`);
        });
    if (one('PRAGMA integrity_check').integrity_check !== 'ok' || all('PRAGMA foreign_key_check').length) fail('ARCHIVE_CORRUPT');
    const incompleteCutover = one("SELECT migration_id FROM control_import_migrations WHERE status IN ('cutover_applying','rolling_back') LIMIT 1");
    if (incompleteCutover && !workerData.controlRecovery) fail('CONTROL_CUTOVER_RECOVERY_REQUIRED');
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
    return { ...snapshot(), schemaVersion: 7, journalMode: one('PRAGMA journal_mode').journal_mode,
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
        lifecycle=CASE WHEN ?='live' AND ?='inbound' THEN 'open' ELSE lifecycle END,
        capturing_since=CASE WHEN ?='live' THEN COALESCE(capturing_since,?) ELSE capturing_since END,
        history_observed=CASE WHEN ? IN ('history','import') THEN 1 ELSE history_observed END WHERE id=?`,
    aggregate, draft.inboundSeq ?? c.inbound_seq, draft.occurredAt, draft.source, draft.direction,
    draft.source, now, draft.source, c.id);
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
        handoffReason: row.handoff_reason, profileKey: row.profile_key ?? null,
        requiresReview: row.requires_review === 1,
        reviewReasons: row.control_review_reason ? row.control_review_reason.split(',').filter(Boolean) : [] };
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
    const state = { ...input.state };
    for (const key of ['profileKey','requiresReview','reviewReasons']) {
        if (state[key] === undefined) state[key] = current[key];
    }
    const profileChanged = state.profileKey !== current.profileKey;
    const next = { ...state, controlVersion: nextVersion,
        contextVersion: profileChanged ? String(BigInt(current.contextVersion) + 1n) : current.contextVersion };
    assertValid('ConversationControl', next);
    const keys = ['accessPolicy','automationMode','lifecycle','ownerId','status','takenAt','handoffReason',
        'profileKey','requiresReview','reviewReasons'];
    if (keys.every(key => Array.isArray(next[key]) && Array.isArray(current[key])
        ? next[key].length === current[key].length && next[key].every((value, index) => value === current[key][index])
        : next[key] === current[key])) return { status: 'unchanged', control: current };
    const aggregate = String(BigInt(row.aggregate_version) + 1n);
    const now = new Date().toISOString();
    run(`UPDATE conversations SET access_policy=?,automation_mode=?,lifecycle=?,owner_id=?,control_version=?,context_version=?,
        control_status=?,taken_at=?,handoff_reason=?,profile_key=?,requires_review=?,control_review_reason=?,aggregate_version=? WHERE id=? AND control_version=?`,
    next.accessPolicy, next.automationMode, next.lifecycle, next.ownerId, next.controlVersion,
    next.contextVersion, next.status, next.takenAt, next.handoffReason, next.profileKey,
    next.requiresReview ? 1 : 0, next.reviewReasons.length ? [...new Set(next.reviewReasons)].sort().join(',') : null,
    aggregate, input.conversationId, current.controlVersion);
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
function controlPolicy() {
    const row = one('SELECT * FROM control_policy WHERE id=1');
    return { globalMode: row.global_mode, globalProfileKey: row.global_profile_key,
        policyVersion: row.policy_version, requiresReview: row.requires_review === 1, reviewReason: row.review_reason };
}
function writeControlPolicy(input) {
    assertValid('Id', input?.actorId);
    assertValid('Version', input?.expectedVersion);
    if (!['allowed_all','ignored_all'].includes(input?.globalMode)) fail('INVALID_GLOBAL_MODE');
    const profile = input.globalProfileKey ?? null;
    if (profile !== null && (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(profile))) fail('INVALID_GLOBAL_PROFILE');
    const current = controlPolicy();
    if (input.expectedVersion !== current.policyVersion) return { status: 'conflict', policy: current };
    if (input.globalMode === current.globalMode && profile === current.globalProfileKey && !current.requiresReview) {
        return { status: 'unchanged', policy: current };
    }
    const policyVersion = String(BigInt(current.policyVersion) + 1n);
    const now = new Date().toISOString();
    run('UPDATE control_policy SET global_mode=?,global_profile_key=?,policy_version=?,requires_review=0,review_reason=NULL WHERE id=1',
        input.globalMode, profile, policyVersion);
    const cursor = snapshot();
    cursor.seq = String(BigInt(cursor.seq) + 1n);
    const event = assertValid('Event', { schemaVersion: 1, cursor, type: 'policy.updated', occurredAt: now,
        data: { policyVersion } });
    run('INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload) VALUES(?,?,NULL,?,?,?)',
        cursor.seq, null, now, input.actorId, JSON.stringify(event));
    run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
    pruneRetainedEvents();
    return { status: 'updated', policy: controlPolicy(), event };
}
function controlOperationFromRow(row) {
    if (!row) return null;
    return { id: row.id, conversationId: row.conversation_id, actorId: row.actor_id, type: row.type,
        status: row.status, controlVersion: row.control_version,
        uncertainMessageIds: JSON.parse(row.uncertain_message_ids), createdAt: row.created_at,
        completedAt: row.completed_at };
}
function controlOperation(operationId) {
    assertValid('Id', operationId);
    return controlOperationFromRow(one('SELECT * FROM control_operations WHERE id=?', operationId));
}
function pendingControlOperations() {
    return all("SELECT * FROM control_operations WHERE status='taking_control' ORDER BY created_at,id")
        .map(controlOperationFromRow);
}
function appendOperationEvent(operation, aggregateVersion, now) {
    const cursor = snapshot();
    cursor.seq = String(BigInt(cursor.seq) + 1n);
    const event = assertValid('Event', { schemaVersion: 1, cursor, type: 'operation.updated', occurredAt: now,
        data: { conversationId: operation.conversationId, operationId: operation.id, aggregateVersion } });
    run('INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload) VALUES(?,?,NULL,?,?,?)',
        cursor.seq, operation.conversationId, now, operation.actorId, JSON.stringify(event));
    run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
    return event;
}
function beginControlTakeover(input) {
    assertValid('Id', input?.conversationId); assertValid('Id', input?.actorId); assertValid('Version', input?.expectedVersion);
    if (typeof input?.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) fail('INVALID_IDEMPOTENCY_KEY');
    if (typeof input?.overrideOwner !== 'boolean') fail('INVALID_OVERRIDE_OWNER');
    const fingerprint = createHash('sha256').update(JSON.stringify({ actorId: input.actorId,
        conversationId: input.conversationId, expectedVersion: input.expectedVersion,
        overrideOwner: input.overrideOwner })).digest('hex');
    const prior = one('SELECT * FROM control_operations WHERE idempotency_key=?', input.idempotencyKey);
    if (prior) {
        if (prior.request_fingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
        return { status: 'existing', operation: controlOperationFromRow(prior), control: controlState(input.conversationId) };
    }
    const current = controlState(input.conversationId);
    if (!current) return { status: 'missing' };
    if (input.expectedVersion !== current.controlVersion) return { status: 'conflict', control: current };
    if (current.ownerId && current.ownerId !== input.actorId && !input.overrideOwner) return { status: 'owner_conflict', control: current };
    const now = new Date().toISOString();
    const opId = randomUUID();
    const result = writeControlState({ conversationId: input.conversationId, actorId: input.actorId,
        expectedVersion: input.expectedVersion, state: { ...current, automationMode: 'human', ownerId: input.actorId,
            status: 'taking_control', takenAt: current.takenAt || now, handoffReason: 'operator' } });
    if (result.status !== 'updated') return result;
    run(`INSERT INTO control_operations(id,conversation_id,actor_id,type,status,control_version,uncertain_message_ids,
        idempotency_key,request_fingerprint,created_at,completed_at) VALUES(?,?,?,'takeover','taking_control',?,'[]',?,?,?,NULL)`,
        opId, input.conversationId, input.actorId, result.control.controlVersion, input.idempotencyKey, fingerprint, now);
    const operation = controlOperation(opId);
    const operationEvent = appendOperationEvent(operation, String(BigInt(one('SELECT aggregate_version FROM conversations WHERE id=?', input.conversationId).aggregate_version)), now);
    return { status: 'started', operation, control: result.control, events: [result.event, operationEvent] };
}
function completeControlTakeover(input) {
    assertValid('Id', input?.operationId);
    const ids = input.uncertainMessageIds ?? [];
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) fail('INVALID_OPERATION_MESSAGES');
    const row = one('SELECT * FROM control_operations WHERE id=?', input.operationId);
    if (!row) return { status: 'missing' };
    const before = controlOperationFromRow(row);
    if (before.status === 'completed') return { status: 'unchanged', operation: before, control: controlState(row.conversation_id) };
    const control = controlState(row.conversation_id);
    if (!control || control.status !== 'taking_control' || control.controlVersion !== row.control_version) fail('CONTROL_OPERATION_CONFLICT');
    const changed = writeControlState({ conversationId: row.conversation_id, actorId: row.actor_id,
        expectedVersion: control.controlVersion, state: { ...control, status: 'confirmed' } });
    if (changed.status !== 'updated') fail('CONTROL_OPERATION_CONFLICT');
    const now = new Date().toISOString();
    run("UPDATE control_operations SET status='completed',control_version=?,uncertain_message_ids=?,completed_at=? WHERE id=? AND status='taking_control'",
        changed.control.controlVersion, JSON.stringify([...new Set(ids)]), now, row.id);
    const operation = controlOperation(row.id);
    const operationEvent = appendOperationEvent(operation,
        String(BigInt(one('SELECT aggregate_version FROM conversations WHERE id=?', row.conversation_id).aggregate_version)), now);
    return { status: 'completed', operation, control: changed.control, events: [changed.event, operationEvent] };
}
function controlTargets(input) {
    if (!input || !['whatsapp','telegram'].includes(input.channel) || !Array.isArray(input.candidates)
        || !input.candidates.length || input.candidates.length > 512) fail('INVALID_CONTROL_TARGET');
    if (input.accountId !== undefined && input.accountId !== null) assertValid('Id', input.accountId);
    const ids = new Set();
    for (const candidate of input.candidates) {
        assertValid('IdentityKey', candidate);
        if (candidate.channel !== input.channel || (input.accountId && candidate.accountId !== input.accountId)) fail('INVALID_CONTROL_TARGET');
        const row = lookup(candidate);
        if (row) ids.add(row.conversation_id);
    }
    return [...ids].sort().map(conversationId => {
        const row = one('SELECT c.id AS conversation_id,c.account_id,a.channel,c.* FROM conversations c JOIN accounts a ON a.id=c.account_id WHERE c.id=?', conversationId);
        const identities = all('SELECT kind,exact_value FROM identities WHERE conversation_id=? ORDER BY kind,exact_value', conversationId)
            .map(identity => ({ kind: identity.kind, exactValue: identity.exact_value }));
        return { conversationId, accountId: row.account_id, channel: row.channel, identities, control: controlStateFromRow(row) };
    });
}
function controlByIdentity(identity) {
    assertValid('IdentityKey', identity);
    const found = lookup(identity);
    if (!found) return null;
    const row = one('SELECT c.id AS conversation_id,c.account_id,a.channel,c.* FROM conversations c JOIN accounts a ON a.id=c.account_id WHERE c.id=?', found.conversation_id);
    return { conversationId: found.conversation_id, accountId: row.account_id, channel: row.channel,
        control: controlStateFromRow(row) };
}
function controlAuthority() {
    const row = one('SELECT mode,migration_id,service_ready,changed_at FROM control_authority WHERE id=1');
    return { mode: row.mode, migrationId: row.migration_id, serviceReady: row.service_ready === 1, changedAt: row.changed_at };
}
function importReportSummary(report) {
    const { entries, ...summary } = report;
    return { ...summary, entryCount: Array.isArray(entries) ? entries.length : 0 };
}
function controlImportEntries(input) {
    if (typeof input?.runId !== 'string' || !/^[0-9a-f]{64}$/.test(input.runId)) fail('INVALID_IMPORT_RUN_ID');
    const after = input.afterSourceKey ?? '';
    if (typeof after !== 'string') fail('INVALID_IMPORT_CURSOR');
    const limit = input.limit ?? 250;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT');
    const rows = all('SELECT source_key,entry_json FROM control_import_entries WHERE run_id=? AND source_key>? ORDER BY source_key LIMIT ?',
        input.runId, after, limit);
    return rows.map(row => JSON.parse(row.entry_json));
}
function controlImportStatus(migrationId) {
    if (migrationId !== undefined && (typeof migrationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(migrationId))) fail('INVALID_MIGRATION_ID');
    const migration = migrationId
        ? one('SELECT * FROM control_import_migrations WHERE migration_id=?', migrationId)
        : one('SELECT * FROM control_import_migrations ORDER BY updated_at DESC,migration_id LIMIT 1');
    if (!migration) return null;
    const run = migration.latest_run_id ? one('SELECT * FROM control_import_runs WHERE id=?', migration.latest_run_id) : null;
    return { migrationId: migration.migration_id, status: migration.status, baseEpoch: migration.base_epoch,
        baseSeq: migration.base_seq, latestRunId: migration.latest_run_id,
        run: run ? { id: run.id, reportSha256: run.report_sha256, archiveEpoch: run.archive_epoch,
            archiveSeq: run.archive_seq, status: run.status, report: importReportSummary(JSON.parse(run.report_json)) } : null,
        startedAt: migration.started_at, updatedAt: migration.updated_at, cutoverAt: migration.cutover_at };
}
function importReportDigest(report) {
    const stableReport = { ...report };
    delete stableReport.generatedAt;
    return createHash('sha256').update(stableImport(stableReport)).digest('hex');
}
function stableImport(value) {
    if (Array.isArray(value)) return '[' + value.map(stableImport).join(',') + ']';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableImport(value[key])).join(',') + '}';
}
function reportCounts(report) {
    report.counts.imported = report.entries.filter(entry => entry.disposition === 'imported').length;
    report.counts.quarantined = report.entries.filter(entry => entry.disposition === 'quarantined').length;
    report.counts.excluded = report.entries.filter(entry => entry.disposition === 'excluded').length;
    report.counts.requiresReview = report.entries.filter(entry => entry.control?.requiresReview).length;
    report.counts.sourceRecords = report.counts.imported + report.counts.quarantined + report.counts.excluded;
}
function addImportBlocker(report, code, count = 1) {
    const existing = report.blockers.find(blocker => blocker.code === code);
    if (existing) existing.count = (existing.count || 0) + count;
    else report.blockers.push({ code, count });
}
function normalizeDeltaReport(report, previousReport, decisions = {}) {
    const next = JSON.parse(JSON.stringify(report));
    if (!previousReport || !Array.isArray(previousReport.entries)) return next;
    const current = new Map(next.entries.map(entry => [entry.sourceKey, entry]));
    const priorContacts = previousReport.entries.filter(entry => entry.source === 'contact'
        && (entry.disposition === 'imported' || ['source_record_removed','source_record_removed_accepted','identity_target_changed'].includes(entry.reason)));
    let removed = 0;
    let acceptedRemovals = 0;
    let acceptedIdentityChanges = 0;
    for (const previous of priorContacts) {
        const currentEntry = current.get(previous.sourceKey);
        const previousTarget = previous.reviewTargetId || previous.targetId;
        const targetChanged = currentEntry?.disposition === 'imported' && previousTarget
            && previousTarget !== currentEntry.targetId;
        if (targetChanged && !decisions.acceptIdentityChanges) {
            currentEntry.disposition = 'quarantined';
            currentEntry.reason = 'identity_target_changed';
            currentEntry.reviewTargetId = previousTarget;
            delete currentEntry.control;
            addImportBlocker(next, 'identity_target_changed');
        } else if (targetChanged && decisions.acceptIdentityChanges) {
            acceptedIdentityChanges += 1;
        } else if (currentEntry?.disposition === 'imported' && previous.reason === 'identity_target_changed'
            && !decisions.acceptIdentityChanges) {
            currentEntry.disposition = 'quarantined';
            currentEntry.reason = 'identity_target_changed';
            currentEntry.reviewTargetId = previousTarget;
            delete currentEntry.control;
            addImportBlocker(next, 'identity_target_changed');
        } else if (!currentEntry && previous.reason === 'source_record_removed_accepted') {
            next.entries.push(previous);
            removed += 1;
            acceptedRemovals += 1;
        } else if (!currentEntry) {
            const accepted = decisions.acceptSourceRemovals === true;
            next.entries.push({ sourceKey: previous.sourceKey, source: 'contact', sourceChecksum: previous.sourceChecksum,
                disposition: accepted ? 'excluded' : 'quarantined',
                reason: accepted ? 'source_record_removed_accepted' : 'source_record_removed',
                ...(previous.targetId ? { targetId: previous.targetId } : {}) });
            removed += 1;
            if (accepted) acceptedRemovals += 1;
        }
    }
    if (removed) {
        next.delta = { ...(next.delta || {}), removedRecords: removed };
        if (acceptedRemovals) next.delta.acceptedSourceRemovals = acceptedRemovals;
        if (removed > acceptedRemovals) addImportBlocker(next, 'source_record_removed', removed - acceptedRemovals);
    }
    if (acceptedIdentityChanges) next.delta = { ...(next.delta || {}), acceptedIdentityChanges };
    next.blockers = next.blockers.filter(blocker => blocker.code !== 'source_records_quarantined' && blocker.code !== 'records_require_review');
    reportCounts(next);
    if (next.counts.quarantined) addImportBlocker(next, 'source_records_quarantined', next.counts.quarantined);
    if (next.counts.requiresReview) addImportBlocker(next, 'records_require_review', next.counts.requiresReview);
    next.entries.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    next.status = next.blockers.length ? 'review_required' : 'ready';
    next.cutoverAllowed = next.blockers.length === 0;
    return next;
}
function beginControlImport(input) {
    if (typeof input?.migrationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.migrationId)) fail('INVALID_MIGRATION_ID');
    const report = input.report;
    if (!report || report.schemaVersion !== 1 || report.dryRun !== true || !Array.isArray(report.entries)
        || !Array.isArray(report.blockers) || typeof report.cutoverAllowed !== 'boolean') fail('INVALID_IMPORT_REPORT');
    if (![6, 7].includes(report.sourceManifest?.archive?.schemaVersion) || typeof report.sourceManifest.archive.dataEpoch !== 'string'
        || !/^(0|[1-9][0-9]*)$/.test(report.sourceManifest.archive.seq || '')) fail('INVALID_IMPORT_SNAPSHOT');
    const currentSnapshot = snapshot();
    if (report.sourceManifest.archive.dataEpoch !== currentSnapshot.dataEpoch || report.sourceManifest.archive.seq !== currentSnapshot.seq) {
        fail('ARCHIVE_SNAPSHOT_CHANGED');
    }
    const authority = one('SELECT mode FROM control_authority WHERE id=1');
    if (authority.mode !== 'legacy') fail('CONTROL_AUTHORITY_ALREADY_SWITCHED');
    const digest = importReportDigest(report);
    const runId = createHash('sha256').update(`${input.migrationId}:${digest}`).digest('hex');
    const existingRun = one('SELECT id,report_sha256,report_json,status FROM control_import_runs WHERE id=?', runId);
    if (existingRun) {
        if (existingRun.report_sha256 !== digest) fail('IMPORT_RUN_CONFLICT');
        return { migrationId: input.migrationId, runId, status: existingRun.status,
            report: importReportSummary(JSON.parse(existingRun.report_json)), resumed: true };
    }
    const previousMigration = one('SELECT * FROM control_import_migrations WHERE migration_id=?', input.migrationId);
    if (previousMigration && ['cutover','cutover_applying','rolling_back','rolled_back'].includes(previousMigration.status)) {
        fail('IMPORT_MIGRATION_CLOSED');
    }
    let preparedReport = JSON.parse(JSON.stringify(report));
    if (previousMigration?.latest_run_id) {
        const previousRun = one('SELECT report_json FROM control_import_runs WHERE id=?', previousMigration.latest_run_id);
        if (previousRun) preparedReport = normalizeDeltaReport(preparedReport, JSON.parse(previousRun.report_json), input.decisions || {});
    }
    const preparedDigest = importReportDigest(preparedReport);
    const preparedRunId = createHash('sha256').update(`${input.migrationId}:${preparedDigest}`).digest('hex');
    const resumedRun = one('SELECT report_sha256,report_json,status FROM control_import_runs WHERE id=?', preparedRunId);
    if (resumedRun) {
        if (resumedRun.report_sha256 !== preparedDigest) fail('IMPORT_RUN_CONFLICT');
        return { migrationId: input.migrationId, runId: preparedRunId, status: resumedRun.status,
            report: importReportSummary(JSON.parse(resumedRun.report_json)), resumed: true };
    }
    const now = new Date().toISOString();
    if (!previousMigration) {
        run(`INSERT INTO control_import_migrations(migration_id,status,base_epoch,base_seq,latest_run_id,started_at,updated_at,cutover_at)
            VALUES(?,?,?,?,?,?,?,NULL)`, input.migrationId, 'staging', currentSnapshot.dataEpoch, currentSnapshot.seq,
        preparedRunId, now, now);
    } else {
        run("UPDATE control_import_migrations SET status='staging',latest_run_id=?,updated_at=? WHERE migration_id=?",
            preparedRunId, now, input.migrationId);
    }
    run(`INSERT INTO control_import_runs(id,migration_id,report_sha256,report_json,archive_epoch,archive_seq,status,created_at,verified_at)
        VALUES(?,?,?,?,?,?,'staging',?,NULL)`, preparedRunId, input.migrationId, preparedDigest,
    JSON.stringify(preparedReport), currentSnapshot.dataEpoch, currentSnapshot.seq, now);
    return { migrationId: input.migrationId, runId: preparedRunId, status: 'staging',
        report: importReportSummary(preparedReport), resumed: false };
}
function stageControlImportBatch(input) {
    if (typeof input?.runId !== 'string' || !/^[0-9a-f]{64}$/.test(input.runId)
        || !Number.isInteger(input.offset) || input.offset < 0) fail('INVALID_IMPORT_BATCH');
    const runRow = one('SELECT status,report_json FROM control_import_runs WHERE id=?', input.runId);
    if (!runRow) fail('IMPORT_RUN_MISSING');
    if (runRow.status !== 'staging') fail('IMPORT_RUN_NOT_STAGING');
    const reportEntries = JSON.parse(runRow.report_json).entries;
    const limit = input.limit ?? 250;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT');
    const entries = reportEntries.slice(input.offset, input.offset + limit);
    for (const entry of entries) {
        if (typeof entry?.sourceKey !== 'string' || !/^(contact|settings):[0-9a-f]{64}$/.test(entry.sourceKey)
            || !['imported','quarantined','excluded'].includes(entry.disposition)) fail('INVALID_IMPORT_ENTRY');
        const status = entry.disposition === 'imported' ? 'pending' : entry.disposition;
        const value = JSON.stringify(entry);
        const existing = one('SELECT entry_json FROM control_import_entries WHERE run_id=? AND source_key=?', input.runId, entry.sourceKey);
        if (existing) {
            if (existing.entry_json !== value) fail('IMPORT_ENTRY_CONFLICT');
            continue;
        }
        run('INSERT INTO control_import_entries(run_id,source_key,disposition,status,entry_json) VALUES(?,?,?,?,?)',
            input.runId, entry.sourceKey, entry.disposition, status, value);
    }
    return { staged: one('SELECT COUNT(*) AS n FROM control_import_entries WHERE run_id=?', input.runId).n,
        batchCount: entries.length };
}
function verifyControlImport(input) {
    const runRow = one('SELECT * FROM control_import_runs WHERE id=?', input?.runId);
    if (!runRow) fail('IMPORT_RUN_MISSING');
    if (['verified','blocked','cutover'].includes(runRow.status)) return { status: runRow.status,
        report: importReportSummary(JSON.parse(runRow.report_json)) };
    if (runRow.status !== 'staging') fail('IMPORT_RUN_NOT_STAGING');
    const report = JSON.parse(runRow.report_json);
    const staged = one('SELECT COUNT(*) AS n FROM control_import_entries WHERE run_id=?', input.runId).n;
    if (staged !== report.entries.length) fail('IMPORT_STAGE_INCOMPLETE');
    const invalid = one("SELECT COUNT(*) AS n FROM control_import_entries WHERE run_id=? AND ((disposition='imported' AND status!='pending') OR (disposition='quarantined' AND status!='quarantined') OR (disposition='excluded' AND status!='excluded'))", input.runId).n;
    if (invalid) fail('IMPORT_STAGE_INCONSISTENT');
    const noCutover = report.cutoverAllowed !== true || report.blockers.length > 0;
    const status = noCutover ? 'blocked' : 'verified';
    const now = new Date().toISOString();
    run('UPDATE control_import_runs SET status=?,verified_at=? WHERE id=?', status, now, input.runId);
    run('UPDATE control_import_migrations SET status=?,updated_at=? WHERE migration_id=?', status, now, runRow.migration_id);
    return { status, report: importReportSummary(report) };
}
function migrationRow(migrationId) {
    if (typeof migrationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(migrationId)) fail('INVALID_MIGRATION_ID');
    const row = one('SELECT * FROM control_import_migrations WHERE migration_id=?', migrationId);
    if (!row) fail('IMPORT_MIGRATION_MISSING');
    return row;
}
function latestImportRun(migration) {
    if (!migration.latest_run_id) fail('IMPORT_RUN_MISSING');
    const row = one('SELECT * FROM control_import_runs WHERE id=? AND migration_id=?', migration.latest_run_id, migration.migration_id);
    if (!row) fail('IMPORT_RUN_MISSING');
    return row;
}
function setControlServiceReady(input) {
    if (typeof input?.ready !== 'boolean') fail('INVALID_SERVICE_READINESS');
    const status = one("SELECT status FROM control_import_migrations WHERE status IN ('cutover_applying','rolling_back') LIMIT 1");
    if (status) fail('CONTROL_CUTOVER_RECOVERY_REQUIRED');
    run('UPDATE control_authority SET service_ready=?,changed_at=? WHERE id=1', input.ready ? 1 : 0, new Date().toISOString());
    return controlAuthority();
}
function startControlCutover(input) {
    const migration = migrationRow(input?.migrationId);
    const authority = one('SELECT mode,service_ready FROM control_authority WHERE id=1');
    if (authority.mode !== 'legacy') fail('CONTROL_AUTHORITY_ALREADY_SWITCHED');
    if (authority.service_ready !== 1) fail('CONTROL_SERVICE_NOT_READY');
    if (migration.status === 'cutover_applying') return { status: migration.status, runId: migration.latest_run_id };
    if (migration.status !== 'verified') fail('IMPORT_NOT_VERIFIED');
    const runRow = latestImportRun(migration);
    const report = JSON.parse(runRow.report_json);
    if (runRow.status !== 'verified' || report.cutoverAllowed !== true || report.blockers.length) fail('IMPORT_CUTOVER_BLOCKED');
    const now = new Date().toISOString();
    run("UPDATE control_import_migrations SET status='cutover_applying',updated_at=? WHERE migration_id=?", now, migration.migration_id);
    run("UPDATE control_import_runs SET status='cutover_applying' WHERE id=?", runRow.id);
    return { status: 'cutover_applying', runId: runRow.id };
}
function rowControlProjection(row) {
    return { accessPolicy: row.access_policy, automationMode: row.automation_mode,
        lifecycle: row.lifecycle, ownerId: row.owner_id, status: row.control_status,
        takenAt: row.taken_at, handoffReason: row.handoff_reason,
        controlVersion: row.control_version, contextVersion: row.context_version,
        profileKey: row.profile_key, requiresReview: row.requires_review === 1,
        reviewReasons: row.control_review_reason ? row.control_review_reason.split(',') : [] };
}
function importControlProjection(entry) {
    const control = entry.control;
    if (!control || typeof control !== 'object') fail('INVALID_IMPORT_CONTROL');
    const state = { accessPolicy: control.accessPolicy, automationMode: control.automationMode,
        lifecycle: control.lifecycle, ownerId: control.ownerId, controlVersion: '1', contextVersion: '1',
        status: 'confirmed', takenAt: control.takenAt, handoffReason: control.handoffReason,
        profileKey: control.profileKey, requiresReview: control.requiresReview, reviewReasons: control.reviewReasons };
    assertValid('ConversationControl', state);
    if (typeof control.requiresReview !== 'boolean' || !Array.isArray(control.reviewReasons)
        || control.reviewReasons.some(reason => !['invalid_legacy_state','invalid_profile_key','profile_inventory_unavailable','profile_missing'].includes(reason))) {
        fail('INVALID_IMPORT_REVIEW_STATE');
    }
    if (control.profileKey !== null && (typeof control.profileKey !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(control.profileKey))) {
        fail('INVALID_IMPORT_PROFILE');
    }
    return { ...state, profileKey: control.profileKey,
        requiresReview: control.requiresReview, reviewReasons: [...new Set(control.reviewReasons)].sort() };
}
function projectionEquals(left, right) {
    return stable(left) === stable(right);
}
function controlProjectionEquals(left, right) {
    const leftValues = { ...left }, rightValues = { ...right };
    delete leftValues.controlVersion; delete leftValues.contextVersion;
    delete rightValues.controlVersion; delete rightValues.contextVersion;
    return projectionEquals(leftValues, rightValues);
}
function controlSnapshot(row) {
    return { state: rowControlProjection(row), aggregateVersion: row.aggregate_version };
}
function setPolicyFromImport(entry, migrationId) {
    const row = one('SELECT * FROM control_policy WHERE id=1');
    const before = { globalMode: row.global_mode, globalProfileKey: row.global_profile_key,
        policyVersion: row.policy_version, requiresReview: row.requires_review === 1, reviewReason: row.review_reason };
    run(`INSERT OR IGNORE INTO control_policy_snapshots(migration_id,before_state,applied_state,applied)
        VALUES(?,?,?,0)`, migrationId, JSON.stringify(before), JSON.stringify(before));
    let globalMode = row.global_mode;
    let globalProfileKey = row.global_profile_key;
    if (entry.field === 'globalMode') {
        if (!['allowed_all','ignored_all'].includes(entry.plannedValue)) fail('INVALID_IMPORT_GLOBAL_MODE');
        globalMode = entry.plannedValue;
    } else if (entry.field === 'currentProfile') {
        if (typeof entry.plannedProfile !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(entry.plannedProfile)) fail('INVALID_IMPORT_GLOBAL_PROFILE');
        globalProfileKey = entry.plannedProfile;
    } else fail('INVALID_IMPORT_SETTINGS_FIELD');
    const changed = globalMode !== row.global_mode || globalProfileKey !== row.global_profile_key || row.requires_review !== 0 || row.review_reason !== null;
    const policyVersion = changed ? String(BigInt(row.policy_version) + 1n) : row.policy_version;
    run('UPDATE control_policy SET global_mode=?,global_profile_key=?,policy_version=?,requires_review=0,review_reason=NULL WHERE id=1',
        globalMode, globalProfileKey, policyVersion);
    const appliedState = { globalMode, globalProfileKey, policyVersion, requiresReview: false, reviewReason: null };
    run('UPDATE control_policy_snapshots SET applied_state=?,applied=1 WHERE migration_id=?', JSON.stringify(appliedState), migrationId);
    return changed;
}
function applyControlImportEntry(migrationId, entry) {
    if (entry.source === 'settings' || entry.source === 'settings_default') {
        setPolicyFromImport(entry, migrationId);
        return null;
    }
    if (entry.source !== 'contact' || typeof entry.targetId !== 'string') fail('INVALID_IMPORT_TARGET');
    const row = one('SELECT * FROM conversations WHERE id=?', entry.targetId);
    if (!row) fail('IMPORT_TARGET_MISSING');
    const currentState = rowControlProjection(row);
    const desired = importControlProjection(entry);
    const desiredState = { ...desired, controlVersion: currentState.controlVersion, contextVersion: currentState.contextVersion };
    const desiredWithoutVersions = { ...desiredState };
    const currentWithoutVersions = { ...currentState };
    delete desiredWithoutVersions.controlVersion; delete currentWithoutVersions.controlVersion;
    delete desiredWithoutVersions.contextVersion; delete currentWithoutVersions.contextVersion;
    const changed = !projectionEquals(currentWithoutVersions, desiredWithoutVersions);
    run(`INSERT OR IGNORE INTO control_import_snapshots(migration_id,conversation_id,before_state,applied_state,applied)
        VALUES(?,?,?,?,0)`, migrationId, entry.targetId, JSON.stringify(controlSnapshot(row)), JSON.stringify(controlSnapshot(row)));
    const saved = one('SELECT before_state,applied_state FROM control_import_snapshots WHERE migration_id=? AND conversation_id=?', migrationId, entry.targetId);
    if (!projectionEquals(JSON.parse(saved.applied_state), controlSnapshot(row))) fail('IMPORT_APPLY_CONFLICT');
    if (!changed) {
        run('UPDATE control_import_snapshots SET applied=1 WHERE migration_id=? AND conversation_id=?', migrationId, entry.targetId);
        return null;
    }
    const controlVersion = String(BigInt(currentState.controlVersion) + 1n);
    const profileChanged = currentState.profileKey !== desired.profileKey;
    const contextVersion = profileChanged ? String(BigInt(currentState.contextVersion) + 1n) : currentState.contextVersion;
    const aggregateVersion = String(BigInt(row.aggregate_version) + 1n);
    const reviewReason = desired.reviewReasons.length ? desired.reviewReasons.join(',') : null;
    run(`UPDATE conversations SET access_policy=?,automation_mode=?,lifecycle=?,owner_id=?,control_version=?,context_version=?,
        control_status=?,taken_at=?,handoff_reason=?,profile_key=?,requires_review=?,control_review_reason=?,aggregate_version=? WHERE id=?`,
    desired.accessPolicy, desired.automationMode, desired.lifecycle, desired.ownerId, controlVersion, contextVersion,
    desired.status, desired.takenAt, desired.handoffReason, desired.profileKey, desired.requiresReview ? 1 : 0,
    reviewReason, aggregateVersion, entry.targetId);
    const cursor = snapshot();
    cursor.seq = String(BigInt(cursor.seq) + 1n);
    const now = new Date().toISOString();
    const event = assertValid('Event', { schemaVersion: 1, cursor, type: 'control.changed', occurredAt: now,
        data: { conversationId: entry.targetId, aggregateVersion, controlVersion } });
    run('INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload) VALUES(?,?,?,?,NULL,?)',
        cursor.seq, entry.targetId, null, now, JSON.stringify(event));
    run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
    run('UPDATE control_import_snapshots SET applied_state=?,applied=1 WHERE migration_id=? AND conversation_id=?',
        JSON.stringify({ state: rowControlProjection(one('SELECT * FROM conversations WHERE id=?', entry.targetId)), aggregateVersion }),
        migrationId, entry.targetId);
    return event;
}
function applyControlCutoverBatch(input) {
    const migration = migrationRow(input?.migrationId);
    if (migration.status !== 'cutover_applying') fail('CONTROL_CUTOVER_NOT_STARTED');
    const authority = one('SELECT mode,service_ready FROM control_authority WHERE id=1');
    if (authority.mode !== 'legacy' || authority.service_ready !== 1) fail('CONTROL_SERVICE_NOT_READY');
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT');
    const runRow = latestImportRun(migration);
    const rows = all("SELECT source_key,entry_json FROM control_import_entries WHERE run_id=? AND disposition='imported' AND status='pending' ORDER BY source_key LIMIT ?", runRow.id, limit);
    const events = [];
    for (const row of rows) {
        const entry = JSON.parse(row.entry_json);
        const event = applyControlImportEntry(migration.migration_id, entry);
        if (event) events.push(event);
        run("UPDATE control_import_entries SET status='applied' WHERE run_id=? AND source_key=?", runRow.id, row.source_key);
    }
    if (events.length) pruneRetainedEvents();
    const remaining = one("SELECT COUNT(*) AS n FROM control_import_entries WHERE run_id=? AND disposition='imported' AND status='pending'", runRow.id).n;
    return { status: 'cutover_applying', applied: rows.length, remaining, events };
}
function verifyAppliedImport(migration, runRow) {
    const report = JSON.parse(runRow.report_json);
    if (report.cutoverAllowed !== true || report.blockers.length) fail('IMPORT_CUTOVER_BLOCKED');
    const pending = one("SELECT COUNT(*) AS n FROM control_import_entries WHERE run_id=? AND disposition='imported' AND status!='applied'", runRow.id).n;
    if (pending) fail('IMPORT_APPLY_INCOMPLETE');
    const entries = all("SELECT entry_json FROM control_import_entries WHERE run_id=? AND disposition='imported' ORDER BY source_key", runRow.id)
        .map(row => JSON.parse(row.entry_json));
    const expectedByTarget = new Map();
    for (const entry of entries) if (entry.source === 'contact') {
        const desired = importControlProjection(entry);
        const previous = expectedByTarget.get(entry.targetId);
        if (previous && !projectionEquals(previous, desired)) fail('IMPORT_TARGET_CONFLICT');
        expectedByTarget.set(entry.targetId, desired);
    }
    for (const [conversationId, desired] of expectedByTarget) {
        const row = one('SELECT * FROM conversations WHERE id=?', conversationId);
        if (!row || !controlProjectionEquals(rowControlProjection(row), desired)) fail('IMPORT_VERIFY_CONTROL_MISMATCH');
    }
    const policy = one('SELECT global_mode,global_profile_key,requires_review FROM control_policy WHERE id=1');
    if (policy.global_mode !== report.globalPolicy.globalMode || policy.global_profile_key !== report.globalPolicy.globalProfile
        || policy.requires_review !== 0) fail('IMPORT_VERIFY_POLICY_MISMATCH');
    if (one('PRAGMA integrity_check').integrity_check !== 'ok' || all('PRAGMA foreign_key_check').length) fail('ARCHIVE_CORRUPT');
    return report;
}
function finishControlCutover(input) {
    const migration = migrationRow(input?.migrationId);
    if (migration.status !== 'cutover_applying') fail('CONTROL_CUTOVER_NOT_STARTED');
    const authority = one('SELECT mode,service_ready FROM control_authority WHERE id=1');
    if (authority.mode !== 'legacy' || authority.service_ready !== 1) fail('CONTROL_SERVICE_NOT_READY');
    const runRow = latestImportRun(migration);
    verifyAppliedImport(migration, runRow);
    const now = new Date().toISOString();
    run("UPDATE control_authority SET mode='sqlite',migration_id=?,changed_at=? WHERE id=1", migration.migration_id, now);
    run("UPDATE control_import_runs SET status='cutover' WHERE id=?", runRow.id);
    run("UPDATE control_import_migrations SET status='cutover',cutover_at=?,updated_at=? WHERE migration_id=?", now, now, migration.migration_id);
    return { status: 'cutover', authority: controlAuthority(), snapshot: snapshot() };
}
function rollbackControlCutoverBatch(input) {
    const migration = migrationRow(input?.migrationId);
    if (!['cutover_applying','rolling_back','verified','blocked','staging'].includes(migration.status)) fail('IMPORT_ROLLBACK_UNAVAILABLE');
    if (one('SELECT mode FROM control_authority WHERE id=1').mode !== 'legacy') fail('CONTROL_AUTHORITY_ALREADY_SWITCHED');
    if (migration.status !== 'rolling_back') {
        run("UPDATE control_import_migrations SET status='rolling_back',updated_at=? WHERE migration_id=?", new Date().toISOString(), migration.migration_id);
        const runRow = latestImportRun(migration);
        run("UPDATE control_import_runs SET status='rolling_back' WHERE id=?", runRow.id);
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT');
    const snapshots = all('SELECT * FROM control_import_snapshots WHERE migration_id=? AND applied=1 ORDER BY conversation_id LIMIT ?',
        migration.migration_id, limit);
    const events = [];
    for (const saved of snapshots) {
        const row = one('SELECT * FROM conversations WHERE id=?', saved.conversation_id);
        if (!row) fail('IMPORT_ROLLBACK_TARGET_MISSING');
        const appliedState = JSON.parse(saved.applied_state);
        if (!projectionEquals(controlSnapshot(row), appliedState)) fail('IMPORT_ROLLBACK_CONFLICT');
        const before = JSON.parse(saved.before_state);
        const current = rowControlProjection(row);
        const prior = before.state;
        const sameValue = controlProjectionEquals(current, prior);
        if (!sameValue) {
            const controlVersion = String(BigInt(current.controlVersion) + 1n);
            const contextVersion = current.profileKey !== prior.profileKey
                ? String(BigInt(current.contextVersion) + 1n) : current.contextVersion;
            const aggregateVersion = String(BigInt(row.aggregate_version) + 1n);
            run(`UPDATE conversations SET access_policy=?,automation_mode=?,lifecycle=?,owner_id=?,control_version=?,context_version=?,
                control_status=?,taken_at=?,handoff_reason=?,profile_key=?,requires_review=?,control_review_reason=?,aggregate_version=? WHERE id=?`,
            prior.accessPolicy, prior.automationMode, prior.lifecycle, prior.ownerId, controlVersion, contextVersion,
            prior.status, prior.takenAt, prior.handoffReason, prior.profileKey, prior.requiresReview ? 1 : 0,
            prior.reviewReasons.length ? prior.reviewReasons.join(',') : null, aggregateVersion, saved.conversation_id);
            const cursor = snapshot(); cursor.seq = String(BigInt(cursor.seq) + 1n);
            const now = new Date().toISOString();
            const event = assertValid('Event', { schemaVersion: 1, cursor, type: 'control.changed', occurredAt: now,
                data: { conversationId: saved.conversation_id, aggregateVersion, controlVersion } });
            run('INSERT INTO events(seq,conversation_id,message_id,created_at,actor_id,payload) VALUES(?,?,?,?,NULL,?)',
                cursor.seq, saved.conversation_id, null, now, JSON.stringify(event));
            run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
            events.push(event);
        }
        run('UPDATE control_import_snapshots SET applied=0 WHERE migration_id=? AND conversation_id=?', migration.migration_id, saved.conversation_id);
    }
    const remainingConversations = one('SELECT COUNT(*) AS n FROM control_import_snapshots WHERE migration_id=? AND applied=1', migration.migration_id).n;
    if (remainingConversations === 0) {
        const savedPolicy = one('SELECT * FROM control_policy_snapshots WHERE migration_id=? AND applied=1', migration.migration_id);
        if (savedPolicy) {
            const current = one('SELECT * FROM control_policy WHERE id=1');
            const appliedState = JSON.parse(savedPolicy.applied_state);
            const currentState = { globalMode: current.global_mode, globalProfileKey: current.global_profile_key,
                policyVersion: current.policy_version, requiresReview: current.requires_review === 1, reviewReason: current.review_reason };
            if (!projectionEquals(currentState, appliedState)) fail('IMPORT_ROLLBACK_CONFLICT');
            const before = JSON.parse(savedPolicy.before_state);
            const policyVersion = String(BigInt(current.policy_version) + 1n);
            run('UPDATE control_policy SET global_mode=?,global_profile_key=?,policy_version=?,requires_review=?,review_reason=? WHERE id=1',
                before.globalMode, before.globalProfileKey, policyVersion, before.requiresReview ? 1 : 0, before.reviewReason);
            run('UPDATE control_policy_snapshots SET applied=0 WHERE migration_id=?', migration.migration_id);
        }
    }
    const remaining = one('SELECT COUNT(*) AS n FROM control_import_snapshots WHERE migration_id=? AND applied=1', migration.migration_id).n
        + one('SELECT COUNT(*) AS n FROM control_policy_snapshots WHERE migration_id=? AND applied=1', migration.migration_id).n;
    if (events.length) pruneRetainedEvents();
    return { status: 'rolling_back', rolledBack: snapshots.length, remaining, events };
}
function finishControlRollback(input) {
    const migration = migrationRow(input?.migrationId);
    if (migration.status !== 'rolling_back') fail('IMPORT_ROLLBACK_NOT_STARTED');
    if (one("SELECT COUNT(*) AS n FROM control_import_snapshots WHERE migration_id=? AND applied=1", migration.migration_id).n
        || one("SELECT COUNT(*) AS n FROM control_policy_snapshots WHERE migration_id=? AND applied=1", migration.migration_id).n) fail('IMPORT_ROLLBACK_INCOMPLETE');
    const runRow = latestImportRun(migration);
    const now = new Date().toISOString();
    run("UPDATE control_import_runs SET status='rolled_back' WHERE migration_id=? AND status IN ('staging','blocked','verified','cutover_applying','rolling_back')", migration.migration_id);
    run("UPDATE control_import_migrations SET status='rolled_back',updated_at=? WHERE migration_id=?", now, migration.migration_id);
    return { status: 'rolled_back', migrationId: migration.migration_id, latestRunId: runRow.id, authority: controlAuthority() };
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
    if (workerData.readOnly && !READ_ONLY_METHODS.has(method)) fail('READ_ONLY_ARCHIVE');
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
        case 'beginControlTakeover': return transaction(() => beginControlTakeover(input));
        case 'completeControlTakeover': return transaction(() => completeControlTakeover(input));
        case 'controlOperation': return controlOperation(input);
        case 'pendingControlOperations': return pendingControlOperations();
        case 'controlTargets': return controlTargets(input);
        case 'controlByIdentity': return controlByIdentity(input);
        case 'controlPolicy': return controlPolicy();
        case 'writeControlPolicy': return transaction(() => writeControlPolicy(input));
        case 'controlAuthority': return controlAuthority();
        case 'controlImportStatus': return controlImportStatus(input ?? undefined);
        case 'controlImportEntries': return controlImportEntries(input);
        case 'beginControlImport': return transaction(() => beginControlImport(input));
        case 'stageControlImportBatch': return transaction(() => stageControlImportBatch(input));
        case 'verifyControlImport': return transaction(() => verifyControlImport(input));
        case 'setControlServiceReady': return transaction(() => setControlServiceReady(input));
        case 'startControlCutover': return transaction(() => startControlCutover(input));
        case 'applyControlCutoverBatch': return transaction(() => applyControlCutoverBatch(input));
        case 'finishControlCutover': return transaction(() => finishControlCutover(input));
        case 'rollbackControlCutoverBatch': return transaction(() => rollbackControlCutoverBatch(input));
        case 'finishControlRollback': return transaction(() => finishControlRollback(input));
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
    if (method === 'writeControlPolicy' && value?.event) return [value.event];
    if (['beginControlTakeover','completeControlTakeover'].includes(method) && Array.isArray(value?.events)) return value.events;
    if (['applyControlCutoverBatch','rollbackControlCutoverBatch'].includes(method) && Array.isArray(value?.events)) return value.events;
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
