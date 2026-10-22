process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');

function message(accountId, phone, id) {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: `${phone}@s.whatsapp.net` },
        providerMessageId: id, source: 'history', direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: 'migration fixture' } };
}
function sourceManifest(contacts, settings) {
    return { contacts: { present: true, sha256: createHash('sha256').update(JSON.stringify(contacts)).digest('hex') },
        settings: { present: true, sha256: createHash('sha256').update(JSON.stringify(settings)).digest('hex') } };
}
async function fixture(t, phones = ['111']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-control-migration-'));
    const databasePath = path.join(dir, 'archive.db');
    const archive = createArchive({ path: databasePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    const accountId = randomUUID();
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'control-migration-fixture' });
    await archive.ingestBatch(phones.map((phone, index) => message(accountId, phone, `migration-${index}`)));
    return { archive, databasePath, accountId };
}
async function reportFor(archive, contacts, settings = { globalMode: 'ignored_all', currentProfile: 'default' }, generatedAt = '2026-10-20T12:00:00.000Z', options = {}) {
    const snapshot = await archive.snapshot();
    const ready = await archive.ready;
    return buildControlImportReport({ contacts, settings, profileKeys: ['default'], conversations: await archive.conversationRows(),
        sourceManifest: sourceManifest(contacts, settings), archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt, ...options });
}
async function stage(archive, migrationId, report, decisions = {}) {
    const begin = await archive.beginControlImport({ migrationId, report, decisions });
    if (begin.status === 'staging') {
        for (let offset = 0; offset < begin.report.entryCount; offset += 2) {
            await archive.stageControlImportBatch({ runId: begin.runId, offset, limit: 2 });
            await archive.stageControlImportBatch({ runId: begin.runId, offset, limit: 2 });
        }
    }
    return { begin, verified: await archive.verifyControlImport({ runId: begin.runId }) };
}

test('F5.3 migrates an existing v5 archive in place and preserves staged control values', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-control-v5-'));
    const databasePath = path.join(dir, 'archive.db');
    const conversationId = randomUUID();
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE archive_meta(id INTEGER PRIMARY KEY,epoch TEXT NOT NULL,seq TEXT NOT NULL);
        CREATE TABLE conversations(id TEXT PRIMARY KEY,access_policy TEXT NOT NULL,automation_mode TEXT NOT NULL,
            lifecycle TEXT NOT NULL,owner_id TEXT,control_version TEXT NOT NULL,context_version TEXT NOT NULL,
            control_status TEXT NOT NULL,taken_at TEXT,handoff_reason TEXT,aggregate_version TEXT NOT NULL DEFAULT '1',
            requires_review INTEGER NOT NULL DEFAULT 0,inbound_seq TEXT NOT NULL DEFAULT '0');
        CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,occurred_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            inbound_seq TEXT,payload TEXT NOT NULL);
        CREATE TABLE events(seq TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT,created_at TEXT NOT NULL,
            actor_id TEXT,payload TEXT NOT NULL);
        INSERT INTO archive_meta VALUES(1,'fixture-v5-epoch','7');
        INSERT INTO conversations(id,access_policy,automation_mode,lifecycle,control_version,context_version,control_status,
            handoff_reason,aggregate_version) VALUES('${conversationId}','neutral','human','open','4','2','confirmed','operator','9');
        PRAGMA user_version=5;`);
    db.close();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const archive = createArchive({ path: databasePath });
    t.after(() => archive.close());
    assert.equal((await archive.ready).schemaVersion, 13);
    assert.deepEqual(await archive.controlState(conversationId), {
        accessPolicy: 'neutral', automationMode: 'human', lifecycle: 'open', ownerId: null,
        controlVersion: '4', contextVersion: '2', status: 'confirmed', takenAt: null, handoffReason: 'operator',
        profileKey: null, requiresReview: false, reviewReasons: []
    });
    assert.equal((await archive.conversation(conversationId)).profile_key, null);
    assert.equal((await archive.controlAuthority()).mode, 'legacy');
    assert.deepEqual(await archive.snapshot(), { dataEpoch: 'fixture-v5-epoch', seq: '7' });
});

test('F5.3 cutover can explicitly keep ambiguous neutral contacts quarantined without changing candidate controls', async t => {
    const { archive } = await fixture(t, ['111', '555']);
    const secondAccountId = randomUUID();
    await archive.registerAccount({ id: secondAccountId, channel: 'whatsapp', providerKey: 'ambiguous-control-migration-fixture' });
    await archive.ingestBatch([message(secondAccountId, '555', 'ambiguous-second-account')]);

    const rows = await archive.conversationRows();
    const ambiguousTargets = rows.filter(row => row.identity_keys.some(identity => identity.exactValue === '555@s.whatsapp.net'));
    assert.equal(ambiguousTargets.length, 2);
    const initialAmbiguousControls = new Map(await Promise.all(ambiguousTargets.map(async row => [row.id, await archive.controlState(row.id)])));
    const contacts = {
        testChat: { phone: '111', estado: 'permitido' },
        ambiguous: { phone: '555', estado: 'neutro' }
    };
    const report = await reportFor(archive, contacts, { globalMode: 'ignored_all', currentProfile: 'default' },
        '2026-10-20T12:00:00.000Z', { preserveAmbiguousQuarantine: true });
    assert.equal(report.cutoverAllowed, true);
    assert.equal(report.status, 'ready_with_quarantines');
    assert.equal(report.quarantineDecision.quarantinedCount, 1);
    const ambiguousEntry = report.entries.find(entry => entry.source === 'contact' && entry.reason === 'identity_ambiguous');
    assert.equal(ambiguousEntry.disposition, 'quarantined');

    const migrationId = 'f5-control-preserve-ambiguous-fixture';
    const staged = await stage(archive, migrationId, report, { preserveAmbiguousQuarantine: true });
    assert.equal(staged.verified.status, 'verified');
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    for (;;) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 10 });
        if (batch.remaining === 0) break;
    }
    const cutover = await archive.finishControlCutover({ migrationId });
    assert.equal(cutover.authority.mode, 'sqlite');
    assert.equal((await archive.controlPolicy()).globalMode, 'ignored_all');
    assert.equal((await archive.controlState(report.entries.find(entry => entry.source === 'contact'
        && entry.disposition === 'imported').targetId)).automationMode, 'ai');
    for (const [conversationId, initial] of initialAmbiguousControls) {
        assert.deepEqual(await archive.controlState(conversationId), initial);
    }
    const entries = await archive.controlImportEntries({ runId: staged.begin.runId });
    assert.equal(entries.find(entry => entry.reason === 'identity_ambiguous').disposition, 'quarantined');
});

test('F5.4 v6 to v7 migration preserves the event timeline and permits audited global policy events', async t => {
    const { archive, databasePath } = await fixture(t, ['909']);
    const created = await archive.ingestBatch([message((await archive.accounts())[0].id, '909', 'v6-event')]);
    assert.equal(created[0].status, 'created');
    const beforeEvents = await archive.events({ after: '0' });
    await archive.close();

    const db = new DatabaseSync(databasePath);
    db.exec(`DROP TRIGGER IF EXISTS messages_search_insert; DROP TRIGGER IF EXISTS messages_search_update;
        DROP TRIGGER IF EXISTS messages_search_delete; DROP TABLE IF EXISTS message_search;
        DROP TABLE attachments; DROP INDEX messages_summary_period; DROP TABLE outbound_intents; DROP TABLE control_operations;
        DROP INDEX messages_ai_context; DROP TABLE message_sequence;
        ALTER TABLE messages DROP COLUMN archive_seq;
        ALTER TABLE conversations DROP COLUMN context_through_seq;
        ALTER TABLE conversations DROP COLUMN handled_inbound_seq;
        ALTER TABLE conversations DROP COLUMN resume_after_inbound_seq;
        ALTER TABLE events RENAME TO events_v7;
        CREATE TABLE events (
            seq TEXT PRIMARY KEY CHECK(seq NOT GLOB '*[^0-9]*' AND substr(seq,1,1) BETWEEN '1' AND '9'),
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL, actor_id TEXT, payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        INSERT INTO events SELECT * FROM events_v7;
        DROP TABLE events_v7;
        CREATE INDEX events_order ON events(length(seq),seq);
        CREATE INDEX events_retention ON events(created_at);
        PRAGMA user_version=6;`);
    db.close();

    const readonly = createArchive({ path: databasePath, readOnly: true });
    t.after(() => readonly.close());
    assert.equal((await readonly.ready).schemaVersion, 6);
    assert.equal((await readonly.recoveryCheckpoint()).schemaVersion, 6);
    assert.equal((await readonly.recoveryCheckpoint()).outboundIntentCount, 0);
    assert.deepEqual(await readonly.attachmentRegistry(), []);
    await readonly.close();

    const migrated = createArchive({ path: databasePath });
    t.after(() => migrated.close());
    assert.equal((await migrated.ready).schemaVersion, 13);
    assert.deepEqual(await migrated.events({ after: '0' }), beforeEvents);
    const policy = await migrated.writeControlPolicy({ actorId: randomUUID(), expectedVersion: '1',
        globalMode: 'allowed_all', globalProfileKey: null });
    assert.equal(policy.status, 'updated');
    assert.equal(policy.event.type, 'policy.updated');
    const diagnostics = await migrated.diagnostics();
    assert.equal(diagnostics.integrity, 'ok');
    assert.equal(diagnostics.foreignKeys, 0);
});

test('F5.3 stages idempotently, preserves legacy authority and blocks unsafe deltas', async t => {
    const { archive } = await fixture(t, ['111', '222']);
    assert.equal((await archive.ready).schemaVersion, 13);
    assert.deepEqual(await archive.controlAuthority(), { mode: 'legacy', migrationId: null, serviceReady: false, changedAt: null });
    const contacts = { alice: { phone: '111', estado: 'permitido' } };
    const first = await reportFor(archive, contacts);
    const migrationId = 'f5-control-migration-fixture';
    const initialControl = await archive.controlState(first.entries.find(entry => entry.source === 'contact').targetId);
    const firstStage = await stage(archive, migrationId, first);
    assert.equal(firstStage.verified.status, 'verified');
    assert.equal((await archive.controlState(first.entries.find(entry => entry.source === 'contact').targetId)).automationMode, 'off');
    assert.equal((await archive.controlAuthority()).mode, 'legacy');
    const repeated = await stage(archive, migrationId, { ...first, generatedAt: '2026-10-20T13:00:00.000Z' });
    assert.equal(repeated.begin.runId, firstStage.begin.runId);
    assert.equal(repeated.begin.resumed, true);

    const changed = { alice: { phone: '111', estado: 'ignorado' } };
    const delta = await stage(archive, migrationId, await reportFor(archive, changed, undefined, '2026-10-20T14:00:00.000Z'));
    assert.notEqual(delta.begin.runId, firstStage.begin.runId);
    assert.equal(delta.verified.status, 'verified');
    const deltaEntries = await archive.controlImportEntries({ runId: delta.begin.runId });
    assert.equal(deltaEntries.find(entry => entry.source === 'contact').control.accessPolicy, 'ignored');

    const removed = await stage(archive, migrationId, await reportFor(archive, {}, undefined, '2026-10-20T15:00:00.000Z'));
    assert.equal(removed.verified.status, 'blocked');
    assert.ok(removed.verified.report.blockers.some(blocker => blocker.code === 'source_record_removed'));
    assert.equal(removed.verified.report.counts.sourceRecords,
        removed.verified.report.counts.imported + removed.verified.report.counts.quarantined + removed.verified.report.counts.excluded);
    assert.deepEqual(await archive.controlState(first.entries.find(entry => entry.source === 'contact').targetId), initialControl);
    assert.equal((await archive.controlAuthority()).mode, 'legacy');
    const acceptedRemoval = await stage(archive, migrationId, await reportFor(archive, {}, undefined, '2026-10-20T16:00:00.000Z'),
        { acceptSourceRemovals: true });
    assert.equal(acceptedRemoval.verified.status, 'verified');
    assert.equal(acceptedRemoval.verified.report.delta.acceptedSourceRemovals, 1);
    const acceptedEntries = await archive.controlImportEntries({ runId: acceptedRemoval.begin.runId });
    assert.equal(acceptedEntries.find(entry => entry.reason === 'source_record_removed_accepted').disposition, 'excluded');
    const acceptedAgain = await stage(archive, migrationId, await reportFor(archive, {}, undefined, '2026-10-20T17:00:00.000Z'));
    assert.equal(acceptedAgain.begin.runId, acceptedRemoval.begin.runId);
});

test('F5.3 keeps an identity remap blocked until an explicit review decision', async t => {
    const { archive } = await fixture(t, ['111', '222']);
    const migrationId = 'f5-control-remap-fixture';
    const first = await stage(archive, migrationId, await reportFor(archive, { person: { phone: '111', estado: 'permitido' } }));
    assert.equal(first.verified.status, 'verified');
    const remappedReport = await reportFor(archive, { person: { phone: '222', estado: 'permitido' } });
    const remapped = await stage(archive, migrationId, remappedReport);
    assert.equal(remapped.verified.status, 'blocked');
    const remappedEntries = await archive.controlImportEntries({ runId: remapped.begin.runId });
    assert.equal(remappedEntries.find(entry => entry.source === 'contact').reason, 'identity_target_changed');
    const repeated = await stage(archive, migrationId, { ...remappedReport, generatedAt: '2026-10-20T13:00:00.000Z' });
    assert.equal(repeated.begin.runId, remapped.begin.runId);
    assert.equal(repeated.verified.status, 'blocked');
    const accepted = await stage(archive, migrationId, { ...remappedReport, generatedAt: '2026-10-20T14:00:00.000Z' },
        { acceptIdentityChanges: true });
    assert.equal(accepted.verified.status, 'verified');
    assert.equal(accepted.verified.report.delta.acceptedIdentityChanges, 1);
    const acceptedEntries = await archive.controlImportEntries({ runId: accepted.begin.runId });
    assert.equal(acceptedEntries.find(entry => entry.source === 'contact').targetId,
        remappedReport.entries.find(entry => entry.source === 'contact').targetId);
});

test('F5.3 cannot turn a previously mapped contact into a no-conversation exclusion', async t => {
    const { archive } = await fixture(t, ['555']);
    const migrationId = 'f5-control-exclusion-target-missing';
    const contacts = { person: { phone: '555', estado: 'permitido' } };
    const originalReport = await reportFor(archive, contacts);
    const original = await stage(archive, migrationId, originalReport);
    assert.equal(original.verified.status, 'verified');

    const snapshot = await archive.snapshot();
    const ready = await archive.ready;
    const changedSnapshot = buildControlImportReport({ contacts, settings: { globalMode: 'ignored_all', currentProfile: 'default' },
        conversations: [], profileKeys: ['default'], sourceManifest: sourceManifest(contacts,
            { globalMode: 'ignored_all', currentProfile: 'default' }),
        archive: { ...snapshot, schemaVersion: ready.schemaVersion }, excludeContactsWithoutConversation: true });
    const missing = await stage(archive, migrationId, changedSnapshot);
    assert.equal(missing.verified.status, 'blocked');
    assert.equal(missing.verified.report.cutoverAllowed, false);
    assert.ok(missing.verified.report.blockers.some(blocker => blocker.code === 'identity_target_missing'));
    assert.ok(missing.verified.report.blockers.some(blocker => blocker.code === 'source_records_quarantined'));
    assert.deepEqual(missing.verified.report.exclusions.noConversationTarget,
        { decision: 'exclude', candidateCount: 1, excludedCount: 0, blockedCount: 1,
            definition: 'Contact phone/LID has no exact conversation identity in the archive snapshot.',
            candidateLegacyControlStateCounts: { allowed: 1, ignored: 0, handoff: 0, neutral: 0, unknown: 0 } });
    const entries = await archive.controlImportEntries({ runId: missing.begin.runId });
    const entry = entries.find(candidate => candidate.source === 'contact');
    assert.equal(entry.disposition, 'quarantined');
    assert.equal(entry.reason, 'identity_target_missing');
    assert.equal(entry.reviewTargetId, originalReport.entries.find(candidate => candidate.source === 'contact').targetId);
    assert.equal((await archive.controlAuthority()).mode, 'legacy');
});

test('F5.3 gates cutover until F5.4 readiness and recovers a partial cutover after restart', async t => {
    const { archive, databasePath } = await fixture(t, ['333']);
    const report = await reportFor(archive, { person: { phone: '333', estado: 'permitido' } },
        { globalMode: 'allowed_all', currentProfile: 'default' });
    const conversationId = report.entries.find(entry => entry.source === 'contact').targetId;
    const initial = await archive.controlState(conversationId);
    const migrationId = 'f5-control-cutover-fixture';
    const staged = await stage(archive, migrationId, report);
    assert.equal(staged.verified.status, 'verified');
    await assert.rejects(archive.startControlCutover({ migrationId }), { code: 'CONTROL_SERVICE_NOT_READY' });
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    const partial = await archive.applyControlCutoverBatch({ migrationId, limit: 1 });
    assert.equal(partial.remaining, 2);
    await archive.close();
    const blocked = createArchive({ path: databasePath });
    await assert.rejects(blocked.ready, { code: 'CONTROL_CUTOVER_RECOVERY_REQUIRED' });
    await blocked.close();
    const recovered = createArchive({ path: databasePath, controlRecovery: true });
    t.after(() => recovered.close());
    await recovered.ready;
    const next = await recovered.applyControlCutoverBatch({ migrationId, limit: 10 });
    assert.equal(next.remaining, 0);
    const active = await recovered.finishControlCutover({ migrationId });
    assert.equal(active.status, 'cutover');
    assert.equal(active.authority.mode, 'sqlite');
    assert.equal((await recovered.controlState(conversationId)).automationMode, 'ai');
    assert.equal((await recovered.conversation(conversationId)).profile_key, 'default');
    assert.equal(initial.automationMode, 'off');
});

test('F5.3 rolls back batches before authority is switched and keeps versions monotonic', async t => {
    const { archive } = await fixture(t, ['444']);
    const report = await reportFor(archive, { person: { phone: '444', estado: 'permitido' } },
        { globalMode: 'allowed_all', currentProfile: 'default' });
    const conversationId = report.entries.find(entry => entry.source === 'contact').targetId;
    const migrationId = 'f5-control-rollback-fixture';
    const initial = await archive.controlState(conversationId);
    const staged = await stage(archive, migrationId, report);
    assert.equal(staged.verified.status, 'verified');
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    let changed = false;
    while (!changed) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 1 });
        changed = batch.events.length > 0;
    }
    for (;;) {
        const batch = await archive.rollbackControlCutoverBatch({ migrationId, limit: 1 });
        if (batch.remaining === 0) break;
    }
    const result = await archive.finishControlRollback({ migrationId });
    const restored = await archive.controlState(conversationId);
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.authority.mode, 'legacy');
    assert.equal(restored.accessPolicy, initial.accessPolicy);
    assert.equal(restored.automationMode, initial.automationMode);
    assert.ok(BigInt(restored.controlVersion) > BigInt(initial.controlVersion));
});

test('F5.3 CLI applies a staged report only and keeps authority legacy until the integrated service is ready', async t => {
    const { archive, databasePath } = await fixture(t, ['555', '777']);
    const secondAccountId = randomUUID();
    await archive.registerAccount({ id: secondAccountId, channel: 'whatsapp', providerKey: 'ambiguous-cli-fixture' });
    await archive.ingestBatch([message(secondAccountId, '777', 'ambiguous-cli-second-account')]);
    const contact = { person: { phone: '555', estado: 'permitido' }, ambiguous: { phone: '777', estado: 'neutro' } };
    const rows = await archive.conversationRows();
    const conversationId = rows.find(row => row.identity_keys.some(identity => identity.exactValue === '555@s.whatsapp.net')).id;
    const ambiguousTargets = rows.filter(row => row.identity_keys.some(identity => identity.exactValue === '777@s.whatsapp.net'));
    assert.equal(ambiguousTargets.length, 2);
    const initialAmbiguousControls = new Map(await Promise.all(ambiguousTargets.map(async row => [row.id, await archive.controlState(row.id)])));
    const contactsPath = path.join(path.dirname(databasePath), 'contacts.json');
    const settingsPath = path.join(path.dirname(databasePath), 'settings.json');
    const profilesPath = path.join(path.dirname(databasePath), 'profiles');
    const lockPath = path.join(path.dirname(databasePath), 'gateway.lock');
    await fs.mkdir(profilesPath);
    await fs.writeFile(path.join(profilesPath, 'default.md'), '# fixture\n');
    await fs.writeFile(contactsPath, JSON.stringify(contact));
    await fs.writeFile(settingsPath, JSON.stringify({ globalMode: 'ignored_all', currentProfile: 'default' }));
    await archive.close();
    const env = { ...process.env, SDK_CONTACTS_DB_PATH: contactsPath, SDK_SETTINGS_DB_PATH: settingsPath,
        SDK_BRAIN_PROFILES_DIR: profilesPath, SDK_CONVERSATIONS_DB_PATH: databasePath, SDK_GATEWAY_LOCK_PATH: lockPath };
    const command = [path.join(__dirname, '..', 'scripts', 'control-import.js')];
    const migrationId = 'f5-control-cli-fixture';
    const staged = spawnSync(process.execPath, [...command, '--apply', '--preserve-ambiguous-blocked', '--migration-id', migrationId], { encoding: 'utf8', env });
    assert.equal(staged.status, 0, staged.stderr || staged.stdout);
    const stagedResult = JSON.parse(staged.stdout);
    assert.equal(stagedResult.status, 'verified');
    assert.equal(stagedResult.cutoverAllowed, true);
    assert.deepEqual(stagedResult.warnings, [{ code: 'ambiguous_records_kept_blocked', count: 1 }]);
    assert.equal(stagedResult.quarantineDecision.decision, 'keep_blocked');
    const reopened = createArchive({ path: databasePath });
    t.after(async () => reopened.close().catch(() => {}));
    await reopened.ready;
    await reopened.setControlServiceReady({ ready: true });
    await reopened.close();
    const requestCutover = spawnSync(process.execPath, [...command, '--apply', '--cutover', '--preserve-ambiguous-blocked',
        '--migration-id', migrationId], { encoding: 'utf8', env });
    assert.equal(requestCutover.status, 0, requestCutover.stderr || requestCutover.stdout);
    assert.equal(JSON.parse(requestCutover.stdout).cutover.status, 'cutover');
    const afterCutover = createArchive({ path: databasePath });
    t.after(() => afterCutover.close());
    await afterCutover.ready;
    assert.equal((await afterCutover.controlAuthority()).mode, 'sqlite');
    assert.equal((await afterCutover.controlPolicy()).globalMode, 'ignored_all');
    assert.equal((await afterCutover.controlState(conversationId)).automationMode, 'ai');
    for (const [id, initial] of initialAmbiguousControls) assert.deepEqual(await afterCutover.controlState(id), initial);
    const migration = await afterCutover.controlImportStatus(migrationId);
    assert.equal(migration.run.report.counts.quarantined, 1);
    assert.equal(migration.status, 'cutover');
});
