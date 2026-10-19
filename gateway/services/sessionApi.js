// @ts-check
const crypto = require('node:crypto');
const { assertValid } = require('@sdk-bot/contracts');
const { BoundaryError } = require('../lib/httpBoundary');
const { requireCapability } = require('../lib/panelContext');

function capabilityFor(method, pathname) {
    if (method === 'GET' && /^\/v1\/(session|accounts|conversations(?:\/[^/]+(?:\/messages)?)?|operations\/[^/]+|events)$/.test(pathname)) return 'conversations:read';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/(takeover|release)$/.test(pathname)) return 'control:write';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/messages$/.test(pathname)) return 'messages:send';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/read$/.test(pathname)) return 'conversations:read';
    if (method === 'PATCH' && /^\/v1\/conversations\/[^/]+$/.test(pathname)) return 'conversations:write';
    return null;
}

function createSessionApi(getPolicy) {
    // Bootstrap sin archivo/SSE: época volátil, seq=0. F2 la reemplaza por el
    // snapshot durable de la DB antes de habilitar consultas/replay.
    const dataEpoch = crypto.randomUUID();
    return function route(req, res, context, pathname) {
        const capability = capabilityFor(req.method, pathname);
        if (!capability) throw new BoundaryError(404, 'NOT_FOUND', 'Ruta no disponible.');
        requireCapability(context.actor, capability);
        if (req.method !== 'GET' || pathname !== '/v1/session') {
            throw new BoundaryError(404, 'NOT_FOUND', 'Ruta todavía no disponible.');
        }
        const body = assertValid('SessionResponse', {
            actor: context.actor, policy: getPolicy(), snapshot: { dataEpoch, seq: '0' }
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store', 'X-Request-Id': context.requestId });
        res.end(JSON.stringify(body));
    };
}

module.exports = { createSessionApi, capabilityFor };
