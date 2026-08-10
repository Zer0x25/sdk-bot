const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const tmp = withTempDbPaths();
after(() => tmp.restore());

const { getContactsDB, getSettingsDB } = require('../services/db');
const { cleanContactsDB, upsertContactMetadata, bulkUpsertContactsMetadata, findExistingKey, findKeyByDigits, isJunkJid } = require('../services/contactsRepository');

beforeEach(() => {
    // Reset de la caché en memoria antes de cada test (misma DB vacía)
    const db = getContactsDB();
    Object.keys(db).forEach(k => delete db[k]);
});

test('isJunkJid: grupos, broadcast, canales y status', () => {
    assert.strictEqual(isJunkJid('123@g.us'), true);
    assert.strictEqual(isJunkJid('123@newsletter'), true);
    assert.strictEqual(isJunkJid('123@broadcast'), true);
    assert.strictEqual(isJunkJid('status@broadcast'), true);
    assert.strictEqual(isJunkJid('0@1'), true);
    assert.strictEqual(isJunkJid(null), true);
    assert.strictEqual(isJunkJid(''), true);
    assert.strictEqual(isJunkJid('56942523669@s.whatsapp.net'), false);
    assert.strictEqual(isJunkJid('272048244940855@lid'), false);
});

test('upsertContactMetadata: crea registro con estado neutro y contadores', () => {
    const rec = upsertContactMetadata({ phoneNumber: '56911112222', pushName: 'Juan' });
    assert.strictEqual(rec.estado, 'neutro');
    assert.strictEqual(rec.totalMessages, 1);
    assert.strictEqual(rec.firstSeen, rec.lastSeen);
    assert.strictEqual(rec.pushName, 'Juan');
});

test('upsertContactMetadata: dedupe phone/lid hacia el mismo registro', () => {
    const r1 = upsertContactMetadata({ phoneNumber: '56911112222', lid: '272048244940855', pushName: 'Juan' });
    const r2 = upsertContactMetadata({ lid: '272048244940855', pushName: 'Juan' });
    const db = getContactsDB();
    assert.strictEqual(r1, r2);
    // Un solo registro que vincula ambos IDs
    const keys = Object.keys(db);
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(db[keys[0]].phone, '56911112222');
    assert.strictEqual(db[keys[0]].lid, '272048244940855');
});

test('upsertContactMetadata: rechaza junk, sin identidad o sin IDs', () => {
    assert.strictEqual(upsertContactMetadata({ phoneNumber: '123@g.us' }), null);
    assert.strictEqual(upsertContactMetadata({ phoneNumber: null, lid: null }), null);
    assert.strictEqual(upsertContactMetadata({}), null);
});

test('findExistingKey / findKeyByDigits: índices RAM', () => {
    upsertContactMetadata({ phoneNumber: '56911112222', lid: '272048244940855', pushName: 'A' });
    assert.strictEqual(findExistingKey('56911112222', null), '56911112222');
    assert.strictEqual(findExistingKey(null, '272048244940855'), '56911112222');
    assert.strictEqual(findKeyByDigits('56911112222'), '56911112222');
    assert.strictEqual(findKeyByDigits('272048244940855'), '56911112222');
    assert.strictEqual(findKeyByDigits('9999999'), null);
});

test('cleanContactsDB: elimina entradas fantasma y basura', () => {
    const db = getContactsDB();
    db['junk@g.us'] = { phone: 'junk@g.us', estado: 'neutro' };
    db['ghost'] = { estado: 'neutro' };
    db['ok'] = { phone: '56911112222', pushName: 'OK', estado: 'neutro' };
    cleanContactsDB();
    assert.ok(!db['junk@g.us']);
    assert.ok(!db['ghost']);
    assert.ok(db['ok']);
});

test('cleanContactsDB: sanitiza bio legacy {status,setAt} -> null', () => {
    const db = getContactsDB();
    db['legacy'] = {
        phone: '56911112222',
        pushName: 'Legacy',
        bio: { status: 'Hola', setAt: '2023' },
        estado: 'neutro'
    };
    cleanContactsDB();
    assert.strictEqual(db['legacy'].bio, null);
});

test('cleanContactsDB: fusiona entrada LID con la de teléfono (si tiene identidad)', () => {
    const db = getContactsDB();
    db['56911112222'] = { phone: '56911112222', lid: '272048244940855', pushName: 'Mismo', savedName: 'Agenda', estado: 'neutro' };
    // La entrada LID necesita identidad (pushName) para no ser borrada como fantasma antes de fusionarse
    db['272048244940855'] = { lid: '272048244940855', pushName: 'Mismo', bio: 'bio del lid', estado: 'neutro' };
    cleanContactsDB();
    assert.ok(!db['272048244940855']); // la entrada LID se elimina
    assert.strictEqual(db['56911112222'].bio, 'bio del lid'); // se fusiona
    assert.strictEqual(db['56911112222'].savedName, 'Agenda'); // y no se pierde lo existente
});

test('cleanContactsDB: entradas válidas sobreviven; LID puro sin identidad es fantasma', () => {
    const db = getContactsDB();
    db['56911112222'] = { phone: '56911112222', estado: 'neutro' };
    db['272048244940855'] = { lid: '272048244940855', estado: 'neutro' }; // fantasma: sin phone ni nombres
    db['con-nombre'] = { lid: '272049999999999', pushName: 'Con nombre', estado: 'neutro' };
    cleanContactsDB();
    assert.ok(db['56911112222']);
    assert.ok(!db['272048244940855']); // sin identidad -> se limpia
    assert.ok(db['con-nombre']);       // con pushName -> sobrevive
});

test('bulkUpsertContactsMetadata: procesa en lote y devuelve conteo', () => {
    const n = bulkUpsertContactsMetadata([
        { phoneNumber: '56911112222', pushName: 'A' },
        { phoneNumber: '56933334444', pushName: 'B' },
        { phoneNumber: 'junk@g.us' },
        {}
    ]);
    assert.strictEqual(n, 2);
    assert.strictEqual(Object.keys(getContactsDB()).length, 2);
});
