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
const { createControlService } = require('../services/conversations/controlService');
const { createLegacyDispatchPump } = require('../services/conversations/legacyDispatch');
const { createSessionApi } = require('../services/sessionApi');
const ChannelAdapter = require('../core/ChannelAdapter');
const { processAIChat } = require('../services/brainService');

const DESTINATION = '15551234567@s.whatsapp.net';
const PHONE = '15551234567';

async function migrateControl(archive, migrationId) {
    const settings = { globalMode: 'allowed_all', currentProfile: 'default' };
    const contacts = {};
    const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const ready = await archive.ready;
    const snapshot = await archive.snapshot();
    const report = buildControlImportReport({ contacts, settings, profileKeys: ['default'],
        conversations: await archive.conversationRows(), sourceManifest: {
            contacts: { present: true, sha256: checksum(contacts) },
            settings: { present: true, sha256: checksum(settings) }
        }, archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt: '2026-10-20T12:00:00.000Z' });
    const started = await archive.beginControlImport({ migrationId, report });
    for (let offset = 0; offset < started.report.entryCount; offset += 100) {
        await archive.stageControlImportBatch({ runId: started.runId, offset, limit: 100 });
    }
    const verified = await archive.verifyControlImport({ runId: started.runId });
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    for (;;) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 100 });
        if (batch.remaining === 0) break;
    }
    await archive.finishControlCutover({ migrationId });
}

function inbound(accountId, providerMessageId, text, seconds) {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: DESTINATION },
        providerMessageId, source: 'live', direction: 'inbound', authorKind: 'customer',
        occurredAt: `2026-10-20T12:00:${String(seconds).padStart(2, '0')}.000Z`,
        content: { type: 'text', text }, legacyDispatch: { waitForTranscription: false,
            message: { channel: 'whatsapp', remoteId: `whatsapp:${DESTINATION}`, rawId: DESTINATION,
                text, transcript: '', isAudio: false,
                metadata: { phoneNumber: 'route-phone-must-not-return', lid: 'route-lid-must-not-return',
                    pushName: 'Nombre público original', savedName: 'Nombre agenda original',
                    isFromMe: false, isAdminChannel: false } } } };
}

class FakeWhatsAppAdapter extends ChannelAdapter {
    constructor(archive, accountId) {
        super('whatsapp');
        this.archive = archive;
        this.accountId = accountId;
        this.rawSends = [];
    }

    async sendPresenceUpdate() {}

    async sendMessageRaw(normalizedJid, text, options = {}) {
        const destination = normalizedJid.replace('whatsapp:', '');
        const providerMessageId = `f63-provider-${this.rawSends.length + 1}`;
        this.rawSends.push({ destination, source: options.source, text, providerMessageId });
        await this.archive.ingestBatch([{ identity: { accountId: this.accountId, channel: 'whatsapp',
            kind: 'whatsapp_jid', exactValue: destination }, providerMessageId, source: 'live', direction: 'outbound',
        authorKind: 'external_self', occurredAt: `2026-10-20T12:01:0${this.rawSends.length}.000Z`,
        content: { type: 'text', text } }]);
        return { key: { id: providerMessageId } };
    }
}

test('F6.3 integrated flow: inbox, human takeover/reply, pending customer entry, and AI context', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-f63-flow-'));
    const archive = createArchive({ path: path.join(dir, 'archive.db') });
    let dispatchPump;
    const previousFetch = global.fetch;
    const previousSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    t.after(async () => {
        global.fetch = previousFetch;
        if (previousSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = previousSecret;
        await dispatchPump?.close();
        await archive.close().catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
    });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'f63-flow-fixture' });
    const [first] = await archive.ingestBatch([inbound(account.id, 'f63-inbound-1', 'consulta inicial', 1)]);
    assert.equal(first.status, 'created');
    const conversationId = first.message.conversationId;
    await migrateControl(archive, `f63-${randomUUID()}`);

    const actor = { id: randomUUID(), capabilities: ['conversations:read', 'control:write', 'messages:send'] };
    const adapter = new FakeWhatsAppAdapter(archive, account.id);
    const policy = await archive.controlPolicy();
    const getPolicy = () => ({ globalMode: policy.globalMode, globalPaused: false,
        policyVersion: policy.policyVersion, globalProfileKey: policy.globalProfileKey });
    let resumeFinished;
    const resumePumpFinished = new Promise(resolve => { resumeFinished = resolve; });
    const control = createControlService(archive, {
        drainConversation: () => ({ drained: true, uncertainMessageIds: [] }),
        onResumePending: async () => { await dispatchPump.trigger(); resumeFinished(); }
    });
    const route = createSessionApi(getPolicy, archive, () => ({}), () => 'connected', control,
        channel => channel === 'whatsapp' ? adapter : null);
    process.env.SDK_PANEL_GATEWAY_SECRET = 'f63-test-panel-secret-with-at-least-32-bytes';
    const brainRequests = [];
    global.fetch = async (url, options) => {
        if (String(url).endsWith('/generate-reply')) {
            const body = JSON.parse(options.body);
            brainRequests.push(body);
            const response = brainRequests.length === 1 ? 'respuesta IA inicial' : 'respuesta IA tras el operador';
            return { ok: true, async json() { return { response }; } };
        }
        if (String(url).endsWith('/invalidate-generation')) return { ok: true };
        throw new Error(`Unexpected fake transport URL: ${url}`);
    };
    const routedMessages = [];
    dispatchPump = createLegacyDispatchPump({ archive, isReady: () => true, onError: (error, id) => {
        throw Object.assign(new Error(`F6.3 dispatch failed for ${id}: ${error?.code || error?.message}`), { cause: error });
    }, dispatch: async message => {
        routedMessages.push(message);
        const state = await archive.controlState(conversationId);
        if (state.automationMode === 'human') return;
        const target = await control.readForIdentity({ accountId: account.id, channel: 'whatsapp',
            kind: 'whatsapp_jid', exactValue: DESTINATION });
        assert.equal(await archive.shouldProcessArchivedInbound({ messageId: message.archiveMessageId }), true);
        await processAIChat(message.text, message.remoteId, message.metadata, adapter, {
            controlSnapshot: target.controlSnapshot, sourceMessageIds: [message.archiveMessageId],
            isCurrent: () => control.isSnapshotCurrent(target.controlSnapshot)
        });
    } });

    const before = await archive.controlState(conversationId);
    const activated = await archive.writeControlState({ conversationId, actorId: actor.id,
        expectedVersion: before.controlVersion, state: { ...before, accessPolicy: 'allowed', automationMode: 'ai' } });
    assert.equal(activated.status, 'updated');
    await dispatchPump.trigger();
    assert.deepEqual(adapter.rawSends.map(send => send.text), ['respuesta IA inicial']);

    async function request(method, url, body = null, headers = {}) {
        let status, response;
        const pathname = new URL(url, 'http://gateway.test').pathname;
        const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
        try {
            await route({ method, url, headers }, res, { actor, requestId: randomUUID() }, pathname,
                body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
        } catch (error) { return { status: error.status, response: { code: error.code, message: error.message } }; }
        return { status, response };
    }

    const inbox = await request('GET', '/v1/conversations?limit=20');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.response.items[0].id, conversationId);
    assert.equal(inbox.response.items[0].control.automationMode, 'ai');
    const thread = await request('GET', `/v1/conversations/${conversationId}/messages`);
    assert.equal(thread.status, 200);
    assert.equal(thread.response.items.some(message => message.id === first.message.id
        && message.content.text === 'consulta inicial'), true);

    const takeover = await request('POST', `/v1/conversations/${conversationId}/takeover`,
        { expectedVersion: inbox.response.items[0].control.controlVersion },
        { 'idempotency-key': 'f63-takeover-conversation-01' });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.response.conversation.control.automationMode, 'human');
    assert.equal(takeover.response.conversation.control.status, 'confirmed');

    const humanReply = await request('POST', `/v1/conversations/${conversationId}/messages`, {
        expectedVersion: takeover.response.conversation.control.controlVersion,
        clientMessageId: randomUUID(), text: 'respuesta del operador',
        handledThroughInboundSeq: first.message.inboundSeq
    });
    assert.equal(humanReply.status, 202);
    const humanMessage = await archive.messageByProviderId({ conversationId,
        providerMessageId: adapter.rawSends.find(send => send.source === 'human').providerMessageId });
    assert.equal(humanMessage.authorKind, 'operator');
    assert.equal(humanMessage.content.text, 'respuesta del operador');
    assert.equal((await archive.controlState(conversationId)).automationMode, 'human');

    const [duringHuman] = await archive.ingestBatch([inbound(account.id, 'f63-inbound-2', 'consulta durante atención humana', 2)]);
    assert.equal(duringHuman.status, 'created');
    await dispatchPump.trigger();
    assert.equal((await archive.controlState(conversationId)).automationMode, 'human');
    assert.deepEqual(adapter.rawSends.map(send => send.source), ['ai', 'human']);

    const pending = await request('GET', `/v1/conversations/${conversationId}/pending-resume`);
    assert.equal(pending.status, 200);
    assert.equal(pending.response.candidateCount, 1);
    assert.equal(pending.response.candidates[0].messageId, duringHuman.message.id);
    assert.equal(pending.response.candidates[0].inboundSeq, duringHuman.message.inboundSeq);

    const released = await request('POST', `/v1/conversations/${conversationId}/release`, {
        expectedVersion: takeover.response.conversation.control.controlVersion,
        resumePolicy: 'process_pending', pendingInboundIds: [duringHuman.message.id],
        selectionVersion: pending.response.selectionVersion
    }, { 'idempotency-key': 'f63-release-selected-pending-01' });
    assert.equal(released.status, 200);
    assert.equal(released.response.conversation.control.automationMode, 'ai');
    let resumeTimeout;
    try {
        await Promise.race([resumePumpFinished, new Promise((_, reject) => {
            resumeTimeout = setTimeout(() => reject(new Error('F6.3 dispatch pump timed out')), 5000);
        })]);
    } finally { clearTimeout(resumeTimeout); }

    assert.equal(brainRequests.length, 2);
    assert.equal(brainRequests[1].message, 'consulta durante atención humana');
    assert.deepEqual(brainRequests[1].context.map(item => [item.author_kind, item.content]), [
        ['customer', 'consulta inicial'], ['ai', 'respuesta IA inicial'], ['operator', 'respuesta del operador']
    ]);
    assert.deepEqual(routedMessages.at(-1).metadata, { isFromMe: false, isAdminChannel: false,
        pushName: 'Nombre público original', savedName: 'Nombre agenda original', phoneNumber: PHONE });
    assert.deepEqual(brainRequests.map(request => request.bot_profile), ['default', 'default']);
    assert.deepEqual(adapter.rawSends.map(send => send.text), [
        'respuesta IA inicial', 'respuesta del operador', 'respuesta IA tras el operador'
    ]);
    const intents = await archive.outboundIntents({ conversationId, limit: 20 });
    const resumedReply = intents.find(intent => intent.source === 'ai' && intent.policy?.handledThroughInboundSeq === duringHuman.message.inboundSeq);
    assert.ok(resumedReply);
    assert.equal(resumedReply.state, 'accepted');
    assert.equal((await archive.pendingLegacyDispatches()).length, 0);
});
