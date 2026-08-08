const path = require('path');

// URL de la API del Cerebro (FastAPI)
const BRAIN_API_URL = 'http://127.0.0.1:8000/chat';

// Rutas de archivos de listas de control de acceso y base de contactos
const ALLOWED_FILE_PATH = path.join(__dirname, 'allowed_numbers.json');
const IGNORED_FILE_PATH = path.join(__dirname, 'ignored_numbers.json');
const CONTACTS_FILE_PATH = path.join(__dirname, 'contacts_db.json');

// Estado Global del Bot
const state = {
    IS_BOT_PAUSED: false,
    CURRENT_PROFILE: 'default',
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
    ALLOWED_FILE_PATH,
    IGNORED_FILE_PATH,
    CONTACTS_FILE_PATH,
    state,
    registerSentMessage,
    isBotSentMessage
};
