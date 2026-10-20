process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const buildDir = path.join(__dirname, '../panel/web/dist');

async function close(server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}

test('panel sirve el build Vite bajo /inbox cuando se habilita el feature flag', async t => {
    if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
        t.skip('Ejecutar npm run panel:build para validar el artefacto servido.');
        return;
    }
    const names = ['NODE_ENV', 'PANEL_GOOGLE_CLIENT_ID', 'PANEL_GOOGLE_CLIENT_SECRET', 'PANEL_CONVERSATIONS_UI_ENABLED'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.NODE_ENV = 'development';
    process.env.PANEL_GOOGLE_CLIENT_ID = '';
    process.env.PANEL_GOOGLE_CLIENT_SECRET = '';
    process.env.PANEL_CONVERSATIONS_UI_ENABLED = 'true';
    delete require.cache[require.resolve('../panel/index')];
    const { server } = require('../panel/index');
    t.after(async () => {
        await close(server);
        delete require.cache[require.resolve('../panel/index')];
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const entry = await fetch(base + '/inbox/');
    assert.equal(entry.status, 200);
    const html = await entry.text();
    assert.match(html, /SDK-Bot · Bandeja/);
    const assetPaths = [...html.matchAll(/(?:src|href)="([^" ]+\/assets\/[^" ]+)"/g)].map(match => match[1]);
    assert.ok(assetPaths.length > 0, 'Vite HTML must reference built assets');
    for (const assetPath of assetPaths) {
        const asset = await fetch(base + assetPath);
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('content-type') || '', /(?:javascript|css)/);
    }
    const nested = await fetch(base + '/inbox/conversations/example-id');
    assert.equal(nested.status, 200);
    assert.match(await nested.text(), /SDK-Bot · Bandeja/);
});
