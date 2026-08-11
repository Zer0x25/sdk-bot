const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Entorno limpio: SIN settings_db.json (deploy fresco) → globalMode debe ser ignored_all.
function freshEnv() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-db-'));
    process.env.SDK_CONTACTS_DB_PATH = path.join(tmpDir, 'contacts_db.json');
    process.env.SDK_SETTINGS_DB_PATH = path.join(tmpDir, 'settings_db.json');
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/db')];
    return {
        tmpDir,
        restore() {
            delete process.env.SDK_CONTACTS_DB_PATH;
            delete process.env.SDK_SETTINGS_DB_PATH;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    };
}

test('deploy fresco: sin settings_db.json el modo global cae en ignored_all', () => {
    const t = freshEnv();
    try {
        const db = require('../services/db');
        const { state } = require('../config');
        assert.strictEqual(state.GLOBAL_MODE, 'ignored_all', 'modo global default seguro');
        assert.strictEqual(JSON.parse(fs.readFileSync(process.env.SDK_SETTINGS_DB_PATH, 'utf8')).globalMode, 'ignored_all');
        assert.ok(db.getSettingsDB(), 'settings cargadas');
    } finally {
        t.restore();
    }
});

test('settings_db.json existente manda sobre el default', () => {
    const t = freshEnv();
    try {
        fs.writeFileSync(process.env.SDK_SETTINGS_DB_PATH, JSON.stringify({ globalMode: 'allowed_all' }, null, 2));
        require('../services/db');
        const { state } = require('../config');
        assert.strictEqual(state.GLOBAL_MODE, 'allowed_all', 'lo persistido manda');
    } finally {
        t.restore();
    }
});