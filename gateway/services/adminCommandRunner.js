// @ts-check
/**
 * 🎛️ EJECUTOR DE COMANDOS ADMIN compartido.
 *
 * Tanto el panel web (/api/command en el bus interno) como los comandos que
 * llegan por Telegram pasan por aquí: mismo commandHandler, mismo JID admin,
 * mismas respuestas normalizadas ({ ok, replies }) para ambos canales.
 *
 * El sock virtual captura las respuestas del commandHandler en memoria; el
 * llamador decide cómo entregarlas (JSON al panel, sendMessage a Telegram).
 */
const { handleAdminCommand } = require('../handlers/commandHandler');

const ADMIN_JID = 'admin-web@web';

/**
 * @param {Array<{type: string, text?: string, fileName?: string, caption?: string, base64?: string}>} replies
 */
function makeVirtualSock(replies) {
    return {
        /** @param {any} text */
        async sendMessage(_jid, text, _options) {
            if (typeof text === 'string') {
                replies.push({ type: 'text', text: text });
            } else if (text && text.document) {
                const buf = Buffer.isBuffer(text.document) ? text.document : Buffer.from(text.document);
                replies.push({
                    type: 'document',
                    fileName: text.fileName || 'archivo',
                    caption: text.caption || '',
                    base64: buf.toString('base64')
                });
            } else {
                replies.push({ type: 'other', text: JSON.stringify(text).slice(0, 500) });
            }
            return null;
        }
    };
}

/**
 * Ejecuta una línea de comando admin y devuelve sus respuestas.
 * @param {any} input
 * @returns {Promise<{ok: boolean, replies: Array<{type: string, text?: string, fileName?: string, caption?: string, base64?: string}>}>}
 */
async function runAdminCommand(input) {
    const text = String(input || '').trim();
    if (!text) return { ok: false, replies: [{ type: 'text', text: '⚠️ Comando vacío.' }] };
    const replies = [];
    const commandLine = text.startsWith('/') ? text : `/${text}`;
    try {
        await handleAdminCommand(commandLine, ADMIN_JID, makeVirtualSock(replies), /** @type {any} */ ({}));
        return { ok: true, replies };
    } catch (e) {
        const { errMsg } = require('./logger');
        return { ok: false, replies: [{ type: 'text', text: `⚠️ Error al ejecutar comando: ${errMsg(e)}` }] };
    }
}

// La decisión de qué es "comando del admin" vive en el pipeline (SCENARIO 1):
// messageHandler marca isSelf para el canal admin de Telegram y
// decideMessageFlow separa '/comando' del texto del Asistente Personal.

module.exports = { ADMIN_JID, makeVirtualSock, runAdminCommand };
