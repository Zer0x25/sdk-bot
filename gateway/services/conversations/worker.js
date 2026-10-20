const { parentPort, workerData, isMainThread } = require('node:worker_threads');
if (isMainThread) throw new Error('Archive SQL requires a worker.');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { assertValid } = require('@sdk-bot/contracts');
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
    if (version > 2) fail('SCHEMA_TOO_NEW');
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
    return { ...snapshot(), schemaVersion: 2, journalMode: one('PRAGMA journal_mode').journal_mode,
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
    return { status: 'created', message: draft, event };
}
function appendMessageEvent(message, aggregate, type, now) {
    const cursor = snapshot();
    cursor.seq = String(BigInt(cursor.seq) + 1n);
    const event = assertValid('Event', { schemaVersion: 1, cursor, type, occurredAt: now,
        data: { conversationId: message.conversationId, messageId: message.id, aggregateVersion: aggregate } });
    run('INSERT INTO events VALUES(?,?,?,?,?)', cursor.seq, message.conversationId, message.id, now, JSON.stringify(event));
    run('UPDATE archive_meta SET seq=? WHERE id=1', cursor.seq);
    return event;
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
    // Fingerprint, inboundSeq, activity and capture time refer to the original.
    const event = appendMessageEvent(message, aggregate, 'message.updated', new Date().toISOString());
    return { status: 'updated', message, event };
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
            return transaction(() => input.map(ingest));
        }
        case 'updateTranscription': return transaction(() => updateTranscription(input));
        case 'conversation': assertValid('Id', input); return one('SELECT * FROM conversations WHERE id=?', input) ?? null;
        case 'messages': return page(input);
        case 'events': {
            const after = input.after ?? '0'; assertValid('Sequence', after);
            const limit = input.limit ?? 100;
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_LIMIT');
            return all('SELECT payload FROM events WHERE length(seq)>length(?) OR (length(seq)=length(?) AND seq>?) ORDER BY length(seq),seq LIMIT ?', after, after, after, limit).map(r => JSON.parse(r.payload));
        }
        case 'diagnostics': return { ...snapshot(), messages: one('SELECT COUNT(*) n FROM messages').n,
            events: one('SELECT COUNT(*) n FROM events').n, quarantine: one('SELECT COUNT(*) n FROM quarantine').n,
            aliases: one('SELECT COUNT(*) n FROM aliases').n, provenance: one('SELECT COUNT(*) n FROM provenance').n,
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
try {
    parentPort.postMessage({ ready: initialize() });
    parentPort.on('message', ({ id, method, input }) => {
        try {
            const value = dispatch(method, input);
            parentPort.postMessage({ id, value });
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
