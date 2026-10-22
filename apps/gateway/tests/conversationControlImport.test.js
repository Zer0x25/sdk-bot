process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');
const { allConversationRows } = require('../scripts/control-import-dry-run');

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function message(accountId, phone, id) {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: `${phone}@s.whatsapp.net` },
        providerMessageId: id, source: 'history', direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: 'fixture' } };
}

test('F5.2 dry-run maps only exact WhatsApp identities and reports conservative conflicts without PII', () => {
    const id = suffix => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    const conversations = [
        { id: id('1'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '111@s.whatsapp.net' }] },
        { id: id('2'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '222@s.whatsapp.net' }] },
        { id: id('3'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '333@s.whatsapp.net' }] },
        { id: id('4'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '444@s.whatsapp.net' }] },
        { id: id('5'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '555@s.whatsapp.net' }] },
        { id: id('6'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '555@s.whatsapp.net' }] },
        { id: id('7'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '666@s.whatsapp.net' }] }
    ];
    const contacts = {
        allowedSource: { phone: '111', estado: 'permitido', savedName: 'Private Alice' },
        expiredHandoff: { phone: '222', estado: 'handoff', handoffAt: '2020-01-01T00:00:00.000Z' },
        missingProfile: { phone: '333', estado: 'permitido', perfil: 'does-not-exist' },
        conflictAllowed: { phone: '444', estado: 'permitido' },
        conflictIgnored: { phone: '444', estado: 'ignorado' },
        ambiguous: { phone: '555', estado: 'permitido' },
        invalidState: { phone: '666', estado: 'unknown' },
        'group@g.us': { phone: '777', estado: 'permitido' },
        noIdentity: { savedName: 'No verified identity', estado: 'permitido' }
    };
    const report = buildControlImportReport({ contacts,
        settings: { globalMode: 'allowed_all', currentProfile: 'default', telegramToken: 'never-print-this-secret' },
        conversations, profileKeys: ['default'], generatedAt: '2026-10-20T12:00:00.000Z',
        sourceManifest: { contacts: { present: true, sha256: 'a'.repeat(64) }, settings: { present: true, sha256: 'b'.repeat(64) } },
        archive: { dataEpoch: id('9'), seq: '44', schemaVersion: 6 } });

    assert.equal(report.status, 'review_required');
    assert.equal(report.cutoverAllowed, false);
    assert.deepEqual(report.counts, { sourceRecords: 11, imported: 6, quarantined: 4, excluded: 1, requiresReview: 2 });
    assert.equal(report.globalPolicy.globalMode, 'allowed_all');
    assert.equal(report.globalPolicy.globalPausedDuringCutover, true);
    assert.ok(report.entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sourceChecksum)));
    assert.equal(report.sourceManifest.contacts.sourceRecordCount, 9);
    assert.equal(report.sourceManifest.settings.sourceRecordCount, 2);
    const entriesBySource = Object.fromEntries(Object.entries(contacts).map(([key]) => [key,
        report.entries.find(entry => entry.sourceKey === `contact:${hash(Buffer.from(`contact\0${key}`))}`)]));
    assert.equal(entriesBySource.expiredHandoff.disposition, 'imported');
    assert.deepEqual(entriesBySource.expiredHandoff.control, { accessPolicy: 'neutral', automationMode: 'human',
        lifecycle: 'open', ownerId: null, takenAt: '2020-01-01T00:00:00.000Z', handoffReason: 'legacy_import',
        requiresReview: false, reviewReasons: [], profileKey: 'default' });
    assert.equal(entriesBySource.conflictAllowed.reason, 'conflicting_legacy_rules');
    assert.equal(entriesBySource.conflictIgnored.reason, 'conflicting_legacy_rules');
    assert.equal(entriesBySource.ambiguous.reason, 'identity_ambiguous');
    assert.equal(entriesBySource['group@g.us'].disposition, 'excluded');
    assert.equal(entriesBySource.noIdentity.disposition, 'quarantined');
    assert.equal(entriesBySource.invalidState.control.automationMode, 'off');
    assert.equal(entriesBySource.missingProfile.control.requiresReview, true);
    assert.equal(entriesBySource.missingProfile.control.automationMode, 'off');
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('Private Alice'));
    assert.ok(!serialized.includes('never-print-this-secret'));
    assert.ok(!serialized.includes('111@s.whatsapp.net'));
    assert.ok(!serialized.includes('allowedSource'));
});

test('F5.2 records effective application defaults when legacy settings omit currentProfile', () => {
    const report = buildControlImportReport({ contacts: {}, settings: { globalMode: 'ignored_all' }, conversations: [],
        profileKeys: ['default'], sourceManifest: {
            contacts: { present: true, sha256: 'a'.repeat(64) }, settings: { present: true, sha256: 'b'.repeat(64) }
        }, archive: { dataEpoch: randomUUID(), seq: '0', schemaVersion: 6 } });
    const profile = report.entries.find(entry => entry.field === 'currentProfile');
    assert.equal(profile.source, 'settings_default');
    assert.equal(profile.disposition, 'imported');
    assert.equal(profile.plannedProfile, 'default');
    assert.equal(report.globalPolicy.globalProfile, 'default');
    assert.equal(report.sourceManifest.settings.sourceRecordCount, 1);
    assert.equal(report.sourceManifest.settings.plannedRecordCount, 2);
    assert.equal(report.counts.sourceRecords,
        report.counts.imported + report.counts.quarantined + report.counts.excluded);
});

test('F5.3 explicitly excludes only contacts without an exact conversation and keeps ambiguous identities blocked', () => {
    const id = suffix => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    const contacts = {
        allowedWithoutConversation: { phone: '777', estado: 'permitido' },
        handoffWithoutConversation: { phone: '888', estado: 'handoff' },
        ambiguous: { phone: '555', estado: 'ignorado' }
    };
    const input = { contacts, settings: { globalMode: 'ignored_all', currentProfile: 'default' },
        conversations: [
            { id: id('1'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '555@s.whatsapp.net' }] },
            { id: id('2'), channel: 'whatsapp', identity_keys: [{ kind: 'whatsapp_jid', exactValue: '555@s.whatsapp.net' }] }
        ], profileKeys: ['default'], sourceManifest: {
            contacts: { present: true, sha256: 'a'.repeat(64) }, settings: { present: true, sha256: 'b'.repeat(64) }
        }, archive: { dataEpoch: id('9'), seq: '44', schemaVersion: 10 } };
    const defaultReport = buildControlImportReport(input);
    assert.equal(defaultReport.counts.quarantined, 3);
    assert.equal(defaultReport.entries.find(entry => entry.reason === 'identity_not_found')?.disposition, 'quarantined');

    const report = buildControlImportReport({ ...input, excludeContactsWithoutConversation: true });
    assert.equal(report.cutoverAllowed, false);
    assert.deepEqual(report.counts, { sourceRecords: 5, imported: 2, quarantined: 1, excluded: 2, requiresReview: 0 });
    assert.deepEqual(report.exclusions.noConversationTarget, {
        decision: 'exclude', candidateCount: 2, excludedCount: 2, blockedCount: 0,
        definition: 'Contact phone/LID has no exact conversation identity in the archive snapshot.',
        candidateLegacyControlStateCounts: { allowed: 1, ignored: 0, handoff: 1, neutral: 0, unknown: 0 }
    });
    const bySource = Object.fromEntries(Object.entries(contacts).map(([key]) => [key,
        report.entries.find(entry => entry.sourceKey === `contact:${hash(Buffer.from(`contact\0${key}`))}`)]));
    assert.equal(bySource.allowedWithoutConversation.disposition, 'excluded');
    assert.equal(bySource.allowedWithoutConversation.reason, 'no_conversation_target');
    assert.equal(bySource.allowedWithoutConversation.decision, 'exclude_no_conversation_target');
    assert.equal(bySource.handoffWithoutConversation.disposition, 'excluded');
    assert.equal(bySource.ambiguous.disposition, 'quarantined');
    assert.equal(bySource.ambiguous.reason, 'identity_ambiguous');
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('555@s.whatsapp.net'));
    assert.ok(!serialized.includes('777@s.whatsapp.net'));
    assert.ok(!serialized.includes('allowedWithoutConversation'));
});

test('F5.3 only preserves ambiguous quarantine when ignored_all already blocks every candidate conversation', () => {
    const id = suffix => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    const contacts = { ambiguous: { phone: '555', estado: 'neutro' } };
    const settings = { globalMode: 'ignored_all', currentProfile: 'default' };
    const conversations = [
        { id: id('1'), channel: 'whatsapp', access_policy: 'neutral', automation_mode: 'off', lifecycle: 'open', requires_review: 0,
            identity_keys: [{ kind: 'whatsapp_jid', exactValue: '555@s.whatsapp.net' }] },
        { id: id('2'), channel: 'whatsapp', access_policy: 'neutral', automation_mode: 'off', lifecycle: 'open', requires_review: 0,
            identity_keys: [{ kind: 'whatsapp_jid', exactValue: '555@s.whatsapp.net' }] }
    ];
    const input = { contacts, settings, conversations, profileKeys: ['default'], sourceManifest: {
        contacts: { present: true, sha256: 'a'.repeat(64) }, settings: { present: true, sha256: 'b'.repeat(64) }
    }, archive: { dataEpoch: id('9'), seq: '44', schemaVersion: 10 } };

    const preserved = buildControlImportReport({ ...input, preserveAmbiguousQuarantine: true });
    assert.equal(preserved.status, 'ready_with_quarantines');
    assert.equal(preserved.cutoverAllowed, true);
    assert.deepEqual(preserved.blockers, []);
    assert.deepEqual(preserved.warnings, [{ code: 'ambiguous_records_kept_blocked', count: 1 }]);
    assert.deepEqual(preserved.quarantineDecision, { decision: 'keep_blocked', requested: true, applied: true,
        quarantinedCount: 1, candidateConversationCount: 2, globalMode: 'ignored_all', controlsChanged: 0,
        reason: 'ambiguous_targets_already_inactive_under_ignored_all' });
    assert.equal(preserved.entries.find(entry => entry.source === 'contact').disposition, 'quarantined');

    const activeCandidate = buildControlImportReport({ ...input, preserveAmbiguousQuarantine: true,
        conversations: conversations.map((conversation, index) => index === 0
            ? { ...conversation, access_policy: 'allowed', automation_mode: 'ai' } : conversation) });
    assert.equal(activeCandidate.cutoverAllowed, false);
    assert.equal(activeCandidate.quarantineDecision.applied, false);
    assert.ok(activeCandidate.blockers.some(blocker => blocker.code === 'source_records_quarantined'));

    const allowedGlobalMode = buildControlImportReport({ ...input, settings: { ...settings, globalMode: 'allowed_all' },
        preserveAmbiguousQuarantine: true,
        conversations: conversations.map(conversation => ({ ...conversation, automation_mode: 'ai' })) });
    assert.equal(allowedGlobalMode.cutoverAllowed, false);
    assert.equal(allowedGlobalMode.quarantineDecision.reason, 'global_mode_must_be_ignored_all');

    const otherQuarantine = buildControlImportReport({ ...input, contacts: { ...contacts, missing: { estado: 'neutro' } },
        preserveAmbiguousQuarantine: true });
    assert.equal(otherQuarantine.cutoverAllowed, false);
    assert.equal(otherQuarantine.quarantineDecision.reason, 'only_identity_ambiguous_records_can_be_preserved');
});

test('F5.2 CLI reports from read-only SQLite and leaves JSON sources and archive bytes unchanged', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-control-dry-run-'));
    const databasePath = path.join(dir, 'archive.db');
    const contactsPath = path.join(dir, 'contacts.json');
    const settingsPath = path.join(dir, 'settings.json');
    const profilesPath = path.join(dir, 'profiles');
    const lockPath = path.join(dir, 'gateway.lock');
    const accountId = randomUUID();
    const archive = createArchive({ path: databasePath });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'dry-run-account' });
    await archive.ingestBatch([message(accountId, '56912345678', 'dry-run-message')]);
    await archive.close();

    await fs.mkdir(profilesPath);
    await fs.writeFile(path.join(profilesPath, 'default.md'), '# fixture profile\n');
    const contactBytes = Buffer.from(JSON.stringify({
        alice: { phone: '56912345678', estado: 'permitido', savedName: 'Secret Name' },
        noConversation: { phone: '56900000000', estado: 'ignorado', savedName: 'Private Orphan' }
    }));
    const settingsBytes = Buffer.from(JSON.stringify({ globalMode: 'allowed_all', currentProfile: 'default', telegramToken: 'secret-token-fixture' }));
    await fs.writeFile(contactsPath, contactBytes);
    await fs.writeFile(settingsPath, settingsBytes);
    const beforeDb = hash(await fs.readFile(databasePath));
    const beforeFiles = (await fs.readdir(dir)).sort();

    const command = [path.join(__dirname, '..', 'scripts', 'control-import-dry-run.js')];
    const env = { ...process.env, SDK_CONTACTS_DB_PATH: contactsPath, SDK_SETTINGS_DB_PATH: settingsPath,
        SDK_BRAIN_PROFILES_DIR: profilesPath, SDK_CONVERSATIONS_DB_PATH: databasePath, SDK_GATEWAY_LOCK_PATH: lockPath };
    await fs.writeFile(lockPath, String(process.pid));
    const busy = spawnSync(process.execPath, command, { encoding: 'utf8', env });
    assert.equal(busy.status, 2);
    assert.deepEqual(JSON.parse(busy.stdout).blockers, [{ code: 'GATEWAY_RUNNING' }]);
    await fs.unlink(lockPath);
    const child = spawnSync(process.execPath, command, { encoding: 'utf8', env });
    assert.equal(child.status, 2, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.cutoverAllowed, false);
    assert.deepEqual(report.counts, { sourceRecords: 4, imported: 3, quarantined: 1, excluded: 0, requiresReview: 0 });
    assert.equal(report.entries.find(entry => entry.reason === 'identity_not_found')?.disposition, 'quarantined');
    assert.equal(report.sourceManifest.archive.schemaVersion, 14);
    assert.equal(hash(await fs.readFile(contactsPath)), hash(contactBytes));
    assert.equal(hash(await fs.readFile(settingsPath)), hash(settingsBytes));
    assert.equal(hash(await fs.readFile(databasePath)), beforeDb);
    assert.deepEqual((await fs.readdir(dir)).sort(), beforeFiles);
    assert.ok(!child.stdout.includes('secret-token-fixture'));
    assert.ok(!child.stdout.includes('Secret Name'));
    assert.ok(!child.stdout.includes('Private Orphan'));

    const excludedChild = spawnSync(process.execPath, [...command, '--exclude-no-conversation'], { encoding: 'utf8', env });
    assert.equal(excludedChild.status, 0, excludedChild.stderr || excludedChild.stdout);
    const excludedReport = JSON.parse(excludedChild.stdout);
    assert.equal(excludedReport.cutoverAllowed, true);
    assert.deepEqual(excludedReport.counts, { sourceRecords: 4, imported: 3, quarantined: 0, excluded: 1, requiresReview: 0 });
    assert.deepEqual(excludedReport.exclusions.noConversationTarget, {
        decision: 'exclude', candidateCount: 1, excludedCount: 1, blockedCount: 0,
        definition: 'Contact phone/LID has no exact conversation identity in the archive snapshot.',
        candidateLegacyControlStateCounts: { allowed: 0, ignored: 1, handoff: 0, neutral: 0, unknown: 0 }
    });
    assert.equal(hash(await fs.readFile(contactsPath)), hash(contactBytes));
    assert.equal(hash(await fs.readFile(settingsPath)), hash(settingsBytes));
    assert.equal(hash(await fs.readFile(databasePath)), beforeDb);
    assert.deepEqual((await fs.readdir(dir)).sort(), beforeFiles);
    assert.ok(!excludedChild.stdout.includes('secret-token-fixture'));
    assert.ok(!excludedChild.stdout.includes('Secret Name'));
    assert.ok(!excludedChild.stdout.includes('Private Orphan'));

    const readOnly = createArchive({ path: databasePath, readOnly: true });
    t.after(() => readOnly.close());
    const ready = await readOnly.ready;
    assert.equal(ready.readOnly, true);
    assert.equal((await allConversationRows(readOnly)).length, 1);
    await assert.rejects(readOnly.writeControlState({ conversationId: randomUUID(), actorId: randomUUID(), expectedVersion: '1',
        state: { accessPolicy: 'neutral', automationMode: 'off', lifecycle: 'open', ownerId: null,
            status: 'confirmed', takenAt: null, handoffReason: null } }), { code: 'READ_ONLY_ARCHIVE' });
    assert.equal(hash(await fs.readFile(databasePath)), beforeDb);
    assert.deepEqual((await fs.readdir(dir)).sort(), beforeFiles);

    await readOnly.close();
    const walPath = `${databasePath}-wal`;
    const walBytes = Buffer.from('stale sidecar fixture');
    await fs.writeFile(walPath, walBytes);
    const blocked = createArchive({ path: databasePath, readOnly: true });
    t.after(() => blocked.close());
    await assert.rejects(blocked.ready, { code: 'ARCHIVE_NOT_QUIESCENT' });
    await blocked.close();
    assert.equal(hash(await fs.readFile(databasePath)), beforeDb);
    assert.deepEqual(await fs.readFile(walPath), walBytes);
    await fs.unlink(walPath);
});
