// @ts-check
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Mockear fetch global para no pegar al servicio STT real.
const realFetch = global.fetch;
/** @type {Array<{url:any, opts:any}>} */
let calls = [];
/** @type {any} */
let fetchImpl = null;

before(() => {
    global.fetch = (/** string */ url, /** any */ opts) => {
        calls.push({ url, opts });
        return fetchImpl(url, opts);
    };
});

after(() => {
    global.fetch = realFetch;
});

// Cargar después de instalar el mock (el módulo lee config/tuning en require).
const { transcribeAudio } = require('../services/stt');

function jsonResponse(status, body) {
    return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    });
}
function timeoutResponse() {
    const err = new Error('The operation was timed out');
    err.name = 'TimeoutError';
    return Promise.reject(err);
}

test('transcribeAudio: devuelve texto en 200 OK', async () => {
    fetchImpl = () => jsonResponse(200, { text: 'hola mundo' });
    calls = [];
    const text = await transcribeAudio(Buffer.from('fake-audio-bytes'), 'wa.ogg', { language: 'es' });
    assert.strictEqual(text, 'hola mundo');
    assert.strictEqual(calls.length, 1);
    // El body debe ser FormData con el archivo.
    assert.ok(calls[0].opts.body, 'debe enviar FormData');
});

test('transcribeAudio: buffer vacío -> null (sin llamar STT)', async () => {
    fetchImpl = () => assert.fail('no debería llamar al STT con audio vacío');
    calls = [];
    const text = await transcribeAudio(Buffer.alloc(0), 'wa.ogg');
    assert.strictEqual(text, null);
    assert.strictEqual(calls.length, 0);
});

test('transcribeAudio: 4xx (413 audio grande) -> null y NO reintenta', async () => {
    fetchImpl = () => jsonResponse(413, { detail: 'too big' });
    calls = [];
    const text = await transcribeAudio(Buffer.alloc(100), 'wa.ogg');
    assert.strictEqual(text, null);
    assert.strictEqual(calls.length, 1, '4xx no debe reintentar');
});

test('transcribeAudio: 5xx -> 1 reintento y luego null', async () => {
    fetchImpl = () => jsonResponse(503, { detail: 'down' });
    calls = [];
    const text = await transcribeAudio(Buffer.alloc(100), 'wa.ogg');
    assert.strictEqual(text, null);
    assert.strictEqual(calls.length, 2, '5xx debe reintentar 1 vez');
});

test('transcribeAudio: timeout (transitorio) -> 1 reintento', async () => {
    fetchImpl = () => timeoutResponse();
    calls = [];
    const text = await transcribeAudio(Buffer.alloc(100), 'wa.ogg');
    assert.strictEqual(text, null);
    assert.strictEqual(calls.length, 2, 'timeout debe reintentar 1 vez');
});

test('transcribeAudio: 200 con texto vacío -> null', async () => {
    fetchImpl = () => jsonResponse(200, { text: '   ' });
    calls = [];
    const text = await transcribeAudio(Buffer.alloc(100), 'wa.ogg');
    assert.strictEqual(text, null);
});

test('transcribeAudio: cancellation reaches fetch and never retries a replaced socket', async () => {
    const controller = new globalThis.AbortController();
    calls = [];
    fetchImpl = (_url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
    const pending = transcribeAudio(Buffer.from('audio'), 'wa.ogg', { signal: controller.signal });
    controller.abort();
    assert.strictEqual(await pending, null);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].opts.signal.aborted);
    assert.strictEqual(await transcribeAudio(Buffer.from('audio'), 'wa.ogg', { signal: controller.signal }), null);
    assert.strictEqual(calls.length, 1);
});
