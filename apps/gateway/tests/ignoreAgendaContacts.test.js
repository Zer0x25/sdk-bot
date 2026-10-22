process.env.SDK_BOT_TEST = '1';
const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const temp = withTempDbPaths();
after(() => { setControlService(null); temp.restore(); });

const { createArchive } = require('../services/conversations');
const { buildControlImportReport } = require('../services/conversations/controlImport');
const { createControlService } = require('../services/conversations/controlService');
const { getContactsDB, saveContactsDB } = require('../services/db');
const { setControlService, ignoreAllAgendaContacts } = require('../services/stateService');

async function fixture(t) {
    const databasePath = path.join(temp.tmpDir, `archive-${randomUUID()}.db`);
    const archive = createArchive({ path: databasePath });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(databasePath, { force: true }); });
    const ready = await archive.ready;
    const accountId = randomUUID();
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'ignore-agenda-fixture' });
    const identities = ['56911111','56922222','56933333'].map(phone => ({ accountId, channel: 'whatsapp',
        kind: 'whatsapp_jid', exactValue: `${phone}@s.whatsapp.net` }));
    await archive.ingestBatch(identities.map((identity, index) => ({ identity,
        providerMessageId: `ignore-agenda-${index}`, source: 'history', direction: 'inbound', authorKind: 'customer',
        occurredAt: '2026-10-20T12:00:00.000Z', content: { type: 'text', text: 'ignore agenda fixture' } })));
    await archive.bindAlias({ canonical: identities[0], alias: { accountId, channel: 'whatsapp',
        kind: 'whatsapp_lid', exactValue: '987654321012345@lid' },
    evidence: { kind: 'admin', reference: 'ignore-agenda-alias-fixture' } });

    const contacts = {}, settings = { globalMode: 'allowed_all', currentProfile: 'default' };
    const manifest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const snapshot = await archive.snapshot();
    const report = buildControlImportReport({ contacts, settings, profileKeys: ['default'],
        conversations: await archive.conversationRows(), sourceManifest: {
            contacts: { present: true, sha256: manifest(contacts) },
            settings: { present: true, sha256: manifest(settings) }
        }, archive: { ...snapshot, schemaVersion: ready.schemaVersion }, generatedAt: '2026-10-20T12:00:00.000Z' });
    const migrationId = 'ignore-agenda-fixture';
    const started = await archive.beginControlImport({ migrationId, report });
    for (let offset = 0; offset < started.report.entryCount; offset += 100) {
        await archive.stageControlImportBatch({ runId: started.runId, offset, limit: 100 });
    }
    assert.equal((await archive.verifyControlImport({ runId: started.runId })).status, 'verified');
    await archive.setControlServiceReady({ ready: true });
    await archive.startControlCutover({ migrationId });
    for (;;) {
        const batch = await archive.applyControlCutoverBatch({ migrationId, limit: 100 });
        if (batch.remaining === 0) break;
    }
    await archive.finishControlCutover({ migrationId });
    return { archive, accountId, service: createControlService(archive) };
}

test('BUG-071: agenda summary counts unique SQLite conversations and effective transitions', async t => {
    const { accountId, service } = await fixture(t);
    setControlService(service);
    await service.setAccessForLegacyTarget({ targetId: '56922222', channel: 'whatsapp', accountId, policy: 'ignored' });
    await service.setAccessForLegacyTarget({ targetId: '56933333', channel: 'whatsapp', accountId, policy: 'allowed' });

    const contacts = getContactsDB();
    for (const key of Object.keys(contacts)) delete contacts[key];
    Object.assign(contacts, {
        primary: { phone: '56911111', lid: null, isContact: true, estado: 'neutro' },
        alias: { phone: null, lid: '987654321012345', isContact: true, estado: 'neutro' },
        alreadyIgnored: { phone: '56922222', lid: null, isContact: true, estado: 'ignorado' },
        allowed: { phone: '56933333', lid: null, isContact: true, estado: 'permitido' }
    });
    saveContactsDB(contacts);

    const first = await ignoreAllAgendaContacts({ channel: 'whatsapp', accountId });
    assert.deepEqual(first, { addedCount: 2, totalIgnored: 3, ambiguous: 0 });
    const second = await ignoreAllAgendaContacts({ channel: 'whatsapp', accountId });
    assert.deepEqual(second, { addedCount: 0, totalIgnored: 3, ambiguous: 0 });

    const [primary, ignored, allowed] = await Promise.all([
        service.resolveLegacyTarget({ targetId: '56911111', channel: 'whatsapp', accountId }),
        service.resolveLegacyTarget({ targetId: '56922222', channel: 'whatsapp', accountId }),
        service.resolveLegacyTarget({ targetId: '56933333', channel: 'whatsapp', accountId })
    ]);
    assert.equal(primary.control.accessPolicy, 'ignored');
    assert.equal(ignored.control.accessPolicy, 'ignored');
    assert.equal(allowed.control.accessPolicy, 'ignored');
});
