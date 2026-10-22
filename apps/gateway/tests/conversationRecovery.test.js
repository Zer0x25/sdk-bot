process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createArchive } = require('../services/conversations');
const { createAttachmentStore } = require('../services/conversations/attachments');
const { buildControlImportReport } = require('../services/conversations/controlImport');
const { normalizeUpdates } = require('../services/conversations/telegramCapture');

const destination = '15551234567@s.whatsapp.net';
const scriptPath = path.join(__dirname, '../scripts/restore-promotion-check.js');

function inbound(accountId, providerMessageId, source = 'history') {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: destination },
        providerMessageId, source, direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: `recovery fixture ${providerMessageId}` } };
}

async function migrateControl(archive, conversationId) {
    const contacts = { fixtureCustomer: { phone: destination.slice(0, -'@s.whatsapp.net'.length), estado: 'permitido' } };
    const settings = { globalMode: 'ignored_all', currentProfile: 'default' };
    const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const ready = await archive.ready;
    const snapshot = await archive.snapshot();
    const report = buildControlImportReport({ contacts, settings, profileKeys: ['default'],
        conversations: await archive.conversationRows(), sourceManifest: {
            contacts: { present: true, sha256: sha(contacts) }, settings: { present: true, sha256: sha(settings) }
        }, archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt: '2026-10-20T12:00:00.000Z' });
    assert.ok(report.entries.some(entry => entry.targetId === conversationId));
    const migrationId = `f84-restore-${randomUUID()}`;
    const begun = await archive.beginControlImport({ migrationId, report });
    for (let offset = 0; offset < begun.report.entryCount; offset += 100) {
        await archive.stageControlImportBatch({ runId: begun.runId, offset, limit: 100 });
    }
    assert.equal((await archive.verifyControlImport({ runId: begun.runId })).status, 'verified');
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    for (;;) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 100 });
        if (batch.remaining === 0) break;
    }
    assert.equal((await archive.finishControlCutover({ migrationId })).authority.mode, 'sqlite');
}

async function acceptedHuman(archive, accountId, conversationId, actorId, idempotencyKey, providerMessageId, text) {
    const current = await archive.controlState(conversationId);
    let control = current;
    if (current.accessPolicy !== 'allowed' || current.automationMode !== 'human' || current.ownerId !== actorId) {
        const changed = await archive.writeControlState({ conversationId, actorId, expectedVersion: current.controlVersion,
            state: { ...current, accessPolicy: 'allowed', automationMode: 'human', ownerId: actorId } });
        assert.equal(changed.status, 'updated');
        control = changed.control;
    }
    const policy = await archive.controlPolicy();
    await archive.beginOutboundIntent({ idempotencyKey, accountId, conversationId, channel: 'whatsapp', destination,
        actorId, source: 'human', payload: { text, options: {} },
        controlSnapshot: { conversationId, controlVersion: control.controlVersion,
            contextVersion: control.contextVersion, policyVersion: policy.policyVersion },
        policy: { clientMessageId: randomUUID() } });
    assert.equal((await archive.claimOutboundIntent({ idempotencyKey })).status, 'claimed');
    await archive.finishOutboundIntent({ idempotencyKey, state: 'accepted', providerMessageId });
    assert.ok(await archive.messageByProviderId({ conversationId, providerMessageId }));
}

function runGate(sourcePath, snapshotPath, lockPath, { sourceAttachments = path.join(path.dirname(sourcePath), 'attachments'),
    snapshotAttachments = path.join(path.dirname(snapshotPath), 'attachments') } = {}) {
    const result = spawnSync(process.execPath, [scriptPath, '--snapshot', snapshotPath,
        '--snapshot-attachments', snapshotAttachments], { cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8', env: { ...process.env, SDK_BOT_TEST: '1', SDK_CONVERSATIONS_DB_PATH: sourcePath,
            SDK_ATTACHMENT_DIR: sourceAttachments, SDK_GATEWAY_LOCK_PATH: lockPath } });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.ok(result.stdout, result.stderr || 'restore check produced no output');
    return { exitCode: result.status, result: JSON.parse(result.stdout) };
}

test('F8.4 migration and restore gate blocks stale snapshots after evented and ledger-only sends', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-f84-recovery-'));
    const sourcePath = path.join(dir, 'active.db');
    const snapshotPath = path.join(dir, 'before-delta.db');
    const freshSnapshotPath = path.join(dir, 'after-delta.db');
    const lockPath = path.join(dir, 'gateway.lock');
    let archive = createArchive({ path: sourcePath });
    t.after(async () => { await archive?.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });

    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'f84-recovery-fixture' });
    const [firstInbound] = await archive.ingestBatch([inbound(account.id, 'before-cutover')]);
    const conversationId = firstInbound.message.conversationId;
    await migrateControl(archive, conversationId);
    const actorId = randomUUID();
    await acceptedHuman(archive, account.id, conversationId, actorId,
        'f84-human-before-snapshot', 'f84-human-before', 'respuesta humana antes del snapshot');
    const base = await archive.backup(snapshotPath);
    await archive.close(); archive = null;

    const initialGate = runGate(sourcePath, snapshotPath, lockPath);
    assert.equal(initialGate.exitCode, 0);
    assert.equal(initialGate.result.promotionAllowed, true);
    assert.deepEqual(initialGate.result.blockers, []);

    archive = createArchive({ path: sourcePath });
    await archive.ready;
    await archive.beginOutboundIntent({ idempotencyKey: 'f84-notice-after-snapshot', accountId: account.id,
        channel: 'whatsapp', destination, actorId: randomUUID(), source: 'notice',
        payload: { text: 'aviso aceptado sin evento de conversación' } });
    assert.equal((await archive.claimOutboundIntent({ idempotencyKey: 'f84-notice-after-snapshot' })).status, 'claimed');
    await archive.finishOutboundIntent({ idempotencyKey: 'f84-notice-after-snapshot', state: 'accepted',
        providerMessageId: 'f84-notice-provider-id' });
    assert.equal((await archive.snapshot()).seq, base.seq);
    await archive.close(); archive = null;

    const ledgerGate = runGate(sourcePath, snapshotPath, lockPath);
    assert.equal(ledgerGate.exitCode, 2);
    assert.equal(ledgerGate.result.promotionAllowed, false);
    assert.equal(ledgerGate.result.source.seq, ledgerGate.result.snapshot.seq);
    assert.ok(ledgerGate.result.blockers.includes('OUTBOUND_LEDGER_MISMATCH'));

    archive = createArchive({ path: sourcePath });
    await archive.ready;
    await archive.beginOutboundIntent({ idempotencyKey: 'f84-unresolved-after-snapshot', accountId: account.id,
        channel: 'whatsapp', destination, actorId: randomUUID(), source: 'notice',
        payload: { text: 'intento aún sin resultado' } });
    await archive.close(); archive = null;
    const unresolvedGate = runGate(sourcePath, snapshotPath, lockPath);
    assert.equal(unresolvedGate.exitCode, 2);
    assert.ok(unresolvedGate.result.blockers.includes('UNRESOLVED_OUTBOUND'));

    archive = createArchive({ path: sourcePath });
    await archive.ready;
    assert.equal((await archive.claimOutboundIntent({ idempotencyKey: 'f84-unresolved-after-snapshot' })).status, 'claimed');
    await archive.finishOutboundIntent({ idempotencyKey: 'f84-unresolved-after-snapshot', state: 'rejected',
        errorCode: 'FIXTURE_REJECTED' });
    await archive.ingestBatch([inbound(account.id, 'after-snapshot', 'live')]);
    await acceptedHuman(archive, account.id, conversationId, actorId,
        'f84-human-after-snapshot', 'f84-human-after', 'respuesta humana después del snapshot');
    await archive.close(); archive = null;

    const staleGate = runGate(sourcePath, snapshotPath, lockPath);
    assert.equal(staleGate.exitCode, 2);
    assert.equal(staleGate.result.promotionAllowed, false);
    assert.ok(staleGate.result.blockers.includes('ARCHIVE_CHECKPOINT_MISMATCH'));
    assert.ok(staleGate.result.blockers.includes('OUTBOUND_LEDGER_MISMATCH'));

    const isolatedRestore = createArchive({ path: snapshotPath, restore: true });
    t.after(() => isolatedRestore.close().catch(() => {}));
    await isolatedRestore.ready;
    assert.notEqual((await isolatedRestore.snapshot()).dataEpoch, base.dataEpoch);
    const restoredMessages = await isolatedRestore.messages({ conversationId, limit: 20 });
    const restoredHuman = await isolatedRestore.messageByProviderId({ conversationId, providerMessageId: 'f84-human-before' });
    assert.ok(restoredMessages.some(row => row.id === restoredHuman?.id));
    assert.equal(restoredMessages.some(row => row.content?.text === 'respuesta humana después del snapshot'), false);
    assert.equal(await isolatedRestore.outboundIntent('f84-notice-after-snapshot'), null);
    await isolatedRestore.close();

    const sourceAfterRestore = createArchive({ path: sourcePath, readOnly: true });
    t.after(() => sourceAfterRestore.close().catch(() => {}));
    await sourceAfterRestore.ready;
    const sourceMessages = await sourceAfterRestore.messages({ conversationId, limit: 20 });
    assert.ok(sourceMessages.some(row => row.content?.text === 'respuesta humana antes del snapshot'));
    assert.ok(sourceMessages.some(row => row.content?.text === 'respuesta humana después del snapshot'));
    assert.equal((await sourceAfterRestore.outboundIntent('f84-notice-after-snapshot')).state, 'accepted');
    await sourceAfterRestore.close();

    archive = createArchive({ path: sourcePath });
    await archive.ready;
    await archive.backup(freshSnapshotPath);
    await archive.close(); archive = null;
    const refreshedGate = runGate(sourcePath, freshSnapshotPath, lockPath);
    assert.equal(refreshedGate.exitCode, 0);
    assert.equal(refreshedGate.result.promotionAllowed, true);
});

test('restore gate detects assistant tool audit changes without exposing the audit digest', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-tool-audit-restore-'));
    const sourcePath = path.join(dir, 'active.db');
    const snapshotPath = path.join(dir, 'snapshot.db');
    const lockPath = path.join(dir, 'gateway.lock');
    const archive = createArchive({ path: sourcePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });

    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: `audit-restore-${randomUUID()}` });
    const [stored] = await archive.ingestBatch([inbound(account.id, 'audit-restore')]);
    const sourceSnapshot = await archive.snapshot();
    await archive.backup(snapshotPath);
    await archive.recordAssistantToolInvocation({ invocationKey: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64),
        resultFingerprint: 'c'.repeat(64), actorId: randomUUID(), conversationId: stored.message.conversationId,
        toolName: 'conversation.search_messages', effect: 'read', status: 'completed', attemptCount: 1,
        createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:00.000Z' });
    assert.deepEqual(await archive.snapshot(), sourceSnapshot);
    await archive.close();

    const gate = runGate(sourcePath, snapshotPath, lockPath);
    assert.equal(gate.exitCode, 2);
    assert.ok(gate.result.blockers.includes('ASSISTANT_TOOL_AUDIT_MISMATCH'));
    assert.equal(gate.result.source.assistantToolInvocationCount, 1);
    assert.equal('assistantToolInvocationSha256' in gate.result.source, false);
});

test('BUG-046: restore gate detects admin inbox changes without exposing their digest', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-tg-admin-restore-'));
    const sourcePath = path.join(dir, 'active.db');
    const snapshotPath = path.join(dir, 'snapshot.db');
    const lockPath = path.join(dir, 'gateway.lock');
    const archive = createArchive({ path: sourcePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'telegram_bot:restore-fixture' });
    const before = await archive.snapshot();
    await archive.backup(snapshotPath);
    const update = normalizeUpdates([{ update_id: '901', message: { message_id: '902', date: 1792368000,
        text: '/permitir 700', chat: { id: '-55', type: 'private' }, from: { first_name: 'Admin' } } }], account.id, '-55')[0];
    await archive.captureTelegramBatch({ accountId: account.id, updates: [
        { updateId: update.updateId, message: null, edit: null, adminInbox: update.adminInbox }
    ] });
    assert.deepEqual(await archive.snapshot(), before, 'admin inbox receipts do not fabricate conversation events');
    await archive.close();

    const gate = runGate(sourcePath, snapshotPath, lockPath);
    assert.equal(gate.exitCode, 2);
    assert.ok(gate.result.blockers.includes('TELEGRAM_ADMIN_INBOX_MISMATCH'));
    assert.equal(gate.result.source.telegramAdminInboxCount, 1);
    assert.equal('telegramAdminInboxSha256' in gate.result.source, false);
});

test('BUG-076: restore gate detects resume-name changes without exposing their digest', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-resume-metadata-restore-'));
    const sourceDirectory = path.join(dir, 'source'), snapshotDirectory = path.join(dir, 'snapshot');
    const sourcePath = path.join(sourceDirectory, 'conversations.db');
    const snapshotPath = path.join(snapshotDirectory, 'conversations.db');
    const sourceAttachments = path.join(sourceDirectory, 'attachments');
    const snapshotAttachments = path.join(snapshotDirectory, 'attachments');
    const lockPath = path.join(dir, 'gateway.lock');
    await fs.mkdir(sourceAttachments, { recursive: true });
    await fs.mkdir(snapshotAttachments, { recursive: true });
    const archive = createArchive({ path: sourcePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'f84-resume-metadata-restore' });
    const source = { ...inbound(account.id, 'resume-metadata', 'live'), legacyDispatch: {
        waitForTranscription: false, message: { channel: 'whatsapp', remoteId: `whatsapp:${destination}`,
            rawId: destination, text: 'recovery fixture resume-metadata', transcript: '', isAudio: false,
            metadata: { pushName: 'Nombre privado', savedName: 'Agenda privada', phoneNumber: 'route-only',
                isFromMe: false, isAdminChannel: false } }
    } };
    await archive.ingestBatch([source]);
    const checkpoint = await archive.recoveryCheckpoint();
    assert.equal(checkpoint.resumeMetadataCount, 1);
    await archive.backup(snapshotPath);
    await archive.close();

    const damaged = new DatabaseSync(sourcePath);
    damaged.prepare('UPDATE legacy_dispatch SET resume_metadata=?').run('{"pushName":"Nombre alterado"}');
    damaged.close();
    const gate = runGate(sourcePath, snapshotPath, lockPath, { sourceAttachments, snapshotAttachments });
    assert.equal(gate.exitCode, 2);
    assert.ok(gate.result.blockers.includes('RESUME_METADATA_MISMATCH'));
    assert.equal(gate.result.source.resumeMetadataCount, 1);
    assert.equal('resumeMetadataSha256' in gate.result.source, false);
});

test('restore gate detects attachment metadata purges that do not advance the event cursor', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-f84-attachment-ledger-'));
    const sourceDirectory = path.join(dir, 'source'), snapshotDirectory = path.join(dir, 'snapshot');
    const sourcePath = path.join(sourceDirectory, 'conversations.db');
    const snapshotPath = path.join(snapshotDirectory, 'conversations.db');
    const sourceAttachments = path.join(sourceDirectory, 'attachments');
    const snapshotAttachments = path.join(snapshotDirectory, 'attachments');
    const lockPath = path.join(dir, 'gateway.lock');
    await fs.mkdir(snapshotDirectory, { recursive: true });
    let archive = createArchive({ path: sourcePath });
    let store;
    t.after(async () => { await store?.close(); await archive?.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'f84-attachment-ledger' });
    const [captured] = await archive.ingestBatch([{ ...inbound(account.id, 'attachment-ledger'),
        content: { type: 'audio', availability: 'not_stored', transcript: null, transcriptionStatus: 'failed' } }]);
    store = createAttachmentStore({ archive, directory: sourceAttachments });
    await store.init();
    const saved = await store.store({ messageId: captured.message.id, source: Buffer.from('bytes'),
        fileName: 'fixture.ogg', contentType: 'audio/ogg' });
    const attachment = await archive.attachment({ id: saved.attachment.id });
    await archive.backup(snapshotPath);
    await store.close(); store = null;
    await fs.cp(sourceAttachments, snapshotAttachments, { recursive: true });
    await archive.close(); archive = null;

    archive = createArchive({ path: sourcePath });
    await archive.ready;
    store = createAttachmentStore({ archive, directory: sourceAttachments });
    await store.init();
    const before = await archive.snapshot();
    await archive.purge({ now: new Date(Date.parse(attachment.expiresAt) + 1).toISOString(), limit: 500 });
    await store.sweepExpired();
    assert.deepEqual(await archive.snapshot(), before);
    await store.close(); store = null;
    await archive.close(); archive = null;

    const gate = runGate(sourcePath, snapshotPath, lockPath, { sourceAttachments, snapshotAttachments });
    assert.equal(gate.exitCode, 2);
    assert.equal(gate.result.source.seq, gate.result.snapshot.seq);
    assert.ok(gate.result.blockers.includes('ATTACHMENT_LEDGER_MISMATCH'));
});

test('F9.4 backs up, verifies, and restores the FTS index with its attachment blobs', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-f94-bundle-'));
    const sourceDirectory = path.join(dir, 'source'), snapshotDirectory = path.join(dir, 'snapshot');
    const restoreDirectory = path.join(dir, 'isolated-restore');
    const sourcePath = path.join(sourceDirectory, 'conversations.db');
    const snapshotPath = path.join(snapshotDirectory, 'conversations.db');
    const sourceAttachments = path.join(sourceDirectory, 'attachments');
    const snapshotAttachments = path.join(snapshotDirectory, 'attachments');
    const restorePath = path.join(restoreDirectory, 'conversations.db');
    const restoreAttachments = path.join(restoreDirectory, 'attachments');
    const lockPath = path.join(dir, 'gateway.lock');
    await Promise.all([fs.mkdir(snapshotDirectory, { recursive: true }), fs.mkdir(restoreDirectory, { recursive: true })]);
    let archive = createArchive({ path: sourcePath });
    let sourceStore;
    let restoredArchive;
    let restoredStore;
    t.after(async () => {
        await restoredStore?.close(); await restoredArchive?.close().catch(() => {});
        await sourceStore?.close(); await archive?.close().catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
    });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'f94-bundle-fixture' });
    const media = { ...inbound(account.id, 'f94-search-media'), content: {
        type: 'image', availability: 'not_stored', transcript: null,
        transcriptionStatus: 'not_requested', caption: 'CAFÉ informe de respaldo'
    } };
    const [captured] = await archive.ingestBatch([media]);
    sourceStore = createAttachmentStore({ archive, directory: sourceAttachments });
    await sourceStore.init();
    const payload = Buffer.from('fixture image bytes for backup');
    const saved = await sourceStore.store({ messageId: captured.message.id, source: payload,
        fileName: 'captura.png', contentType: 'image/png' });
    const base = await archive.backup(snapshotPath);
    await sourceStore.close(); sourceStore = null;
    await fs.cp(sourceAttachments, snapshotAttachments, { recursive: true });
    await archive.close(); archive = null;

    const validGate = runGate(sourcePath, snapshotPath, lockPath, { sourceAttachments, snapshotAttachments });
    assert.equal(validGate.exitCode, 0, JSON.stringify(validGate.result));
    assert.equal(validGate.result.promotionAllowed, true);
    assert.equal(validGate.result.source.searchIndexCount, 1);
    assert.equal(validGate.result.source.searchIndexMismatchCount, 0);
    assert.equal(validGate.result.source.attachmentBlobCount, 1);
    assert.equal(validGate.result.source.attachmentBlobBytes, payload.length);

    const sharedAttachmentGate = runGate(sourcePath, snapshotPath, lockPath, {
        sourceAttachments, snapshotAttachments: sourceAttachments
    });
    assert.equal(sharedAttachmentGate.exitCode, 2);
    assert.ok(sharedAttachmentGate.result.blockers.includes('ATTACHMENT_SNAPSHOT_NOT_SEPARATE'));

    await fs.copyFile(snapshotPath, restorePath);
    await fs.cp(snapshotAttachments, restoreAttachments, { recursive: true });
    restoredArchive = createArchive({ path: restorePath, restore: true });
    await restoredArchive.ready;
    restoredStore = createAttachmentStore({ archive: restoredArchive, directory: restoreAttachments });
    await restoredStore.init();
    const search = await restoredArchive.searchMessages({ conversationId: captured.message.conversationId, query: 'cafe respaldo' });
    assert.deepEqual(search.items.map(item => item.message.id), [captured.message.id]);
    assert.match(search.items[0].snippet, /CAFÉ/i);
    const opened = await restoredStore.open(saved.attachment.id);
    assert.ok(opened);
    const parts = [];
    for await (const chunk of opened.stream) parts.push(chunk);
    assert.deepEqual(Buffer.concat(parts), payload);
    assert.notEqual((await restoredArchive.snapshot()).dataEpoch, base.dataEpoch);

    await restoredStore.close(); restoredStore = null;
    await restoredArchive.close(); restoredArchive = null;

    const brokenIndexPath = path.join(dir, 'broken-index.db');
    const brokenIndexAttachments = path.join(dir, 'broken-index-attachments');
    await fs.copyFile(snapshotPath, brokenIndexPath);
    await fs.cp(snapshotAttachments, brokenIndexAttachments, { recursive: true });
    const damaged = new DatabaseSync(brokenIndexPath);
    damaged.prepare('DELETE FROM message_search WHERE rowid=(SELECT rowid FROM messages WHERE id=?)').run(captured.message.id);
    damaged.close();
    const brokenIndexGate = runGate(sourcePath, brokenIndexPath, lockPath, {
        sourceAttachments, snapshotAttachments: brokenIndexAttachments
    });
    assert.equal(brokenIndexGate.exitCode, 2);
    assert.ok(brokenIndexGate.result.blockers.includes('SEARCH_INDEX_INVALID'));

    await fs.writeFile(path.join(snapshotAttachments, `${saved.attachment.id}.blob`), Buffer.from('tampered bytes'));
    const brokenBlobGate = runGate(sourcePath, snapshotPath, lockPath, { sourceAttachments, snapshotAttachments });
    assert.equal(brokenBlobGate.exitCode, 2);
    assert.ok(brokenBlobGate.result.blockers.includes('ATTACHMENT_BLOB_INVALID'));
});
