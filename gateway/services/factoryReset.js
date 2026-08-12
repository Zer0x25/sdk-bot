// @ts-check
/**
 * 🧹 FASE 7: Reset limpio (factory reset) — punto ÚNICO de borrado.
 * Borra TODO el estado de runtime para dejar la app "como recién clonada":
 * sesión de WhatsApp, agenda, configuración, broadcasts, cola, memoria del
 * brain, logs y locks. Los perfiles SOUL NO se tocan (versionados en git).
 *
 * Lo consumen:
 *   - reset-clean.js (CLI, `npm run clean`): detiene instancias → borra → relanza.
 *   - adminWebServer.js (panel): POST /api/reset con clean:true.
 *
 * Rutas: mismas env vars que los módulos productores (SDK_AUTH_DIR,
 * SDK_CONTACTS_DB_PATH, …) para que los tests apunten a temporales y el
 * borrado nunca desincronice del estado real. Los locks tienen env propios
 * (SDK_GATEWAY_LOCK_PATH / SDK_BRAIN_LOCK_PATH) solo por seguridad de tests:
 * el proceso vivo del gateway escribe su lock en la ruta real, y los tests
 * locales no deben poder borrarle el lock a una instancia en producción.
 *
 * Flag `wiping`: mientras el reset limpio está en curso, el gateway NO debe
 * volcar su caché RAM a disco (al reiniciar, un flush reescribiría las DBs
 * recién borradas — resistiría el wipe). db.js e index.js lo consultan.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { CONTACTS_FILE_PATH, SETTINGS_FILE_PATH } = require('../config');
const { cat, errMsg } = require('./logger');

const logError = cat('ERROR');

/**
 * @typedef {Object} StatePath
 * @property {string} label — descripción para el reporte (español)
 * @property {'file'|'dir'} kind — tipo para el display
 * @property {string} path — ruta absoluta a borrar
 */

const AUTH_DIR = () => process.env.SDK_AUTH_DIR || path.join(__dirname, '..', 'auth_info_baileys');
const BROADCAST_DB = () => process.env.SDK_BROADCAST_DB_PATH || path.join(__dirname, '..', 'broadcast_db.json');
const QUEUE_FILE = () => process.env.SDK_MESSAGE_QUEUE_PATH || path.join(__dirname, '..', 'queue', 'pending_messages.jsonl');
const BRAIN_MEMORY_DB = () => process.env.BRAIN_MEMORY_DB || path.join(__dirname, '..', '..', 'brain', 'memory.db');
const GATEWAY_LOG_DIR = () => process.env.SDK_ADMIN_WEB_LOG_GATEWAY || path.join(__dirname, '..', 'logs');
const BRAIN_LOG_DIR = () => process.env.SDK_ADMIN_WEB_LOG_BRAIN || path.join(__dirname, '..', '..', 'brain', 'logs');

let wiping = false;

/**
 * True mientras un reset limpio está en curso: los flushes de RAM a disco
 * (debounce + cierre seguro) se SKIPEAN para no reescribir lo recién borrado.
 * @param {boolean} v
 */
function setWiping(v) {
    wiping = !!v;
}

/** @returns {boolean} */
function isWiping() {
    return wiping;
}

/** @returns {{gateway: string, brain: string}} */
function lockFiles() {
    return {
        gateway: process.env.SDK_GATEWAY_LOCK_PATH || path.join(__dirname, '..', '.gateway.lock'),
        brain: process.env.SDK_BRAIN_LOCK_PATH || path.join(__dirname, '..', '..', 'brain', '.brain.lock')
    };
}

/**
 * Inventario canónico (y ÚNICO) de todo el estado de runtime. Si un módulo
 * cambia la ruta de su estado, esto se actualiza en UN solo lugar.
 * @returns {StatePath[]}
 */
function getStatePaths() {
    return [
        { label: 'Sesión de WhatsApp (auth_info_baileys)', kind: 'dir', path: AUTH_DIR() },
        { label: 'Agenda (contacts_db.json)', kind: 'file', path: CONTACTS_FILE_PATH },
        { label: 'Configuración (settings_db.json)', kind: 'file', path: SETTINGS_FILE_PATH },
        { label: 'Broadcasts (broadcast_db.json)', kind: 'file', path: BROADCAST_DB() },
        { label: 'Cola de mensajes (pending_messages.jsonl)', kind: 'file', path: QUEUE_FILE() },
        { label: 'Memoria del brain (memory.db)', kind: 'file', path: BRAIN_MEMORY_DB() },
        { label: 'Logs del gateway (logs/)', kind: 'dir', path: GATEWAY_LOG_DIR() },
        { label: 'Logs del brain (logs/)', kind: 'dir', path: BRAIN_LOG_DIR() },
        { label: 'Lock del gateway (.gateway.lock)', kind: 'file', path: lockFiles().gateway },
        { label: 'Lock del brain (.brain.lock)', kind: 'file', path: lockFiles().brain }
    ];
}

/**
 * Borra TODO el estado de runtime. Atómico por archivo (rmSync); si algo
 * falla, corta y devuelve el error (el llamador NO debe reiniciar a medias).
 * @returns {{deleted: string[], missing: string[], errors: string[]}}
 */
function performFactoryReset() {
    const deleted = [];
    const missing = [];
    const errors = [];
    for (const entry of getStatePaths()) {
        try {
            if (fs.existsSync(entry.path)) {
                fs.rmSync(entry.path, { recursive: true, force: true });
                deleted.push(entry.label);
            } else {
                missing.push(entry.label);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`${entry.label} (${entry.path}): ${msg}`);
        }
    }
    return { deleted, missing, errors };
}

/**
 * Reinicia el proceso del gateway (tras reset limpio/pairing): bajo systemd
 * vía `systemctl restart` (exit como fallback → Restart=always); en
 * manual/dev solo exit(0) y el admin relanza (`npm start`). Margen de 500ms
 * para que la respuesta HTTP/WhatsApp llegue antes de morir.
 * (SDK_RESET_NO_EXIT=1: solo tests — el proceso del runner no muere)
 */
function restartGatewayProcess() {
    setTimeout(() => {
        if (process.env.SDK_RESET_NO_EXIT === '1') return;
        if (process.env.SYSTEMD_EXEC_PID) {
            execFile('systemctl', ['restart', process.env.SDK_GATEWAY_SERVICE || 'sdk-bot-gateway'], (e) => {
                if (e) {
                    logError.error(`🧹 systemctl restart del gateway falló: ${errMsg(e)} — saliendo igualmente`);
                    process.exit(0);
                }
            });
        } else {
            process.exit(0);
        }
    }, 500);
}

/**
 * Reinicia el service del brain si estamos bajo systemd (misma máquina):
 * con el memory.db borrado y el proceso vivo, la memoria en RAM solo se
 * suelta con un reinicio; `systemctl restart` además recrea el .db vacío.
 * En manual no se puede: el llamador avisa que hay que reiniciarlo a mano.
 * @returns {boolean} true si se disparó el restart (bajo systemd)
 */
function restartBrainIfSystemd() {
    if (!process.env.SYSTEMD_EXEC_PID) return false;
    execFile('systemctl', ['restart', process.env.SDK_BRAIN_SERVICE || 'sdk-bot-brain'], (e) => {
        if (e) logError.error(`🧹 systemctl restart del brain falló: ${errMsg(e)}`);
    });
    return true;
}

module.exports = { getStatePaths, performFactoryReset, setWiping, isWiping, lockFiles, restartGatewayProcess, restartBrainIfSystemd };