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
const https = require('https');
const { getSettingsDB } = require('./db');
const { cat } = require('./logger');

const log = cat('TELEGRAM');

/**
 * @param {string} message
 * @param {string|null} [overrideToken]
 * @param {string|null} [overrideChatId]
 * @param {boolean} [useMarkdown]
 * @returns {Promise<any>}
 */
function sendTelegramMessage(message, overrideToken = null, overrideChatId = null, useMarkdown = true) {
    return new Promise((resolve, reject) => {
        const settings = getSettingsDB();
        const token = overrideToken || settings.telegramToken;
        const chatId = overrideChatId || settings.telegramChatId;

        if (!token || !chatId) {
            return reject(new Error('No hay configuración de Telegram (Token o Chat ID faltante)'));
        }

        const payload = {
            chat_id: chatId,
            text: message
        };
        if (useMarkdown) {
            payload.parse_mode = 'Markdown';
        }

        const data = JSON.stringify(payload);

        const req = https.request({
            hostname: 'api.telegram.org',
            family: 4,
            port: 443,
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    if (useMarkdown) log.info(`Notificación enviada a Telegram (chat ${chatId})`);
                    resolve(JSON.parse(body));
                } else {
                    const errMsg = `Error de Telegram: ${res.statusCode} ${body}`;
                    if (useMarkdown && res.statusCode === 400 && body.includes("can't parse entities")) {
                        sendTelegramMessage(message, token, chatId, false).then(resolve).catch(reject);
                    } else {
                        reject(new Error(errMsg));
                    }
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

function testAndGetChatId(token) {
    return new Promise((resolve, reject) => {
        https.get({hostname: 'api.telegram.org', path: `/bot${token}/getUpdates`, family: 4}, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.ok) return reject(new Error(data.description || 'Error al obtener updates'));
                    const updates = data.result || [];
                    for (let i = updates.length - 1; i >= 0; i--) {
                        if (updates[i].message && updates[i].message.chat) {
                            return resolve(updates[i].message.chat.id);
                        }
                    }
                    reject(new Error('No se encontraron mensajes. Por favor, envía un mensaje (ej: /start) al bot en Telegram primero y vuelve a intentarlo.'));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
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

function updateTelegramMenu(token) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ commands: TELEGRAM_MENU_COMMANDS });
        const req = https.request({
            hostname: 'api.telegram.org',
            family: 4,
            port: 443,
            path: `/bot${token}/setMyCommands`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

module.exports = {
    sendTelegramMessage,
    testAndGetChatId,
    updateTelegramMenu,
    TELEGRAM_MENU_COMMANDS,
    classifyPollResponse
};
