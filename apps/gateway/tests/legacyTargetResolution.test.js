process.env.SDK_BOT_TEST = '1';
const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const tmp = withTempDbPaths();
after(() => tmp.restore());

const { getContactsDB, saveContactsDB } = require('../services/db');
const { upsertContactMetadata } = require('../services/contactsRepository');
const { setControlService, setNumberState, setContactProfile } = require('../services/stateService');
const { state } = require('../config');
const { decideMessageFlow } = require('../services/pipeline');
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

test('BUG-011: /humano and /ia preserve an allowed contact under ignored_all', async t => {
    const previousMode = state.GLOBAL_MODE;
    const previousPaused = state.IS_BOT_PAUSED;
    t.after(() => { state.GLOBAL_MODE = previousMode; state.IS_BOT_PAUSED = previousPaused; });
    state.GLOBAL_MODE = 'ignored_all';
    state.IS_BOT_PAUSED = false;

    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'Allowed' });
    await setNumberState('56912345678', 'allowed', { channel: 'whatsapp' });
    const runHumano = chatControlCommands.find(definition => definition.aliases.includes('/humano')).run;
    const runIa = chatControlCommands.find(definition => definition.aliases.includes('/ia')).run;
    const targetAdapter = { channelName: 'whatsapp' };

    const humanMessage = await runHumano({ queryParam: '56912345678', targetAdapter });
    assert.match(humanMessage, /Atención Humana activada/);
    assert.equal(getContactsDB()['56912345678'].estado, 'handoff');
    assert.equal(getContactsDB()['56912345678'].handoffPreviousState, 'permitido');

    const aiMessage = await runIa({ queryParam: '56912345678', targetAdapter });
    assert.match(aiMessage, /volverá a responder/);
    assert.equal(getContactsDB()['56912345678'].estado, 'permitido');
    assert.equal(getContactsDB()['56912345678'].handoffPreviousState, undefined);
    assert.equal(decideMessageFlow({ textMessage: 'hola', metadata: {}, contactRecord: getContactsDB()['56912345678'],
        isSelf: false, isFromMe: false }).type, 'respond');
});

test('BUG-011: /humano and /ia report access and global policies that still block replies', async t => {
    const previousMode = state.GLOBAL_MODE;
    const previousPaused = state.IS_BOT_PAUSED;
    t.after(() => { state.GLOBAL_MODE = previousMode; state.IS_BOT_PAUSED = previousPaused; });
    state.GLOBAL_MODE = 'ignored_all';
    state.IS_BOT_PAUSED = false;

    upsertContactMetadata({ phoneNumber: '56912345678', pushName: 'Ignored' });
    upsertContactMetadata({ phoneNumber: '56812345678', pushName: 'Neutral' });
    await setNumberState('56912345678', 'ignored', { channel: 'whatsapp' });
    const runHumano = chatControlCommands.find(definition => definition.aliases.includes('/humano')).run;
    const runIa = chatControlCommands.find(definition => definition.aliases.includes('/ia')).run;
    const targetAdapter = { channelName: 'whatsapp' };

    const ignoredHumanMessage = await runHumano({ queryParam: '56912345678', targetAdapter });
    assert.match(ignoredHumanMessage, /sigue ignorado/);
    assert.match(ignoredHumanMessage, /\/permitir 56912345678/);
    const ignoredAiMessage = await runIa({ queryParam: '56912345678', targetAdapter });
    assert.match(ignoredAiMessage, /sigue ignorado/);
    assert.match(ignoredAiMessage, /\/permitir 56912345678/);
    assert.equal(getContactsDB()['56912345678'].estado, 'ignorado');

    const neutralHumanMessage = await runHumano({ queryParam: '56812345678', targetAdapter });
    assert.match(neutralHumanMessage, /Atención Humana activada/);
    const neutralAiMessage = await runIa({ queryParam: '56812345678', targetAdapter });
    assert.match(neutralAiMessage, /modo global estricto/);
    assert.match(neutralAiMessage, /\/permitir 56812345678/);
    assert.equal(getContactsDB()['56812345678'].estado, 'neutro');
});
