const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('saving legacy settings leaves the current SQLite control snapshot authoritative', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-settings-control-'));
    const settingsPath = path.join(dir, 'settings_db.json');
    const contactsPath = path.join(dir, 'contacts_db.json');
    const archivePath = path.join(dir, 'conversations.db');
    const oldEnv = new Map();
    const env = {
        SDK_BOT_TEST: '1',
        SDK_SETTINGS_DB_PATH: settingsPath,
        SDK_CONTACTS_DB_PATH: contactsPath,
        SDK_BROADCAST_DB_PATH: path.join(dir, 'broadcast_db.json'),
        SDK_MESSAGE_QUEUE_PATH: path.join(dir, 'queue.jsonl'),
        SDK_CONVERSATIONS_DB_PATH: archivePath,
        SDK_AUTH_DIR: path.join(dir, 'auth'),
        SDK_GATEWAY_LOCK_PATH: path.join(dir, '.gateway.lock'),
        SDK_BRAIN_LOCK_PATH: path.join(dir, '.brain.lock'),
        BRAIN_MEMORY_DB: path.join(dir, 'memory.db'),
        SDK_ADMIN_WEB_LOG_GATEWAY: path.join(dir, 'logs', 'gateway'),
        SDK_ADMIN_WEB_LOG_BRAIN: path.join(dir, 'logs', 'brain'),
        GATEWAY_SAVE_DELAY_MS: '10'
    };
    for (const [key, value] of Object.entries(env)) {
        oldEnv.set(key, process.env[key]);
        process.env[key] = value;
    }
    const initialSettings = {
        globalMode: 'allowed_all',
        currentProfile: 'default',
        telegramToken: 'fixture-token-not-for-output'
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2));

    let archive;
    let stateService;
    try {
        const { createArchive } = require('../services/conversations');
        const { buildControlImportReport } = require('../services/conversations/controlImport');
        const { createControlService } = require('../services/conversations/controlService');
        const settingsDb = require('../services/db');
        stateService = require('../services/stateService');

        archive = createArchive({ path: archivePath });
        const ready = await archive.ready;
        const accountId = randomUUID();
        await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: 'settings-authority-fixture' });
        await archive.ingestBatch([{
            identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '56911111111@s.whatsapp.net' },
            providerMessageId: 'settings-authority-message', source: 'history', direction: 'inbound',
            authorKind: 'customer', occurredAt: '2026-10-20T12:00:00.000Z',
            content: { type: 'text', text: 'fixture' }
        }]);

        const contacts = {};
        const snapshot = await archive.snapshot();
        const report = buildControlImportReport({
            contacts,
            settings: initialSettings,
            profileKeys: ['default'],
            conversations: await archive.conversationRows(),
            sourceManifest: {
                contacts: { present: true, sha256: digest(contacts) },
                settings: { present: true, sha256: digest(initialSettings) }
            },
            archive: { ...snapshot, schemaVersion: ready.schemaVersion },
            generatedAt: '2026-10-20T12:00:00.000Z'
        });
        const migrationId = 'settings-authority-fixture';
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

        const service = createControlService(archive, { validateProfile: async key => key === 'default' });
        stateService.setControlService(service);
        const policyChange = await stateService.setNumberState('*', 'ignored');
        assert.equal(policyChange.success, true);
        assert.equal((await archive.controlPolicy()).globalMode, 'ignored_all');
        const contactChange = await stateService.setNumberState('56911111111', 'allowed', {
            channel: 'whatsapp', accountId
        });
        assert.equal(contactChange.success, true);

        const job = await service.readForIdentity({
            accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '56911111111@s.whatsapp.net'
        });
        settingsDb.saveSettingsDB({ ...settingsDb.getSettingsDB(), telegramChatId: '555123' });
        await new Promise(resolve => setTimeout(resolve, 40));

        const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.equal(persisted.telegramChatId, '555123');
        assert.equal(persisted.globalMode, 'allowed_all');
        assert.equal((await archive.controlPolicy()).globalMode, 'ignored_all');
        assert.equal(await service.isSnapshotCurrent(job.controlSnapshot), true);
    } finally {
        stateService?.setControlService(null);
        await archive?.close().catch(() => {});
        for (const [key, prior] of oldEnv) {
            if (prior === undefined) delete process.env[key];
            else process.env[key] = prior;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
