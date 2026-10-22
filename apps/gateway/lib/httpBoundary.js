// @ts-check
// Infraestructura HTTP compartida; no importa estado, adapters ni servicios.
const crypto = require('node:crypto');
const { assertValid } = require('@sdk-bot/contracts');

class BoundaryError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function sendError(res, error, requestId = crypto.randomUUID()) {
    const known = error instanceof BoundaryError;
    const body = assertValid('ErrorResponse', { error: {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'No se pudo completar la solicitud.',
        requestId
    } });
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(known ? error.status : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Request-Id': requestId
    });
    res.end(JSON.stringify(body));
}

function readBytes(req, { maxBytes = 1024 * 1024, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => finish(new BoundaryError(503, 'TIMEOUT', 'Tiempo de recepción agotado.')), timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            req.off('data', onData); req.off('end', onEnd);
            req.off('error', onError); req.off('aborted', onAbort);
        };
        /** @param {Buffer | undefined} [value] */
        function finish(error, value = undefined) {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) { req.resume(); reject(error); } else resolve(value);
        }
        function onData(chunk) {
            size += chunk.length;
            if (size > maxBytes) return finish(new BoundaryError(422, 'VALIDATION_ERROR', 'Cuerpo demasiado grande.'));
            chunks.push(chunk);
        }
        function onEnd() { finish(null, Buffer.concat(chunks)); }
        function onError() { finish(new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Solicitud interrumpida.')); }
        function onAbort() {
            // IncomingMessage puede emitir error después de aborted.
            req.once('error', () => {});
            onError();
        }
        req.on('data', onData); req.on('end', onEnd);
        req.on('error', onError); req.on('aborted', onAbort);
    });
}

module.exports = { BoundaryError, sendError, readBytes };
