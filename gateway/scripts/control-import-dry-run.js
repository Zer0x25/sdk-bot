#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');

function safeErrorCode(error) {
    return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'DRY_RUN_FAILED';
}

async function readJsonSource(filePath, kind) {
    let bytes;
    try { bytes = await fs.readFile(filePath); }
    catch (error) {
        if (error?.code === 'ENOENT') return { value: {}, manifest: { present: false, fileName: path.basename(filePath), sizeBytes: 0, sha256: null } };
        throw error;
    }
    let value;
    try {
        let text = bytes.toString('utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        value = JSON.parse(text);
    } catch { throw Object.assign(new Error('INVALID_JSON_SOURCE'), { code: `${kind.toUpperCase()}_JSON_INVALID` }); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new Error('INVALID_JSON_ROOT'), { code: `${kind.toUpperCase()}_ROOT_INVALID` });
    }
    return { value, manifest: { present: true, fileName: path.basename(filePath), sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') } };
}

async function readProfileKeys(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return null; }
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => entry.name.slice(0, -3)).sort();
}

async function assertGatewayStopped(lockPath) {
    let stat;
    try { stat = await fs.lstat(lockPath); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('UNSAFE_GATEWAY_LOCK'), { code: 'UNSAFE_GATEWAY_LOCK' });
    const rawPid = (await fs.readFile(lockPath, 'utf8')).trim();
    const pid = Number(rawPid);
    if (!/^[1-9][0-9]*$/.test(rawPid) || !Number.isSafeInteger(pid)) {
        throw Object.assign(new Error('INVALID_GATEWAY_LOCK'), { code: 'INVALID_GATEWAY_LOCK' });
    }
    try {
        process.kill(pid, 0);
        throw Object.assign(new Error('GATEWAY_RUNNING'), { code: 'GATEWAY_RUNNING' });
    } catch (error) {
        if (error?.code === 'GATEWAY_RUNNING') throw error;
        if (error?.code !== 'ESRCH') {
            if (error?.code === 'EPERM') throw Object.assign(new Error('GATEWAY_RUNNING'), { code: 'GATEWAY_RUNNING' });
            throw error;
        }
    }
}

async function allConversationRows(archive) {
    const rows = [];
    let before;
    for (;;) {
        const page = await archive.conversationRows({ limit: 500, before });
        rows.push(...page);
        if (page.length < 500) return rows;
        const last = page[page.length - 1];
        before = { lastActivityAt: last.last_activity_at, id: last.id };
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        process.stdout.write('Read-only F5 control migration report. Use --exclude-no-conversation to exclude contacts with no exact archive target. Ambiguous identities stay blocked by default; --preserve-ambiguous-blocked only records a keep-blocked decision when globalMode is ignored_all and every candidate conversation is already automation-inactive. Configure SDK_CONTACTS_DB_PATH, SDK_SETTINGS_DB_PATH, SDK_BRAIN_PROFILES_DIR, and SDK_CONVERSATIONS_DB_PATH.\n');
        return;
    }
    if (args.some(arg => !['--exclude-no-conversation','--preserve-ambiguous-blocked'].includes(arg))) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, dryRun: true, status: 'blocked', cutoverAllowed: false,
            blockers: [{ code: 'INVALID_ARGUMENT' }] }, null, 2)}\n`);
        process.exitCode = 2;
        return;
    }
    const excludeContactsWithoutConversation = args.includes('--exclude-no-conversation');
    const preserveAmbiguousQuarantine = args.includes('--preserve-ambiguous-blocked');
    const contactsPath = process.env.SDK_CONTACTS_DB_PATH || path.join(__dirname, '..', 'contacts_db.json');
    const settingsPath = process.env.SDK_SETTINGS_DB_PATH || path.join(__dirname, '..', 'settings_db.json');
    const profilesPath = process.env.SDK_BRAIN_PROFILES_DIR || path.resolve(__dirname, '../../brain/profiles');
    const databasePath = process.env.SDK_CONVERSATIONS_DB_PATH || path.join(__dirname, '..', 'data', 'conversations.db');
    const gatewayLockPath = process.env.SDK_GATEWAY_LOCK_PATH || path.join(__dirname, '..', '.gateway.lock');
    let archive;
    let manifest = {};
    try {
        await assertGatewayStopped(gatewayLockPath);
        const [contacts, settings, profileKeys] = await Promise.all([
            readJsonSource(contactsPath, 'contacts'), readJsonSource(settingsPath, 'settings'), readProfileKeys(profilesPath)
        ]);
        manifest = { contacts: contacts.manifest, settings: settings.manifest };
        archive = createArchive({ path: databasePath, readOnly: true });
        const ready = await archive.ready;
        const archiveSnapshot = await archive.snapshot();
        const conversations = await allConversationRows(archive);
        const report = buildControlImportReport({ contacts: contacts.value, settings: settings.value,
            conversations, profileKeys, sourceManifest: manifest,
            archive: { dataEpoch: archiveSnapshot.dataEpoch, seq: archiveSnapshot.seq, schemaVersion: ready.schemaVersion },
            excludeContactsWithoutConversation, preserveAmbiguousQuarantine });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.cutoverAllowed) process.exitCode = 2;
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, dryRun: true, status: 'blocked', cutoverAllowed: false,
            sourceManifest: manifest, blockers: [{ code: safeErrorCode(error) }] }, null, 2)}\n`);
        process.exitCode = 2;
    } finally {
        if (archive) await archive.close().catch(() => {});
    }
}

if (require.main === module) void main();

module.exports = { main, readJsonSource, readProfileKeys, assertGatewayStopped, allConversationRows };
