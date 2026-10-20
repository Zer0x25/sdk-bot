process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-ai-context-'));
    const archive = createArchive({ path: path.join(dir, 'archive.db') });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'ai-context-fixture' });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return { archive, account };
}

function inbound(accountId, providerMessageId, text, occurredAt) {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '15551234567@s.whatsapp.net' },
        providerMessageId, source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt,
        content: { type: 'text', text } };
}

async function acceptedOutbound(archive, accountId, conversationId, providerMessageId, source, text, extra = {}) {
    const key = `${source}:${providerMessageId}`;
    await archive.beginOutboundIntent({ idempotencyKey: key, accountId, conversationId, channel: 'whatsapp',
        destination: '15551234567@s.whatsapp.net', actorId: randomUUID(), source,
        payload: { text, options: {} }, ...extra });
    await archive.claimOutboundIntent({ idempotencyKey: key });
    await archive.finishOutboundIntent({ idempotencyKey: key, state: 'accepted', providerMessageId });
    const [result] = await archive.ingestBatch([{ identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid',
        exactValue: '15551234567@s.whatsapp.net' }, providerMessageId, source: 'live', direction: 'outbound',
    authorKind: 'external_self', occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text } }]);
    assert.equal(result.status, 'created');
    return result.message;
}

test('versioned AI context includes confirmed human output and confirmed AI bubbles only', async t => {
    const { archive, account } = await fixture(t);
    const [first] = await archive.ingestBatch([inbound(account.id, 'in-1', 'consulta anterior', '2026-10-20T11:00:00.000Z')]);
    const conversationId = first.message.conversationId;
    const human = await acceptedOutbound(archive, account.id, conversationId, 'human-1', 'human', 'respuesta del operador');
    const ai = await acceptedOutbound(archive, account.id, conversationId, 'ai-1', 'ai', 'respuesta confirmada', {
        controlSnapshot: { conversationId, controlVersion: '1', contextVersion: '1', policyVersion: '1' },
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
