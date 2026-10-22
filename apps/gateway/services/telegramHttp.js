// @ts-check
const https = require('node:https');

/**
 * Bounded raw Bot API request for call sites that need Telegram's error text.
 * The request settles on response end or its own deadline; timeouts are never
 * retried here because a send may already have reached Telegram.
 * @param {{path:string, method?:string, body?:object, signal?:AbortSignal, timeoutMs:number, requestImpl?:(options:any,callback:(response:any)=>void)=>any, maxBytes?:number}} input
 * @returns {Promise<{statusCode:number, body:string}>}
 */
function requestText({ path, method = 'GET', body, signal, timeoutMs, requestImpl, maxBytes = 8 * 1024 * 1024 }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(failure('TG_REQUEST_CANCELLED'));
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reject(failure('TG_TIMEOUT_INVALID'));
        let request, response, settled = false, responseEnded = false, timer;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancelled);
            if (error) reject(error); else resolve(result);
        };
        const abort = code => {
            const error = failure(code);
            finish(error);
            response?.destroy?.(error);
            request?.destroy?.(error);
        };
        const cancelled = () => abort('TG_REQUEST_CANCELLED');
        timer = setTimeout(() => abort('TG_REQUEST_TIMEOUT'), timeoutMs);
        timer.unref?.();
        signal?.addEventListener('abort', cancelled, { once: true });

        const receive = res => {
            response = res;
            const chunks = [];
            let bytes = 0;
            res.on('data', chunk => {
                if (settled) return;
                const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += value.length;
                if (bytes > maxBytes) { abort('TG_RESPONSE_TOO_LARGE'); return; }
                chunks.push(value);
            });
            res.on('error', () => finish(failure('TG_RESPONSE_FAILED')));
            res.on('aborted', () => finish(failure('TG_RESPONSE_INCOMPLETE')));
            res.on('close', () => {
                if (!responseEnded) finish(failure('TG_RESPONSE_INCOMPLETE'));
            });
            res.on('end', () => {
                responseEnded = true;
                let text;
                try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
                catch { finish(failure('TG_RESPONSE_INVALID_UTF8')); return; }
                finish(null, { statusCode: Number(res.statusCode) || 0, body: text });
            });
        };

        try {
            const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const options = { hostname: 'api.telegram.org', path, family: 4,
                ...(method === 'POST' ? { method, headers: {
                    'Content-Type': 'application/json',
                    ...(payload ? { 'Content-Length': String(payload.length) } : {})
                } } : {}) };
            request = requestImpl
                ? requestImpl(options, receive)
                : method === 'GET' ? https.get(options, receive) : https.request(options, receive);
            request.on('error', () => finish(failure('TG_REQUEST_FAILED')));
            request.on('close', () => {
                if (!responseEnded) finish(failure('TG_RESPONSE_INCOMPLETE'));
            });
            if (method !== 'GET' && typeof request.end === 'function') request.end(payload || undefined);
        } catch { finish(failure('TG_REQUEST_FAILED')); }
    });
}

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
                    parsed = parseTelegramJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
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

/** JSON.parse rounds integer tokens above 2^53. Telegram uses JSON numbers for
 * provider IDs, so quote unsafe integer tokens before parsing. Safe integers
 * and all non-ID values retain their normal JSON types. */
function parseTelegramJson(source) {
    let output = '';
    for (let i = 0; i < source.length;) {
        const char = source[i];
        if (char === '"') {
            const start = i++;
            while (i < source.length) {
                if (source[i] === '\\') { i += 2; continue; }
                if (source[i++] === '"') break;
            }
            output += source.slice(start, i);
            continue;
        }
        if (char === '-' || char >= '0' && char <= '9') {
            const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
            if (match) {
                const token = match[0];
                const integer = !/[.eE]/.test(token);
                output += integer && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
                i += token.length;
                continue;
            }
        }
        output += char;
        i++;
    }
    return JSON.parse(output);
}

module.exports = { requestText, requestJson, failure, parseTelegramJson };
