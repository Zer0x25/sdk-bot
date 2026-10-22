// @ts-check
'use strict';

const { createHash } = require('node:crypto');
const { assertValid, validate } = require('@sdk-bot/contracts');

const TOOL_DEFINITIONS = Object.freeze({
    'conversation.search_messages': Object.freeze({ effect: 'read', capability: 'conversations:read', timeoutMs: 3000 })
});

function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

function fingerprint(value) {
    return createHash('sha256').update(stable(value)).digest('hex');
}

function toolError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function withTimeout(promise, timeoutMs) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(toolError(504, 'TOOL_TIMEOUT', 'La herramienta excedió su tiempo límite.')), timeoutMs);
    })]).finally(() => clearTimeout(timer));
}

function authorized(actor, capability) {
    return Array.isArray(actor?.capabilities) && actor.capabilities.includes(capability);
}

async function recordInvocation(archive, entry) {
    return archive.recordAssistantToolInvocation(assertValid('AssistantToolAuditRecord', entry));
}

/** @param {{archive:any, actor:any, conversationId:string, expectedSnapshot:any, request:any, timeoutMs?:number}} input
 * Executes only registered Gateway tools; Brain-provided data never chooses an adapter or URL. */
async function executeAssistantTool(input) {
    const { archive, actor, conversationId, expectedSnapshot, request, timeoutMs } = input;
    const validation = validate('AssistantToolRequest', request);
    if (!validation.valid) throw toolError(422, 'TOOL_REQUEST_INVALID', 'La solicitud de herramienta no cumple el contrato.');
    const definition = TOOL_DEFINITIONS[request.toolName];
    if (!definition || definition.effect !== request.effect) {
        throw toolError(403, 'TOOL_NOT_AVAILABLE', 'La herramienta solicitada no está habilitada.');
    }
    if (!authorized(actor, definition.capability)) {
        throw toolError(403, 'TOOL_PERMISSION_DENIED', 'El actor no tiene permiso para esta herramienta.');
    }
    if (!archive || !validate('Id', conversationId).valid || !validate('EventCursor', expectedSnapshot).valid) {
        throw toolError(422, 'TOOL_CONTEXT_INVALID', 'Falta el contexto verificado de la conversación.');
    }

    const canonicalRequest = { actorId: actor.id, conversationId, expectedSnapshot,
        toolName: request.toolName, effect: request.effect, input: request.input };
    const requestFingerprint = fingerprint(canonicalRequest);
    const invocationKey = fingerprint({ namespace: 'assistant-tool-v1', requestFingerprint });
    const startedAt = new Date().toISOString();
    const limitMs = timeoutMs ?? definition.timeoutMs;

    try {
        const search = await withTimeout(archive.searchMessages({ conversationId, query: request.input.query,
            limit: request.input.limit, expectedSnapshot }), limitMs);
        if (search.snapshot.dataEpoch !== expectedSnapshot.dataEpoch || search.snapshot.seq !== expectedSnapshot.seq) {
            throw toolError(410, 'CURSOR_EXPIRED', 'El hilo cambió durante la búsqueda de contexto.');
        }
        const hits = search.items.flatMap(item => {
            const message = item.message;
            if (!message || message.deletedAt || !['customer', 'ai', 'operator'].includes(message.authorKind)
                || typeof item.snippet !== 'string' || !item.snippet.trim()) return [];
            return [{ messageId: message.id, occurredAt: message.occurredAt,
                authorKind: message.authorKind, snippet: item.snippet.trim().slice(0, 512) }];
        });
        const result = assertValid('ConversationSearchToolResult', {
            toolName: request.toolName, invocationKey, snapshot: search.snapshot, hits
        });
        const completedAt = new Date().toISOString();
        await recordInvocation(archive, { invocationKey, requestFingerprint,
            resultFingerprint: fingerprint({ snapshot: result.snapshot, hits: result.hits }),
            actorId: actor.id, conversationId, toolName: request.toolName, effect: request.effect,
            status: 'completed', attemptCount: 1, createdAt: startedAt, updatedAt: completedAt });
        return result;
    } catch (error) {
        const completedAt = new Date().toISOString();
        const toolFailure = /** @type {{status?:number,code?:string}} */ (error);
        const code = typeof toolFailure?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(toolFailure.code) ? toolFailure.code : 'TOOL_EXECUTION_FAILED';
        try {
            await recordInvocation(archive, { invocationKey, requestFingerprint, resultFingerprint: null,
                actorId: actor.id, conversationId, toolName: request.toolName, effect: request.effect,
                status: 'failed', attemptCount: 1, createdAt: startedAt, updatedAt: completedAt });
        } catch { /* Preserve the bounded tool error; the caller still fails closed. */ }
        if (toolFailure?.status) throw error;
        if (code === 'CURSOR_EXPIRED' || code === 'DATA_EPOCH_MISMATCH') {
            throw toolError(410, 'CURSOR_EXPIRED', 'El hilo cambió; actualiza el contexto y vuelve a intentarlo.');
        }
        if (code === 'INVALID_SEARCH_QUERY' || code === 'SEARCH_TOO_COMPLEX' || code === 'INVALID_LIMIT') {
            throw toolError(422, 'TOOL_INPUT_INVALID', 'La consulta de contexto no es válida.');
        }
        throw toolError(503, 'TOOL_UNAVAILABLE', 'La herramienta no está disponible ahora.');
    }
}

module.exports = { TOOL_DEFINITIONS, executeAssistantTool, fingerprint };
