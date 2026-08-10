const path = require('path');
const os = require('os');
const fs = require('fs');

// Redirige los paths de config.js a un directorio temporal ANTES de requerir
// los módulos (db.js carga los archivos al importarse). Cada archivo de test
// corre en su propio proceso con `node --test`, así que el parcheo es seguro.
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.js');

function withTempDbPaths() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-test-'));
    fs.writeFileSync(path.join(tmpDir, 'contacts_db.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'settings_db.json'), JSON.stringify({ globalMode: 'allowed_all' }, null, 2));

    const original = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const patched = original
        .replace("const CONTACTS_FILE_PATH = path.join(__dirname, 'contacts_db.json');", `const CONTACTS_FILE_PATH = ${JSON.stringify(path.join(tmpDir, 'contacts_db.json'))};`)
        .replace("const SETTINGS_FILE_PATH = path.join(__dirname, 'settings_db.json');", `const SETTINGS_FILE_PATH = ${JSON.stringify(path.join(tmpDir, 'settings_db.json'))};`);
    fs.writeFileSync(CONFIG_PATH, patched);

    return {
        tmpDir,
        restore() {
            fs.writeFileSync(CONFIG_PATH, original);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    };
}

module.exports = { withTempDbPaths };
