process.env.SDK_BOT_TEST = '1';
const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const tmp = withTempDbPaths();
after(() => tmp.restore());

const { getContactsDB, saveContactsDB } = require('../services/db');
const { upsertContactMetadata } = require('../services/contactsRepository');
const { setControlService, setNumberState, setContactProfile } = require('../services/stateService');
const { handleAdminCommand } = require('../handlers/commandHandler');
const contactCommands = require('../handlers/commands/contacts');
const chatControlCommands = require('../handlers/commands/chatControl');

beforeEach(() => {
    setControlService(null);
    const contacts = getContactsDB();
    for (const key of Object.keys(contacts)) delete contacts[key];
    saveContactsDB({ ...contacts });
});

test('BUG-008: a shared suffix is rejected and never changes either WhatsApp contact', async () => {
    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'A' });
    upsertContactMetadata({ phoneNumber: '56812345678', pushName: 'B' });

    const result = await setNumberState('12345678', 'ignored', { channel: 'whatsapp', accountId: 'wa-account' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'IDENTITY_AMBIGUOUS');
    assert.equal(Object.keys(getContactsDB()).length, 2);
    assert.equal(getContactsDB()['56912345678'].estado, 'neutro');
    assert.equal(getContactsDB()['56812345678'].estado, 'neutro');
});

test('BUG-008: exact numeric identity collisions fail closed instead of choosing one cache row', async () => {
    const contacts = getContactsDB();
    contacts.phone = { phone: '56912345678', estado: 'neutro' };
    contacts.lid = { lid: '56912345678', estado: 'neutro' };
    saveContactsDB({ ...contacts });

    const result = await setNumberState('56912345678', 'ignored', { channel: 'whatsapp' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'IDENTITY_AMBIGUOUS');
    assert.equal(getContactsDB().phone.estado, 'neutro');
    assert.equal(getContactsDB().lid.estado, 'neutro');
});

test('BUG-008: legacy authority refuses Telegram identities instead of matching WhatsApp digits', async () => {
    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'WA only' });

    const state = await setNumberState('56912345678', 'ignored', { channel: 'telegram', accountId: 'tg-account' });
    const profile = await setContactProfile('56912345678', 'default', { channel: 'telegram', accountId: 'tg-account' });
    assert.equal(state.success, false);
    assert.equal(state.code, 'LEGACY_CHANNEL_UNSUPPORTED');
    assert.equal(profile.success, false);
    assert.equal(profile.code, 'LEGACY_CHANNEL_UNSUPPORTED');
    assert.equal(getContactsDB()['56912345678'].estado, 'neutro');
    assert.equal(getContactsDB()['56912345678'].perfil, undefined);
});

test('BUG-008: a complete target still updates its exact WhatsApp row', async () => {
    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'A' });
    upsertContactMetadata({ phoneNumber: '56812345678', pushName: 'B' });

    const result = await setNumberState('56912345678', 'allowed', { channel: 'whatsapp' });
    assert.equal(result.success, true);
    assert.equal(getContactsDB()['56912345678'].estado, 'permitido');
    assert.equal(getContactsDB()['56812345678'].estado, 'neutro');
});

test('BUG-008: Telegram admin command replies on Telegram but resolves its target through WhatsApp', async () => {
    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'WA contact' });
    const replies = [];
    const telegramAdapter = { channelName: 'telegram', async sendMessage(remote, text) {
        replies.push({ remote, text });
        return { key: { id: `reply-${replies.length}` } };
    } };
    const whatsappTargetAdapter = { channelName: 'whatsapp', accountId: 'wa-account' };

    await handleAdminCommand('/permitir 56912345678', 'telegram:-900', telegramAdapter, {}, null, whatsappTargetAdapter);

    assert.equal(getContactsDB()['56912345678'].estado, 'permitido');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].remote, 'telegram:-900');
});

test('BUG-008: /nombre and /limpiar reject partial suffixes before mutating or clearing context', async () => {
    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'A' });
    upsertContactMetadata({ phoneNumber: '56812345678', pushName: 'B' });
    const runNombre = contactCommands.find(def => def.aliases.includes('/nombre')).run;
    const runLimpiar = chatControlCommands.find(def => def.aliases.includes('/limpiar')).run;

    const named = runNombre({ queryParam: '12345678 NuevoNombre' });
    const cleared = await runLimpiar({ queryParam: '12345678', targetAdapter: { channelName: 'whatsapp' } });

    assert.match(named, /número o LID completo/);
    assert.match(cleared, /número o LID completo/);
    assert.equal(Object.keys(getContactsDB()).length, 2);
    assert.equal(getContactsDB()['56912345678'].savedName, null);
    assert.equal(getContactsDB()['56812345678'].savedName, null);
});
