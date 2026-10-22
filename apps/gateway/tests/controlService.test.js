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
const { createSessionApi, capabilityFor, projectConversation } = require('../services/sessionApi');
const ChannelAdapter = require('../core/ChannelAdapter');
const { setControlService } = require('../services/stateService');
const { state } = require('../config');
const chatControlCommands = require('../handlers/commands/chatControl');

async function fixture(t, phones = ['111','222']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-control-service-'));
    const databasePath = path.join(dir, 'archive.db');
    const archive = createArchive({ path: databasePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    const ready = await archive.ready;
    const accountId = randomUUID();
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'wa-control-service' });
    await archive.ingestBatch(phones.map((phone, index) => ({ identity: {
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
    const service = createControlService(archive, { drainConversation: () => ({ drained: true }),
        validateProfile: async key => key === 'default' });
    const target = await service.resolveLegacyTarget({ targetId: '111', channel: 'whatsapp', accountId });
    const route = createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false, policyVersion: '1' }),
        archive, () => ({}), undefined, service, undefined, async () => [
            { key: 'default', nombre: 'Predeterminado', descripcion: 'No se devuelve esta descripción.' }
        ]);
    const actor = { id: randomUUID(), capabilities: ['control:write','conversations:read','conversations:write'] };
    async function request(method, pathname, body = null, headers = {}, requestActor = actor) {
        let status, response;
        const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
        const effectiveHeaders = method === 'PATCH' && !headers['idempotency-key']
            ? { ...headers, 'idempotency-key': `test-idempotency-${randomUUID()}` } : headers;
        try {
            await route({ method, url: pathname, headers: effectiveHeaders }, res, { actor: requestActor, requestId: randomUUID() }, pathname,
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
    }, { 'idempotency-key': 'api-release-pending-stale-selection' });
    assert.equal(pendingRelease.status, 409);
    assert.equal(pendingRelease.response.code, 'PENDING_RESUME_SELECTION_STALE');
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

    const profiles = await request('GET', '/v1/profiles');
    assert.equal(profiles.status, 200);
    assert.deepEqual(profiles.response.items, [{ key: 'default', name: 'Predeterminado' }]);
    const namedActor = { id: randomUUID(), capabilities: ['conversations:read'] };
    const deniedProfileWrite = await request('PATCH', `/v1/conversations/${target.conversationId}`,
        { expectedVersion: resolved.response.conversation.control.controlVersion, profileKey: 'default' }, {}, namedActor);
    assert.equal(deniedProfileWrite.status, 403);
    const profileUpdate = await request('PATCH', `/v1/conversations/${target.conversationId}`,
        { expectedVersion: resolved.response.conversation.control.controlVersion, profileKey: 'default' });
    assert.equal(profileUpdate.status, 200);
    assert.equal(profileUpdate.response.conversation.control.profileKey, 'default');
});

test('BUG-075 authenticated reconciliation correlates accepted output before advancing pending inbound', async t => {
    const previousSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    process.env.SDK_PANEL_GATEWAY_SECRET = 'test-outbound-reconciliation-secret-32-bytes';
    t.after(() => { if (previousSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = previousSecret; });
    const { archive, accountId, migrationId } = await fixture(t, ['111']);
    await cutover(archive, migrationId);
    const conversationId = (await archive.conversationRows())[0].id;
    const identity = { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '111@s.whatsapp.net' };
    const [pendingInbound] = await archive.ingestBatch([{ identity, providerMessageId: 'live-pending-accepted', source: 'live',
        direction: 'inbound', authorKind: 'customer', occurredAt: '2026-10-22T09:59:00.000Z',
        content: { type: 'text', text: 'entrada pendiente' }, legacyDispatch: { waitForTranscription: false,
            message: { channel: 'whatsapp', remoteId: 'whatsapp:111@s.whatsapp.net', rawId: '111@s.whatsapp.net',
                text: 'entrada pendiente', transcript: '', isAudio: false,
                metadata: { phoneNumber: '111', isFromMe: false, isAdminChannel: false } } } }]);
    const inboundSeq = (await archive.conversation(conversationId)).inbound_seq;
    await archive.markLegacyDispatched({ messageId: pendingInbound.message.id });
    const actor = { id: randomUUID(), capabilities: ['conversations:read','messages:send'] };
    let control = await archive.controlState(conversationId);
    await archive.writeControlState({ conversationId, actorId: randomUUID(), expectedVersion: control.controlVersion,
        state: { ...control, accessPolicy: 'allowed', automationMode: 'human', ownerId: actor.id } });
    control = await archive.controlState(conversationId);
    const policy = await archive.controlPolicy();
    const intent = { idempotencyKey: 'ai-reconcile-accepted-001', accountId, conversationId,
        channel: 'whatsapp', destination: '111@s.whatsapp.net', actorId: actor.id, source: 'human',
        payload: { text: 'respuesta bajo revisión' },
        controlSnapshot: { conversationId, controlVersion: control.controlVersion,
            contextVersion: control.contextVersion, policyVersion: policy.policyVersion },
        policy: { handledThroughInboundSeq: inboundSeq, clientMessageId: randomUUID() } };
    await archive.beginOutboundIntent(intent);
    const claim = await archive.claimOutboundIntent({ idempotencyKey: intent.idempotencyKey });
    assert.equal(claim.status, 'claimed', claim.errorCode);
    await archive.finishOutboundIntent({ idempotencyKey: intent.idempotencyKey, state: 'delivery_unknown',
        errorCode: 'PROCESS_RESTARTED_DURING_SEND' });
    const row = await archive.outboundIntent(intent.idempotencyKey);
    await archive.ingestBatch([{ identity, providerMessageId: 'provider-echo-wrong', source: 'history',
        direction: 'outbound', authorKind: 'external_self', occurredAt: '2026-10-22T10:00:00.000Z',
        content: { type: 'text', text: 'contenido diferente' } }, { identity, providerMessageId: 'provider-echo-correct',
        source: 'history', direction: 'outbound', authorKind: 'external_self', occurredAt: '2026-10-22T10:01:00.000Z',
        content: { type: 'text', text: intent.payload.text } }]);

    let providerSendCalls = 0;
    let route = createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false, policyVersion: '1' }),
        archive, () => ({}), undefined, null, () => { providerSendCalls += 1; throw new Error('reconciliation must not send'); });
    async function request(method, pathname, body = null, requestActor = actor) {
        let status, response;
        const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
        const routePath = new URL(pathname, 'http://gateway.test').pathname;
        try {
            await route({ method, url: pathname, headers: {} }, res,
                { actor: requestActor, requestId: randomUUID() }, routePath,
                body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
        } catch (error) { return { status: error.status, response: { code: error.code } }; }
        return { status, response };
    }
    const listPath = `/v1/conversations/${conversationId}/outbound-reconciliations?limit=10`;
    assert.equal(capabilityFor('GET', `/v1/conversations/${conversationId}/outbound-reconciliations`), 'conversations:read');
    assert.equal(capabilityFor('POST', `/v1/conversations/${conversationId}/outbound-intents/${row.id}/reconcile`), 'messages:send');
    const list = await request('GET', listPath);
    assert.equal(list.status, 200);
    assert.equal(list.response.items.length, 1);
    assert.equal(list.response.items[0].text, intent.payload.text);
    assert.equal('idempotencyKey' in list.response.items[0], false);
    assert.equal('providerResult' in list.response.items[0], false);
    assert.equal('payload' in list.response.items[0], false);

    const postPath = `/v1/conversations/${conversationId}/outbound-intents/${row.id}/reconcile`;
    const missingId = await request('POST', postPath, { state: 'accepted', note: 'Revisé el historial.' });
    assert.equal(missingId.status, 422);
    const mismatch = await request('POST', postPath, { state: 'accepted', providerMessageId: 'provider-echo-wrong',
        note: 'El identificador apunta a otro contenido.' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.response.code, 'OUTBOUND_ARCHIVE_RECONCILIATION_FAILED');
    const foreignActor = { id: randomUUID(), capabilities: ['messages:send'] };
    const ownerConflict = await request('POST', postPath, { state: 'accepted', providerMessageId: 'provider-echo-correct',
        note: 'ID visible en el historial.' }, foreignActor);
    assert.equal(ownerConflict.status, 409);
    assert.equal(ownerConflict.response.code, 'CONTROL_OWNER_CONFLICT');
    assert.equal((await archive.outboundIntent(intent.idempotencyKey)).state, 'delivery_unknown');
    assert.equal((await archive.pendingResumeMessages({ conversationId })).uncertainOutboundCount, 1);

    const accepted = await request('POST', postPath, { state: 'accepted', providerMessageId: 'provider-echo-correct',
        note: 'Verifiqué el eco archivado del canal.' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.response.state, 'accepted');
    assert.equal(accepted.response.status, 'reconciled');
    assert.equal((await archive.outboundIntent(intent.idempotencyKey)).reconciledBy, actor.id);
    const archived = await archive.messageByProviderId({ conversationId: row.conversationId,
        providerMessageId: 'provider-echo-correct' });
    assert.equal(archived.authorKind, 'operator');
    assert.equal(archived.source, 'panel');
    assert.equal(archived.content.text, intent.payload.text);
    assert.equal((await archive.pendingResumeMessages({ conversationId })).uncertainOutboundCount, 0);
    assert.equal((await archive.conversation(conversationId)).handled_inbound_seq, inboundSeq);
    assert.equal(providerSendCalls, 0);

    const latestControl = await archive.controlState(conversationId);
    const latestPolicy = await archive.controlPolicy();
    const expiredIntent = await archive.beginOutboundIntent({ idempotencyKey: 'human-reconcile-expired-001',
        accountId, conversationId, channel: 'whatsapp', destination: '111@s.whatsapp.net', actorId: actor.id,
        source: 'human', payload: { text: 'contenido vencido' },
        controlSnapshot: { conversationId, controlVersion: latestControl.controlVersion,
            contextVersion: latestControl.contextVersion, policyVersion: latestPolicy.policyVersion },
        policy: { handledThroughInboundSeq: inboundSeq, clientMessageId: randomUUID() } });
    assert.equal((await archive.claimOutboundIntent({ idempotencyKey: expiredIntent.intent.idempotencyKey })).status, 'claimed');
    await archive.finishOutboundIntent({ idempotencyKey: expiredIntent.intent.idempotencyKey, state: 'delivery_unknown' });
    await archive.purge({ now: new Date(Date.parse(expiredIntent.intent.createdAt) + 90 * 86400000 + 1).toISOString() });
    const redactedList = await request('GET', listPath);
    assert.equal(redactedList.status, 200, JSON.stringify(redactedList.response));
    assert.equal(redactedList.response.items.length, 1);
    assert.equal(redactedList.response.items[0].text, null);
    const redactedRow = await archive.outboundIntent(expiredIntent.intent.idempotencyKey);
    const lateAcceptance = await request('POST', `/v1/conversations/${conversationId}/outbound-intents/${redactedRow.id}/reconcile`,
        { state: 'accepted', providerMessageId: 'provider-after-retention', note: 'Verifiqué el envío en el canal.' });
    assert.equal(lateAcceptance.status, 200);
    assert.equal((await archive.outboundIntent(expiredIntent.intent.idempotencyKey)).state, 'accepted');
    assert.equal(await archive.messageByProviderId({ conversationId, providerMessageId: 'provider-after-retention' }), null);

    providerSendCalls = 0;
    const panelAdapter = Object.assign(new ChannelAdapter('whatsapp'), { archive, accountId,
        async sendMessageRaw() { providerSendCalls += 1; return { key: { id: `panel-provider-${providerSendCalls}` } }; } });
    route = createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false, policyVersion: '1' }), archive,
    () => ({}), () => 'connected', createControlService(archive, { drainConversation: () => ({ drained: true }) }),
    () => panelAdapter);
    const sendBody = { expectedVersion: latestControl.controlVersion, clientMessageId: randomUUID(), text: 'respuesta con clave durable' };
    const panelSendPath = `/v1/conversations/${conversationId}/messages`;
    const firstPanelSend = await request('POST', panelSendPath, sendBody);
    assert.equal(firstPanelSend.status, 202);
    assert.equal(providerSendCalls, 1);
    const panelKey = `panel_${actor.id}_${conversationId}_${sendBody.clientMessageId}`;
    const panelIntent = await archive.outboundIntent(panelKey);
    await archive.purge({ now: new Date(Date.parse(panelIntent.createdAt) + 90 * 86400000 + 1).toISOString() });
    const expiredPanelReplay = await request('POST', panelSendPath, sendBody);
    assert.equal(expiredPanelReplay.status, 410);
    assert.equal(expiredPanelReplay.response.code, 'IDEMPOTENCY_RESULT_EXPIRED');
    const conflictingPanelReplay = await request('POST', panelSendPath, { ...sendBody, text: 'texto diferente' });
    assert.equal(conflictingPanelReplay.status, 409);
    assert.equal(conflictingPanelReplay.response.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(providerSendCalls, 1);
});

test('BUG-075 rejected reconciliation clears the delivery block without marking inbound handled', async t => {
    const { archive, accountId, migrationId } = await fixture(t, ['111']);
    await cutover(archive, migrationId);
    const conversationId = (await archive.conversationRows())[0].id;
    const identity = { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '111@s.whatsapp.net' };
    const [pendingInbound] = await archive.ingestBatch([{ identity, providerMessageId: 'live-pending-rejected', source: 'live',
        direction: 'inbound', authorKind: 'customer', occurredAt: '2026-10-22T09:59:00.000Z',
        content: { type: 'text', text: 'otra entrada pendiente' }, legacyDispatch: { waitForTranscription: false,
            message: { channel: 'whatsapp', remoteId: 'whatsapp:111@s.whatsapp.net', rawId: '111@s.whatsapp.net',
                text: 'otra entrada pendiente', transcript: '', isAudio: false,
                metadata: { phoneNumber: '111', isFromMe: false, isAdminChannel: false } } } }]);
    const inboundSeq = (await archive.conversation(conversationId)).inbound_seq;
    await archive.markLegacyDispatched({ messageId: pendingInbound.message.id });
    const actor = { id: randomUUID(), capabilities: ['conversations:read','messages:send'] };
    let firstControl = await archive.controlState(conversationId);
    await archive.writeControlState({ conversationId, actorId: randomUUID(), expectedVersion: firstControl.controlVersion,
        state: { ...firstControl, accessPolicy: 'allowed', automationMode: 'human', ownerId: actor.id } });
    firstControl = await archive.controlState(conversationId);
    const firstPolicy = await archive.controlPolicy();
    const intent = { idempotencyKey: 'ai-reconcile-rejected-001', accountId, conversationId,
        channel: 'whatsapp', destination: '111@s.whatsapp.net', actorId: actor.id, source: 'human',
        payload: { text: 'respuesta que no salió' },
        controlSnapshot: { conversationId, controlVersion: firstControl.controlVersion,
            contextVersion: firstControl.contextVersion, policyVersion: firstPolicy.policyVersion },
        policy: { handledThroughInboundSeq: inboundSeq, clientMessageId: randomUUID() } };
    await archive.beginOutboundIntent(intent);
    const claim = await archive.claimOutboundIntent({ idempotencyKey: intent.idempotencyKey });
    assert.equal(claim.status, 'claimed', claim.errorCode);
    await archive.finishOutboundIntent({ idempotencyKey: intent.idempotencyKey, state: 'delivery_unknown' });
    const row = await archive.outboundIntent(intent.idempotencyKey);
    const route = createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false, policyVersion: '1' }), archive);
    let status, response;
    const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
    await route({ method: 'POST', url: `/v1/conversations/${conversationId}/outbound-intents/${row.id}/reconcile`, headers: {} },
        res, { actor, requestId: randomUUID() }, `/v1/conversations/${conversationId}/outbound-intents/${row.id}/reconcile`,
        Buffer.from(JSON.stringify({ state: 'rejected', note: 'El operador verificó que no apareció en el canal.' })));
    assert.equal(status, 200);
    assert.equal(response.state, 'rejected');
    assert.equal((await archive.outboundIntent(intent.idempotencyKey)).reconciliationNote,
        'El operador verificó que no apareció en el canal.');
    const pending = await archive.pendingResumeMessages({ conversationId });
    assert.equal(pending.uncertainOutboundCount, 0);
    assert.equal(pending.candidateCount, 1);
    assert.equal((await archive.conversation(conversationId)).handled_inbound_seq, '0');
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

test('BUG-011 SQLite legacy commands preserve access across /humano and explain ignored_all blocks', async t => {
    const previousMode = state.GLOBAL_MODE;
    const previousPaused = state.IS_BOT_PAUSED;
    t.after(() => {
        setControlService(null);
        state.GLOBAL_MODE = previousMode;
        state.IS_BOT_PAUSED = previousPaused;
    });
    state.IS_BOT_PAUSED = false;

    const { archive, accountId, migrationId } = await fixture(t, ['56911111','56922222']);
    await cutover(archive, migrationId);
    const service = createControlService(archive, { drainConversation: () => ({ drained: true }) });
    await service.setAccessForLegacyTarget({ targetId: '56911111', channel: 'whatsapp', accountId, policy: 'allowed' });
    await service.setGlobalPolicy({ globalMode: 'ignored_all' });
    state.GLOBAL_MODE = 'ignored_all';
    setControlService(service);

    const runHumano = chatControlCommands.find(definition => definition.aliases.includes('/humano')).run;
    const runIa = chatControlCommands.find(definition => definition.aliases.includes('/ia')).run;
    const targetAdapter = { channelName: 'whatsapp', accountId };

    const humanMessage = await runHumano({ queryParam: '56911111', targetAdapter });
    assert.match(humanMessage, /Atención Humana activada/);
    assert.doesNotMatch(humanMessage, /sigue ignorado/);
    let control = (await service.resolveLegacyTarget({ targetId: '56911111', channel: 'whatsapp', accountId })).control;
    assert.equal(control.automationMode, 'human');
    assert.equal(control.accessPolicy, 'allowed');

    const aiMessage = await runIa({ queryParam: '56911111', targetAdapter });
    assert.match(aiMessage, /volverá a responder/);
    control = (await service.resolveLegacyTarget({ targetId: '56911111', channel: 'whatsapp', accountId })).control;
    assert.equal(control.automationMode, 'ai');
    assert.equal(control.accessPolicy, 'allowed');

    const neutralHumanMessage = await runHumano({ queryParam: '56922222', targetAdapter });
    assert.match(neutralHumanMessage, /Atención Humana activada/);
    const neutralAiMessage = await runIa({ queryParam: '56922222', targetAdapter });
    assert.match(neutralAiMessage, /modo global estricto/);
    assert.match(neutralAiMessage, /\/permitir 56922222/);
    control = (await service.resolveLegacyTarget({ targetId: '56922222', channel: 'whatsapp', accountId })).control;
    assert.equal(control.accessPolicy, 'neutral');
    assert.equal(control.automationMode, 'ai');
});
