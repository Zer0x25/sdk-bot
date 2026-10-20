const { randomUUID } = require('node:crypto');

function createTelegramArchive() {
    const accounts = new Map(), cursor = new Map(), messages = new Map();
    return {
        async registerAccount({ channel, providerKey }) {
            const key = `${channel}:${providerKey}`;
            if (!accounts.has(key)) accounts.set(key, { id: randomUUID(), channel, provider_key: providerKey });
            return accounts.get(key);
        },
        async telegramCursor(accountId) { return cursor.get(accountId) ?? null; },
        async captureTelegramBatch({ accountId, updates }) {
            let lastUpdateId = cursor.get(accountId) ?? null;
            const results = updates.map(update => {
                if (lastUpdateId !== null && BigInt(update.updateId) <= BigInt(lastUpdateId)) return { updateId: update.updateId, status: 'stale' };
                lastUpdateId = update.updateId;
                if (!update.message) return { updateId: update.updateId, status: 'excluded' };
                const key = `${accountId}:${update.message.identity.exactValue}:${update.message.providerMessageId}`;
                const old = messages.get(key);
                if (old) return { updateId: update.updateId, status: 'duplicate', result: { status: 'duplicate', messageId: old.id, conversationId: old.conversationId } };
                const message = { ...update.message, id: randomUUID(), conversationId: randomUUID() };
                messages.set(key, message);
                return { updateId: update.updateId, status: 'created', result: { status: 'created', message } };
            });
            cursor.set(accountId, lastUpdateId);
            return { lastUpdateId, results };
        },
        async updateTranscription({ messageId, status, transcript = null }) {
            return { status: 'updated', message: { id: messageId, conversationId: randomUUID(), content: { transcriptionStatus: status, transcript } } };
        },
        async conversation() { return { requires_review: 0 }; },
        async diagnostics() { return { messages: messages.size }; },
        _accounts: accounts,
        _cursor: cursor,
        _messages: messages
    };
}

module.exports = { createTelegramArchive };
