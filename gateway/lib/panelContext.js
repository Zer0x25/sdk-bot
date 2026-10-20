// @ts-check
const crypto = require('node:crypto');
const { validate, assertValid } = require('@sdk-bot/contracts');
const { BoundaryError } = require('./httpBoundary');
const CONTEXT_HEADER = 'x-sdkbot-context';
const SIGNATURE_HEADER = 'x-sdkbot-signature';
const TTL_MS = 30000;

function requireSecret(secret) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
        throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Frontera del panel sin configurar.');
    }
}
function digest(body) { return crypto.createHash('sha256').update(body).digest('hex'); }
function mac(secret, encoded) {
    return crypto.createHmac('sha256', secret).update(`sdkbot-panel-v1.${encoded}`).digest('base64url');
}

function signContext({ secret, actor, requestId, method, target, body, now = Date.now() }) {
    requireSecret(secret);
    assertValid('Actor', actor);
    assertValid('Id', requestId);
    const encoded = Buffer.from(JSON.stringify({
        v: 1, issuer: 'panel', audience: 'gateway', actor, requestId,
        issuedAt: now, expiresAt: now + TTL_MS, method, target, bodyHash: digest(body)
    })).toString('base64url');
    return { [CONTEXT_HEADER]: encoded, [SIGNATURE_HEADER]: mac(secret, encoded) };
}

// Cache acotada por proceso: no expulsar nonces vigentes para admitir nuevos.
// Reiniciar pierde la cache; TTL 30s limita esa ventana, no sustituye idempotencia F5.
function createVerifier({ secret = '', now = Date.now, maxNonces = 10000 } = {}) {
    const used = new Map();
    return function verify(req, body) {
        requireSecret(secret);
        const denied = () => new BoundaryError(401, 'UNAUTHENTICATED', 'Contexto del panel inválido o vencido.');
        const encoded = req.headers[CONTEXT_HEADER];
        const signature = req.headers[SIGNATURE_HEADER];
        if (typeof encoded !== 'string' || encoded.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(encoded) ||
            typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw denied();
        const expected = mac(secret, encoded);
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw denied();
        let context;
        try { context = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw denied(); }
        const time = now();
        if (!context || Object.keys(context).sort().join(',') !==
            'actor,audience,bodyHash,expiresAt,issuedAt,issuer,method,requestId,target,v' ||
            context.v !== 1 || context.issuer !== 'panel' || context.audience !== 'gateway' ||
            !validate('Actor', context.actor).valid || !validate('Id', context.requestId).valid ||
            !Number.isSafeInteger(context.issuedAt) || !Number.isSafeInteger(context.expiresAt) ||
            context.issuedAt > time + 5000 || context.expiresAt <= time ||
            context.expiresAt <= context.issuedAt || context.expiresAt - context.issuedAt > TTL_MS ||
            context.method !== req.method || context.target !== req.url || context.bodyHash !== digest(body)) throw denied();
        for (const [nonce, expires] of used) if (expires <= time) used.delete(nonce);
        if (used.has(context.requestId)) throw denied();
        if (used.size >= maxNonces) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Frontera temporalmente ocupada.');
        used.set(context.requestId, context.expiresAt);
        return context;
    };
}

function requireCapability(actor, capability) {
    if (!actor.capabilities.includes(capability)) throw new BoundaryError(403, 'FORBIDDEN', 'Permiso insuficiente.');
}

// UUID v8 determinista, con namespace fijo; independiente de secretos rotables.
function actorId(subject) {
    const bytes = crypto.createHash('sha256').update(`sdk-bot/actor/v1/${subject}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { CONTEXT_HEADER, SIGNATURE_HEADER, TTL_MS, signContext, createVerifier, requireCapability, actorId };
