#!/usr/bin/env node
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');
const { readJsonSource, readProfileKeys, assertGatewayStopped, allConversationRows } = require('./control-import-dry-run');

function safeErrorCode(error) {
    return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'CONTROL_IMPORT_FAILED';
}
function parseArgs(args) {
    const result = { apply: false, cutover: false, resumeCutover: false, rollback: false,
        acceptSourceRemovals: false, acceptIdentityChanges: false, migrationId: null };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--apply') result.apply = true;
        else if (arg === '--cutover') result.cutover = true;
        else if (arg === '--resume-cutover') result.resumeCutover = true;
        else if (arg === '--rollback') result.rollback = true;
        else if (arg === '--accept-source-removals') result.acceptSourceRemovals = true;
        else if (arg === '--accept-identity-changes') result.acceptIdentityChanges = true;
        else if (arg === '--migration-id') {
            const value = args[index + 1];
            if (!value || value.startsWith('--')) throw Object.assign(new Error('INVALID_MIGRATION_ID'), { code: 'INVALID_MIGRATION_ID' });
            result.migrationId = value;
            index += 1;
        } else if (arg === '--help') result.help = true;
        else throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
    }
    if (result.resumeCutover && (result.apply || result.cutover || result.rollback)) throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
    if (result.rollback && (result.apply || result.cutover || result.resumeCutover)) throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
    if (result.cutover && !result.apply) throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
    if ((result.acceptSourceRemovals || result.acceptIdentityChanges) && !result.apply) throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
    if ((result.rollback || result.resumeCutover) && !result.migrationId) throw Object.assign(new Error('MIGRATION_ID_REQUIRED'), { code: 'MIGRATION_ID_REQUIRED' });
    return result;
}
function migrationIdFor(epoch) {
    return createHash('sha256').update(`f5-control-import:${epoch}`).digest('hex').slice(0, 32);
}
function profileDigest(keys) {
    return keys ? createHash('sha256').update([...keys].sort().join('\n')).digest('hex') : null;
}
async function readSources(paths) {
    const [contacts, settings, profileKeys] = await Promise.all([
        readJsonSource(paths.contacts, 'contacts'), readJsonSource(paths.settings, 'settings'), readProfileKeys(paths.profiles)
    ]);
    return { contacts, settings, profileKeys, manifest: { contacts: contacts.manifest, settings: settings.manifest } };
}
async function assertSourcesUnchanged(paths, expected) {
    const current = await readSources(paths);
    if (current.manifest.contacts.sha256 !== expected.contacts?.sha256
        || current.manifest.settings.sha256 !== expected.settings?.sha256
        || current.manifest.contacts.present !== expected.contacts?.present
        || current.manifest.settings.present !== expected.settings?.present
        || profileDigest(current.profileKeys) !== expected.profileInventory?.sha256) {
        throw Object.assign(new Error('SOURCE_CHANGED_RESTART_DRY_RUN'), { code: 'SOURCE_CHANGED_RESTART_DRY_RUN' });
    }
}
async function stageReport(archive, migrationId, report, decisions = {}, beforeVerify = async () => {}) {
    const result = await archive.beginControlImport({ migrationId, report, decisions });
    if (result.status === 'staging') {
        for (let offset = 0; offset < result.report.entryCount; offset += 250) {
            await archive.stageControlImportBatch({ runId: result.runId, offset, limit: 250 });
        }
    }
    await beforeVerify(result.report.sourceManifest);
    const verified = await archive.verifyControlImport({ runId: result.runId });
    return { ...result, status: verified.status, report: verified.report };
}
async function cutover(archive, migrationId, beforeFinish = async () => {}) {
    const existing = await archive.controlImportStatus(migrationId);
    if (existing?.status === 'cutover') return { status: 'cutover', authority: await archive.controlAuthority(), snapshot: await archive.snapshot() };
    const started = await archive.startControlCutover({ migrationId });
    if (started.status === 'cutover_applying') {
        for (;;) {
            const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 100 });
            if (batch.remaining === 0) break;
        }
        await beforeFinish(existing?.run?.report?.sourceManifest);
        return archive.finishControlCutover({ migrationId });
    }
    return { status: started.status, authority: await archive.controlAuthority(), snapshot: await archive.snapshot() };
}
async function rollback(archive, migrationId) {
    const state = await archive.controlImportStatus(migrationId);
    if (!state) throw Object.assign(new Error('IMPORT_MIGRATION_MISSING'), { code: 'IMPORT_MIGRATION_MISSING' });
    if (state.status === 'rolled_back') return { status: 'rolled_back', migrationId, authority: await archive.controlAuthority() };
    for (;;) {
        const batch = await archive.rollbackControlCutoverBatch({ migrationId, limit: 100 });
        if (batch.remaining === 0) break;
    }
    return archive.finishControlRollback({ migrationId });
}
async function run(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (options.help) {
        process.stdout.write('Read-only by default. Use --apply to stage a verified migration; --cutover also requests activation and is gated until F5.4 registers the SQLite control service. Accept source removals or identity remaps only with the explicit --accept-source-removals / --accept-identity-changes flags. Use --resume-cutover or --rollback with --migration-id after an interrupted cutover.\n');
        return 0;
    }
    const paths = {
        contacts: process.env.SDK_CONTACTS_DB_PATH || path.join(__dirname, '..', 'contacts_db.json'),
        settings: process.env.SDK_SETTINGS_DB_PATH || path.join(__dirname, '..', 'settings_db.json'),
        profiles: process.env.SDK_BRAIN_PROFILES_DIR || path.resolve(__dirname, '../../brain/profiles'),
        database: process.env.SDK_CONVERSATIONS_DB_PATH || path.join(__dirname, '..', 'data', 'conversations.db'),
        lock: process.env.SDK_GATEWAY_LOCK_PATH || path.join(__dirname, '..', '.gateway.lock')
    };
    let archive;
    let sourceManifest = {};
    try {
        await assertGatewayStopped(paths.lock);
        if (options.resumeCutover || options.rollback) {
            archive = createArchive({ path: paths.database, controlRecovery: true });
            await archive.ready;
            const state = await archive.controlImportStatus(options.migrationId);
            if (!state) throw Object.assign(new Error('IMPORT_MIGRATION_MISSING'), { code: 'IMPORT_MIGRATION_MISSING' });
            if (options.resumeCutover && state.status !== 'cutover') {
                await assertSourcesUnchanged(paths, state.run?.report?.sourceManifest || {});
            }
            const result = options.rollback ? await rollback(archive, options.migrationId)
                : await cutover(archive, options.migrationId, manifest => assertSourcesUnchanged(paths, manifest || {}));
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return result.status === 'cutover' || result.status === 'rolled_back' ? 0 : 2;
        }

        const sources = await readSources(paths);
        sourceManifest = sources.manifest;
        if (!options.apply) {
            const readonlyArchive = createArchive({ path: paths.database, readOnly: true });
            archive = readonlyArchive;
            const ready = await archive.ready;
            const archiveSnapshot = await archive.snapshot();
            const report = buildControlImportReport({ contacts: sources.contacts.value, settings: sources.settings.value,
                conversations: await allConversationRows(archive), profileKeys: sources.profileKeys, sourceManifest,
                archive: { dataEpoch: archiveSnapshot.dataEpoch, seq: archiveSnapshot.seq, schemaVersion: ready.schemaVersion } });
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            return report.cutoverAllowed ? 0 : 2;
        }

        archive = createArchive({ path: paths.database });
        const ready = await archive.ready;
        const archiveSnapshot = await archive.snapshot();
        const report = buildControlImportReport({ contacts: sources.contacts.value, settings: sources.settings.value,
            conversations: await allConversationRows(archive), profileKeys: sources.profileKeys, sourceManifest,
            archive: { dataEpoch: archiveSnapshot.dataEpoch, seq: archiveSnapshot.seq, schemaVersion: ready.schemaVersion } });
        const migrationId = options.migrationId || migrationIdFor(archiveSnapshot.dataEpoch);
        const staged = await stageReport(archive, migrationId, report, {
            acceptSourceRemovals: options.acceptSourceRemovals,
            acceptIdentityChanges: options.acceptIdentityChanges
        }, manifest => assertSourcesUnchanged(paths, manifest || {}));
        await assertSourcesUnchanged(paths, staged.report.sourceManifest);
        let result = { migrationId, runId: staged.runId, status: staged.status,
            cutoverAllowed: staged.report.cutoverAllowed, counts: staged.report.counts,
            blockers: staged.report.blockers, authority: await archive.controlAuthority() };
        let exitCode = staged.status === 'verified' ? 0 : 2;
        if (options.cutover && staged.status === 'verified') {
            result = { ...result, cutover: await cutover(archive, migrationId,
                manifest => assertSourcesUnchanged(paths, manifest || {})), authority: await archive.controlAuthority() };
            exitCode = result.cutover.status === 'cutover' ? 0 : 2;
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return exitCode;
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ status: 'blocked', cutoverAllowed: false,
            sourceManifest, blockers: [{ code: safeErrorCode(error) }] }, null, 2)}\n`);
        return 2;
    } finally {
        if (archive) await archive.close().catch(() => {});
    }
}

if (require.main === module) void run().then(code => { process.exitCode = code; });

module.exports = { run, parseArgs, migrationIdFor, profileDigest, assertSourcesUnchanged, stageReport, cutover, rollback };
