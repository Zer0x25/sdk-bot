// @ts-check
/**
 * ✈️ SERVICIO TELEGRAM: utilidades HTTP de la Bot API compartidas por el
 * gateway y el bus interno.
 *
 * El POLLING de getUpdates tiene un ÚNICO dueño: TelegramAdapter
 * (gateway/adapters/telegramAdapter.js). Antes había dos loops compitiendo
 * por el mismo token y cada update caía en uno u otro según carrera; ahora
 * el adaptador emite StandardMessage y el gateway enruta los comandos del
 * admin al adminCommandRunner. Este módulo queda solo con helpers sin estado.
 */
const { getSettingsDB } = require('./db');
const { cat } = require('./logger');
const { num } = require('../tuning');
const { requestText, parseTelegramJson } = require('./telegramHttp');

const log = cat('TELEGRAM');
const TELEGRAM_ADMIN_REQUEST_TIMEOUT_MS = num('TELEGRAM_ADMIN_REQUEST_TIMEOUT_MS', 8000);

/**
 * @param {string} message
 * @param {string|null} [overrideToken]
 * @param {string|null} [overrideChatId]
 * @param {boolean} [useMarkdown]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function sendTelegramMessage(message, overrideToken = null, overrideChatId = null, useMarkdown = true,
    timeoutMs = TELEGRAM_ADMIN_REQUEST_TIMEOUT_MS) {
    const settings = getSettingsDB();
    const token = overrideToken || settings.telegramToken;
    const chatId = overrideChatId || settings.telegramChatId;

    if (!token || !chatId) throw new Error('No hay configuración de Telegram (Token o Chat ID faltante)');

    const payload = { chat_id: chatId, text: message };
    if (useMarkdown) payload.parse_mode = 'Markdown';
    const response = await requestText({ path: `/bot${token}/sendMessage`, method: 'POST', body: payload, timeoutMs });

    if (useMarkdown && response.statusCode === 400 && response.body.includes("can't parse entities")) {
        return sendTelegramMessage(message, token, chatId, false, timeoutMs);
    }
    if (response.statusCode !== 200) {
        throw Object.assign(new Error(`TELEGRAM_HTTP_${response.statusCode}`), {
            code: `TELEGRAM_HTTP_${response.statusCode}`, status: response.statusCode
        });
    }
    if (useMarkdown) log.info('Notificación enviada a Telegram.');
    return parseTelegramJson(response.body);
}

/**
 * Menú de comandos del bot (única fuente de verdad).
 * El adaptador de Telegram lo reutiliza para que el menú que ve el usuario
 * en la app no dependa de qué proceso registró setMyCommands al final.
 */
const TELEGRAM_MENU_COMMANDS = [
    { command: "estado", description: "Ver estado y panel principal" },
    { command: "ia", description: "Dar el control del chat a la IA" },
    { command: "humano", description: "Tomar control manual (Pausar IA)" },
    { command: "limpiar", description: "Borrar la memoria de este chat" },
    { command: "contactos", description: "Ver agenda de contactos" },
    { command: "buscar", description: "Buscar un contacto" },
    { command: "nombre", description: "Renombrar un contacto" },
    { command: "ignorar", description: "Ignorar (bloquear) un contacto" },
    { command: "permitir", description: "Permitir a un contacto hablar con la IA" },
    { command: "quitar", description: "Borrar contacto de listas" },
    { command: "listas", description: "Ver listas de control de acceso" },
    { command: "perfil", description: "Asignar un perfil de IA distinto" },
    { command: "broadcast", description: "Enviar mensaje masivo" },
    { command: "pausar", description: "Apagar globalmente el bot" },
    { command: "reanudar", description: "Encender globalmente el bot" }
];

/** Clasifica la respuesta de getUpdates para decidir reacción y backoff. */
function classifyPollResponse(payload) {
    if (payload && payload.ok) return 'ok';
    const code = payload && payload.error_code;
    // 401 Unauthorized: token inválido/revocado. 404 Not Found: token malformado.
    if (code === 401 || code === 404) return 'auth';
    return 'error';
}

async function updateTelegramMenu(token, timeoutMs = TELEGRAM_ADMIN_REQUEST_TIMEOUT_MS) {
    await requestText({ path: `/bot${token}/setMyCommands`, method: 'POST',
        body: { commands: TELEGRAM_MENU_COMMANDS }, timeoutMs });
}

module.exports = {
    sendTelegramMessage,
    updateTelegramMenu,
    TELEGRAM_MENU_COMMANDS,
    classifyPollResponse
};
