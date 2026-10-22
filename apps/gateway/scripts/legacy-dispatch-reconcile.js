#!/usr/bin/env node
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { GATEWAY_STATE_DIR } = require('../lib/repoPaths');
const { assertGatewayStopped } = require('./control-import-dry-run');

const CURRENT_SCHEMA_VERSION = 17;
const DISPOSITIONS = new Set(['confirmed_not_dispatched', 'confirmed_processed', 'uncertain']);

function fail(code) {
    throw Object.assign(new Error(code), { code });
}

function safeErrorCode(error) {
    return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'RECONCILIATION_FAILED';
}

function parseArguments(args) {
    if (args.includes('--help')) return { help: true };
    const values = {};
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (!['--db', '--reconciliation'].includes(option) || values[option]) fail('INVALID_ARGUMENT');
        const value = args[index + 1];
        if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT');
        values[option] = path.resolve(value);
        index += 1;
    }
    if (!values['--db']) fail('DATABASE_PATH_REQUIRED');
    return { databasePath: values['--db'], reconciliationPath: values['--reconciliation'] };
}

async function sha256File(filePath) {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

async function assertClosedDatabase(filePath) {
    let stat;
    try { stat = await fs.lstat(filePath); }
    catch (error) {
        if (error?.code === 'ENOENT') fail('ARCHIVE_NOT_FOUND');
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_PATH');
    const canonical = path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
    for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = `${canonical}${suffix}`;
        let exists = false;
        try {
            await fs.lstat(sidecar);
            exists = true;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        if (exists) fail('ARCHIVE_NOT_QUIESCENT');
    }
    return { filePath: canonical, sizeBytes: stat.size, sha256: await sha256File(canonical) };
}

async function readReconciliation(filePath) {
    if (!filePath) return null;
    let stat;
    try { stat = await fs.lstat(filePath); }
    catch (error) {
        if (error?.code === 'ENOENT') fail('RECONCILIATION_NOT_FOUND');
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 10 * 1024 * 1024) {
        fail('RECONCILIATION_FILE_INVALID');
    }
    let value;
    try { value = JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch { fail('RECONCILIATION_JSON_INVALID'); }
    return { value, fileName: path.basename(filePath), sizeBytes: stat.size, sha256: await sha256File(filePath) };
}

function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columns(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function archiveCandidates(filePath) {
    let db;
    try {
        db = new DatabaseSync(`${pathToFileURL(filePath).href}?immutable=1`, { readOnly: true });
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (!Number.isInteger(version) || version < 2) fail('SCHEMA_VERSION_REQUIRED');
        if (version > CURRENT_SCHEMA_VERSION) fail('SCHEMA_TOO_NEW');
        if (!tableExists(db, 'messages')) fail('ARCHIVE_SCHEMA_INVALID');
        const dispatchExists = tableExists(db, 'legacy_dispatch');
        if ((version === 2 && dispatchExists) || (version >= 3 && !dispatchExists)) fail('ARCHIVE_SCHEMA_INVALID');
        const available = columns(db, 'messages');
        for (const required of ['id', 'conversation_id', 'occurred_at', 'source', 'payload']) {
            if (!available.has(required)) fail('ARCHIVE_SCHEMA_INVALID');
        }
        const checks = db.prepare('PRAGMA integrity_check').all();
        if (checks.length !== 1 || checks[0].integrity_check !== 'ok'
            || db.prepare('PRAGMA foreign_key_check').all().length) fail('ARCHIVE_CORRUPT');
        const selected = ['m.id', 'm.conversation_id', 'm.occurred_at', 'm.source', 'm.payload'];
        if (available.has('inbound_seq')) selected.push('m.inbound_seq');
        if (available.has('ingested_at')) selected.push('m.ingested_at');
        const join = dispatchExists ? 'LEFT JOIN legacy_dispatch d ON d.message_id=m.id WHERE d.message_id IS NULL' : '';
        const rows = db.prepare(`SELECT ${selected.join(',')} FROM messages m ${join} ORDER BY m.occurred_at,m.id`).all();
        const candidates = rows.map(row => {
            let message;
            try { message = JSON.parse(row.payload); }
            catch { fail('ARCHIVE_CORRUPT'); }
            if (!message || typeof message !== 'object' || Array.isArray(message)) fail('ARCHIVE_CORRUPT');
            return {
                messageId: row.id,
                conversationId: row.conversation_id,
                occurredAt: row.occurred_at,
                source: row.source,
                direction: typeof message.direction === 'string' ? message.direction : null,
                authorKind: typeof message.authorKind === 'string' ? message.authorKind : null,
                contentType: typeof message.content?.type === 'string' ? message.content.type : null,
                inboundSeq: row.inbound_seq ?? null,
                ingestedAt: row.ingested_at ?? null,
                deliveryState: 'unknown'
            };
        });
        return { schemaVersion: version, candidates };
    } finally {
        db?.close();
    }
}

function validateReconciliation(reconciliation, sourceSha256, candidates) {
    if (!reconciliation || typeof reconciliation !== 'object' || Array.isArray(reconciliation)
        || reconciliation.schemaVersion !== 1 || reconciliation.sourceSha256 !== sourceSha256
        || typeof reconciliation.reviewedBy !== 'string' || !reconciliation.reviewedBy.trim()
        || reconciliation.reviewedBy.length > 128 || !reconciliation.reviewedBy.isWellFormed()
        || typeof reconciliation.reviewedAt !== 'string'
        || !Number.isFinite(Date.parse(reconciliation.reviewedAt))
        || new Date(reconciliation.reviewedAt).toISOString() !== reconciliation.reviewedAt
        || !Array.isArray(reconciliation.decisions) || reconciliation.decisions.length !== candidates.length) {
        fail('RECONCILIATION_MISMATCH');
    }
    const candidateIds = new Set(candidates.map(candidate => candidate.messageId));
    const seen = new Set();
    const byId = new Map();
    for (const decision of reconciliation.decisions) {
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)
            || Object.keys(decision).some(key => !['messageId', 'disposition', 'evidenceRef'].includes(key))
            || typeof decision.messageId !== 'string' || !candidateIds.has(decision.messageId)
            || seen.has(decision.messageId) || !DISPOSITIONS.has(decision.disposition)
            || typeof decision.evidenceRef !== 'string' || !decision.evidenceRef.trim()
            || decision.evidenceRef.length > 512 || !decision.evidenceRef.isWellFormed()) {
            fail('RECONCILIATION_MISMATCH');
        }
        seen.add(decision.messageId);
        byId.set(decision.messageId, { disposition: decision.disposition, evidenceRef: decision.evidenceRef.trim() });
    }
    if (seen.size !== candidateIds.size) fail('RECONCILIATION_MISMATCH');
    return { decisions: byId, reviewedBy: reconciliation.reviewedBy.trim(), reviewedAt: reconciliation.reviewedAt };
}

function buildReport({ source, schemaVersion, candidates, reconciliationFile, generatedAt = new Date().toISOString() }) {
    const review = reconciliationFile
        ? validateReconciliation(reconciliationFile.value, source.sha256, candidates) : null;
    const reviewedCandidates = candidates.map(candidate => ({
        ...candidate,
        ...(review ? { review: review.decisions.get(candidate.messageId) } : {})
    }));
    const reviewedCounts = { confirmedNotDispatched: 0, confirmedProcessed: 0, uncertain: 0 };
    for (const candidate of reviewedCandidates) {
        const disposition = candidate.review?.disposition;
        if (disposition === 'confirmed_not_dispatched') reviewedCounts.confirmedNotDispatched += 1;
        if (disposition === 'confirmed_processed') reviewedCounts.confirmedProcessed += 1;
        if (disposition === 'uncertain') reviewedCounts.uncertain += 1;
    }
    const report = {
        reportVersion: 1,
        reportType: 'legacy_dispatch_reconciliation',
        generatedAt,
        status: reconciliationFile ? 'reconciled' : (candidates.length ? 'review_required' : 'clear'),
        source: { fileName: source.fileName, sizeBytes: source.sizeBytes, sha256: source.sha256, schemaVersion },
        readOnly: true,
        replayPerformed: false,
        writesPerformed: false,
        counts: { candidates: candidates.length, ...reviewedCounts },
        candidates: reviewedCandidates,
        reconciliation: reconciliationFile ? {
            fileName: reconciliationFile.fileName,
            sizeBytes: reconciliationFile.sizeBytes,
            sha256: reconciliationFile.sha256,
            reviewedBy: review.reviewedBy,
            reviewedAt: review.reviewedAt
        } : null,
        note: 'Missing legacy_dispatch receipt means delivery is unknown. Review decisions are operator attestations; this report never queues or replays messages.'
    };
    if (!reconciliationFile) {
        report.reviewTemplate = {
            schemaVersion: 1,
            sourceSha256: source.sha256,
            reviewedBy: '',
            reviewedAt: '',
            decisions: candidates.map(({ messageId }) => ({ messageId, disposition: 'unreviewed', evidenceRef: '' }))
        };
    }
    return report;
}

async function run(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    if (options.help) {
        process.stdout.write('Offline read-only report for messages without a legacy_dispatch receipt. Usage: node scripts/legacy-dispatch-reconcile.js --db <closed-sqlite-file> [--reconciliation <review.json>]. Requires Gateway stopped and no SQLite sidecars. The command never writes the archive or replays messages.\n');
        return;
    }
    const gatewayLockPath = process.env.SDK_GATEWAY_LOCK_PATH || path.join(GATEWAY_STATE_DIR, '.gateway.lock');
    await assertGatewayStopped(gatewayLockPath);
    const sourceFile = await assertClosedDatabase(options.databasePath);
    const archive = archiveCandidates(sourceFile.filePath);
    if (await sha256File(sourceFile.filePath) !== sourceFile.sha256) fail('ARCHIVE_CHANGED');
    const reconciliationFile = await readReconciliation(options.reconciliationPath);
    const report = buildReport({ source: { fileName: path.basename(sourceFile.filePath), sizeBytes: sourceFile.sizeBytes,
        sha256: sourceFile.sha256 }, schemaVersion: archive.schemaVersion, candidates: archive.candidates, reconciliationFile });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main(args = process.argv.slice(2)) {
    try { await run(args); }
    catch (error) {
        process.stdout.write(`${JSON.stringify({ reportVersion: 1, reportType: 'legacy_dispatch_reconciliation',
            status: 'blocked', readOnly: true, replayPerformed: false, writesPerformed: false,
            blockers: [{ code: safeErrorCode(error) }] }, null, 2)}\n`);
        process.exitCode = 2;
    }
}

if (require.main === module) void main();

module.exports = { archiveCandidates, buildReport, main, parseArguments, validateReconciliation };
