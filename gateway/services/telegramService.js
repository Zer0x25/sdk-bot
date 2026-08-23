const https = require('https');
const { getSettingsDB } = require('./db');
const { cat } = require('./logger');

const log = cat('TELEGRAM');

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

let pollerActive = false;
let lastUpdateId = 0;
let commandCallback = null;
let currentPollReq = null;
let currentPollTimer = null;
// Racha de errores de autenticación: loguear solo la primera vez (sin spam).
let authErrorStreak = 0;

function setTelegramCommandCallback(cb) {
    commandCallback = cb;
}

const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

async function pollTelegram() {
    if (!pollerActive) return;
    const settings = getSettingsDB();
    const token = settings.telegramToken;
    const chatId = String(settings.telegramChatId || '');

    if (!token || !chatId || chatId === 'undefined') {
        currentPollTimer = setTimeout(pollTelegram, 5000);
        currentPollTimer.unref();
        return;
    }

    try {
        const updates = await new Promise((resolve, reject) => {
            const req = https.get({hostname: 'api.telegram.org', path: `/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, family: 4}, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(e); }
                });
            });
            currentPollReq = req;
            req.on('error', reject);
            req.setTimeout(35000, () => { req.destroy(); resolve({ ok: true, result: [] }); });
        });
        currentPollReq = null;

        const kind = classifyPollResponse(updates);
        if (kind === 'ok') {
            authErrorStreak = 0;
            for (const u of (updates.result || [])) {
                lastUpdateId = Math.max(lastUpdateId, u.update_id);
                if (u.message && u.message.text && String(u.message.chat.id) === chatId) {
                    if (commandCallback) {
                        try {
                            const res = await commandCallback(u.message.text);
                            if (res && res.replies) {
                                for (const reply of res.replies) {
                                    if (reply.text) {
                                        await sendTelegramMessage(reply.text, token, chatId).catch(e => log.error('Error enviando reply tg: ' + e.message));
                                    }
                                }
                            }
                        } catch (err) {
                            log.error('Error en callback tg: ' + err.message);
                        }
                    }
                }
            }
        } else if (kind === 'auth') {
            // Token inválido o revocado: avisar claro y esperar (el poller
            // relee settings cada vuelta, así que se recupera solo al guardar
            // un token nuevo desde el panel).
            authErrorStreak += 1;
            if (authErrorStreak === 1) {
                log.error(`🚫 Token de Telegram inválido o revocado (HTTP ${updates.error_code}). Genera uno nuevo con @BotFather y guárdalo en el panel.`);
            }
            await sleep(30000);
        } else {
            authErrorStreak = 0;
            log.error('Error en poller de telegram: ' + ((updates && updates.description) || 'respuesta no válida'));
            await new Promise(r => setTimeout(r, 5000));
        }
    } catch (e) {
        if (e.message !== 'socket hang up') {
            log.error('Error en poller de telegram: ' + e.message);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    
    if (pollerActive) {
        setImmediate(pollTelegram);
    }
}

function startTelegramPoller() {
    if (!pollerActive) {
        pollerActive = true;
        const settings = getSettingsDB();
        if (settings.telegramToken) {
            updateTelegramMenu(settings.telegramToken).catch(e => log.error('Error al actualizar menú de Telegram: ' + e.message));
        }
        pollTelegram();
    }
}

function stopTelegramPoller() {
    pollerActive = false;
    if (currentPollTimer) {
        clearTimeout(currentPollTimer);
        currentPollTimer = null;
    }
    if (currentPollReq) {
        currentPollReq.destroy();
        currentPollReq = null;
    }
}

module.exports = {
    setTelegramCommandCallback,
    startTelegramPoller,
    stopTelegramPoller,
    sendTelegramMessage,
    testAndGetChatId,
    TELEGRAM_MENU_COMMANDS,
    classifyPollResponse
};
