process.env.SDK_BOT_TEST = '1';
process.env.AUDIO_STT_ENABLED = '0';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths(); after(() => temporary.restore());
const { saveSettingsDB, getSettingsDB } = require('../services/db');
const TelegramAdapter = require('../adapters/telegramAdapter');
const { createTelegramArchive } = require('./helpers/telegramArchive');
const bus = require('../services/internalBus');
const https = require('node:https');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const update = (id = 1, chat = '555', body = { text: '/start' }) => ({ update_id: id, message: {
    message_id: id, date: 1792368000, chat: { id: chat, type: 'private' }, from: { first_name: 'Synthetic' }, ...body
} });
async function until(predicate) {
    const deadline = Date.now() + 2500;
    while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
    assert.ok(predicate(), 'condition completed within deadline');
}
function transport({ delayedAbort = false } = {}) {
    const calls = []; let active = 0, peak = 0;
    function getUpdates(input) {
        return new Promise((resolve, reject) => {
            active++; peak = Math.max(peak, active);
            let done = false;
            const call = { ...input, aborted: false, finish(value = { ok: true, result: [] }, error) {
                if (done) return; done = true; active--;
                input.signal.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(value);
            } };
            const abort = () => { call.aborted = true; if (!delayedAbort) call.finish(undefined, new Error('cancelled')); };
            input.signal.addEventListener('abort', abort, { once: true }); calls.push(call);
        });
    }
    return { getUpdates, calls, peak: () => peak, active: () => active };
}
async function fixture(t, options = {}, network = transport()) {
    saveSettingsDB({ telegramToken: 'fixture_A', telegramChatId: '555', globalMode: 'ignored_all' });
    const archive = options.archive || createTelegramArchive();
    const adapter = new TelegramAdapter({ archive, getMe: async () => ({ ok: true, result: { id: 42, is_bot: true } }),
        getUpdates: network.getUpdates, updateMenu: async () => {}, discoveryTimeoutMs: 30, retryMs: 20, ...options });
    const seen = []; adapter.on('message', m => seen.push(m));
    await adapter.connect();
    t.after(async () => {
        const closing = adapter.disconnect();
        for (const call of network.calls) call.finish();
        await closing;
    });
    return { adapter, network, seen, archive };
}

test('BUG-004: concurrent discovery observes the sole poll, never steals messages or adds getUpdates/offsets', async t => {
    const { adapter, network, seen } = await fixture(t);
    const readers = Array.from({ length: 3 }, () => adapter.discoverChatId('fixture_A'));
    await adapter.poll(); assert.equal(network.calls.length, 1);
    network.calls[0].finish({ ok: true, result: [update(7), update(8, '-9007199254740993', { voice: { file_id: 'fixture' } })] });
    assert.deepEqual(await Promise.all(readers), ['555','555','555']);
    await until(() => network.calls.length === 2);
    assert.equal(network.calls[1].offset, '9'); assert.equal(network.peak(), 1);
    assert.equal(seen.length, 1); assert.equal(seen[0].text, '/start');
    assert.equal(await adapter.discoverChatId('fixture_A'), '-9007199254740993');
    assert.equal(network.calls.length, 2); assert.equal(adapter.chatWaiters.size, 0);
});

test('discovery rejects drafts/standby, expires cache, and a restarted adapter observes only new messages', async t => {
    const { adapter, network } = await fixture(t);
    await assert.rejects(adapter.discoverChatId('draft_B'), { code: 'TG_SAVE_TOKEN_FIRST' });
    network.calls[0].finish({ ok: true, result: [update(1)] });
    await until(() => network.calls.length === 2);
    assert.equal(await adapter.discoverChatId('fixture_A'), '555');
    adapter.lastChat.at = Date.now() - 5 * 60000 - 1;
    await assert.rejects(adapter.discoverChatId('fixture_A'), { code: 'TG_CHAT_NOT_OBSERVED' });
    await adapter.disconnect();
    const restarted = await fixture(t);
    await assert.rejects(restarted.adapter.discoverChatId('fixture_A'), { code: 'TG_CHAT_NOT_OBSERVED' });
    assert.equal(restarted.network.calls.length, 1); assert.equal(restarted.network.calls[0].offset, '0');
    saveSettingsDB({}); await restarted.adapter.connect();
    await assert.rejects(restarted.adapter.discoverChatId('fixture_A'), { code: 'TG_SAVE_TOKEN_FIRST' });
    assert.equal(restarted.adapter.status, 'standby');
});

test('discovery bounds waiters and cancellation/timeouts remove them without cancelling polling', async t => {
    const { adapter, network } = await fixture(t, { discoveryTimeoutMs: 1000 });
    const controllers = Array.from({ length: 64 }, () => new globalThis.AbortController());
    const readers = controllers.map(c => adapter.discoverChatId('fixture_A', { signal: c.signal }));
    const settled = Promise.allSettled(readers);
    await assert.rejects(adapter.discoverChatId('fixture_A'), { code: 'TG_DISCOVERY_BUSY' });
    for (const c of controllers) c.abort();
    assert.ok((await settled).every(r => r.status === 'rejected' && r.reason.code === 'TG_REQUEST_CANCELLED'));
    assert.equal(adapter.chatWaiters.size, 0); assert.equal(network.calls[0].aborted, false);
    assert.equal(network.calls.length, 1); assert.equal(adapter.lastUpdateId, null);
});

test('BUG-038: reconnect waits for real request settlement; superseded connects cannot start another poll', async t => {
    const network = transport({ delayedAbort: true });
    const { adapter, seen } = await fixture(t, {}, network);
    const discovery = adapter.discoverChatId('fixture_A');
    const failed = assert.rejects(discovery, { code: 'TG_CONNECTION_CHANGED' });
    saveSettingsDB({ telegramToken: 'fixture_B' }); const b = adapter.connect();
    saveSettingsDB({ telegramToken: 'fixture_C' }); const c = adapter.connect();
    await failed; await tick();
    assert.equal(network.calls.length, 1); assert.equal(network.calls[0].aborted, true);
    network.calls[0].finish({ ok: true, result: [update(900)] });
    await Promise.all([b, c]);
    assert.equal(network.calls.length, 2); assert.equal(network.calls[1].token, 'fixture_C');
    assert.equal(network.calls[1].offset, '0'); assert.equal(network.peak(), 1);
    assert.equal(seen.length, 0); assert.equal(adapter.lastChat, null);
});

test('verified bot identity preserves cursor on credential rotation and isolates a different bot account', async t => {
    const { adapter, network } = await fixture(t, { getMe: async ({ token }) => ({ ok: true,
        result: { id: token === 'fixture_B' ? 43 : 42, is_bot: true } }) });
    network.calls[0].finish({ ok: true, result: [update(900)] });
    await until(() => network.calls.length === 2);
    await adapter.connect();
    assert.equal(network.calls[2].offset, '901');
    saveSettingsDB({ telegramToken: 'fixture_ROTATED' }); await adapter.connect();
    assert.equal(network.calls[3].offset, '901'); assert.equal(network.calls[3].token, 'fixture_ROTATED');
    saveSettingsDB({ telegramToken: 'fixture_B' }); await adapter.connect();
    assert.equal(network.calls[4].offset, '0'); assert.equal(network.calls[4].token, 'fixture_B');
    assert.equal(network.peak(), 1); assert.equal(adapter.lastChat, null);
});

test('disconnect invalidates discovery immediately but waits for in-flight request closure', async t => {
    const network = transport({ delayedAbort: true });
    const { adapter, seen } = await fixture(t, {}, network);
    const reader = adapter.discoverChatId('fixture_A');
    const rejected = assert.rejects(reader, { code: 'TG_CONNECTION_CHANGED' });
    let closed = false; const stopping = adapter.disconnect().then(() => { closed = true; });
    await rejected; await tick(); assert.equal(closed, false);
    network.calls[0].finish({ ok: true, result: [update(30)] });
    await stopping; assert.equal(adapter.status, 'disconnected'); assert.equal(seen.length, 0);
    assert.equal(adapter.lastUpdateId, null); assert.equal(adapter.lastChat, null);
});

test('BUG-040: 4xx stops visibly, while provider/network errors back off and remain cancellable', async t => {
    for (const code of [401,404,409]) {
        const { adapter, network } = await fixture(t);
        const waiting = adapter.discoverChatId('fixture_A'); const rejected = assert.rejects(waiting, { code: 'TG_NOT_CONNECTED' });
        network.calls[0].finish({ ok: false, error_code: code }); await rejected;
        assert.equal(adapter.status, 'standby'); await tick(); assert.equal(network.calls.length, 1);
        await adapter.disconnect();
    }
    const { adapter, network } = await fixture(t);
    network.calls[0].finish({ ok: false, error_code: 500 });
    await new Promise(r => setTimeout(r, 5)); assert.equal(network.calls.length, 1);
    await until(() => network.calls.length === 2);
    network.calls[1].finish(undefined, new Error('private request failure'));
    await until(() => network.calls.length === 3);
    await adapter.disconnect(); const total = network.calls.length;
    await new Promise(r => setTimeout(r, 30)); assert.equal(network.calls.length, total);
});

test('stale audio cannot emit or use replacement token after reconnect', async t => {
    const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch; process.env.AUDIO_STT_ENABLED = '0'; });
    const urls = [];
    global.fetch = async url => { urls.push(String(url)); return String(url).includes('getFile')
        ? { ok: true, json: async () => ({ ok: true, result: { file_path: 'fixture.oga' } }) }
        : { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }; };
    const started = deferred(), transcript = deferred();
    const { adapter, network, seen } = await fixture(t, { transcribe: async () => { started.resolve(); return transcript.promise; } });
    adapter.sendPresenceUpdate = async () => {};
    process.env.AUDIO_STT_ENABLED = '1';
    network.calls[0].finish({ ok: true, result: [update(1, '555', { voice: { file_id: 'fixture' } }), update(2)] });
    await started.promise;
    saveSettingsDB({ telegramToken: 'fixture_B' }); await adapter.connect();
    transcript.resolve('late audio'); await tick(); await tick();
    assert.equal(seen.length, 0); assert.equal(adapter.lastChat, null);
    assert.ok(urls.every(url => url.includes('fixture_A')));
    assert.equal(network.calls[1].token, 'fixture_B');
});

async function server(t, adapter) {
    bus.setTelegramChatIdResolver((token, options) => adapter.discoverChatId(token, options));
    const instance = bus.startInternalBus({ port: 0 }); await new Promise(r => instance.once('listening', r));
    t.after(async () => { bus.setTelegramChatIdResolver(null); instance.closeAllConnections(); await new Promise(r => instance.close(r)); });
    return `http://127.0.0.1:${instance.address().port}`;
}
function fakeSends(t) {
    const original = https.request; t.after(() => { https.request = original; });
    const sent = [];
    https.request = (options, callback) => {
        const req = new EventEmitter();
        req.destroy = () => process.nextTick(() => req.emit('close'));
        req.end = body => {
            sent.push({ options, body: JSON.parse(body) });
            const res = new EventEmitter(); res.statusCode = 200;
            callback(res);
            process.nextTick(() => { res.emit('data', '{"ok":true}'); res.emit('end'); req.emit('close'); });
        };
        return req;
    };
    return sent;
}

test('real bus test route observes active adapter; cancelling one panel request leaves the other and polling alive', async t => {
    const { adapter, network, seen } = await fixture(t, { discoveryTimeoutMs: 1000 });
    const url = await server(t, adapter), sent = fakeSends(t);
    const post = signal => fetch(url + '/telegram/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"fixture_A"}', signal });
    const controller = new globalThis.AbortController();
    const cancelled = post(controller.signal); const caught = cancelled.catch(() => {});
    const second = post(); await until(() => adapter.chatWaiters.size === 2);
    controller.abort(); await caught; await until(() => adapter.chatWaiters.size === 1);
    assert.equal(network.calls.length, 1); assert.equal(network.calls[0].aborted, false);
    network.calls[0].finish({ ok: true, result: [update(1, '-777')] });
    const response = await second; assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, chatId: '-777' });
    assert.equal(sent.length, 1); assert.equal(sent[0].body.chat_id, '-777'); assert.equal(seen.length, 1);
    assert.equal(getSettingsDB().telegramChatId, '555'); // discovery does not save or grant admin
});

test('bus rejects unsaved token, malformed JSON and unsafe IDs without getUpdates or test sends', async t => {
    const { adapter, network } = await fixture(t); const url = await server(t, adapter), sent = fakeSends(t);
    for (const body of ['{"token":"draft_B"}', '{"token":', '{"token":"fixture_A","chatId":9007199254740992}']) {
        const response = await fetch(url + '/telegram/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        assert.equal(response.status, 400); assert.equal((await response.json()).success, false);
    }
    assert.equal(network.calls.length, 1); assert.equal(sent.length, 0);
    const manual = await fetch(url + '/telegram/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"draft_B","chatId":"-9007199254740993"}' });
    assert.equal(manual.status, 200); assert.equal(sent[0].body.chat_id, '-9007199254740993');
    assert.equal(network.calls.length, 1);
});
