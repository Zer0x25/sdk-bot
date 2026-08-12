const { test, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Timers cortos para probar lectura/expiración rápido + wipe a temporales
process.env.SDK_RESET_CLEAN_READ_MS = '50';
process.env.SDK_RESET_CLEAN_TTL_MS = '300';
process.env.SDK_RESET_NO_EXIT = '1'; // el restart del gateway no mata al runner

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-rcflow-'));
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

const { requestCleanReset, tryCleanConfirm, hasPendingCleanReset, resetForTests } = require('../services/resetCleanFlow');
const { getStatePaths } = require('../services/factoryReset');

const JID = '56912345678@s.whatsapp.net';
let fakeSock;
function makeSock() {
    fakeSock = { sent: [], async sendMessage(_jid, msg) { this.sent.push(msg); } };
    return fakeSock;
}

function populateState() {
    // Limpiar tmp para que tests previos no dejen dirs/files que rompan este
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const entry of getStatePaths()) {
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        if (entry.kind === 'dir') {
            fs.mkdirSync(entry.path, { recursive: true });
        } else {
            fs.writeFileSync(entry.path, 'x');
        }
    }
}

// Categorías derivadas del inventario para asserts post-wipe.
const LOG_DIRS = new Set(getStatePaths().filter(e => /Logs/.test(e.label)).map(e => e.path));
const DIRS = new Set(getStatePaths().filter(e => e.kind === 'dir').map(e => e.path));

afterEach(() => resetForTests());

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const k of [
        'SDK_RESET_CLEAN_READ_MS', 'SDK_RESET_CLEAN_TTL_MS', 'SDK_RESET_NO_EXIT',
        'SDK_AUTH_DIR', 'SDK_CONTACTS_DB_PATH', 'SDK_SETTINGS_DB_PATH',
        'SDK_BROADCAST_DB_PATH', 'SDK_MESSAGE_QUEUE_PATH', 'BRAIN_MEMORY_DB',
        'SDK_ADMIN_WEB_LOG_GATEWAY', 'SDK_ADMIN_WEB_LOG_BRAIN',
        'SDK_GATEWAY_LOCK_PATH', 'SDK_BRAIN_LOCK_PATH'
    ]) delete process.env[k];
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastReply = () => fakeSock.sent[fakeSock.sent.length - 1];

test('requestCleanReset: aviso con la palabra mágica + pedido pendiente', () => {
    const text = requestCleanReset(makeSock(), JID);
    assert.match(text, /BORRAR-TODO/);
    assert.match(text, /RESET LIMPIO/);
    assert.ok(hasPendingCleanReset(), 'pedido pendiente');

    // Segundo pedido mientras hay uno vigente → aviso, no duplicado
    const again = requestCleanReset(makeSock(), JID);
    assert.match(again, /ya hay un reset limpio pendiente/i);
});

test('timer de LECTURA: la palabra no se acepta antes del mínimo', async () => {
    requestCleanReset(makeSock(), JID);
    const consumed = await tryCleanConfirm('borrar-todo', fakeSock, JID);
    assert.strictEqual(consumed, true, 'se consume (no va a la IA)');
    assert.match(lastReply().text, /Timer de lectura/);
    assert.ok(hasPendingCleanReset(), 'sigue pendiente tras la lectura');
    await sleep(70); // dejar vencer el mínimo
});

test('palabra mágica tras el timer de lectura → ejecuta el reset limpio completo', async () => {
    populateState();
    requestCleanReset(makeSock(), JID);

    await sleep(70); // superar el timer de lectura
    const consumed = await tryCleanConfirm('BORRAR-TODO', fakeSock, JID);
    assert.strictEqual(consumed, true);

    const reply = lastReply().text;
    assert.match(reply, /Reset limpio ejecutado/);
    assert.ok(!hasPendingCleanReset(), 'pedido consumido');

    // TODO el estado quedó borrado en disco; los dirs de logs se recrean vacíos
    // por el fix (F7 fix) y deben seguir existiendo.
    for (const entry of getStatePaths()) {
        if (LOG_DIRS.has(entry.path)) {
            assert.ok(fs.existsSync(entry.path), `logs recreados: ${entry.label}`);
        } else {
            assert.ok(!fs.existsSync(entry.path), `borrado: ${entry.label}`);
        }
    }
    // Perfiles SOUL intactos
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'brain', 'profiles', 'default.md')));

    // Proceso por morir: cualquier mensaje se consume y un nuevo pedido avisa
    assert.strictEqual(await tryCleanConfirm('hola', fakeSock, JID), true);
    assert.match(requestCleanReset(fakeSock, JID), /ya en curso/);
});

test('cualquier otro texto NO consume (va a la IA) y el pedido sigue vigente', async () => {
    requestCleanReset(makeSock(), JID);
    assert.strictEqual(await tryCleanConfirm('escribe una receta', fakeSock, JID), false);
    assert.ok(hasPendingCleanReset(), 'sigue pendiente');
    await sleep(350); // dejar expirar
});

test('cancelar en cualquier momento cancela sin borrar nada', async () => {
    populateState();
    requestCleanReset(makeSock(), JID);
    const consumed = await tryCleanConfirm('cancelar', fakeSock, JID);
    assert.strictEqual(consumed, true);
    assert.match(lastReply().text, /cancelado/);
    assert.ok(!hasPendingCleanReset(), 'pedido limpio');
    // Nada fue borrado; los dirs de logs deben seguir existiendo incluso si
    // cancelar no toca nada (el fix F7 los recrea vacíos tras un wipe real).
    for (const entry of getStatePaths()) {
        if (LOG_DIRS.has(entry.path)) {
            assert.ok(fs.existsSync(entry.path), `logs recreados: ${entry.label}`);
        } else {
            assert.ok(fs.existsSync(entry.path), `sigue: ${entry.label}`);
        }
    }
});

test('expiración: el timer avisa y cancela el pedido solo', async () => {
    requestCleanReset(makeSock(), JID);
    await sleep(380); // TTL 300ms + margen
    assert.ok(!hasPendingCleanReset(), 'pedido expirado');
    assert.ok(fakeSock.sent.some(m => /Tiempo agotado/.test(m.text)), 'aviso de expiración enviado');
});