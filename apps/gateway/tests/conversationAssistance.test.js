process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { createSessionApi, capabilityFor } = require('../services/sessionApi');

const actorId = randomUUID();
const assistantActor = { id: actorId, capabilities: ['admin:write', 'conversations:read'] };
const deniedActor = { id: randomUUID(), capabilities: ['admin:write'] };

async function fixture(t, channel = 'whatsapp') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-assist-'));
    const archive = createArchive({ path: path.join(directory, 'conversations.db') });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
    await archive.ready;
    const account = await archive.registerAccount({ channel, providerKey: `assist-${channel}-${randomUUID()}` });
    const [stored] = await archive.ingestBatch([{ identity: {
        accountId: account.id, channel, kind: channel === 'whatsapp' ? 'whatsapp_jid' : 'telegram_chat_id',
        exactValue: channel === 'whatsapp' ? '15551234567@s.whatsapp.net' : '-10012345'
    }, providerMessageId: `assist-${randomUUID()}`, source: 'live', direction: 'inbound', authorKind: 'customer',
    occurredAt: '2026-10-22T10:00:00.000Z', content: { type: 'text', text: '¿Tienen disponibilidad para el viernes?' } }]);
    archive.controlAuthority = async () => ({ mode: 'sqlite', serviceReady: true });
    archive.controlState = async () => ({ accessPolicy: 'allowed', lifecycle: 'open', requiresReview: false,
        status: 'confirmed', controlVersion: '1', contextVersion: '1', profileKey: 'default' });
    return { archive, conversationId: stored.message.conversationId, messageId: stored.message.id };
}

function createRoute(archive, assistConversation) {
    return createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false, policyVersion: '1', globalProfileKey: 'default' }),
        archive, undefined, undefined, undefined, undefined, undefined, undefined, assistConversation);
}

async function callRoute(route, conversationId, actor, input) {
    const pathname = `/v1/conversations/${conversationId}/assistance`;
    const req = { method: 'POST', url: pathname, headers: {} };
    let status = 200;
    let body;
    const res = { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
    try {
        await route(req, res, { actor, requestId: randomUUID() }, pathname,
            Buffer.from(JSON.stringify(input)));
    } catch (error) {
        status = error.status || 503;
        body = { error: { code: error.code || 'INTERNAL_ERROR' } };
    }
    return { status, body };
}

test('operator assistance requires both grants and produces snapshot-bound references without a send', async t => {
    const { archive, conversationId, messageId } = await fixture(t);
    const before = await archive.snapshot();
    let received;
    const route = createRoute(archive, async input => {
        received = input;
        return { summaryPoints: [{ text: 'Pregunta por disponibilidad para el viernes.', messageIds: [messageId] }],
            draft: 'Sí, tenemos disponibilidad para el viernes. ¿Qué horario te acomoda?', draftMessageIds: [messageId] };
    });
    const pathname = `/v1/conversations/${conversationId}/assistance`;
    const req = { method: 'POST', url: pathname, headers: {} };
    let status = 0, body;
    const res = { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
    await route(req, res, { actor: assistantActor, requestId: randomUUID() }, pathname, Buffer.from(JSON.stringify({
        expectedContextVersion: '1', expectedSnapshot: before
    })));

    assert.equal(capabilityFor('POST', pathname), 'admin:write');
    assert.equal(status, 200);
    assert.equal(body.conversationId, conversationId);
    assert.equal(body.snapshot.seq, before.seq);
    assert.equal(body.summaryPoints[0].references[0].messageId, messageId);
    assert.equal(body.draftReferences[0].authorKind, 'customer');
    assert.equal(received.actorId, actorId);
    assert.equal(received.context[0].messageId, messageId);
    assert.deepEqual(await archive.outboundIntents({ conversationId }), []);
    assert.deepEqual(await archive.snapshot(), before);

    const denied = await callRoute(createRoute(archive, async () => { throw new Error('must not call'); }),
        conversationId, deniedActor, { expectedContextVersion: '1', expectedSnapshot: before });
    assert.equal(denied.status, 403);
});

test('operator assistance refuses Telegram and stale snapshots before invoking the Brain', async t => {
    const telegram = await fixture(t, 'telegram');
    let calls = 0;
    const route = createRoute(telegram.archive, async () => { calls += 1; return {}; });
    const deniedChannel = await callRoute(route, telegram.conversationId, assistantActor,
        { expectedContextVersion: '1', expectedSnapshot: await telegram.archive.snapshot() });
    assert.equal(deniedChannel.status, 409);
    assert.equal(deniedChannel.body.error.code, 'ASSISTANCE_CHANNEL_UNAVAILABLE');

    const whatsapp = await fixture(t);
    const staleRoute = createRoute(whatsapp.archive, async () => { calls += 1; return {}; });
    const snapshot = await whatsapp.archive.snapshot();
    const stale = await callRoute(staleRoute, whatsapp.conversationId, assistantActor,
        { expectedContextVersion: '1', expectedSnapshot: { ...snapshot, seq: '0' } });
    assert.equal(stale.status, 410);
    assert.equal(stale.body.error.code, 'CURSOR_EXPIRED');
    assert.equal(calls, 0);
});

test('operator assistance discards provider output if the thread changes during generation and rejects foreign references', async t => {
    const { archive, conversationId, messageId } = await fixture(t);
    const snapshot = await archive.snapshot();
    const newId = randomUUID();
    const changingRoute = createRoute(archive, async () => {
        await archive.ingestBatch([{ identity: { accountId: (await archive.accounts())[0].id,
            channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '15551234567@s.whatsapp.net' },
        providerMessageId: `changed-${randomUUID()}`, source: 'live', direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-22T10:01:00.000Z', content: { type: 'text', text: 'Cambio durante generación' } }]);
        return { summaryPoints: [{ text: 'Resumen.', messageIds: [messageId] }], draft: 'Borrador.', draftMessageIds: [messageId] };
    });
    const changed = await callRoute(changingRoute, conversationId, assistantActor,
        { expectedContextVersion: '1', expectedSnapshot: snapshot });
    assert.equal(changed.status, 410);
    assert.equal(changed.body.error.code, 'CURSOR_EXPIRED');

    const fresh = await archive.snapshot();
    const invalidRoute = createRoute(archive, async () => ({
        summaryPoints: [{ text: 'Resumen.', messageIds: [newId] }], draft: 'Borrador.', draftMessageIds: [messageId]
    }));
    const invalid = await callRoute(invalidRoute, conversationId, assistantActor,
        { expectedContextVersion: '1', expectedSnapshot: fresh });
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.error.code, 'ASSISTANCE_RESPONSE_INVALID');
});

test('operator assistance discards provider output if control changes during generation', async t => {
    const { archive, conversationId, messageId } = await fixture(t);
    const snapshot = await archive.snapshot();
    let contextVersion = '1';
    archive.controlState = async () => ({ accessPolicy: 'allowed', lifecycle: 'open', requiresReview: false,
        status: 'confirmed', controlVersion: contextVersion, contextVersion, profileKey: 'default' });
    const route = createRoute(archive, async () => {
        contextVersion = '2';
        return { summaryPoints: [{ text: 'Resumen.', messageIds: [messageId] }],
            draft: 'Borrador.', draftMessageIds: [messageId] };
    });
    const changed = await callRoute(route, conversationId, assistantActor,
        { expectedContextVersion: '1', expectedSnapshot: snapshot });

    assert.equal(changed.status, 410);
    assert.equal(changed.body.error.code, 'CURSOR_EXPIRED');
    assert.deepEqual(await archive.outboundIntents({ conversationId }), []);
});
