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
async function reportFor(archive, contacts, settings = { globalMode: 'ignored_all', currentProfile: 'default' }, generatedAt = '2026-10-20T12:00:00.000Z') {
    const snapshot = await archive.snapshot();
    const ready = await archive.ready;
    return buildControlImportReport({ contacts, settings, profileKeys: ['default'], conversations: await archive.conversationRows(),
        sourceManifest: sourceManifest(contacts, settings), archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt });
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
        CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,payload TEXT NOT NULL);
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
    assert.equal((await archive.ready).schemaVersion, 10);
    assert.deepEqual(await archive.controlState(conversationId), {
        accessPolicy: 'neutral', automationMode: 'human', lifecycle: 'open', ownerId: null,
        controlVersion: '4', contextVersion: '2', status: 'confirmed', takenAt: null, handoffReason: 'operator',
        profileKey: null, requiresReview: false, reviewReasons: []
    });
    assert.equal((await archive.conversation(conversationId)).profile_key, null);
    assert.equal((await archive.controlAuthority()).mode, 'legacy');
    assert.deepEqual(await archive.snapshot(), { dataEpoch: 'fixture-v5-epoch', seq: '7' });
});

test('F5.4 v6 to v7 migration preserves the event timeline and permits audited global policy events', async t => {
    const { archive, databasePath } = await fixture(t, ['909']);
    const created = await archive.ingestBatch([message((await archive.accounts())[0].id, '909', 'v6-event')]);
    assert.equal(created[0].status, 'created');
    const beforeEvents = await archive.events({ after: '0' });
    await archive.close();

    const db = new DatabaseSync(databasePath);
    db.exec(`DROP TABLE outbound_intents; DROP TABLE control_operations;
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

    const migrated = createArchive({ path: databasePath });
    t.after(() => migrated.close());
    assert.equal((await migrated.ready).schemaVersion, 10);
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
    assert.equal((await archive.ready).schemaVersion, 10);
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
    const { archive, databasePath } = await fixture(t, ['555']);
    const contact = { person: { phone: '555', estado: 'permitido' } };
    const accountRows = await archive.conversationRows();
    const conversationId = accountRows[0].id;
    const contactsPath = path.join(path.dirname(databasePath), 'contacts.json');
    const settingsPath = path.join(path.dirname(databasePath), 'settings.json');
    const profilesPath = path.join(path.dirname(databasePath), 'profiles');
    const lockPath = path.join(path.dirname(databasePath), 'gateway.lock');
    await fs.mkdir(profilesPath);
    await fs.writeFile(path.join(profilesPath, 'default.md'), '# fixture\n');
    await fs.writeFile(contactsPath, JSON.stringify(contact));
    await fs.writeFile(settingsPath, JSON.stringify({ globalMode: 'allowed_all', currentProfile: 'default' }));
    await archive.close();
    const env = { ...process.env, SDK_CONTACTS_DB_PATH: contactsPath, SDK_SETTINGS_DB_PATH: settingsPath,
        SDK_BRAIN_PROFILES_DIR: profilesPath, SDK_CONVERSATIONS_DB_PATH: databasePath, SDK_GATEWAY_LOCK_PATH: lockPath };
    const command = [path.join(__dirname, '..', 'scripts', 'control-import.js')];
    const migrationId = 'f5-control-cli-fixture';
    const staged = spawnSync(process.execPath, [...command, '--apply', '--migration-id', migrationId], { encoding: 'utf8', env });
    assert.equal(staged.status, 0, staged.stderr || staged.stdout);
    assert.equal(JSON.parse(staged.stdout).status, 'verified');
    const requestCutover = spawnSync(process.execPath, [...command, '--apply', '--cutover', '--migration-id', migrationId], { encoding: 'utf8', env });
    assert.equal(requestCutover.status, 2);
    assert.deepEqual(JSON.parse(requestCutover.stdout).blockers, [{ code: 'CONTROL_SERVICE_NOT_READY' }]);
    const reopened = createArchive({ path: databasePath });
    t.after(() => reopened.close());
    await reopened.ready;
    assert.equal((await reopened.controlAuthority()).mode, 'legacy');
    assert.equal((await reopened.controlImportStatus(migrationId)).status, 'verified');
    assert.equal((await reopened.controlState(conversationId)).automationMode, 'off');
});
