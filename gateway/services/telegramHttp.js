// @ts-check
const https = require('node:https');

/** Bounded Bot API JSON request. Resolve only after the request has closed, so
 * replacing a poll cannot overlap the previous local HTTP request. No retries.
 * @param {{path:string, method?:string, body?:object, signal?:AbortSignal, timeoutMs:number}} input
 * @returns {Promise<any>}
 */
function requestJson({ path, method = 'GET', body, signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(failure('TG_REQUEST_CANCELLED'));
        let request, response, parsed, error, ended = false, bytes = 0;
        const timer = setTimeout(() => abort('TG_REQUEST_TIMEOUT'), timeoutMs);
        const cancelled = () => abort('TG_REQUEST_CANCELLED');
        signal?.addEventListener('abort', cancelled, { once: true });
        function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); }
        function abort(code) {
            error = failure(code);
            response?.destroy(error);
            request?.destroy(error);
        }
        const options = { hostname: 'api.telegram.org', path, family: 4,
            ...(method === 'POST' ? { method, headers: { 'Content-Type': 'application/json' } } : {}) };
        const receive = res => {
            response = res;
            const chunks = [];
            res.on('error', () => { error ||= failure('TG_RESPONSE_FAILED'); });
            res.on('data', chunk => {
                bytes += Buffer.byteLength(chunk);
                if (bytes > 8 * 1024 * 1024) { abort('TG_RESPONSE_TOO_LARGE'); return; }
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            res.on('end', () => {
                ended = true;
                try {
                    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
                    // Preserve classification even for an invalid/non-JSON 4xx body.
                    if (res.statusCode >= 400) parsed = { ok: false, error_code: res.statusCode };
                } catch { if (res.statusCode >= 400) parsed = { ok: false, error_code: res.statusCode }; else error ||= failure('TG_RESPONSE_INVALID'); }
            });
        };
        try {
            request = method === 'GET' ? https.get(options, receive) : https.request(options, receive);
            request.on('error', () => { error ||= failure('TG_REQUEST_FAILED'); });
            request.on('close', () => {
                cleanup();
                if (error) reject(error);
                else if (!ended) reject(failure('TG_RESPONSE_INCOMPLETE'));
                else resolve(parsed);
            });
            if (method === 'POST') request.end(JSON.stringify(body));
        } catch {
            cleanup(); reject(failure('TG_REQUEST_FAILED'));
        }
    });
}

function failure(code, message = 'No se pudo completar la consulta de Telegram. Reintenta.') {
    return Object.assign(new Error(message), { code });
}

module.exports = { requestJson, failure };
