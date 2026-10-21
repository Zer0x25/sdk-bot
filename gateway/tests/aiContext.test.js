process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-ai-context-'));
    const archive = createArchive({ path: path.join(dir, 'archive.db') });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'ai-context-fixture' });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return { archive, account };
}

async function migrateControl(archive) {
    const contacts = {};
    const settings = { globalMode: 'allowed_all', currentProfile: 'default' };
    const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const ready = await archive.ready;
    const snapshot = await archive.snapshot();
    const report = buildControlImportReport({ contacts, settings, profileKeys: ['default'],
        conversations: await archive.conversationRows(), sourceManifest: {
            contacts: { present: true, sha256: checksum(contacts) },
            settings: { present: true, sha256: checksum(settings) }
        }, archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt: '2026-10-20T12:00:00.000Z' });
    const migrationId = `ai-context-${randomUUID()}`;
    const started = await archive.beginControlImport({ migrationId, report });
    for (let offset = 0; offset < started.report.entryCount; offset += 100) {
        await archive.stageControlImportBatch({ runId: started.runId, offset, limit: 100 });
    }
    assert.equal((await archive.verifyControlImport({ runId: started.runId })).status, 'verified');
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    for (;;) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 100 });
        if (batch.remaining === 0) break;
    }
    await archive.finishControlCutover({ migrationId });
}

async function setAutomationMode(archive, conversationId, automationMode) {
    const current = await archive.controlState(conversationId);
    const actorId = automationMode === 'human' ? current.ownerId || randomUUID() : randomUUID();
    const ownerId = automationMode === 'human' ? actorId : null;
    if (current.accessPolicy === 'allowed' && current.automationMode === automationMode && current.ownerId === ownerId) {
        return { control: current, actorId };
    }
    const changed = await archive.writeControlState({ conversationId, actorId, expectedVersion: current.controlVersion,
        state: { ...current, accessPolicy: 'allowed', automationMode, ownerId } });
    assert.equal(changed.status, 'updated');
    return { control: changed.control, actorId };
}

function inbound(accountId, providerMessageId, text, occurredAt) {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '15551234567@s.whatsapp.net' },
        providerMessageId, source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt,
        content: { type: 'text', text } };
}

async function acceptedOutbound(archive, accountId, conversationId, providerMessageId, source, text, extra = {}) {
    const key = `${source}:${providerMessageId}`;
    const { control, actorId } = await setAutomationMode(archive, conversationId, source === 'human' ? 'human' : 'ai');
    const policy = await archive.controlPolicy();
    const clientMessageId = source === 'human' ? randomUUID() : undefined;
    const controlSnapshot = { conversationId, controlVersion: control.controlVersion,
        contextVersion: control.contextVersion, policyVersion: policy.policyVersion };
    await archive.beginOutboundIntent({ idempotencyKey: key, accountId, conversationId, channel: 'whatsapp',
        destination: '15551234567@s.whatsapp.net', actorId, source,
        payload: { text, options: {} }, controlSnapshot,
        policy: { ...(extra.policy || {}), ...(clientMessageId ? { clientMessageId } : {}) } });
    const claimed = await archive.claimOutboundIntent({ idempotencyKey: key });
    assert.equal(claimed.status, 'claimed');
    await archive.finishOutboundIntent({ idempotencyKey: key, state: 'accepted', providerMessageId });
    const [result] = await archive.ingestBatch([{ identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid',
        exactValue: '15551234567@s.whatsapp.net' }, providerMessageId, source: 'live', direction: 'outbound',
    authorKind: 'external_self', occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text } }]);
    assert.equal(result.status, source === 'human' ? 'duplicate' : 'created');
    return archive.messageByProviderId({ conversationId, providerMessageId });
}

test('versioned AI context includes confirmed human output and confirmed AI bubbles only', async t => {
    const { archive, account } = await fixture(t);
    const [first] = await archive.ingestBatch([inbound(account.id, 'in-1', 'consulta anterior', '2026-10-20T11:00:00.000Z')]);
    const conversationId = first.message.conversationId;
    await migrateControl(archive);
    const human = await acceptedOutbound(archive, account.id, conversationId, 'human-1', 'human', 'respuesta del operador');
    const ai = await acceptedOutbound(archive, account.id, conversationId, 'ai-1', 'ai', 'respuesta confirmada', {
        policy: { generationId: 'gen-accepted', bubbleIndex: 0 }
    });
    await archive.ingestBatch([{ identity: { accountId: account.id, channel: 'whatsapp', kind: 'whatsapp_jid',
        exactValue: '15551234567@s.whatsapp.net' }, providerMessageId: 'unknown-ai', source: 'live',
    direction: 'outbound', authorKind: 'external_self', occurredAt: '2026-10-20T12:00:30.000Z',
    content: { type: 'text', text: 'generación nunca confirmada' } }]);
    const [current] = await archive.ingestBatch([inbound(account.id, 'in-2', 'nueva consulta', '2026-10-20T12:01:00.000Z')]);

    const context = await archive.aiContext({ conversationId, expectedContextVersion: '1',
        throughMessageId: current.message.id, excludeMessageIds: [current.message.id] });
    assert.deepEqual(context.messages.map(message => [message.authorKind, message.content.text]), [
        ['customer', 'consulta anterior'], ['operator', 'respuesta del operador'], ['ai', 'respuesta confirmada']
    ]);
    assert.equal(context.messages.some(message => message.content.text === 'generación nunca confirmada'), false);

    const resumed = await archive.aiContext({ conversationId, expectedContextVersion: '1',
        throughMessageId: ai.id, excludeGenerationId: 'gen-accepted' });
    assert.equal(resumed.messages.some(message => message.id === ai.id), false);
    assert.equal(resumed.messages.some(message => message.id === human.id), true);
});

test('/limpiar advances a durable context boundary without deleting the archive', async t => {
    const { archive, account } = await fixture(t);
    const [old] = await archive.ingestBatch([inbound(account.id, 'clear-old', 'tramo anterior', '2026-10-20T11:00:00.000Z')]);
    const conversationId = old.message.conversationId;
    await migrateControl(archive);
    const oldHuman = await acceptedOutbound(archive, account.id, conversationId, 'clear-human-old', 'human', 'respuesta anterior');
    const actorId = randomUUID();
    const cleared = await archive.clearAIContext({ conversationId, actorId, expectedContextVersion: '1' });
    assert.equal(cleared.status, 'updated');
    assert.equal(cleared.contextVersion, '2');
    assert.equal(cleared.throughMessageId, oldHuman.id);
    assert.equal((await archive.messages({ conversationId })).length, 2);
    await assert.rejects(archive.aiContext({ conversationId, expectedContextVersion: '1' }), { code: 'AI_CONTEXT_VERSION_STALE' });

    await acceptedOutbound(archive, account.id, conversationId, 'clear-human-new', 'human', 'respuesta nueva');
    const [current] = await archive.ingestBatch([inbound(account.id, 'clear-new', 'mensaje posterior', '2026-10-20T10:00:00.000Z')]);
    const context = await archive.aiContext({ conversationId, expectedContextVersion: '2',
        throughMessageId: current.message.id, excludeMessageIds: [current.message.id] });
    assert.deepEqual(context.messages.map(message => message.content.text), ['respuesta nueva']);
    assert.equal(context.messages.some(message => message.id === old.message.id || message.id === oldHuman.id), false);
});
