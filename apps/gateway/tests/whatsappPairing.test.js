process.env.SDK_BOT_TEST = '1';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-wa-pairing-'));
process.env.SDK_AUTH_DIR = authDir;
const WhatsappAdapter = require('../adapters/whatsappAdapter');
const { createWhatsappPairingCallbacks } = require('../services/whatsappPairing');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function pairingFixture(t, loadAuth) {
    const sockets = [];
    const pairingRequests = [];
    const adapter = new WhatsappAdapter({
        loadAuth,
        makeSocket: () => {
            const socket = {
                ws: { readyState: 1 },
                ev: new EventEmitter(),
                async requestPairingCode(number) {
                    pairingRequests.push(number);
                    return '12345678';
                },
                end() { this.ws.readyState = 3; }
            };
            sockets.push(socket);
            return socket;
        }
    });
    t.after(async () => adapter.disconnect());
    return { adapter, sockets, pairingRequests };
}

test('BUG-035: pairing code waits for auth/socket and propagates auth failures', async t => {
    const authGate = deferred();
    const authStarted = deferred();
    const f = pairingFixture(t, async () => {
        authStarted.resolve();
        await authGate.promise;
        return { state: { creds: { registered: false } }, saveCreds: async () => {} };
    });
    const callbacks = createWhatsappPairingCallbacks({ whatsapp: f.adapter, isQrWindowOpen: () => false });

    const request = callbacks.requestCode('56912345678');
    await authStarted.promise;
    assert.equal(f.sockets.length, 0);
    assert.equal(f.pairingRequests.length, 0);
    authGate.resolve();
    assert.equal(await request, '12345678');
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.pairingRequests, ['56912345678']);

    const failed = pairingFixture(t, async () => { throw new Error('fixture auth failure'); });
    const failedCallbacks = createWhatsappPairingCallbacks({ whatsapp: failed.adapter, isQrWindowOpen: () => false });
    await assert.rejects(failedCallbacks.requestCode('56912345678'), /fixture auth failure/);
    assert.equal(failed.sockets.length, 0);
    assert.equal(failed.pairingRequests.length, 0);
});

test('BUG-035: QR refresh awaits connect and leaves an active pairing socket alone', async t => {
    const authGate = deferred();
    const authStarted = deferred();
    const f = pairingFixture(t, async () => {
        authStarted.resolve();
        await authGate.promise;
        return { state: { creds: { registered: false } }, saveCreds: async () => {} };
    });
    let qrWindowOpen = false;
    const callbacks = createWhatsappPairingCallbacks({ whatsapp: f.adapter, isQrWindowOpen: () => qrWindowOpen });

    let refreshFinished = false;
    const refresh = callbacks.refreshQr().then(() => { refreshFinished = true; });
    await authStarted.promise;
    assert.equal(refreshFinished, false);
    assert.equal(f.sockets.length, 0);
    authGate.resolve();
    await refresh;
    assert.equal(refreshFinished, true);
    assert.equal(f.sockets.length, 1);

    const activeSocket = f.adapter.sock;
    qrWindowOpen = true;
    await callbacks.refreshQr();
    assert.equal(f.adapter.sock, activeSocket);
    assert.equal(f.sockets.length, 1);
});

test('pairing callbacks reject invalid dependencies', () => {
    assert.throws(() => createWhatsappPairingCallbacks({}), /INVALID_WHATSAPP_PAIRING_DEPENDENCIES/);
});

after(() => fs.rmSync(authDir, { recursive: true, force: true }));
