process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');
const { createControlService, LEGACY_ADMIN_ACTOR } = require('../services/conversations/controlService');
const { createSessionApi, projectConversation } = require('../services/sessionApi');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-control-service-'));
    const databasePath = path.join(dir, 'archive.db');
    const archive = createArchive({ path: databasePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    const ready = await archive.ready;
    const accountId = randomUUID();
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'wa-control-service' });
    await archive.ingestBatch(['111','222'].map((phone, index) => ({ identity: {
        accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: `${phone}@s.whatsapp.net`
    }, providerMessageId: `control-${index}`, source: 'history', direction: 'inbound', authorKind: 'customer',
    occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: 'control fixture' } })));
    const contacts = {};
    const settings = { globalMode: 'allowed_all', currentProfile: 'default' };
    const sourceManifest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const snapshot = await archive.snapshot();
    const report = buildControlImportReport({ contacts, settings, profileKeys: ['default'],
        conversations: await archive.conversationRows(), sourceManifest: {
            contacts: { present: true, sha256: sourceManifest(contacts) },
            settings: { present: true, sha256: sourceManifest(settings) }
        }, archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt: '2026-10-20T12:00:00.000Z' });
    const migrationId = 'control-service-fixture';
    const started = await archive.beginControlImport({ migrationId, report });
    for (let offset = 0; offset < started.report.entryCount; offset += 100) {
        await archive.stageControlImportBatch({ runId: started.runId, offset, limit: 100 });
    }
    assert.equal((await archive.verifyControlImport({ runId: started.runId })).status, 'verified');
    return { archive, accountId, migrationId, databasePath };
}

async function cutover(archive, migrationId) {
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    for (;;) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 100 });
        if (batch.remaining === 0) break;
    }
    await archive.finishControlCutover({ migrationId });
}

test('F5.4 SQLite control applies global policy only to neutral contacts', () => {
    const row = { id: randomUUID(), account_id: randomUUID(), contact_id: randomUUID(), canonical_id: randomUUID(),
        identity_keys: [], access_policy: 'neutral', automation_mode: 'off', lifecycle: 'open', owner_id: null,
        control_version: '1', context_version: '1', control_status: 'confirmed', taken_at: null,
        handoff_reason: null, profile_key: null, requires_review: 0, control_review_reason: null,
        aggregate_version: '1', last_activity_at: null, capturing_since: null, history_observed: 0,
        first_ingested_at: null, unread_count: 0, channel: 'whatsapp' };
    const project = (overrides, globalMode = 'allowed_all') => projectConversation({ ...row, ...overrides },
        { exact: new Map() }, { globalMode, globalPaused: false }, Date.now(), 'sqlite').control;
    assert.equal(project({}).automationMode, 'ai');
    assert.equal(project({}, 'ignored_all').automationMode, 'off');
    assert.equal(project({ access_policy: 'allowed', automation_mode: 'ai' }, 'ignored_all').automationMode, 'ai');
    assert.equal(project({ access_policy: 'neutral', automation_mode: 'human' }).automationMode, 'human');
    assert.equal(project({ access_policy: 'neutral', requires_review: 1 }).automationMode, 'off');
});

test('F5.4 commands resolve exact channel/account identities and reject ambiguous account matches', async t => {
    const { archive, accountId, migrationId } = await fixture(t);
    const otherAccount = randomUUID();
    await archive.registerAccount({ id: otherAccount, channel: 'whatsapp', providerKey: 'other-wa-control-service' });
    await archive.ingestBatch([{ identity: { accountId: otherAccount, channel: 'whatsapp', kind: 'whatsapp_jid',
        exactValue: '111@s.whatsapp.net' }, providerMessageId: 'other-111', source: 'history', direction: 'inbound',
        authorKind: 'customer', occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: 'second account' } }]);
    // Rebuild staging after adding the second account so the cutover snapshot remains current.
    const contacts = {}, settings = { globalMode: 'allowed_all', currentProfile: 'default' };
    const manifest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const ready = await archive.ready, snapshot = await archive.snapshot();
    const report = buildControlImportReport({ contacts, settings, profileKeys: ['default'],
        conversations: await archive.conversationRows(), sourceManifest: {
            contacts: { present: true, sha256: manifest(contacts) }, settings: { present: true, sha256: manifest(settings) }
        }, archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt: '2026-10-20T12:30:00.000Z' });
    const migration = await archive.beginControlImport({ migrationId: `${migrationId}-two-accounts`, report });
    for (let offset = 0; offset < migration.report.entryCount; offset += 100) {
        await archive.stageControlImportBatch({ runId: migration.runId, offset, limit: 100 });
    }
    assert.equal((await archive.verifyControlImport({ runId: migration.runId })).status, 'verified');
    await cutover(archive, `${migrationId}-two-accounts`);
    const service = createControlService(archive, { drainConversation: () => ({ drained: true }) });
    await assert.rejects(service.resolveLegacyTarget({ targetId: '111', channel: 'whatsapp' }),
        error => error.code === 'IDENTITY_AMBIGUOUS');
    const exact = await service.resolveLegacyTarget({ targetId: '111', channel: 'whatsapp', accountId });
    assert.equal(exact.accountId, accountId);
    assert.equal(exact.identities.some(identity => identity.exactValue === '111@s.whatsapp.net'), true);
    await assert.rejects(service.resolveLegacyTarget({ targetId: '111@s.whatsapp.net', channel: 'telegram' }),
        error => error.code === 'CONTROL_TARGET_NOT_FOUND');
    await assert.rejects(service.resolveLegacyTarget({ targetId: 'not-a-phone', channel: 'whatsapp', accountId }),
        error => error.code === 'INVALID_CONTROL_TARGET');
});

test('F5.4 takeover is CAS/idempotent, remains pending during drain, and release preserves access/profile', async t => {
    const { archive, accountId, migrationId } = await fixture(t);
    const service = createControlService(archive, { drainConversation: () => ({ drained: true }) });
    await cutover(archive, migrationId);
    const target = await service.resolveLegacyTarget({ targetId: '111', channel: 'whatsapp', accountId });
    const actorId = randomUUID();
    let finishDrain;
    const drainingService = createControlService(archive, { drainConversation: () => new Promise(resolve => { finishDrain = resolve; }) });
    const first = await drainingService.takeover({ conversationId: target.conversationId, actorId,
        expectedVersion: target.control.controlVersion, idempotencyKey: 'same-takeover-intent' });
    assert.equal(first.status, 'pending');
    assert.equal(first.operation.status, 'taking_control');
    assert.equal((await archive.controlState(target.conversationId)).status, 'taking_control');
    const duplicate = await drainingService.takeover({ conversationId: target.conversationId, actorId,
        expectedVersion: target.control.controlVersion, idempotencyKey: 'same-takeover-intent' });
    assert.equal(duplicate.operation.id, first.operation.id);
    finishDrain({ drained: true, uncertainMessageIds: [] });
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await archive.controlOperation(first.operation.id)).status === 'completed') break;
        await new Promise(resolve => setImmediate(resolve));
    }
    const completed = await archive.controlOperation(first.operation.id);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.uncertainMessageIds, []);
    const human = await archive.controlState(target.conversationId);
    assert.equal(human.automationMode, 'human');
    assert.equal(human.ownerId, actorId);
    assert.equal(human.status, 'confirmed');

    await assert.rejects(drainingService.release({ conversationId: target.conversationId,
        actorId: randomUUID(), expectedVersion: human.controlVersion }), error => error.code === 'CONTROL_OWNER_CONFLICT');
    const released = await drainingService.release({ conversationId: target.conversationId, actorId,
        expectedVersion: human.controlVersion });
    assert.equal(released.control.automationMode, 'ai');
    assert.equal(released.control.ownerId, null);
    assert.equal(released.control.accessPolicy, human.accessPolicy);
});

test('F5.7 context clearing is identity-scoped, versioned, and drains the previous generation', async t => {
    const { archive, accountId, migrationId } = await fixture(t);
    await cutover(archive, migrationId);
    const target = { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '111@s.whatsapp.net' };
    const existing = await archive.resolve(target);
    let drained = 0;
    const service = createControlService(archive, { drainConversation: async conversationId => {
        assert.equal(conversationId, existing.conversation_id); drained += 1; return { drained: true };
    } });
    const before = await archive.controlState(existing.conversation_id);
    const result = await service.clearContextForLegacyTarget({ targetId: '111', channel: 'whatsapp', accountId });
    assert.equal(result.status, 'updated');
    assert.equal(result.contextVersion, String(BigInt(before.contextVersion) + 1n));
    assert.equal((await archive.controlState(existing.conversation_id)).controlVersion, before.controlVersion);
    assert.equal(drained, 1);
    assert.equal((await archive.messages({ conversationId: existing.conversation_id })).length, 1);
    await assert.rejects(archive.aiContext({ conversationId: existing.conversation_id,
        expectedContextVersion: before.contextVersion }), { code: 'AI_CONTEXT_VERSION_STALE' });
});

test('F5.4 resumes a durable takeover after the gateway restarts', async t => {
    const { archive, accountId, migrationId, databasePath } = await fixture(t);
    await cutover(archive, migrationId);
    const target = (await archive.controlTargets({ channel: 'whatsapp', accountId,
        candidates: [{ accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '111@s.whatsapp.net' }] }))[0];
    const actorId = randomUUID();
    const service = createControlService(archive, { drainConversation: () => new Promise(() => {}) });
    const pending = await service.takeover({ conversationId: target.conversationId, actorId,
        expectedVersion: target.control.controlVersion, idempotencyKey: 'takeover-before-process-restart' });
    assert.equal(pending.status, 'pending');
    await archive.close();

    const recoveredArchive = createArchive({ path: databasePath });
    t.after(() => recoveredArchive.close());
    await recoveredArchive.ready;
    const recoveredService = createControlService(recoveredArchive, {
        drainConversation: () => ({ drained: true, uncertainMessageIds: [] })
    });
    assert.deepEqual(await recoveredService.recoverPendingOperations(), { recovered: 1 });
    assert.equal((await recoveredArchive.controlOperation(pending.operation.id)).status, 'completed');
    const control = await recoveredArchive.controlState(target.conversationId);
    assert.equal(control.status, 'confirmed');
    assert.equal(control.automationMode, 'human');
    assert.equal(control.ownerId, actorId);
});

test('F5.4 API uses signed actor identity, expectedVersion and durable operation response contracts', async t => {
    const previousSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    process.env.SDK_PANEL_GATEWAY_SECRET = 'test-control-service-panel-secret-32-bytes';
    t.after(() => { if (previousSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = previousSecret; });
    const { archive, accountId, migrationId } = await fixture(t);
    await cutover(archive, migrationId);
    const service = createControlService(archive, { drainConversation: () => ({ drained: true }) });
    const target = await service.resolveLegacyTarget({ targetId: '111', channel: 'whatsapp', accountId });
    const route = createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false, policyVersion: '1' }),
        archive, () => ({}), undefined, service);
    const actor = { id: randomUUID(), capabilities: ['control:write','conversations:read','conversations:write'] };
    async function request(method, pathname, body = null, headers = {}) {
        let status, response;
        const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
        const effectiveHeaders = method === 'PATCH' && !headers['idempotency-key']
            ? { ...headers, 'idempotency-key': `test-idempotency-${randomUUID()}` } : headers;
        try {
            await route({ method, url: pathname, headers: effectiveHeaders }, res, { actor, requestId: randomUUID() }, pathname,
                body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
        } catch (error) { return { status: error.status, response: { code: error.code } }; }
        return { status, response };
    }
    const takeover = await request('POST', `/v1/conversations/${target.conversationId}/takeover`,
        { expectedVersion: target.control.controlVersion }, { 'idempotency-key': 'api-takeover-intent-01' });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.response.conversation.control.ownerId, actor.id);
    assert.equal(takeover.response.conversation.control.automationMode, 'human');
    const pendingRelease = await request('POST', `/v1/conversations/${target.conversationId}/release`, {
        expectedVersion: takeover.response.conversation.control.controlVersion,
        resumePolicy: 'process_pending', pendingInboundIds: [randomUUID()], selectionVersion: 'a'.repeat(64)
    }, { 'idempotency-key': 'api-release-pending-future-feature' });
    assert.equal(pendingRelease.status, 409);
    assert.equal(pendingRelease.response.code, 'PENDING_RESUME_NOT_AVAILABLE');
    const stale = await request('PATCH', `/v1/conversations/${target.conversationId}`,
        { expectedVersion: target.control.controlVersion, lifecycle: 'resolved' });
    assert.equal(stale.status, 409);
    const current = takeover.response.conversation.control;
    const resolved = await request('PATCH', `/v1/conversations/${target.conversationId}`,
        { expectedVersion: current.controlVersion, lifecycle: 'resolved' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.response.conversation.control.lifecycle, 'resolved');
    const operationId = (await archive.events({ after: '0' })).find(event => event.type === 'operation.updated').data.operationId;
    const operation = await request('GET', `/v1/operations/${operationId}`);
    assert.equal(operation.status, 200);
    assert.equal(operation.response.status, 'completed');
    assert.equal(operation.response.actorId, actor.id);
});

test('F5.4 policy updates are actor-audited and notification events allow no conversation target', async t => {
    const { archive, databasePath } = await fixture(t);
    const actorId = LEGACY_ADMIN_ACTOR;
    const changed = await archive.writeControlPolicy({ actorId, expectedVersion: '1',
        globalMode: 'ignored_all', globalProfileKey: 'default' });
    assert.equal(changed.status, 'updated');
    assert.equal(changed.event.type, 'policy.updated');
    assert.equal(changed.event.data.policyVersion, '2');
    const events = await archive.events({ after: '0' });
    assert.deepEqual(events.at(-1), changed.event);
    await archive.close();
    const db = new (require('node:sqlite').DatabaseSync)(databasePath);
    try {
        assert.equal(db.prepare("SELECT actor_id FROM events WHERE payload LIKE '%policy.updated%'").get().actor_id, actorId);
        assert.equal(db.prepare('SELECT conversation_id FROM events WHERE payload LIKE ?').get('%policy.updated%').conversation_id, null);
    } finally { db.close(); }
});

test('F5.5 job snapshots become obsolete after control and global policy versions change', async t => {
    const { archive, accountId, migrationId } = await fixture(t);
    await cutover(archive, migrationId);
    const service = createControlService(archive, { drainConversation: () => ({ drained: true }) });
    const identity = { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '111@s.whatsapp.net' };
    const initial = await service.readForIdentity(identity);
    assert.equal(await service.isSnapshotCurrent(initial.controlSnapshot), true);

    await service.setGlobalPolicy({ globalMode: 'ignored_all' });
    assert.equal(await service.isSnapshotCurrent(initial.controlSnapshot), false);
    await service.setGlobalPolicy({ globalMode: 'allowed_all' });
    const refreshed = await service.readForIdentity(identity);
    assert.equal(await service.isSnapshotCurrent(refreshed.controlSnapshot), true);

    await service.setAccessForLegacyTarget({ targetId: '111', channel: 'whatsapp', accountId, policy: 'ignored' });
    assert.equal(await service.isSnapshotCurrent(refreshed.controlSnapshot), false);
});
