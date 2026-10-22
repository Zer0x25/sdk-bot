// @ts-check
const http = require('node:http');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validate } = require('@sdk-bot/contracts');
const { signContext } = require('../gateway/lib/panelContext');
const { readBytes, BoundaryError, sendError } = require('../gateway/lib/httpBoundary');

function responseContract(method, pathname, status) {
    if (status >= 400) return 'ErrorResponse';
    if (method === 'GET' && pathname === '/v1/session') return 'SessionResponse';
    if (method === 'GET' && pathname === '/v1/accounts') return 'AccountsResponse';
    if (method === 'GET' && pathname === '/v1/profiles') return 'AutomationProfilesResponse';
    if (method === 'GET' && pathname === '/v1/summary') return 'SummaryResponse';
    if (method === 'GET' && pathname === '/v1/conversations') return 'ConversationsResponse';
    if (method === 'GET' && /^\/v1\/operations\/[^/]+$/.test(pathname)) return 'Operation';
    if (method === 'GET' && /^\/v1\/conversations\/[^/]+\/pending-resume$/.test(pathname)) return 'PendingResumeResponse';
    if (method === 'GET' && /^\/v1\/conversations\/[^/]+$/.test(pathname)) return 'ConversationResponse';
    if (method === 'GET' && /^\/v1\/conversations\/[^/]+\/messages$/.test(pathname)) return 'MessagesResponse';
    if (method === 'GET' && /^\/v1\/conversations\/[^/]+\/search$/.test(pathname)) return 'MessageSearchResponse';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/assistance$/.test(pathname)) return 'ConversationAssistanceResponse';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/messages$/.test(pathname)) return 'SendMessageResponse';
    if (method === 'POST' && /^\/v1\/conversations\/[^/]+\/read$/.test(pathname)) return 'ReadResponse';
    const control = /^\/v1\/conversations\/[^/]+\/(takeover|release)$/.exec(pathname);
    if (method === 'POST' && control) {
        return control[1] === 'takeover' && status === 202 ? 'TakeoverPendingResponse' : 'TakeoverConfirmedResponse';
    }
    if (method === 'PATCH' && /^\/v1\/conversations\/[^/]+$/.test(pathname)) return 'TakeoverConfirmedResponse';
    return null;
}

// Lista positiva: nunca propagar Cookie/Authorization/X-Status-Token ni contexto
// o firmas del navegador. Content-Length se calcula sobre los bytes firmados.
function upstreamHeaders(req, target, body) {
    const headers = { host: target.host, 'content-length': String(body.length) };
    for (const name of ['accept', 'content-type', 'last-event-id', 'idempotency-key']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    return headers;
}

function isAttachmentDownload(method, pathname) {
    return method === 'GET' && /^\/v1\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pathname);
}

function attachmentResponseHeaders(headers, requestId) {
    const contentLength = headers['content-length'];
    const disposition = headers['content-disposition'];
    if (headers['content-type'] !== 'application/octet-stream' || headers['content-encoding']
        || typeof contentLength !== 'string' || !/^[1-9][0-9]*$/.test(contentLength)
        || Number(contentLength) > 16 * 1024 * 1024
        || typeof disposition !== 'string'
        || !/^attachment; filename="attachment"; filename\*=UTF-8''(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+$/.test(disposition)
        || headers['x-content-type-options'] !== 'nosniff') return null;
    return { 'Content-Type': 'application/octet-stream', 'Content-Length': contentLength,
        'Content-Disposition': disposition, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId };
}

async function proxy(req, res, targetPath, {
    internal, secret, actor, requestId, v1 = false, sessionExpiresAt,
    timeoutMs = 5000, idleMs = 45000, streamMaxMs = 12 * 60 * 60 * 1000
}) {
    try {
        const body = await readBytes(req, { timeoutMs });
        if (res.destroyed) return;
        const target = new URL(targetPath, internal);
        if (!targetPath.startsWith('/') || targetPath.startsWith('//') || target.origin !== new URL(internal).origin || target.protocol !== 'http:') {
            throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Destino del gateway inválido.');
        }
        const headers = upstreamHeaders(req, target, body);
        const attachmentDownload = v1 && isAttachmentDownload(req.method, target.pathname);
        if (v1 || secret) Object.assign(headers, signContext({
            secret, actor, requestId, method: req.method,
            target: target.pathname + target.search, body
        }));
        const stream = req.method === 'GET' && ['/qr', '/logs', '/v1/events'].includes(target.pathname);
        let pres;
        let lifetime;
        let failed = false;
        const fail = (error) => {
            if (failed) return;
            failed = true;
            clearTimeout(deadline); clearTimeout(lifetime);
            pres?.destroy(); preq.destroy();
            if (!res.destroyed) {
                if (v1 && !res.headersSent) sendError(res, error, requestId);
                else if (res.headersSent) res.destroy();
                else {
                    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ error: 'Bus interno no disponible.' }));
                }
            }
        };
        const deadline = setTimeout(() => fail(new BoundaryError(503, 'TIMEOUT', 'Tiempo de respuesta agotado.')),
            attachmentDownload ? Math.max(timeoutMs, 30000) : timeoutMs);
        const preq = http.request(target, { method: req.method, headers }, (upstream) => {
            pres = upstream;
            const isStream = stream && upstream.statusCode === 200 &&
                (upstream.headers['content-type'] || '').startsWith('text/event-stream');
            if (isStream) {
                clearTimeout(deadline);
                // Heartbeats cuentan como actividad; el stream nunca supera
                // la sesión que lo abrió, incluso con tráfico continuo.
                preq.setTimeout(idleMs, () => fail(new BoundaryError(503, 'TIMEOUT', 'Stream sin actividad.')));
                lifetime = setTimeout(() => fail(new BoundaryError(401, 'UNAUTHENTICATED', 'Renueva la sesión.')),
                    Math.max(1, Math.min(streamMaxMs, (sessionExpiresAt ?? Date.now() + streamMaxMs) - Date.now())));
            }
            upstream.on('error', () => fail(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Respuesta interrumpida.')));
            upstream.on('end', () => { clearTimeout(deadline); clearTimeout(lifetime); });
            if (attachmentDownload && upstream.statusCode === 200) {
                const safeHeaders = attachmentResponseHeaders(upstream.headers, requestId);
                if (!safeHeaders) return fail(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Respuesta de adjunto inválida del gateway.'));
                clearTimeout(deadline);
                preq.setTimeout(idleMs, () => fail(new BoundaryError(503, 'TIMEOUT', 'Descarga sin actividad.')));
                res.writeHead(200, safeHeaders);
                let size = 0;
                const expected = Number(safeHeaders['Content-Length']);
                const bounded = new Transform({
                    transform(chunk, _encoding, callback) {
                        size += chunk.length;
                        if (size > expected || size > 16 * 1024 * 1024) {
                            callback(Object.assign(new Error('ATTACHMENT_RESPONSE_TOO_LARGE'), { code: 'ATTACHMENT_RESPONSE_TOO_LARGE' }));
                        } else callback(null, chunk);
                    },
                    flush(callback) {
                        if (size !== expected) callback(Object.assign(new Error('ATTACHMENT_RESPONSE_TRUNCATED'), { code: 'ATTACHMENT_RESPONSE_TRUNCATED' }));
                        else callback();
                    }
                });
                void pipeline(upstream, bounded, res).catch(() => fail(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Descarga interrumpida.')));
            } else if (v1 && !isStream) {
                const chunks = [];
                let size = 0;
                upstream.on('data', chunk => {
                    size += chunk.length;
                    if (size > 65536) return fail(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Respuesta inválida del gateway.'));
                    chunks.push(chunk);
                });
                upstream.on('end', () => {
                    if (res.destroyed || res.writableEnded) return;
                    let value;
                    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* saneado abajo */ }
                    const status = upstream.statusCode || 503;
                    const contract = responseContract(req.method, target.pathname, status);
                    if (!contract || !validate(contract, value).valid) {
                        return fail(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Respuesta inválida del gateway.'));
                    }
                    // La correlación pública la fija el panel, no un header de cliente.
                    if (status >= 400) value.error.requestId = requestId;
                    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store', 'X-Request-Id': requestId });
                    res.end(JSON.stringify(value));
                });
            } else {
                const responseHeaders = { ...upstream.headers, 'cache-control': 'no-store' };
                for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'proxy-authenticate', 'upgrade']) delete responseHeaders[name];
                res.writeHead(upstream.statusCode || 503, responseHeaders);
                upstream.pipe(res);
            }
        });
        preq.on('error', () => fail(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Gateway no disponible.')));
        res.on('close', () => { clearTimeout(deadline); clearTimeout(lifetime); pres?.destroy(); preq.destroy(); });
        preq.end(body); // Un intento: nunca reintentar mutaciones ambiguas.
    } catch (error) {
        sendError(res, error, requestId);
    }
}

module.exports = { proxy, upstreamHeaders, responseContract };
