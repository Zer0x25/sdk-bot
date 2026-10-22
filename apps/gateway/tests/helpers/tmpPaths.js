const path = require('path');
const os = require('os');
const fs = require('fs');

// Redirige config.js a una DB temporal SOLO vía variables de entorno
// (config.js las lee si están presentes). NUNCA reescribe archivos fuente:
// en el pasado, un restore fallido dejó rutas de /tmp commitadas en config.js
// y prod escribió su DB real en /tmp (bug F3-P1). Cada archivo de test corre
// en su propio proceso con `node --test`, así que las env vars no colisionan.
function withTempDbPaths() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-test-'));
    const contactsPath = path.join(tmpDir, 'contacts_db.json');
    const settingsPath = path.join(tmpDir, 'settings_db.json');
    fs.writeFileSync(contactsPath, JSON.stringify({}, null, 2));
    fs.writeFileSync(settingsPath, JSON.stringify({ globalMode: 'allowed_all' }, null, 2));

    process.env.SDK_CONVERSATIONS_DB_PATH = path.join(tmpDir, 'conversations.db');
    process.env.SDK_ATTACHMENT_DIR = path.join(tmpDir, 'attachments');
    process.env.SDK_CONTACTS_DB_PATH = contactsPath;
    process.env.SDK_SETTINGS_DB_PATH = settingsPath;

    return {
        tmpDir,
        restore() {
            delete process.env.SDK_CONVERSATIONS_DB_PATH;
            delete process.env.SDK_ATTACHMENT_DIR;
            delete process.env.SDK_CONTACTS_DB_PATH;
            delete process.env.SDK_SETTINGS_DB_PATH;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    };
}

module.exports = { withTempDbPaths };
