process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { serveConversationsApp } = require('../panel/webApp');

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}

test('panel sirve el build de bandeja solo bajo /inbox, con fallback SPA y límites de ruta', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-panel-web-'));
    const root = path.join(temp, 'dist');
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'index.html'), '<main id="root">bandeja</main>');
    await fs.writeFile(path.join(root, 'assets', 'app.js'), 'globalThis.panelInbox = true;');
    await fs.writeFile(path.join(temp, 'outside.js'), 'secret outside build');
    await fs.symlink(path.join(temp, 'outside.js'), path.join(root, 'assets', 'link.js'));
    const server = http.createServer((req, res) => {
        const handled = serveConversationsApp(res, new URL(req.url || '/', 'http://panel.local').pathname,
            { enabled: true, rootDir: root });
        if (!handled) { res.writeHead(404); res.end(); }
    });
    t.after(async () => { await close(server); await fs.rm(temp, { recursive: true, force: true }); });
    const base = await listen(server);

    const entry = await fetch(base + '/inbox/');
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await entry.text(), /bandeja/);
    const nestedRoute = await fetch(base + '/inbox/conversation-123');
    assert.equal(nestedRoute.status, 200);
    assert.match(await nestedRoute.text(), /id="root"/);
    const asset = await fetch(base + '/inbox/assets/app.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await asset.text(), 'globalThis.panelInbox = true;');
    assert.equal((await fetch(base + '/inbox/assets/missing.js')).status, 404);
    const symlink = await fetch(base + '/inbox/assets/link.js');
    assert.equal(symlink.status, 403);
    assert.ok(!(await symlink.text()).includes('secret outside build'));
});

test('la ruta de bandeja respeta feature flag y falla clara si el build no existe', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-panel-web-disabled-'));
    const server = http.createServer((req, res) => {
        const enabled = req.url?.startsWith('/on') === true;
        const pathName = req.url?.replace(/^\/on/, '/inbox') || '/';
        const handled = serveConversationsApp(res, pathName, {
            enabled,
            rootDir: path.join(temp, 'missing')
        });
        if (!handled) { res.writeHead(404); res.end(); }
    });
    t.after(async () => { await close(server); await fs.rm(temp, { recursive: true, force: true }); });
    const base = await listen(server);
    assert.equal((await fetch(base + '/off')).status, 404);
    const unavailable = await fetch(base + '/on');
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /no está construida/);
});
