// @ts-check
const { registerSentMessage } = require('../config');
const { cat } = require("../services/logger");
const log = cat("COMANDO");
const logError = cat("ERROR");
const { createRateLimiter } = require('../services/rateLimit');
const { extractPhoneFromQuoted, chunkAdminText } = require('./commandHelpers');
const { errMsg } = require("../services/logger");
const { num } = require('../tuning');

/**
 * 🧩 Definición de un comando admin en la tabla de registro
 * @typedef {Object} CommandDef
 * @property {string[]} aliases
 * @property {(ctx: {sock: any, remoteJid: string, queryParam: string, rawMsg: any}) => (string|null) | Promise<string|null>} run
 */

/** @type {CommandDef[]} */
const chatControlCommands = /** @type {CommandDef[]} */ (require('./commands/chatControl'));
/** @type {CommandDef[]} */
const listsCommands = /** @type {CommandDef[]} */ (require('./commands/lists'));
/** @type {CommandDef[]} */
const contactsCommands = /** @type {CommandDef[]} */ (require('./commands/contacts'));
/** @type {CommandDef[]} */
const systemCommands = /** @type {CommandDef[]} */ (require('./commands/system'));
/** @type {CommandDef[]} */
const broadcastCommands = /** @type {CommandDef[]} */ (require('./commands/broadcast'));
/** @type {CommandDef[] & {handleProfileUpload: (ctx: any) => Promise<any>}} */
const profilesModule = /** @type {CommandDef[] & {handleProfileUpload: (ctx: any) => Promise<any>}} */ (require('./commands/profiles'));

// -------------------------------------------------------------
// 📋 TABLA DE REGISTRO DE COMANDOS (aliases -> handler)
// -------------------------------------------------------------
const COMMANDS = [
    ...chatControlCommands,
    ...listsCommands,
    ...contactsCommands,
    ...systemCommands,
    ...broadcastCommands,
    ...profilesModule
];

const commandRegistry = new Map();
for (const def of COMMANDS) {
    for (const alias of def.aliases) {
        commandRegistry.set(alias, def);
    }
}

// ⏱️ S2 — Límite de comandos admin: máx N/min por admin (ventana deslizante).
// Tunable vía GATEWAY_ADMIN_CMD_MAX_PER_MIN en .env.tuning (default 20).
const ADMIN_CMD_MAX_PER_MIN = num('GATEWAY_ADMIN_CMD_MAX_PER_MIN', 20);
const adminCommandLimiter = createRateLimiter(ADMIN_CMD_MAX_PER_MIN, 60 * 1000);

// 📊 Métricas para GET /status (F4-P3)
/** @type {{adminCommands: number, lastCommandAt: string|null}} */
const commandStats = { adminCommands: 0, lastCommandAt: null };

function getCommandStats() {
    return { ...commandStats, rateLimit: adminCommandLimiter.stats() };
}

/**
 * 👑 Despachador de comandos admin (self-chat)
 * @param {string} textMessage
 * @param {string} remoteJid
 * @param {any} sock
 * @param {import('../services/metadataService.js').UserMetadata} metadata
 * @param {any} [rawMsg]
 */
async function handleAdminCommand(textMessage, remoteJid, sock, metadata, rawMsg = null) {
    commandStats.adminCommands += 1;
    commandStats.lastCommandAt = new Date().toISOString();

    // ⏱️ S2 — Rate limit de comandos admin (protege de spam accidental de comandos)
    if (adminCommandLimiter(remoteJid)) {
        log.warn(`⏱️ [RATE LIMIT ADMIN] ${remoteJid} excedió ${ADMIN_CMD_MAX_PER_MIN} comandos/min. Ignorado: ${textMessage.slice(0, 60)}`);
        await sock.sendMessage(remoteJid, { text: "⏱️ *Demasiados comandos por minuto.* Espera unos segundos e inténtalo de nuevo." });
        return;
    }

    const args = textMessage.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    let queryParam = args.slice(1).join(' ').trim();

    // 💡 EXTRACCIÓN AUTOMÁTICA DE ID SI EL ADMIN RESPONDE (CITA) A UN MENSAJE DE ALERTA O CONTACTO
    if (!queryParam && rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const extracted = extractPhoneFromQuoted(rawMsg);
        if (extracted) {
            queryParam = extracted;
            log.info(`📌 [CITA DETECTADA] Extraído objetivo automáticamente del mensaje citado: ${queryParam}`);
        }
    }

    log.info(`\n👑 [COMANDO ADMIN EN SELF-CHAT]: ${command} ${queryParam || ''}`);

    const def = commandRegistry.get(command);
    let adminResponse;
    if (def) {
        adminResponse = await def.run({ sock, remoteJid, queryParam, rawMsg });
    } else {
        adminResponse = `⚠️ Comando no reconocido: *${command}*. Usa \`/e\` o \`/estado\` para ver el menú.`;
    }

    // ✂️ Enviar por partes si la respuesta es demasiado larga (WhatsApp rechaza >~4096 chars)
    try {
        const chunks = chunkAdminText(adminResponse);
        for (let i = 0; i < chunks.length; i++) {
            const suffix = chunks.length > 1 ? `\n_(Mensaje ${i + 1}/${chunks.length})_` : '';
            const sentMsg = await sock.sendMessage(remoteJid, { text: chunks[i] + suffix });
            registerSentMessage(sentMsg);
        }
    } catch (e) {
        logError.error("⚠️ No se pudo enviar confirmación admin por reconexión temporal de WhatsApp: " + errMsg(e));
    }
}

module.exports = {
    handleAdminCommand,
    getCommandStats,
    handleProfileUpload: profilesModule.handleProfileUpload
};
