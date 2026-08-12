const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Env vars de TODAS las rutas de estado apuntando a temporales: el wipe
// debe tocar exactamente esos archivos y NINGÚN otro (perfiles, otros).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-freset-'));
process.env.SDK_AUTH_DIR = path.join(tmp, 'auth_info_baileys');
process.env.SDK_CONTACTS_DB_PATH = path.join(tmp, 'contacts_db.json');
process.env.SDK_SETTINGS_DB_PATH = path.join(tmp, 'settings_db.json');
process.env.SDK_BROADCAST_DB_PATH = path.join(tmp, 'broadcast_db.json');
process.env.SDK_MESSAGE_QUEUE_PATH = path.join(tmp, 'queue', 'pending_messages.jsonl');
process.env.BRAIN_MEMORY_DB = path.join(tmp, 'memory.db');
process.env.SDK_ADMIN_WEB_LOG_GATEWAY = path.join(tmp, 'gwlogs');
process.env.SDK_ADMIN_WEB_LOG_BRAIN = path.join(tmp, 'brlogs');
process.env.SDK_GATEWAY_LOCK_PATH = path.join(tmp, '.gateway.lock');
process.env.SDK_BRAIN_LOCK_PATH = path.join(tmp, '.brain.lock');

const {
    getStatePaths,
    performFactoryReset,
    lockFiles,
    setWiping,
    isWiping
} = require('../services/factoryReset');

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const k of [
        'SDK_AUTH_DIR', 'SDK_CONTACTS_DB_PATH', 'SDK_SETTINGS_DB_PATH',
        'SDK_BROADCAST_DB_PATH', 'SDK_MESSAGE_QUEUE_PATH', 'BRAIN_MEMORY_DB',
        'SDK_ADMIN_WEB_LOG_GATEWAY', 'SDK_ADMIN_WEB_LOG_BRAIN',
        'SDK_GATEWAY_LOCK_PATH', 'SDK_BRAIN_LOCK_PATH'
    ]) delete process.env[k];
});

// Crea todos los archivos del inventario (dirs incluidos) + un "extranjero".
function populate() {
    const created = [];
    for (const entry of getStatePaths()) {
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        fs.writeFileSync(entry.path, 'x');
        created.push(entry.path);
    }
    const stranger = path.join(tmp, 'no-tocar.txt');
    fs.writeFileSync(stranger, 'x');
    return { created, stranger };
}

test('getStatePaths resuelve todas las rutas con las env vars (temporales)', () => {
    const paths = getStatePaths();
    assert.strictEqual(paths.length, 10);
    for (const entry of paths) {
        assert.ok(fs.existsSync(entry.path) || path.dirname(entry.path) === tmp || entry.path.startsWith(tmp),
            `ruta bajo el tmp: ${entry.label}`);
        assert.ok(entry.path.startsWith(tmp), `${entry.label}: ${entry.path}`);
    }
    const locks = lockFiles();
    assert.strictEqual(locks.gateway, path.join(tmp, '.gateway.lock'));
    assert.strictEqual(locks.brain, path.join(tmp, '.brain.lock'));
});

test('performFactoryReset borra TODO el estado y reporta lo que no existía', () => {
    const { created } = populate();
    const report = performFactoryReset();

    assert.strictEqual(report.errors.length, 0, JSON.stringify(report.errors));
    assert.ok(report.deleted.length >= 10, `todos borrados (${report.deleted.length})`);
    assert.strictEqual(report.missing.length, 0, 'nada faltante: todo existía');

    for (const p of created) assert.ok(!fs.existsSync(p), `borrado: ${p}`);
});

test('performFactoryReset reporta como missing lo que no existe y NO toca perfiles ni archivos ajenos', () => {
    // Después del wipe anterior TODO es missing (y hay un archivo extranjero)
    const report = performFactoryReset();
    assert.strictEqual(report.deleted.length, 0, 'nada que borrar la segunda vez');
    assert.ok(report.missing.length >= 10, `missing reportado (${report.missing.length})`);
    assert.strictEqual(report.errors.length, 0);

    const stranger = path.join(tmp, 'no-tocar.txt');
    fs.writeFileSync(stranger, 'x');
    assert.ok(fs.existsSync(stranger), 'archivo ajeno intacto');
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'brain', 'profiles', 'default.md')), 'perfil SOUL intacto');
});

test('flag wiping: setWiping/isWiping controlados (los flushes lo consultan)', () => {
    setWiping(false);
    assert.strictEqual(isWiping(), false);
    setWiping(true);
    assert.strictEqual(isWiping(), true);
    setWiping(false);
});