const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stateEnvKeys = [
    'SDK_AUTH_DIR', 'SDK_CONTACTS_DB_PATH', 'SDK_SETTINGS_DB_PATH', 'SDK_BROADCAST_DB_PATH',
    'SDK_CONVERSATIONS_DB_PATH', 'SDK_ATTACHMENT_DIR', 'SDK_MESSAGE_QUEUE_PATH', 'BRAIN_MEMORY_DB',
    'SDK_ADMIN_WEB_LOG_GATEWAY', 'SDK_ADMIN_WEB_LOG_BRAIN', 'SDK_GATEWAY_LOCK_PATH', 'SDK_BRAIN_LOCK_PATH'
];
const savedEnv = new Map(stateEnvKeys.map(key => [key, process.env[key]]));
for (const key of stateEnvKeys) delete process.env[key];

const { REPO_ROOT, GATEWAY_STATE_DIR, BRAIN_STATE_DIR } = require('../lib/repoPaths');
const { CONTACTS_FILE_PATH, SETTINGS_FILE_PATH } = require('../config');
const { databasePath, attachmentDirectory } = require('../services/conversations/paths');
const { getStatePaths, lockFiles } = require('../services/factoryReset');

after(() => {
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test('apps/gateway resolves existing runtime data and credentials at repository-root paths', () => {
    assert.equal(REPO_ROOT, path.resolve(__dirname, '../../..'));
    assert.equal(GATEWAY_STATE_DIR, path.join(REPO_ROOT, 'gateway'));
    assert.equal(BRAIN_STATE_DIR, path.join(REPO_ROOT, 'brain'));
    assert.equal(CONTACTS_FILE_PATH, path.join(GATEWAY_STATE_DIR, 'contacts_db.json'));
    assert.equal(SETTINGS_FILE_PATH, path.join(GATEWAY_STATE_DIR, 'settings_db.json'));
    assert.equal(databasePath(), path.join(GATEWAY_STATE_DIR, 'data', 'conversations.db'));
    assert.equal(attachmentDirectory(), path.join(GATEWAY_STATE_DIR, 'data', 'attachments'));
    assert.deepEqual(lockFiles(), {
        gateway: path.join(GATEWAY_STATE_DIR, '.gateway.lock'),
        brain: path.join(BRAIN_STATE_DIR, '.brain.lock')
    });

    const inventory = getStatePaths();
    assert.ok(inventory.some(entry => entry.path === path.join(GATEWAY_STATE_DIR, 'auth_info_baileys')));
    assert.ok(inventory.some(entry => entry.path === path.join(BRAIN_STATE_DIR, 'memory.db')));
    assert.ok(inventory.some(entry => entry.path === path.join(GATEWAY_STATE_DIR, 'logs')));
    assert.ok(inventory.some(entry => entry.path === path.join(BRAIN_STATE_DIR, 'logs')));
});
