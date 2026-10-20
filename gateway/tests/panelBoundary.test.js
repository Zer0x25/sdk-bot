process.env.SDK_BOT_TEST = '1';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { Response } = globalThis;
const { assertValid } = require('@sdk-bot/contracts');
const { withTempDbPaths } = require('./helpers/tmpPaths');
const temporary = withTempDbPaths();
const { signContext, createVerifier, actorId, requireCapability } = require('../lib/panelContext');
const { resolveActor } = require('../panel/identity');
const { proxy, responseContract } = require('../panel/proxy');
const { readBytes, sendError } = require('../lib/httpBoundary');
const { startInternalBus } = require('../services/internalBus');
const { state, getGlobalPolicy } = require('../config');
after(() => temporary.restore());

const secret = 'test-only-service-secret-32-bytes-minimum';
const cookieSecret = 'test-only-cookie-secret-never-production';
const actor = { id: actorId('google:123'), displayName: 'Operador', capabilities: ['conversations:read'] };
const empty = Buffer.alloc(0);
const bootstrap = { snapshot: async () => ({ dataEpoch: '00000000-0000-4000-8000-000000000001', seq: '0' }) };
function signed(overrides = {}) {
    return signContext({ secret, actor, requestId: crypto.randomUUID(), method: 'GET', target: '/v1/session', body: empty, ...overrides });
}
function request(headers, overrides = {}) { return { headers, method: 'GET', url: '/v1/session', ...overrides }; }
function rejectsCode(fn, status) { assert.throws(fn, error => error.status === status); }

test('contexto verifica bytes, método y ruta exactos; firma alterada/ausente y expiración se rechazan', () => {
    const verify = createVerifier({ secret, now: () => 100000 });
    const headers = signed({ now: 99000 });
    assert.deepEqual(verify(request(headers), empty).actor, actor);
    rejectsCode(() => verify(request(headers), empty), 401);
    for (const altered of [
        request(signed({ now: 99000 }), { method: 'POST' }),
        request(signed({ now: 99000 }), { url: '/v1/session?scope=other' }),
        request(signed({ now: 99000, target: '/v1/other' })),
        request(signed({ now: 99000, body: Buffer.from('different') })),
        request(signed({ now: 70000 })), request(signed({ now: 106000 })),
        request({}), request({ ...headers, 'x-sdkbot-signature': 'A'.repeat(43) }),
        request({ ...headers, 'x-sdkbot-context': headers['x-sdkbot-context'] + 'A' })
    ]) rejectsCode(() => verify(altered, empty), 401);
    rejectsCode(() => createVerifier()(request(headers), empty), 503);
});

test('cache replay acotada falla cerrada y libera nonces vencidos; permisos no implícitos', () => {
    let now = 100000;
    const verify = createVerifier({ secret, now: () => now, maxNonces: 1 });
    verify(request(signed({ now })), empty);
    rejectsCode(() => verify(request(signed({ now })), empty), 503);
    now += 30001;
    verify(request(signed({ now })), empty);
    rejectsCode(() => requireCapability(actor, 'messages:send'), 403);
});

test('firma correcta no autoriza audiencia/issuer, actor, TTL o esquema de contexto inválidos', () => {
    const verify = createVerifier({ secret, now: () => 100000 });
    const good = signed({ now: 99000 });
    const template = JSON.parse(Buffer.from(good['x-sdkbot-context'], 'base64url').toString('utf8'));
    for (const delta of [
        { audience: 'brain' }, { issuer: 'browser' }, { expiresAt: 200000 },
        { actor: { ...actor, capabilities: ['admin'] } }, { requestId: 'client-id' }, { extra: 'value' }
    ]) {
        const encoded = Buffer.from(JSON.stringify({ ...template, ...delta })).toString('base64url');
        const signature = crypto.createHmac('sha256', secret).update(`sdkbot-panel-v1.${encoded}`).digest('base64url');
        rejectsCode(() => verify(request({ 'x-sdkbot-context': encoded, 'x-sdkbot-signature': signature }), empty), 401);
    }
    assert.deepEqual(verify(request(good), empty).actor, actor);
});

test('actor OAuth usa sub verificado y grants del servidor; dev explícito solo en development', () => {
    const session = { sub: '123', verified: true, name: 'Operador', capabilities: ['control:override'], id: crypto.randomUUID() };
    assert.deepEqual(resolveActor(session, { oauthEnabled: true, nodeEnv: 'production', devActor: 'true' }), actor);
    const configured = resolveActor(session, { oauthEnabled: true, nodeEnv: 'production', grants: '{"google:123":[]}' });
    assert.deepEqual(configured.capabilities, []);
    for (const sessionValue of [null, { email: 'old-session@example.invalid' }, { sub: '123', verified: false }]) {
        rejectsCode(() => resolveActor(sessionValue, { oauthEnabled: true, nodeEnv: 'production', devActor: 'true' }), 401);
    }
    rejectsCode(() => resolveActor(null, { oauthEnabled: false, nodeEnv: 'production', devActor: 'true' }), 401);
    rejectsCode(() => resolveActor(null, { oauthEnabled: false, nodeEnv: 'development' }), 401);
    assertValid('Actor', resolveActor(null, { oauthEnabled: false, nodeEnv: 'development', devActor: 'true' }));
    rejectsCode(() => resolveActor(session, { oauthEnabled: true, nodeEnv: 'production', grants: '{"google:123":["admin"]}' }), 503);
});

async function listen(server) {
    if (!server.listening) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
function environment(values) {
    const old = {};
    for (const [key, value] of Object.entries(values)) {
        old[key] = process.env[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return () => {
        for (const [key, value] of Object.entries(old)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
}
async function panelFixture(options = {}) {
    const restore = environment({
        NODE_ENV: 'production', PANEL_GOOGLE_CLIENT_ID: 'fake-google-client',
        PANEL_GOOGLE_CLIENT_SECRET: 'fake-google-secret', PANEL_SESSION_SECRET: cookieSecret,
        SDK_PANEL_GATEWAY_SECRET: secret, PANEL_REQUIRE_AUTH: undefined, PANEL_DEV_ACTOR: undefined,
        PANEL_ACTOR_GRANTS: undefined, PANEL_PUBLIC_URL: undefined, PANEL_ALLOWED_EMAILS: undefined,
        PANEL_CONVERSATIONS_UI_ENABLED: undefined,
        STATUS_TOKEN: 'fake-status-token', ...options
    });
    delete require.cache[require.resolve('../panel/index')];
    const panel = require('../panel/index');
    const url = await listen(panel.server);
    return { ...panel, url, close: async () => { await close(panel.server); restore(); } };
}
function cookie(data = {}) {
    const value = Buffer.from(JSON.stringify({ sub: '123', verified: true, name: 'Operador', exp: Date.now() + 60000, ...data })).toString('base64url');
    const signature = crypto.createHmac('sha256', cookieSecret).update(value).digest('base64url');
    return `sdkbot_session=${value}.${signature}`;
}
async function errorResponse(response, status) {
    assert.equal(response.status, status);
    const value = assertValid('ErrorResponse', await response.json());
    assert.ok(!JSON.stringify(value).includes(secret));
    return value;
}

test('bus real: v1 exige firma/permisos y mantiene rutas legacy cuando secreto está configurado', async () => {
    const restore = environment({ SDK_PANEL_GATEWAY_SECRET: secret });
    const bus = startInternalBus({ port: 0, archive: bootstrap });
    await new Promise(resolve => bus.once('listening', resolve));
    const url = await listen(bus);
    try {
        await errorResponse(await fetch(url + '/v1/session'), 401);
        await errorResponse(await fetch(url + '/status'), 401);
        await errorResponse(await fetch(url + '/v1/session', { headers: signed({ actor: { ...actor, capabilities: [] } }) }), 403);
        const res = await fetch(url + '/v1/session', { headers: signed() });
        assert.equal(res.status, 200);
        const value = assertValid('SessionResponse', await res.json());
        assert.deepEqual(value.actor, actor);
        assert.equal(value.snapshot.seq, '0');
        assert.deepEqual(value.policy, getGlobalPolicy());
        const deniedSend = signed({ method: 'POST', target: '/v1/conversations/test/messages', body: Buffer.from('{}') });
        await errorResponse(await fetch(url + '/v1/conversations/test/messages', { method: 'POST', headers: deniedSend, body: '{}' }), 403);
        const legacy = await fetch(url + '/status', { headers: signed({ target: '/status' }) });
        assert.equal(legacy.status, 200);
        assert.equal((await legacy.json()).status, 'ok');
        const command = Buffer.from('{"command":"/estado"}');
        const mutation = await fetch(url + '/command', { method: 'POST', body: command,
            headers: signed({ method: 'POST', target: '/command', body: command }) });
        assert.equal(mutation.status, 200);
        assert.equal((await mutation.json()).ok, true);
    } finally { await close(bus); restore(); }
});

test('sin secreto: v1 falla cerrada, status legacy conserva compatibilidad local', async () => {
    const restore = environment({ SDK_PANEL_GATEWAY_SECRET: undefined, NODE_ENV: 'development', INTERNAL_BUS_HOST: '127.0.0.1' });
    const bus = startInternalBus({ port: 0, archive: bootstrap });
    await new Promise(resolve => bus.once('listening', resolve));
    const url = await listen(bus);
    try {
        await errorResponse(await fetch(url + '/v1/session'), 503);
        assert.equal((await fetch(url + '/status')).status, 200);
    } finally { await close(bus); restore(); }
});

test('bus en producción o bind expuesto sin secreto nunca abre rutas legacy', async () => {
    for (const options of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development', INTERNAL_BUS_HOST: '0.0.0.0' }]) {
        const restore = environment({ SDK_PANEL_GATEWAY_SECRET: undefined, INTERNAL_BUS_HOST: '127.0.0.1', ...options });
        const bus = startInternalBus({ port: 0, archive: bootstrap });
        await new Promise(resolve => bus.once('listening', resolve));
        try { await errorResponse(await fetch(await listen(bus) + '/status'), 503); }
        finally { await close(bus); restore(); }
    }
});

test('panel y bus reales: sesión sin tokens, headers falsificados no sustituyen actor ni elevan permisos', async () => {
    const restore = environment({ SDK_PANEL_GATEWAY_SECRET: secret });
    const bus = startInternalBus({ port: 0, archive: bootstrap });
    await new Promise(resolve => bus.once('listening', resolve));
    const panel = await panelFixture({ GATEWAY_INTERNAL_URL: await listen(bus) });
    try {
        await errorResponse(await fetch(panel.url + '/api/v1/session', { headers: { 'x-status-token': 'fake-status-token', 'x-actor-id': actor.id } }), 401);
        await errorResponse(await fetch(panel.url + '/api/v1/session', { headers: { cookie: 'sdkbot_session=%ZZ' } }), 401);
        for (const invalidCookie of [cookie({ exp: Date.now() - 1 }), cookie({ sub: undefined, verified: undefined }), `prefix_${cookie()}`, cookie() + 'tampered']) {
            await errorResponse(await fetch(panel.url + '/api/v1/session', { headers: { cookie: invalidCookie } }), 401);
        }
        const response = await fetch(panel.url + '/api/v1/session', { headers: {
            cookie: cookie({ capabilities: ['messages:send', 'control:override'] }),
            'x-sdkbot-context': 'forged', 'x-sdkbot-signature': 'forged', 'x-request-id': actor.id,
            authorization: 'Bearer fake-browser-credential'
        } });
        assert.equal(response.status, 200);
        const data = assertValid('SessionResponse', await response.json());
        assert.deepEqual(data.actor, actor);
        assert.notEqual(response.headers.get('x-request-id'), actor.id);
        assert.ok(!JSON.stringify(data).includes('verified'));
        await errorResponse(await fetch(panel.url + '/api/v1/conversations/test/messages', { method: 'POST', body: '{}', headers: { cookie: cookie(), origin: panel.url } }), 403);
        await errorResponse(await fetch(panel.url + '/api/v1/conversations/test/takeover', { method: 'POST', body: '{}', headers: {
            cookie: cookie(), origin: 'https://external.invalid', 'x-status-token': 'fake-status-token'
        } }), 403);
        const legacy = await fetch(panel.url + '/api/status', { headers: { cookie: cookie({ sub: undefined, verified: undefined }) } });
        assert.equal(legacy.status, 200);
        assert.equal((await legacy.json()).status, 'ok');
    } finally { await panel.close(); await close(bus); restore(); }
});

test('panel: dev requiere opt-in y producción sin OAuth nunca recibe actor v1', async () => {
    for (const options of [
        { NODE_ENV: 'development' },
        { PANEL_GOOGLE_CLIENT_ID: '', PANEL_GOOGLE_CLIENT_SECRET: '', PANEL_DEV_ACTOR: 'true' },
        { NODE_ENV: 'development', PANEL_REQUIRE_AUTH: 'true', PANEL_GOOGLE_CLIENT_ID: '', PANEL_GOOGLE_CLIENT_SECRET: '', PANEL_DEV_ACTOR: 'true' }
    ]) {
        const panel = await panelFixture(options);
        try {
            await errorResponse(await fetch(panel.url + '/api/v1/session'), 401);
            if (options.PANEL_GOOGLE_CLIENT_ID === '') {
                await errorResponse(await fetch(panel.url + '/api/status'), 503);
                await errorResponse(await fetch(panel.url + '/'), 503);
            }
        }
        finally { await panel.close(); }
    }
    const upstream = http.createServer((req, res) => {
        const context = createVerifier({ secret })(req, empty);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ actor: context.actor, policy: { globalMode: 'ignored_all', globalPaused: false, policyVersion: '1' },
            snapshot: { dataEpoch: crypto.randomUUID(), seq: '0' } }));
    });
    const upstreamUrl = await listen(upstream);
    const panel = await panelFixture({ NODE_ENV: 'development', PANEL_DEV_ACTOR: 'true', GATEWAY_INTERNAL_URL: upstreamUrl });
    try {
        const response = await fetch(panel.url + '/api/v1/session');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).actor.id, actorId('dev:local'));
    } finally { await panel.close(); await close(upstream); }
});

test('la nueva bandeja sigue oculta por defecto y el panel anterior conserva su ruta raíz', async () => {
    const panel = await panelFixture({ NODE_ENV: 'development', PANEL_GOOGLE_CLIENT_ID: '', PANEL_GOOGLE_CLIENT_SECRET: '' });
    try {
        const inbox = await fetch(panel.url + '/inbox');
        assert.equal(inbox.status, 404);
        const legacy = await fetch(panel.url + '/');
        assert.equal(legacy.status, 200);
        assert.match(await legacy.text(), /SDK-Bot · Panel/);
    } finally { await panel.close(); }
});

test('habilitar la nueva bandeja no omite la sesión OAuth del panel', async () => {
    const panel = await panelFixture({ PANEL_CONVERSATIONS_UI_ENABLED: 'true' });
    try {
        const response = await fetch(panel.url + '/inbox', { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), '/');
    } finally { await panel.close(); }
});

test('OAuth conserva state server-side de un uso y cookie Lax/Secure; rechaza correo no verificado', async () => {
    const panel = await panelFixture({ PANEL_PUBLIC_URL: 'https://panel.example.invalid' });
    const originalFetch = globalThis.fetch;
    let verified = false;
    let calls = 0;
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/')) {
            calls += 1; assert.ok(options.signal);
            return Response.json({ access_token: 'fake-access-token' });
        }
        if (String(url).startsWith('https://www.googleapis.com/')) {
            calls += 1; assert.ok(options.signal);
            return Response.json({ id: '123', verified_email: verified, email: 'test@example.invalid', name: 'Operador' });
        }
        return originalFetch(url, options);
    };
    try {
        for (const isVerified of [false, true]) {
            verified = isVerified;
            const login = await fetch(panel.url + '/auth/google', { redirect: 'manual' });
            assert.equal(login.status, 302);
            assert.equal(login.headers.get('set-cookie'), null);
            const authUrl = new URL(login.headers.get('location'));
            assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://panel.example.invalid/auth/callback');
            const callbackUrl = panel.url + '/auth/callback?code=fake&state=' + authUrl.searchParams.get('state');
            const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
            assert.equal(callback.status, verified ? 302 : 401);
            if (verified) {
                const setCookie = callback.headers.get('set-cookie');
                assert.match(setCookie, /; HttpOnly; SameSite=Lax; Path=\/; Secure; Expires=/);
                const parsed = panel.parseSession({ headers: { cookie: setCookie.split(';')[0] } });
                assert.equal(parsed.sub, '123'); assert.equal(parsed.verified, true);
                assert.ok(!setCookie.includes('fake-access-token'));
            }
            const before = calls;
            assert.equal((await fetch(callbackUrl, { redirect: 'manual' })).status, 400);
            assert.equal(calls, before);
        }
        const logout = await fetch(panel.url + '/auth/logout', { redirect: 'manual' });
        assert.match(logout.headers.get('set-cookie'), /; Secure; Max-Age=0/);
        assert.equal(panel.isWriteAuthorized({ headers: { referer: 'not a URL' } }), false);
    } finally { globalThis.fetch = originalFetch; await panel.close(); }
});

test('política bootstrap cambia versión en cada transición efectiva incluso ida/vuelta, sin perder modo legacy', () => {
    const original = { paused: state.IS_BOT_PAUSED, mode: state.GLOBAL_MODE };
    const first = BigInt(getGlobalPolicy().policyVersion);
    state.IS_BOT_PAUSED = !original.paused;
    state.IS_BOT_PAUSED = original.paused;
    assert.equal(BigInt(getGlobalPolicy().policyVersion), first + 2n);
    state.IS_BOT_PAUSED = original.paused;
    assert.equal(BigInt(getGlobalPolicy().policyVersion), first + 2n);
    state.GLOBAL_MODE = original.mode === 'ignored_all' ? 'allowed_all' : 'ignored_all';
    state.GLOBAL_MODE = original.mode;
    assert.equal(BigInt(getGlobalPolicy().policyVersion), first + 4n);
    const profile = state.CURRENT_PROFILE;
    state.CURRENT_PROFILE = profile + '-temporary';
    state.CURRENT_PROFILE = profile;
    assert.equal(BigInt(getGlobalPolicy().policyVersion), first + 6n);
});

test('proxy reconstruye headers y firma bytes; timeouts, respuesta inválida y mutación sin retry', async () => {
    let attempts = 0;
    let seen;
    const upstream = http.createServer((req, res) => {
        attempts += 1;
        seen = req.headers;
        req.resume();
        req.on('end', () => {
            if (req.url === '/v1/invalid') { res.end('{"secret":"should-not-leak"}'); }
            if (req.url === '/v1/conversations') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ items: [], nextCursor: null, snapshot: { dataEpoch: crypto.randomUUID(), seq: '0' } }));
            }
            // Los demás no responden; la llamada debe terminar sin repetir POST.
        });
    });
    const upstreamUrl = await listen(upstream);
    const front = http.createServer((req, res) => proxy(req, res, req.url, {
        internal: upstreamUrl, secret, actor, requestId: crypto.randomUUID(), v1: true, timeoutMs: 80
    }));
    const frontUrl = await listen(front);
    try {
        const response = await fetch(frontUrl + '/v1/hang', { method: 'POST', body: 'á', headers: {
            cookie: 'private-cookie', authorization: 'private-token', 'x-status-token': 'private-status',
            'x-sdkbot-context': 'forged', 'x-sdkbot-signature': 'forged', 'x-actor-id': 'forged'
        } });
        await errorResponse(response, 503);
        assert.equal(attempts, 1);
        for (const name of ['cookie', 'authorization', 'x-status-token', 'x-actor-id']) assert.equal(seen[name], undefined);
        assert.equal(seen['content-length'], '2');
        assert.notEqual(seen['x-sdkbot-context'], 'forged');
        const page = await fetch(frontUrl + '/v1/conversations');
        assert.equal(page.status, 200);
        assertValid('ConversationsResponse', await page.json());
        const invalid = await errorResponse(await fetch(frontUrl + '/v1/invalid'), 503);
        assert.ok(!JSON.stringify(invalid).includes('should-not-leak'));
    } finally { await close(front); await close(upstream); }
});

test('proxy valida cada respuesta v1 con su contrato y no deja pasar rutas sin esquema', () => {
    assert.equal(responseContract('GET', '/v1/accounts', 200), 'AccountsResponse');
    assert.equal(responseContract('GET', '/v1/conversations/00000000-0000-4000-8000-000000000001', 200), 'ConversationResponse');
    assert.equal(responseContract('GET', '/v1/conversations/00000000-0000-4000-8000-000000000001/messages', 200), 'MessagesResponse');
    assert.equal(responseContract('POST', '/v1/conversations/00000000-0000-4000-8000-000000000001/read', 200), 'ReadResponse');
    assert.equal(responseContract('GET', '/v1/unknown', 200), null);
});

test('proxy SSE transmite y cierra upstream al desconectar, sin actividad y al vencer sesión', async () => {
    let closed = 0;
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: initial\n\n');
        req.on('close', () => { closed += 1; });
    });
    const upstreamUrl = await listen(upstream);
    const front = http.createServer((req, res) => proxy(req, res, '/qr', {
        internal: upstreamUrl, secret: '', actor, requestId: crypto.randomUUID(),
        timeoutMs: 500, idleMs: 60, streamMaxMs: req.url === '/expiry' ? 30 : 500
    }));
    const frontUrl = await listen(front);
    try {
        for (const route of ['/disconnect', '/idle', '/expiry']) {
            const res = await fetch(frontUrl + route);
            const reader = res.body.getReader();
            assert.match(new TextDecoder().decode((await reader.read()).value), /initial/);
            if (route === '/disconnect') await reader.cancel();
            else await assert.rejects(reader.read());
        }
        // Esperar un evento del socket, no un sleep ni un proceso vivo indefinido.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, 3);
    } finally { await close(front); await close(upstream); }
});

test('proxy v1 conserva Last-Event-ID y cierra el stream de eventos al desconectar el navegador', async () => {
    let seenCursor;
    let seenContext;
    let resolveUpstreamClosed;
    const upstreamClosed = new Promise(resolve => { resolveUpstreamClosed = resolve; });
    const upstream = http.createServer((req, res) => {
        seenCursor = req.headers['last-event-id'];
        seenContext = req.headers['x-sdkbot-context'];
        res.on('close', resolveUpstreamClosed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write('retry: 3000\n\ndata: connected\n\n');
    });
    const upstreamUrl = await listen(upstream);
    const front = http.createServer((req, res) => proxy(req, res, req.url, {
        internal: upstreamUrl, secret, actor, requestId: crypto.randomUUID(), v1: true,
        sessionExpiresAt: Date.now() + 5000, timeoutMs: 500
    }));
    const frontUrl = await listen(front);
    try {
        const response = await fetch(frontUrl + '/v1/events', { headers: { 'last-event-id': '00000000-0000-4000-8000-000000000001:12' } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/event-stream/);
        const reader = response.body.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /data: connected/);
        assert.equal(seenCursor, '00000000-0000-4000-8000-000000000001:12');
        assert.equal(typeof seenContext, 'string');
        await reader.cancel();
        await upstreamClosed;
    } finally { await close(front); await close(upstream); }
});

test('una URL absoluta del cliente nunca cambia el upstream configurado', async () => {
    let outsideHits = 0;
    const outside = http.createServer((_req, res) => { outsideHits += 1; res.end('outside'); });
    const outsideUrl = await listen(outside);
    const internal = http.createServer((_req, res) => { res.end('{"status":"internal"}'); });
    const panel = await panelFixture({ GATEWAY_INTERNAL_URL: await listen(internal), SDK_PANEL_GATEWAY_SECRET: '' });
    try {
        const result = await new Promise((resolve, reject) => {
            const req = http.request(panel.url, { path: outsideUrl + '/api/status', headers: { cookie: cookie() } }, res => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => resolve(body));
            });
            req.on('error', reject); req.end();
        });
        assert.equal(result, '{"status":"internal"}');
        assert.equal(outsideHits, 0);
    } finally { await panel.close(); await close(internal); await close(outside); }
});

test('recepción HTTP limita bytes, corta uploads detenidos y limpia una desconexión prematura', async () => {
    let abortedHandled;
    const handled = new Promise(resolve => { abortedHandled = resolve; });
    const server = http.createServer(async (req, res) => {
        try {
            await readBytes(req, { maxBytes: 1024, timeoutMs: 60 });
            res.end('ok');
        } catch (error) {
            sendError(res, error);
            if (req.url === '/abort') abortedHandled();
        }
    });
    const url = await listen(server);
    try {
        await errorResponse(await fetch(url, { method: 'POST', body: Buffer.alloc(1025) }), 422);
        await new Promise((resolve, reject) => {
            const req = http.request(url + '/slow', { method: 'POST', headers: { 'content-length': '100' } }, res => {
                assert.equal(res.statusCode, 503);
                res.resume(); res.on('end', () => { req.destroy(); resolve(); });
            });
            req.on('error', reject); req.write('partial');
        });
        const incoming = new Promise(resolve => server.once('request', resolve));
        const aborted = http.request(url + '/abort', { method: 'POST', headers: { 'content-length': '100' } });
        aborted.on('error', () => {});
        aborted.write('partial');
        await incoming;
        aborted.destroy();
        await handled;
        assert.equal(await (await fetch(url)).text(), 'ok');
    } finally { await close(server); }
});
