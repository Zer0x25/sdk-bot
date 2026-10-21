/* global AbortController */
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
const { processAIChat } = require('../services/brainService');

test('F5.5 refuses a pool job when its durable control snapshot is stale', async () => {
    const oldFetch = global.fetch;
    let requests = 0, sends = 0;
    global.fetch = async () => { requests += 1; throw new Error('fetch must not run'); };
    try {
        await processAIChat('mensaje', 'whatsapp:111', {}, {
            async sendPresenceUpdate() {}, async sendMessage() { sends += 1; }
        }, { controlSnapshot: { conversationId: 'conversation' }, isCurrent: async () => false });
        assert.equal(requests, 0);
        assert.equal(sends, 0);
    } finally { global.fetch = oldFetch; }
});

test('F5.5 stops before sending another bubble when takeover aborts a running response', async () => {
    const oldFetch = global.fetch;
    const controller = new AbortController();
    const sent = [], presence = [], requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, async json() { return { response: `${'A'.repeat(240)}\n${'B'.repeat(240)}` }; } };
    };
    const adapter = {
        archive: { async aiContext(input) { return { conversationId: input.conversationId, contextVersion: '1',
            throughMessageId: 'source-1', messages: [] }; } },
        async sendPresenceUpdate(status) { presence.push(status); },
        async sendMessage(_remoteJid, text) { sent.push(text); controller.abort(); return { key: { id: 'sent-1' } }; }
    };
    try {
        await processAIChat('mensaje', 'whatsapp:111', {}, adapter, { signal: controller.signal,
            sourceMessageIds: ['source-1'], controlSnapshot: { conversationId: 'conversation', contextVersion: '1' },
            isCurrent: async () => true });
        assert.equal(sent.length, 1);
        assert.match(requests[0].url, /\/generate-reply$/);
        assert.equal(requests[0].body.context_version, '1');
        assert.equal(requests[0].body.through_message_id, 'source-1');
        assert.ok(requests[0].body.generation_id.startsWith('gen_'));
        assert.equal(requests.some(request => /\/invalidate-generation$/.test(request.url)), true);
        assert.equal(presence.includes('composing'), true);
        assert.equal(presence.at(-1), 'paused');
    } finally { global.fetch = oldFetch; }
});
