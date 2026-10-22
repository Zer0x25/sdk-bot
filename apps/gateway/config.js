// @ts-check
const path = require('path');
const fs = require('fs');
const { num } = require('./tuning');
const { GATEWAY_STATE_DIR, BRAIN_STATE_DIR } = require('./lib/repoPaths');

// URL de la API del Cerebro (FastAPI).
// Lee BRAIN_API_BASE por env; fallback a :5100 (estándar dev playground).
// Dev (playground): se setea BRAIN_API_BASE=http://127.0.0.1:5100 (rango dev).
const BRAIN_API_BASE = process.env.BRAIN_API_BASE || 'http://127.0.0.1:5100';
const BRAIN_API_URL = `${BRAIN_API_BASE}/chat`;

// 🎤 STT (speech-to-text) local — servicio faster-whisper del repo (apps/stt/).
// En Docker apunta a http://stt:9000 (service en compose.yml); en dev local
// a http://127.0.0.1:9000. Detrás de red interna, sin exposición a internet.
const STT_API_URL = process.env.STT_API_URL || (process.env.NODE_ENV === 'production'
    ? 'http://stt:9000'
    : 'http://127.0.0.1:9000');
// Tope de espera por audio (ADR-004: todo fetch lleva timeout explícito).
// La transcripción en CPU puede tardar; 60s cubre audios cortos en base int8.
const STT_TIMEOUT_MS = num('STT_TIMEOUT_MS', 60000);

// 🔐 S1 — API key del brain. El gateway la toma de process.env o, por defecto,
// de brain/.env (misma fuente que el brain; se pega UNA sola vez, gitignored).
// Si no hay key definida, el brain corre sin autenticación (modo legacy).
function getBrainApiKey() {
    if (process.env.BRAIN_API_KEY) return process.env.BRAIN_API_KEY;
    try {
        const envPath = path.join(BRAIN_STATE_DIR, '.env');
        const line = fs.readFileSync(envPath, 'utf-8')
            .split('\n')
            .find(l => l.trim().startsWith('BRAIN_API_KEY='));
        if (line) return line.split('=').slice(1).join('=').trim();
    } catch (e) { /* brain/.env no existe: sin key = sin autenticación */ }
    return '';
}

// Rutas de archivos de bases de datos.
// En tests se redirigen con env vars (SDK_CONTACTS_DB_PATH / SDK_SETTINGS_DB_PATH)
// para que tmpPaths.js NUNCA reescriba este archivo fuente (ver bug F3 en 351fa1a).
const CONTACTS_FILE_PATH = process.env.SDK_CONTACTS_DB_PATH || path.join(GATEWAY_STATE_DIR, 'contacts_db.json');
const SETTINGS_FILE_PATH = process.env.SDK_SETTINGS_DB_PATH || path.join(GATEWAY_STATE_DIR, 'settings_db.json');

// Estado Global del Bot
// Revisión de la política efectiva durante esta época de proceso. F5 trasladará
// la autoridad/versionado a SQLite; por ahora no hay jobs/control v1 que la usen.
let policyRevision = 1n;
let paused = false;
let globalMode = 'ignored_all';
let currentProfile = 'default';
const state = {
    get IS_BOT_PAUSED() { return paused; },
    set IS_BOT_PAUSED(value) {
        if (paused !== value) { paused = value; policyRevision += 1n; }
    },
    get CURRENT_PROFILE() { return currentProfile; },
    set CURRENT_PROFILE(value) {
        if (currentProfile !== value) { currentProfile = value; policyRevision += 1n; }
    },
    get GLOBAL_MODE() { return globalMode; },
    set GLOBAL_MODE(value) {
        if (globalMode !== value) { globalMode = value; policyRevision += 1n; }
    },
    ADMIN_PHONE: '',
    ADMIN_LID: ''
};

/**
 * @typedef {typeof state} GlobalState
 */

// 🛑 Registro de IDs de mensajes enviados por el bot para PREVENIR BUCLE INFINITO
const botSentMessageIds = new Set();

// 📊 Contadores globales para GET /status (F4-P3)
const counters = { sentMessages: 0 };

function registerSentMessage(sentMsg) {
    // Acepta tanto formato WhatsApp (sentMsg.key.id) como Telegram (sentMsg.message_id)
    const id = (sentMsg && (sentMsg.key && sentMsg.key.id)) || (sentMsg && sentMsg.message_id);
    if (id) {
        botSentMessageIds.add(id);
        counters.sentMessages += 1;
        const timer = setTimeout(() => botSentMessageIds.delete(id), 60000);
        timer.unref?.();
    }
}

function isBotSentMessage(msgId) {
    return msgId ? botSentMessageIds.has(msgId) : false;
}

module.exports = {
    BRAIN_API_URL,
    BRAIN_API_BASE,
    BRAIN_API_KEY: getBrainApiKey(),
    STT_API_URL,
    STT_TIMEOUT_MS,
    CONTACTS_FILE_PATH,
    SETTINGS_FILE_PATH,
    state,
    getGlobalPolicy: () => ({ globalMode, globalPaused: paused, policyVersion: String(policyRevision) }),
    counters,
    registerSentMessage,
    isBotSentMessage
};
