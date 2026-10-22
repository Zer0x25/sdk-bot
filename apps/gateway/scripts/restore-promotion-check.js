#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { createArchive } = require('../services/conversations');
const { inspectAttachmentFiles } = require('../services/conversations/attachments');
const { attachmentDirectory, databasePath } = require('../services/conversations/paths');
const { GATEWAY_STATE_DIR } = require('../lib/repoPaths');
const { assertGatewayStopped } = require('./control-import-dry-run');

function parseArgs(args) {
    const result = { snapshot: null, snapshotAttachments: null, help: false };
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--help') result.help = true;
        else if (args[index] === '--snapshot') {
            const value = args[index + 1];
            if (!value || value.startsWith('--') || result.snapshot) {
                throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
            }
            result.snapshot = value;
            index += 1;
        } else if (args[index] === '--snapshot-attachments') {
            const value = args[index + 1];
            if (!value || value.startsWith('--') || result.snapshotAttachments) {
                throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
            }
            result.snapshotAttachments = value;
            index += 1;
        } else throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
    }
    if (!result.help && !result.snapshot) throw Object.assign(new Error('SNAPSHOT_REQUIRED'), { code: 'SNAPSHOT_REQUIRED' });
    if (result.snapshot && !path.isAbsolute(result.snapshot)) {
        throw Object.assign(new Error('SNAPSHOT_PATH_MUST_BE_ABSOLUTE'), { code: 'SNAPSHOT_PATH_MUST_BE_ABSOLUTE' });
    }
    if (result.snapshotAttachments && !path.isAbsolute(result.snapshotAttachments)) {
        throw Object.assign(new Error('SNAPSHOT_ATTACHMENTS_PATH_MUST_BE_ABSOLUTE'), { code: 'SNAPSHOT_ATTACHMENTS_PATH_MUST_BE_ABSOLUTE' });
    }
    return result;
}

function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

async function readCheckpoint(filePath, attachmentsPath) {
    const archive = createArchive({ path: filePath, readOnly: true });
    try {
        const ready = await archive.ready;
        const checkpoint = await archive.recoveryCheckpoint();
        const registry = await archive.attachmentRegistry();
        const attachmentBlobs = await inspectAttachmentFiles({ directory: attachmentsPath, registry });
        return { ...checkpoint, schemaVersion: ready.schemaVersion, attachmentBlobs };
    } finally {
        await archive.close().catch(() => {});
    }
}

function safeSummary(checkpoint) {
    return { schemaVersion: checkpoint.schemaVersion, seq: checkpoint.seq,
        outboundIntentCount: checkpoint.outboundIntentCount,
        attachmentCount: checkpoint.attachmentCount, attachmentSha256: checkpoint.attachmentSha256,
        attachmentBlobCount: checkpoint.attachmentBlobs.count, attachmentBlobBytes: checkpoint.attachmentBlobs.bytes,
        attachmentBlobsValid: checkpoint.attachmentBlobs.valid,
        searchIndexCount: checkpoint.searchIndexCount, searchIndexMismatchCount: checkpoint.searchIndexMismatchCount,
        assistantToolInvocationCount: checkpoint.assistantToolInvocationCount,
        telegramAdminInboxCount: checkpoint.telegramAdminInboxCount,
        resumeMetadataCount: checkpoint.resumeMetadataCount,
        controlOperationCount: checkpoint.controlOperationCount,
        controlImportLedgerCount: checkpoint.controlImportLedgerCount,
        readCursorCount: checkpoint.readCursorCount,
        quarantineCount: checkpoint.quarantineCount,
        unresolvedOutboundCount: checkpoint.unresolvedOutboundCount,
        integrity: checkpoint.integrity, foreignKeys: checkpoint.foreignKeys };
}

function compare(source, candidate) {
    const blockers = [];
    if ([source, candidate].some(value => value.integrity !== 'ok' || value.foreignKeys !== 0)) {
        blockers.push('ARCHIVE_INTEGRITY_FAILED');
    }
    if (source.schemaVersion !== candidate.schemaVersion || source.dataEpoch !== candidate.dataEpoch
        || source.seq !== candidate.seq || stable(source.controlAuthority) !== stable(candidate.controlAuthority)) {
        blockers.push('ARCHIVE_CHECKPOINT_MISMATCH');
    }
    if (source.outboundIntentCount !== candidate.outboundIntentCount
        || source.outboundIntentSha256 !== candidate.outboundIntentSha256) {
        blockers.push('OUTBOUND_LEDGER_MISMATCH');
    }
    if (source.attachmentCount !== candidate.attachmentCount || source.attachmentSha256 !== candidate.attachmentSha256) {
        blockers.push('ATTACHMENT_LEDGER_MISMATCH');
    }
    if (!source.attachmentBlobs.valid || !candidate.attachmentBlobs.valid) blockers.push('ATTACHMENT_BLOB_INVALID');
    if (source.attachmentBlobs.count !== candidate.attachmentBlobs.count
        || source.attachmentBlobs.bytes !== candidate.attachmentBlobs.bytes
        || source.attachmentBlobs.sha256 !== candidate.attachmentBlobs.sha256) {
        blockers.push('ATTACHMENT_BLOB_MISMATCH');
    }
    if (source.searchIndexMismatchCount > 0 || candidate.searchIndexMismatchCount > 0) {
        blockers.push('SEARCH_INDEX_INVALID');
    }
    if (source.searchIndexCount !== candidate.searchIndexCount || source.searchIndexSha256 !== candidate.searchIndexSha256) {
        blockers.push('SEARCH_INDEX_MISMATCH');
    }
    if (source.assistantToolInvocationCount !== candidate.assistantToolInvocationCount
        || source.assistantToolInvocationSha256 !== candidate.assistantToolInvocationSha256) {
        blockers.push('ASSISTANT_TOOL_AUDIT_MISMATCH');
    }
    if (source.telegramAdminInboxCount !== candidate.telegramAdminInboxCount
        || source.telegramAdminInboxSha256 !== candidate.telegramAdminInboxSha256) {
        blockers.push('TELEGRAM_ADMIN_INBOX_MISMATCH');
    }
    if (source.resumeMetadataCount !== candidate.resumeMetadataCount
        || source.resumeMetadataSha256 !== candidate.resumeMetadataSha256) {
        blockers.push('RESUME_METADATA_MISMATCH');
    }
    if (source.controlOperationCount !== candidate.controlOperationCount
        || source.controlOperationSha256 !== candidate.controlOperationSha256) {
        blockers.push('CONTROL_OPERATION_LEDGER_MISMATCH');
    }
    if (source.controlImportLedgerCount !== candidate.controlImportLedgerCount
        || source.controlImportLedgerSha256 !== candidate.controlImportLedgerSha256) {
        blockers.push('CONTROL_IMPORT_LEDGER_MISMATCH');
    }
    if (source.readCursorCount !== candidate.readCursorCount || source.readCursorSha256 !== candidate.readCursorSha256) {
        blockers.push('READ_CURSOR_LEDGER_MISMATCH');
    }
    if (source.quarantineCount !== candidate.quarantineCount || source.quarantineSha256 !== candidate.quarantineSha256) {
        blockers.push('QUARANTINE_LEDGER_MISMATCH');
    }
    if (source.unresolvedOutboundCount > 0 || candidate.unresolvedOutboundCount > 0) {
        blockers.push('UNRESOLVED_OUTBOUND');
    }
    return blockers;
}

async function main(args = process.argv.slice(2)) {
    let options;
    try { options = parseArgs(args); }
    catch (error) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, readOnly: true, promotionAllowed: false,
            status: 'blocked', blockers: [error.code || 'INVALID_ARGUMENT'] }, null, 2)}\n`);
        return 2;
    }
    if (options.help) {
        process.stdout.write('Offline, read-only archive restore gate. Stop Gateway, then run: npm run conversations:restore-check -- --snapshot /absolute/path/to/conversations.db [--snapshot-attachments /absolute/path/to/attachments]. By default, attachments are read from the sibling attachments/ directory. The active source paths come from their SDK_* settings. This command never restores or promotes a volume.\n');
        return 0;
    }

    try {
        const sourcePath = databasePath();
        const candidatePath = path.resolve(options.snapshot);
        const candidateAttachments = options.snapshotAttachments
            ? path.resolve(options.snapshotAttachments) : path.join(path.dirname(candidatePath), 'attachments');
        await assertGatewayStopped(process.env.SDK_GATEWAY_LOCK_PATH || path.join(GATEWAY_STATE_DIR, '.gateway.lock'));
        const [sourceRealPath, candidateRealPath] = await Promise.all([fs.realpath(sourcePath), fs.realpath(candidatePath)]);
        if (sourceRealPath === candidateRealPath) {
            throw Object.assign(new Error('SOURCE_AND_SNAPSHOT_SAME'), { code: 'SOURCE_AND_SNAPSHOT_SAME' });
        }
        const [source, candidate] = await Promise.all([
            readCheckpoint(sourceRealPath, attachmentDirectory()),
            readCheckpoint(candidateRealPath, candidateAttachments)
        ]);
        const blockers = compare(source, candidate);
        if (source.attachmentBlobs.count > 0 || candidate.attachmentBlobs.count > 0) {
            const [sourceAttachmentRealPath, candidateAttachmentRealPath] = await Promise.all([
                fs.realpath(attachmentDirectory()), fs.realpath(candidateAttachments)
            ]);
            if (sourceAttachmentRealPath === candidateAttachmentRealPath) {
                blockers.push('ATTACHMENT_SNAPSHOT_NOT_SEPARATE');
            }
        }
        const result = { schemaVersion: 1, readOnly: true, status: blockers.length ? 'blocked' : 'current',
            promotionAllowed: blockers.length === 0, source: safeSummary(source), snapshot: safeSummary(candidate), blockers };
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return blockers.length ? 2 : 0;
    } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? error.code : 'RESTORE_CHECK_FAILED';
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, readOnly: true, promotionAllowed: false,
            status: 'blocked', blockers: [code] }, null, 2)}\n`);
        return 2;
    }
}

if (require.main === module) void main().then(code => { process.exitCode = code; });

module.exports = { main, parseArgs, compare };
