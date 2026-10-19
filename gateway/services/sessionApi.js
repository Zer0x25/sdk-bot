// @ts-check
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

function createSessionApi(getPolicy, archive) {
    return async function route(req, res, context, pathname) {
        const capability = capabilityFor(req.method, pathname);
        if (!capability) throw new BoundaryError(404, 'NOT_FOUND', 'Ruta no disponible.');
        requireCapability(context.actor, capability);
        if (req.method !== 'GET' || pathname !== '/v1/session') {
            throw new BoundaryError(404, 'NOT_FOUND', 'Ruta todavía no disponible.');
        }
        let snapshot;
        try { snapshot = await archive.snapshot(); }
        catch { throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Archivo de conversaciones no disponible.'); }
        const body = assertValid('SessionResponse', {
            actor: context.actor, policy: getPolicy(), snapshot
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store', 'X-Request-Id': context.requestId });
        res.end(JSON.stringify(body));
    };
}

module.exports = { createSessionApi, capabilityFor };
