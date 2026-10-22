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

function runGate(sourcePath, snapshotPath, lockPath) {
    const result = spawnSync(process.execPath, [scriptPath, '--snapshot', snapshotPath], { cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8', env: { ...process.env, SDK_BOT_TEST: '1', SDK_CONVERSATIONS_DB_PATH: sourcePath,
            SDK_GATEWAY_LOCK_PATH: lockPath } });
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
