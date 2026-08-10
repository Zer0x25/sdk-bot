const path = require('path');
const fs = require('fs');

// URL de la API del Cerebro (FastAPI)
const BRAIN_API_BASE = 'http://127.0.0.1:8000';
const BRAIN_API_URL = `${BRAIN_API_BASE}/chat`;

// 🔐 S1 — API key del brain. El gateway la toma de process.env o, por defecto,
// de brain/.env (misma fuente que el brain; se pega UNA sola vez, gitignored).
// Si no hay key definida, el brain corre sin autenticación (modo legacy).
function getBrainApiKey() {
    if (process.env.BRAIN_API_KEY) return process.env.BRAIN_API_KEY;
    try {
        const envPath = path.join(__dirname, '..', 'brain', '.env');
        const line = fs.readFileSync(envPath, 'utf-8')
            .split('\n')
            .find(l => l.trim().startsWith('BRAIN_API_KEY='));
        if (line) return line.split('=').slice(1).join('=').trim();
    } catch (e) { /* brain/.env no existe: sin key = sin autenticación */ }
    return '';
}

// Rutas de archivos de bases de datos
const CONTACTS_FILE_PATH = path.join(__dirname, 'contacts_db.json');
const SETTINGS_FILE_PATH = path.join(__dirname, 'settings_db.json');

// Estado Global del Bot
const state = {
    IS_BOT_PAUSED: false,
    CURRENT_PROFILE: 'default',
    GLOBAL_MODE: 'allowed_all', // 'allowed_all' o 'ignored_all'
    ADMIN_PHONE: '',
    ADMIN_LID: ''
};

// 🛑 Registro de IDs de mensajes enviados por el bot para PREVENIR BUCLE INFINITO
const botSentMessageIds = new Set();

function registerSentMessage(sentMsg) {
    if (sentMsg && sentMsg.key && sentMsg.key.id) {
        botSentMessageIds.add(sentMsg.key.id);
        setTimeout(() => botSentMessageIds.delete(sentMsg.key.id), 60000);
    }
}

function isBotSentMessage(msgId) {
    return msgId ? botSentMessageIds.has(msgId) : false;
}

module.exports = {
    BRAIN_API_URL,
    BRAIN_API_BASE,
    BRAIN_API_KEY: getBrainApiKey(),
    CONTACTS_FILE_PATH,
    SETTINGS_FILE_PATH,
    state,
    registerSentMessage,
    isBotSentMessage
};
