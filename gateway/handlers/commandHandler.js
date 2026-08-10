const { registerSentMessage } = require('../config');
const { cat } = require("../services/logger");
const log = cat("COMANDO");
const logError = cat("ERROR");
const { createRateLimiter } = require('../services/rateLimit');
const { extractPhoneFromQuoted, chunkAdminText } = require('./commandHelpers');

const chatControlCommands = require('./commands/chatControl');
const listsCommands = require('./commands/lists');
const contactsCommands = require('./commands/contacts');
const systemCommands = require('./commands/system');
const profilesModule = require('./commands/profiles');

// -------------------------------------------------------------
// 📋 TABLA DE REGISTRO DE COMANDOS (aliases -> handler)
// -------------------------------------------------------------
const COMMANDS = [
    ...chatControlCommands,
    ...listsCommands,
    ...contactsCommands,
    ...systemCommands,
    ...profilesModule
];

const commandRegistry = new Map();
for (const def of COMMANDS) {
    for (const alias of def.aliases) {
        commandRegistry.set(alias, def);
    }
}

// ⏱️ S2 — Límite de comandos admin: máx 20/min por admin (ventana deslizante)
const ADMIN_CMD_MAX_PER_MIN = 20;
const adminCommandLimiter = createRateLimiter(ADMIN_CMD_MAX_PER_MIN, 60 * 1000);

async function handleAdminCommand(textMessage, remoteJid, sock, metadata, rawMsg = null) {
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
        logError.error("⚠️ No se pudo enviar confirmación admin por reconexión temporal de WhatsApp:", e.message);
    }
}

module.exports = {
    handleAdminCommand,
    handleProfileUpload: profilesModule.handleProfileUpload
};
