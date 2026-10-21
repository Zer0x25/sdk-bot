process.env.SDK_BOT_TEST = '1';
process.env.GATEWAY_READ_DELAY_MIN_MS = '0';
process.env.GATEWAY_READ_DELAY_MAX_MS = '0';
process.env.GATEWAY_READ_DELAY_JITTER_MS = '0';
process.env.GATEWAY_TYPING_MS_PER_CHAR_MIN = '0';
process.env.GATEWAY_TYPING_MS_PER_CHAR_MAX = '0';
process.env.GATEWAY_TYPING_MIN_MS = '0';
process.env.GATEWAY_TYPING_MAX_MS = '0';
process.env.GATEWAY_TYPING_JITTER_MS = '0';
process.env.GATEWAY_PAUSE_BETWEEN_BUBBLES_MIN_MS = '0';
process.env.GATEWAY_PAUSE_BETWEEN_BUBBLES_MAX_MS = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');
const ChannelAdapter = require('../core/ChannelAdapter');
const { processAIChat } = require('../services/brainService');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const DESTINATION = '15551234567@s.whatsapp.net';

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-f58-acceptance-'));
    const archive = createArchive({ path: path.join(dir, 'archive.db') });
    await archive.ready;
    const account = await archive.registerAccount({ id: ACCOUNT_ID, channel: 'whatsapp', providerKey: 'f58-fixture' });
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
    const migrationId = `f58-${randomUUID()}`;
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

function inbound(accountId, providerMessageId, text, occurredAt) {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: DESTINATION },
        providerMessageId, source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt,
        content: { type: 'text', text } };
}

async function acceptedHumanMessage(archive, accountId, conversationId, suffix, text, actorId) {
    const idempotencyKey = `operator-send-f58-${suffix}`;
    const current = await archive.controlState(conversationId);
    let control = current;
    if (current.accessPolicy !== 'allowed' || current.automationMode !== 'human' || current.ownerId !== actorId) {
        const updated = await archive.writeControlState({ conversationId, actorId,
            expectedVersion: current.controlVersion,
            state: { ...current, accessPolicy: 'allowed', automationMode: 'human', ownerId: actorId } });
        assert.equal(updated.status, 'updated');
        control = updated.control;
    }
    const policy = await archive.controlPolicy();
    const clientMessageId = randomUUID();
    await archive.beginOutboundIntent({ idempotencyKey, accountId, conversationId, channel: 'whatsapp',
        destination: DESTINATION, actorId, source: 'human', payload: { text, options: {} },
        controlSnapshot: { conversationId, controlVersion: control.controlVersion,
            contextVersion: control.contextVersion, policyVersion: policy.policyVersion },
        policy: { clientMessageId } });
    const claimed = await archive.claimOutboundIntent({ idempotencyKey });
    assert.equal(claimed.status, 'claimed');
    await archive.finishOutboundIntent({ idempotencyKey, state: 'accepted', providerMessageId: `human-${suffix}` });
    const [saved] = await archive.ingestBatch([{ identity: { accountId, channel: 'whatsapp',
        kind: 'whatsapp_jid', exactValue: DESTINATION }, providerMessageId: `human-${suffix}`, source: 'live',
    direction: 'outbound', authorKind: 'external_self', occurredAt: `2026-10-20T11:30:0${suffix}.000Z`,
    content: { type: 'text', text } }]);
    assert.equal(saved.status, 'duplicate');
}

class FakeWhatsAppAdapter extends ChannelAdapter {
    constructor(archive, accountId) {
        super('whatsapp');
        this.archive = archive;
        this.accountId = accountId;
        this.rawSends = [];
    }
    async sendPresenceUpdate() {}
    async sendMessageRaw(jid, text) {
        const remote = jid.replace('whatsapp:', '');
        const providerMessageId = `generated-${this.rawSends.length + 1}`;
        this.rawSends.push({ text, providerMessageId });
        await this.archive.ingestBatch([{ identity: { accountId: this.accountId, channel: 'whatsapp',
            kind: 'whatsapp_jid', exactValue: remote }, providerMessageId, source: 'live', direction: 'outbound',
        authorKind: 'external_self', occurredAt: '2026-10-20T12:03:00.000Z', content: { type: 'text', text } }]);
        return { key: { id: providerMessageId } };
    }
}

test('F5.8 integrated acceptance: human context reaches GenerateReply and an accepted AI reply replays once', async t => {
    const { archive, account } = await fixture(t);
    const [prior] = await archive.ingestBatch([inbound(account.id, 'prior-f58', 'consulta previa', '2026-10-20T11:00:00.000Z')]);
    const conversationId = prior.message.conversationId;
    await migrateControl(archive);
    const operatorId = randomUUID();
    await acceptedHumanMessage(archive, account.id, conversationId, '1', 'primera respuesta humana', operatorId);
    await acceptedHumanMessage(archive, account.id, conversationId, '2', 'segunda respuesta humana', operatorId);
    const [current] = await archive.ingestBatch([inbound(account.id, 'current-f58', 'consulta actual', '2026-10-20T12:01:00.000Z')]);
    const beforeAI = await archive.controlState(conversationId);
    const activatedAI = await archive.writeControlState({ conversationId, actorId: operatorId,
        expectedVersion: beforeAI.controlVersion,
        state: { ...beforeAI, accessPolicy: 'allowed', automationMode: 'ai', ownerId: null } });
    assert.equal(activatedAI.status, 'updated');
    const activeControl = await archive.controlState(conversationId);
    const activePolicy = await archive.controlPolicy();
    const adapter = new FakeWhatsAppAdapter(archive, account.id);
    const previousFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        if (String(url).endsWith('/generate-reply')) {
            requests.push(JSON.parse(options.body));
            return { ok: true, async json() { return { response: 'respuesta IA confirmada' }; } };
        }
        if (String(url).endsWith('/invalidate-generation')) return { ok: true };
        throw new Error(`Unexpected fake transport URL: ${url}`);
    };
    const snapshot = { conversationId, controlVersion: activeControl.controlVersion,
        contextVersion: activeControl.contextVersion, policyVersion: activePolicy.policyVersion };
    const options = { controlSnapshot: snapshot, sourceMessageIds: [current.message.id], isCurrent: async () => true };
    try {
        await processAIChat('consulta actual', `whatsapp:${DESTINATION}`, {}, adapter, options);
        await processAIChat('consulta actual', `whatsapp:${DESTINATION}`, {}, adapter, options);
    } finally { global.fetch = previousFetch; }

    assert.equal(requests.length, 2);
    assert.equal(requests[0].generation_id, requests[1].generation_id);
    assert.equal(requests[0].message, 'consulta actual');
    assert.deepEqual(requests[0].context.map(item => [item.author_kind, item.content]), [
        ['customer', 'consulta previa'], ['operator', 'primera respuesta humana'], ['operator', 'segunda respuesta humana']
    ]);
    assert.deepEqual(adapter.rawSends.map(send => send.text), ['respuesta IA confirmada']);
    assert.equal((await archive.messages({ conversationId })).length, 5);

    const [next] = await archive.ingestBatch([inbound(account.id, 'next-f58', 'siguiente consulta', '2026-10-20T12:04:00.000Z')]);
    const context = await archive.aiContext({ conversationId, expectedContextVersion: '1',
        throughMessageId: next.message.id, excludeMessageIds: [next.message.id] });
    assert.deepEqual(context.messages.map(message => message.authorKind), ['customer', 'operator', 'operator', 'customer', 'ai']);
    assert.equal(context.messages.at(-1).content.text, 'respuesta IA confirmada');
});

test('F5.8 takeover during a fake in-flight send keeps control pending and records an uncertain intent', async t => {
    const { archive, account } = await fixture(t);
    const [created] = await archive.ingestBatch([inbound(account.id, 'takeover-f58', 'entrada', '2026-10-20T12:00:00.000Z')]);
    const conversationId = created.message.conversationId;
    const current = await archive.controlState(conversationId);
    const actorId = '22222222-2222-4222-8222-222222222222';
    const enabled = await archive.writeControlState({ conversationId, actorId, expectedVersion: current.controlVersion,
        state: { ...current, accessPolicy: 'allowed', automationMode: 'ai' } });
    assert.equal(enabled.status, 'updated');

    let sendStarted;
    const started = new Promise(resolve => { sendStarted = resolve; });
    let rejectProvider;
    const providerResult = new Promise((_, reject) => { rejectProvider = reject; });
    const adapter = new FakeWhatsAppAdapter(archive, account.id);
    adapter.sendMessageRaw = async () => { sendStarted(); return providerResult; };
    const key = 'generation-in-flight-f58:bubble:0';
    const generation = adapter.sendMessage(`whatsapp:${DESTINATION}`, 'respuesta incierta', {
        source: 'ai', generationId: 'generation-in-flight-f58', bubbleIndex: 0, idempotencyKey: key,
        conversationId, controlSnapshot: { conversationId, controlVersion: enabled.control.controlVersion,
            contextVersion: enabled.control.contextVersion, policyVersion: '1' }, isCurrent: async () => true
    });
    await started;

    const takeover = await archive.beginControlTakeover({ conversationId, actorId,
        expectedVersion: enabled.control.controlVersion, idempotencyKey: 'takeover-in-flight-f58', overrideOwner: false });
    assert.equal(takeover.status, 'started');
    assert.equal((await archive.controlState(conversationId)).status, 'taking_control');
    rejectProvider(Object.assign(new Error('provider response timed out'), { code: 'WA_TIMEOUT' }));
    await assert.rejects(generation, { code: 'WA_TIMEOUT' });
    assert.equal((await archive.outboundIntent(key)).state, 'delivery_unknown');

    const completed = await archive.completeControlTakeover({ operationId: takeover.operation.id, uncertainMessageIds: [] });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.operation.uncertainMessageIds, [(await archive.outboundIntent(key)).id]);
    assert.equal(completed.control.automationMode, 'human');
    assert.equal(completed.control.status, 'confirmed');
});
