process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { requestJson } = require('../services/telegramHttp');
const originalGet = https.get, originalRequest = https.request;

async function fixture(t, handler) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const local = options => ({ ...options, hostname: '127.0.0.1', port: server.address().port });
    https.get = (options, callback) => http.get(local(options), callback);
    https.request = (options, callback) => http.request(local(options), callback);
    t.after(async () => { https.get = originalGet; https.request = originalRequest; server.closeAllConnections(); await new Promise(r => server.close(r)); });
    return { sockets };
}

test('absolute deadline closes request without headers or with a stalled body, without exposing raw URL/body', async t => {
    for (const headers of [false, true]) {
        const f = await fixture(t, (_req, res) => { if (headers) { res.writeHead(200); res.write('{'); } });
        await assert.rejects(requestJson({ path: '/botSYNTHETIC/getUpdates', timeoutMs: 30 }), error => error.code === 'TG_REQUEST_TIMEOUT' && !error.message.includes('SYNTHETIC'));
        // The client promise settles on close; the server observes it shortly after.
        await new Promise(r => setTimeout(r, 10)); assert.equal(f.sockets.size, 0);
    }
});

test('cancelling a request waits for closure and a pre-aborted request opens no connection', async t => {
    let started; const ready = new Promise(r => { started = r; }); let count = 0;
    const f = await fixture(t, () => { count++; started(); });
    const controller = new globalThis.AbortController();
    const pending = requestJson({ path: '/updates', signal: controller.signal, timeoutMs: 1000 });
    const rejected = assert.rejects(pending, { code: 'TG_REQUEST_CANCELLED' });
    await ready; controller.abort(); await rejected;
    await new Promise(r => setTimeout(r, 10)); assert.equal(f.sockets.size, 0);
    await assert.rejects(requestJson({ path: '/updates', signal: controller.signal, timeoutMs: 1000 }), { code: 'TG_REQUEST_CANCELLED' });
    assert.equal(count, 1);
});

test('BUG-042: split UTF-8 is decoded once; invalid UTF-8/JSON and oversized responses reject before delivery', async t => {
    await fixture(t, async (req, res) => {
        res.writeHead(200);
        if (req.url === '/unicode') {
            const value = Buffer.from('{"ok":true,"text":"😀á"}');
            for (const byte of value) { res.write(Buffer.from([byte])); await new Promise(r => setImmediate(r)); }
            res.end();
        } else if (req.url === '/unsafe') {
            res.end('{"update_id":9007199254740993,"message":{"message_id":9007199254740995,"chat":{"id":-9007199254740993}}}');
        } else if (req.url === '/utf8') res.end(Buffer.from([0xc3,0x28]));
        else if (req.url === '/large') res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
        else res.end('{bad json');
    });
    assert.deepEqual(await requestJson({ path: '/unicode', timeoutMs: 1000 }), { ok: true, text: '😀á' });
    assert.deepEqual(await requestJson({ path: '/unsafe', timeoutMs: 1000 }), {
        update_id: '9007199254740993', message: { message_id: '9007199254740995', chat: { id: '-9007199254740993' } }
    });
    for (const path of ['/utf8','/bad']) await assert.rejects(requestJson({ path, timeoutMs: 1000 }), { code: 'TG_RESPONSE_INVALID' });
    await assert.rejects(requestJson({ path: '/large', timeoutMs: 1000 }), { code: 'TG_RESPONSE_TOO_LARGE' });
});

test('HTTP error status survives malformed response, and test-send POST is bounded without automatic retry', async t => {
    let posts = 0;
    await fixture(t, (req, res) => {
        if (req.method === 'POST') { posts++; return; }
        res.writeHead(401); res.end('not JSON');
    });
    assert.deepEqual(await requestJson({ path: '/auth', timeoutMs: 1000 }), { ok: false, error_code: 401 });
    await assert.rejects(requestJson({ path: '/sendMessage', method: 'POST', body: { chat_id: '1', text: 'fixture' }, timeoutMs: 30 }), { code: 'TG_REQUEST_TIMEOUT' });
    assert.equal(posts, 1);
});
