const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('panel setup can save token without chat ID, reload partial setup, discover then explicitly save the ID', async () => {
    const ids = ['tgToken','tgChatId','tgMsg','tgStatus','tgTestBtn','tgSaveBtn','tgResetBtn'];
    const elements = Object.fromEntries(ids.map(id => [id, { value: '', style: {}, textContent: '', events: {}, addEventListener(name, fn) { this.events[name] = fn; } }]));
    let stored = { token: '', chatId: '' }; const tests = [], saves = [];
    const context = vm.createContext({
        $: id => elements[id.slice(1)], maskToken: token => 'masked:' + token,
        getTelegramSettings: async () => stored, getStatus: async () => ({ channels: { telegram: { connection: 'open' } } }),
        testTelegramToken: async (token, chatId, idempotencyKey) => { tests.push({ token, chatId, idempotencyKey }); return { success: true, chatId: '-777' }; },
        saveTelegramSettings: async (token, chatId) => { stored = { token, chatId }; saves.push(stored); return { success: true }; },
        setTimeout: () => 0, confirm: () => true,
        crypto: { randomUUID: () => `fixture-key-${tests.length + 1}` }, console
    });
    const source = fs.readFileSync(path.join(__dirname, '../../panel/public/js/tabs/telegram.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context); context.initTelegramTab();
    await context.loadTgSettings();
    elements.tgToken.value = 'fixture_A'; await elements.tgSaveBtn.events.click();
    assert.equal(stored.chatId, ''); assert.equal(elements.tgChatId.readOnly, false);
    assert.equal(elements.tgTestBtn.style.display, 'block'); assert.equal(elements.tgResetBtn.style.display, 'block');
    await context.loadTgSettings(); assert.equal(elements.tgToken.value, 'fixture_A');
    await elements.tgTestBtn.events.click(); assert.equal(elements.tgChatId.value, '-777');
    assert.equal(stored.chatId, ''); // discover does not silently grant admin
    assert.match(tests[0].idempotencyKey, /^fixture-key-/);
    await elements.tgSaveBtn.events.click(); assert.equal(stored.chatId, '-777');
    assert.equal(elements.tgChatId.readOnly, true); assert.equal(elements.tgToken.value, 'masked:fixture_A');
    assert.equal(tests[0].token, 'fixture_A'); assert.equal(tests[0].chatId, '');
    await elements.tgResetBtn.events.click(); assert.equal(elements.tgToken.value, ''); assert.equal(elements.tgChatId.value, '');
    assert.equal(stored.token, ''); assert.equal(saves.length, 3);
});

test('panel requires explicit confirmation before retrying a Telegram test with unknown delivery', async () => {
    const ids = ['tgToken','tgChatId','tgMsg','tgStatus','tgTestBtn','tgSaveBtn','tgResetBtn'];
    const elements = Object.fromEntries(ids.map(id => [id, { value: '', style: {}, textContent: '', events: {}, addEventListener(name, fn) { this.events[name] = fn; } }]));
    const values = new Map(), requests = [], confirmations = [];
    let keyNumber = 0, answer = false;
    const context = vm.createContext({
        $: id => elements[id.slice(1)], maskToken: value => value,
        getTelegramSettings: async () => ({}), getStatus: async () => ({}),
        testTelegramToken: async (token, chatId, idempotencyKey) => {
            requests.push({ token, chatId, idempotencyKey });
            return requests.length === 1 ? { success: false, delivery: 'unknown', chatId: '-777' }
                : { success: true, delivery: 'accepted', chatId: '-777' };
        },
        saveTelegramSettings: async () => ({}), setTimeout: () => 0,
        confirm: message => { confirmations.push(message); return answer; },
        crypto: { randomUUID: () => `fixture-key-${++keyNumber}` },
        localStorage: {
            getItem: key => values.get(key) || null,
            setItem: (key, value) => values.set(key, value),
            removeItem: key => values.delete(key)
        }, console
    });
    const source = fs.readFileSync(path.join(__dirname, '../../panel/public/js/tabs/telegram.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context); context.initTelegramTab();
    elements.tgToken.value = 'fixture_A';

    await elements.tgTestBtn.events.click();
    assert.equal(requests.length, 1); assert.equal(requests[0].idempotencyKey, 'fixture-key-1');
    assert.match(elements.tgMsg.textContent, /pudo haber recibido/i);
    assert.equal(elements.tgChatId.value, '-777');

    elements.tgChatId.value = ''; // Simulate reload before the discovered ID was saved.
    await elements.tgTestBtn.events.click();
    assert.equal(requests.length, 1, 'declining confirmation does not send');
    assert.equal(confirmations.length, 1);

    answer = true;
    await elements.tgTestBtn.events.click();
    assert.equal(requests.length, 2); assert.equal(requests[1].idempotencyKey, 'fixture-key-2');
    assert.equal(confirmations.length, 2); assert.match(confirmations[1], /revisa el chat/i);
    assert.match(elements.tgMsg.textContent, /Mensaje de prueba enviado/i);
    assert.equal(values.size, 0, 'a settled result clears the pending confirmation');
});

test('panel reports a stopped Telegram capture instead of a generic disconnected state', async () => {
    const elements = Object.fromEntries(['tgToken','tgChatId','tgMsg','tgStatus','tgTestBtn','tgSaveBtn','tgResetBtn']
        .map(id => [id, { value: '', style: {}, textContent: '', addEventListener() {} }]));
    const context = vm.createContext({
        $: id => elements[id.slice(1)], maskToken: value => value,
        getStatus: async () => ({ channels: { telegram: { connection: 'standby', lastDisconnectReason: 'error_captura' } } }),
        getTelegramSettings: async () => ({}), testTelegramToken: async () => ({}), saveTelegramSettings: async () => ({}), console
    });
    const source = fs.readFileSync(path.join(__dirname, '../../panel/public/js/tabs/telegram.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
    await context.refreshTgStatus();
    assert.match(elements.tgStatus.textContent, /captura se detuvo/i);
    assert.equal(elements.tgStatus.className, 'bad');
});
