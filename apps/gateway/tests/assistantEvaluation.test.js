process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { createSessionApi } = require('../services/sessionApi');

const actor = { id: randomUUID(), capabilities: ['admin:write', 'conversations:read'] };
const at = '2026-10-22T10:00:00.000Z';

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-assistant-eval-'));
    const archive = createArchive({ path: path.join(directory, 'conversations.db') });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
    await archive.ready;

    const accountA = await archive.registerAccount({ channel: 'whatsapp', providerKey: `eval-a-${randomUUID()}` });
    const accountB = await archive.registerAccount({ channel: 'whatsapp', providerKey: `eval-b-${randomUUID()}` });
    const [messageA] = await archive.ingestBatch([{ identity: { accountId: accountA.id, channel: 'whatsapp',
        kind: 'whatsapp_jid', exactValue: '15550000001@s.whatsapp.net' }, providerMessageId: `eval-a-${randomUUID()}`,
    source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt: at,
    content: { type: 'text', text: '¿Cuál es el horario disponible?' } }]);
    const [messageB] = await archive.ingestBatch([{ identity: { accountId: accountB.id, channel: 'whatsapp',
        kind: 'whatsapp_jid', exactValue: '15550000002@s.whatsapp.net' }, providerMessageId: `eval-b-${randomUUID()}`,
    source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt: at,
    content: { type: 'text', text: 'Secreto de la cuenta B: presupuesto 900.' } }]);

    archive.controlAuthority = async () => ({ mode: 'sqlite', serviceReady: true });
    archive.controlState = async conversationId => ({ accessPolicy: 'allowed', automationMode: 'ai',
        lifecycle: 'open', ownerId: null, requiresReview: false, status: 'confirmed', controlVersion: '1',
        contextVersion: '1', profileKey: 'default', conversationId });
    return { archive, directory, accountA, accountB,
        conversationA: messageA.message.conversationId, conversationB: messageB.message.conversationId,
        messageA: messageA.message, messageB: messageB.message };
}

function routeFor(archive, assistConversation) {
    return createSessionApi(() => ({ globalMode: 'allowed_all', globalPaused: false,
        policyVersion: '1', globalProfileKey: 'default' }), archive,
    undefined, undefined, undefined, undefined, undefined, undefined, assistConversation);
}

async function callAssistance(route, conversationId, snapshot) {
    const pathname = `/v1/conversations/${conversationId}/assistance`;
    const req = { method: 'POST', url: pathname, headers: {} };
    let status = 200;
    let body;
    const res = { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
    try {
        await route(req, res, { actor, requestId: randomUUID() }, pathname,
            Buffer.from(JSON.stringify({ expectedContextVersion: '1', expectedSnapshot: snapshot })));
    } catch (error) {
        status = error.status || 503;
        body = { error: { code: error.code || 'INTERNAL_ERROR' } };
    }
    return { status, body };
}

test('F10.4 synthetic human-control case: assistance never creates an outbound message', async t => {
    const { archive, conversationA, messageA } = await fixture(t);
    archive.controlState = async () => ({ accessPolicy: 'allowed', automationMode: 'human', lifecycle: 'open',
        ownerId: actor.id, requiresReview: false, status: 'confirmed', controlVersion: '4', contextVersion: '1' });
    const beforeSnapshot = await archive.snapshot();
    const beforeMessages = await archive.messages({ conversationId: conversationA });
    const route = routeFor(archive, async () => ({ kind: 'final',
        summaryPoints: [{ text: 'El cliente consulta el horario.', messageIds: [messageA.id] }],
        draft: '¿Qué horario te acomoda?', draftMessageIds: [messageA.id] }));

    const response = await callAssistance(route, conversationA, beforeSnapshot);
    assert.equal(response.status, 200);
    assert.deepEqual(await archive.messages({ conversationId: conversationA }), beforeMessages);
    assert.deepEqual(await archive.outboundIntents({ conversationId: conversationA }), []);
    assert.deepEqual(await archive.snapshot(), beforeSnapshot);
});

test('F10.4 synthetic draft case: an operator draft is neither a note nor a delivered message', async t => {
    const { archive, conversationA, messageA } = await fixture(t);
    const beforeMessages = await archive.messages({ conversationId: conversationA });
    const beforeSnapshot = await archive.snapshot();
    const draft = 'Borrador pendiente de revisión: confirmar el horario.';
    const route = routeFor(archive, async () => ({ kind: 'final',
        summaryPoints: [{ text: 'Falta confirmar el horario.', messageIds: [messageA.id] }],
        draft, draftMessageIds: [messageA.id] }));

    const response = await callAssistance(route, conversationA, beforeSnapshot);
    assert.equal(response.status, 200);
    assert.equal(response.body.draft, draft);
    assert.deepEqual(await archive.messages({ conversationId: conversationA }), beforeMessages);
    assert.deepEqual(await archive.outboundIntents({ conversationId: conversationA }), []);
    assert.deepEqual(await archive.snapshot(), beforeSnapshot);
});

test('F10.4 synthetic account-isolation case: Gateway search and citations stay inside the selected conversation', async t => {
    const { archive, conversationA, messageA, messageB } = await fixture(t);
    const beforeSnapshot = await archive.snapshot();
    const phases = [];
    const route = routeFor(archive, async input => {
        phases.push(input);
        if (input.phase === 'plan') return { kind: 'tool_request', toolName: 'conversation.search_messages',
            effect: 'read', input: { query: 'Secreto', limit: 5 } };
        return { kind: 'final',
            summaryPoints: [{ text: 'El hilo pregunta por un horario, sin el dato consultado.', messageIds: [messageA.id] }],
            draft: 'No veo ese dato en este hilo. ¿Puedes confirmarlo?', draftMessageIds: [messageA.id] };
    });

    const response = await callAssistance(route, conversationA, beforeSnapshot);
    assert.equal(response.status, 200);
    assert.equal(phases.length, 2);
    assert.ok(phases[0].context.every(item => !item.content.includes('Secreto de la cuenta B')));
    assert.deepEqual(phases[1].toolResults[0].hits, []);
    assert.equal(JSON.stringify(response.body).includes('900'), false);
    assert.deepEqual(response.body.summaryPoints[0].references.map(reference => reference.messageId), [messageA.id]);

    const foreignReferenceRoute = routeFor(archive, async input => input.phase === 'plan'
        ? { kind: 'tool_request', toolName: 'conversation.search_messages', effect: 'read',
            input: { query: 'Secreto', limit: 5 } }
        : { kind: 'final', summaryPoints: [{ text: 'Dato externo.', messageIds: [messageB.id] }],
            draft: 'Usa el presupuesto 900.', draftMessageIds: [messageB.id] });
    const foreignReference = await callAssistance(foreignReferenceRoute, conversationA, beforeSnapshot);
    assert.equal(foreignReference.status, 503);
    assert.equal(foreignReference.body.error.code, 'ASSISTANCE_RESPONSE_INVALID');
    assert.deepEqual(await archive.outboundIntents({ conversationId: conversationA }), []);
});
