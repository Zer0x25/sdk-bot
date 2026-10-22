process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const { isWriteAuthorized } = require('../panel/index');

test('isWriteAuthorized rechaza peticiones con sec-fetch-site cross-site', () => {
    const req = /** @type {any} */ ({
        headers: {
            'sec-fetch-site': 'cross-site',
            host: 'localhost:5201'
        }
    });
    assert.strictEqual(isWriteAuthorized(req), false);
});

test('isWriteAuthorized rechaza orígenes extraños no coincidentes con el Host', () => {
    const req = /** @type {any} */ ({
        headers: {
            origin: 'http://malicious-site.com',
            host: 'localhost:5201'
        }
    });
    assert.strictEqual(isWriteAuthorized(req), false);
});

test('isWriteAuthorized acepta peticiones del mismo origen (Host)', () => {
    const req = /** @type {any} */ ({
        headers: {
            origin: 'http://localhost:5201',
            host: 'localhost:5201'
        }
    });
    assert.strictEqual(isWriteAuthorized(req), true);
});

test('isWriteAuthorized acepta peticiones sin origin explícito si no son cross-site (ej. herramientas curl/locales)', () => {
    const req = /** @type {any} */ ({
        headers: {
            host: 'localhost:5201'
        }
    });
    assert.strictEqual(isWriteAuthorized(req), true);
});
