const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Entorno aislado: DB de contactos + cola + broadcast_db en /tmp.
// DEBE ejecutarse antes de los requires (los módulos leen env al cargar).
function setupEnv() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-bc-'));
    process.env.SDK_CONTACTS_DB_PATH = path.join(tmpDir, 'contacts_db.json');
    process.env.SDK_SETTINGS_DB_PATH = path.join(tmpDir, 'settings_db.json');
    process.env.SDK_MESSAGE_QUEUE_PATH = path.join(tmpDir, 'pending_messages.jsonl');
    process.env.SDK_BROADCAST_DB_PATH = path.join(tmpDir, 'broadcast_db.json');
    fs.writeFileSync(process.env.SDK_SETTINGS_DB_PATH, JSON.stringify({ globalMode: 'allowed_all' }, null, 2));
    return {
        tmpDir,
        restore() {
            for (const k of ['SDK_CONTACTS_DB_PATH', 'SDK_SETTINGS_DB_PATH', 'SDK_MESSAGE_QUEUE_PATH', 'SDK_BROADCAST_DB_PATH']) {
                delete process.env[k];
            }
            delete process.env.SDK_BROADCAST_DAILY_LIMIT;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    };
}

function freshModules() {
    for (const mod of ['../services/broadcastService', '../services/db', '../config']) {
        delete require.cache[require.resolve(mod)];
    }
    return require('../services/broadcastService');
}

// Escribe la libreta de contactos en el archivo que lee db.js al cargar
function writeContacts(records) {
    fs.writeFileSync(process.env.SDK_CONTACTS_DB_PATH, JSON.stringify(records, null, 2));
}

const contact = (over = {}) => ({
    phone: '56912345678',
    lid: '123456789012',
    savedName: 'Cliente',
    isContact: true,
    estado: 'neutro',
    ...over
});

test('getEligibleContacts filtra agenda, ignorados y handoff', () => {
    const t = setupEnv();
    try {
        const bs = freshModules();
        const db = {
            '56911111111': contact({ phone: '56911111111', savedName: 'A' }),
            '56922222222': contact({ phone: '56922222222', estado: 'ignorado', savedName: 'B' }),
            '56933333333': contact({ phone: '56933333333', estado: 'handoff', savedName: 'C' }),
            '56944444444': contact({ phone: '56944444444', isContact: false, savedName: 'D' }),
            '56955555555': contact({ phone: null, lid: '999999999999', savedName: 'E' }),
            '56966666666': contact({ phone: null, lid: null, savedName: 'F' })
        };
        const eligible = bs.getEligibleContacts(db);
        assert.deepStrictEqual(
            eligible.map(e => e.jid),
            ['56911111111@s.whatsapp.net', '999999999999@lid']
        );
        assert.deepStrictEqual(eligible.map(e => e.phone), ['56911111111', null]);
    } finally {
        t.restore();
    }
});

test('límite diario por número (canSendTo/markSent)', () => {
    const t = setupEnv();
    try {
        process.env.SDK_BROADCAST_DAILY_LIMIT = '2';
        const bs = freshModules();
        const now = new Date();
        const dailySends = {};
        assert.strictEqual(bs.canSendTo('56911111111', dailySends, now), true);
        bs.markSent('56911111111', dailySends, now);
        bs.markSent('56911111111', dailySends, now);
        assert.strictEqual(bs.canSendTo('56911111111', dailySends, now), false);
        assert.strictEqual(bs.canSendTo('56922222222', dailySends, now), true);
        // Sin teléfono (solo LID): sin contador, siempre permitido
        assert.strictEqual(bs.canSendTo(null, dailySends, now), true);
        // Al día siguiente se resetea
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        assert.strictEqual(bs.canSendTo('56911111111', dailySends, tomorrow), true);
    } finally {
        t.restore();
    }
});

test('parseScheduleTime: hoy si no pasó, mañana si pasó, null si inválido', () => {
    const t = setupEnv();
    try {
        const bs = freshModules();
        const now = new Date('2026-08-11T15:00:00');
        const later = bs.parseScheduleTime('18:30', now);
        assert.strictEqual(later, new Date('2026-08-11T18:30:00').toISOString());
        const past = bs.parseScheduleTime('09:00', now);
        assert.strictEqual(past, new Date('2026-08-12T09:00:00').toISOString());
        assert.strictEqual(bs.parseScheduleTime('25:00', now), null);
        assert.strictEqual(bs.parseScheduleTime('12:99', now), null);
        assert.strictEqual(bs.parseScheduleTime('abc', now), null);
    } finally {
        t.restore();
    }
});

test('worker envía 1 mensaje por tick y termina en done con notificación al admin', async () => {
    const t = setupEnv();
    try {
        writeContacts({
            '56911111111': contact({ phone: '56911111111', savedName: 'A' }),
            '56922222222': contact({ phone: '56922222222', savedName: 'B' })
        });
        const bs = freshModules();
        const { state } = require('../config');
        state.ADMIN_PHONE = '56999999999';

        const sentTo = [];
        const fakeSock = {
            sendMessage: async (jid) => {
                sentTo.push(jid);
                return { key: { id: `test-${jid}` } };
            }
        };
        bs.setSock(fakeSock);
        bs.setIsConnected(() => true);
        bs.enqueueBroadcast('Hola a todos', null);

        await bs.tick();
        assert.deepStrictEqual(sentTo, ['56911111111@s.whatsapp.net']);
        await bs.tick();
        assert.deepStrictEqual(sentTo, ['56911111111@s.whatsapp.net', '56922222222@s.whatsapp.net']);
        await bs.tick(); // cierra y notifica al admin
        const [b] = bs.getBroadcasts();
        assert.strictEqual(b.status, 'done');
        assert.strictEqual(b.sent, 2);
        assert.strictEqual(sentTo.filter(j => j === '56999999999@s.whatsapp.net').length, 1);
        assert.strictEqual(bs.getDailySends()['56911111111'].count, 1);
        assert.strictEqual(bs.getDailySends()['56922222222'].count, 1);
    } finally {
        t.restore();
    }
});

test('worker omite contactos que ya superaron el límite diario', async () => {
    const t = setupEnv();
    try {
        process.env.SDK_BROADCAST_DAILY_LIMIT = '1';
        writeContacts({
            '56911111111': contact({ phone: '56911111111', savedName: 'A' }),
            '56922222222': contact({ phone: '56922222222', savedName: 'B' })
        });
        const bs = freshModules();
        const sentTo = [];
        const fakeSock = {
            sendMessage: async (jid) => {
                sentTo.push(jid);
                return { key: { id: `test-${jid}` } };
            }
        };
        bs.setSock(fakeSock);
        bs.setIsConnected(() => true);

        // Pre-marcar el contacto 1 como ya enviado hoy
        bs.markSent('56911111111', bs.getDailySends(), new Date());
        bs.enqueueBroadcast('Promo', null);

        await bs.tick(); // 56911111111 omitido por límite → cursor avanza
        assert.deepStrictEqual(sentTo, []);
        assert.strictEqual(bs.getBroadcasts()[0].skipped, 1);

        await bs.tick(); // 56922222222 se envía
        assert.deepStrictEqual(sentTo, ['56922222222@s.whatsapp.net']);

        await bs.tick(); // done
        const [b] = bs.getBroadcasts();
        assert.strictEqual(b.status, 'done');
        assert.strictEqual(b.sent, 1);
        assert.strictEqual(b.skipped, 1);
    } finally {
        t.restore();
    }
});

test('un broadcast a medias se retoma tras recargar el módulo (cursor persistido)', async () => {
    const t = setupEnv();
    try {
        writeContacts({
            '56911111111': contact({ phone: '56911111111', savedName: 'A' }),
            '56922222222': contact({ phone: '56922222222', savedName: 'B' })
        });
        const bs = freshModules();
        const { state } = require('../config');
        state.ADMIN_PHONE = '56999999999';

        const sentTo = [];
        const fakeSock = {
            sendMessage: async (jid) => {
                sentTo.push(jid);
                return { key: { id: `test-${jid}` } };
            }
        };
        bs.setSock(fakeSock);
        bs.setIsConnected(() => true);
        bs.enqueueBroadcast('Resumen', null);
        await bs.tick(); // envía al primero

        // Simular reinicio: recargar solo broadcastService (lee broadcast_db.json)
        delete require.cache[require.resolve('../services/broadcastService')];
        const bs2 = require('../services/broadcastService');
        assert.strictEqual(bs2.getBroadcasts()[0].status, 'pending', 'sending → pending al recargar');
        assert.strictEqual(bs2.getBroadcasts()[0].cursor, 1, 'el cursor se preservó');

        bs2.setSock(fakeSock);
        bs2.setIsConnected(() => true);
        await bs2.tick();
        await bs2.tick();
        assert.strictEqual(bs2.getBroadcasts()[0].status, 'done');
        assert.strictEqual(bs2.getBroadcasts()[0].sent, 2);
    } finally {
        t.restore();
    }
});

test('tryConfirm consume "si" (encola) y "cancelar", ignora otros textos', async () => {
    const t = setupEnv();
    try {
        writeContacts({
            '56911111111': contact({ phone: '56911111111', savedName: 'A' })
        });
        const bs = freshModules();
        const sent = [];
        const fakeSock = {
            sendMessage: async (jid, msg) => {
                sent.push({ jid, text: msg.text });
                return { key: { id: `x-${sent.length}` } };
            }
        };

        // Sin confirmación pendiente → no consume
        assert.strictEqual(await bs.tryConfirm('si', fakeSock, 'adm@s.whatsapp.net'), false);

        bs.requestConfirmation('Mensaje de prueba', null);
        assert.strictEqual(bs.hasPendingConfirmation(), true);
        assert.strictEqual(await bs.tryConfirm('hola que tal', fakeSock, 'adm@s.whatsapp.net'), false);
        assert.strictEqual(bs.hasPendingConfirmation(), true, 'texto normal no consume la confirmación');

        assert.strictEqual(await bs.tryConfirm('si', fakeSock, 'adm@s.whatsapp.net'), true);
        assert.strictEqual(bs.hasPendingConfirmation(), false);
        assert.strictEqual(bs.getBroadcasts().length, 1);
        assert.strictEqual(bs.getBroadcasts()[0].status, 'pending');
        assert.strictEqual(sent.at(-1).jid, 'adm@s.whatsapp.net');

        // Cancelar
        bs.requestConfirmation('Otro', null);
        assert.strictEqual(await bs.tryConfirm('cancelar', fakeSock, 'adm@s.whatsapp.net'), true);
        assert.strictEqual(bs.hasPendingConfirmation(), false);
        assert.strictEqual(bs.getBroadcasts().length, 1, 'no se encola al cancelar');
    } finally {
        t.restore();
    }
});
