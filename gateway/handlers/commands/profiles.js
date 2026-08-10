/**
 * 🎭 PERFILES SOUL (/perfil, /update, /import) + subida de .md desde WhatsApp
 */
const { state, registerSentMessage } = require('../../config');
const { cat } = require("../../services/logger");
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { setCurrentProfile, setContactProfile } = require('../../services/stateService');
const { getAvailableProfiles, getProfileDetail, exportProfileFile, importProfileFile, deleteProfileFile } = require('../../services/brainService');
const { parsePhoneOrLid, usageOf } = require('../commandHelpers');

const log = cat("COMANDO");
const logError = cat("ERROR");

/**
 * 📥 SUBIR UN PERFIL .MD DESDE UN DOCUMENTO DE WHATSAPP
 * Descarga el documento (adjunto o citado), valida el nombre y lo envía al brain.
 * @param {object} sock - Socket de Baileys
 * @param {string} remoteJid - JID del self-chat
 * @param {object} docMessage - message.documentMessage (o contenido de quotedMessage)
 * @param {object} [msgKey] - key del mensaje original para downloadMediaMessage
 */
async function handleProfileUpload(sock, remoteJid, docMessage, msgKey) {
    try {
        const fileName = docMessage?.fileName || 'perfil.md';
        const match = fileName.match(/^([a-z0-9_-]+)\.(md|txt)$/i);
        if (!match) {
            await sock.sendMessage(remoteJid, { text: `⚠️ *Archivo no válido:* \`${fileName}\`. Debe llamarse \`perfil.md\` o \`<key>.md\` (ej: \`lucia.md\`).` });
            return false;
        }
        const profileKey = match[1].toLowerCase();

        // 📥 Descarga en Baileys 7.0.0-rc14: downloadMediaMessage(msg, type, options, ctx).
        // ctx.logger debe ser un logger real y ctx.reuploadRequest una FUNCIÓN
        // (Baileys la llama solo si el media da 404/410 = expirado; aquí no hay
        // re-fetch posible sin store, así que se reintenta con el mismo mensaje
        // y el error real llega al admin).
        const buffer = await downloadMediaMessage(msgKey, 'buffer', {}, {
            logger: log,
            reuploadRequest: async (msg) => msg
        });
        if (!buffer) {
            await sock.sendMessage(remoteJid, { text: `⚠️ No pude descargar el archivo \`${fileName}\`. Intenta reenviarlo citándolo con \`/update\`.` });
            return false;
        }

        const content = buffer.toString('utf8');
        const result = await importProfileFile(profileKey, content);

        if (result && result.success) {
            const sent = await sock.sendMessage(remoteJid, {
                text: `✅ *Perfil \`${profileKey}\` actualizado:*\n` +
                    `• *Nombre:* ${result.nombre}\n` +
                    `• *Reglas:* ${result.reglas} | *Ejemplos:* ${result.ejemplos}\n\n` +
                    `Comprueba el prompt: \`/perfil ver ${profileKey}\``
            });
            registerSentMessage(sent);
            return true;
        }

        const sent = await sock.sendMessage(remoteJid, {
            text: `⚠️ *Rechazado* (${fileName}): ${result?.message || 'Brain apagado o error de importación'}. El perfil no fue modificado.`
        });
        registerSentMessage(sent);
        return false;
    } catch (e) {
        logError.error("⚠️ Error al importar perfil desde documento:", e.message);
        await sock.sendMessage(remoteJid, { text: `⚠️ Error al importar el perfil: ${e.message}` }).catch(() => {});
        return false;
    }
}

async function runPerfil({ sock, remoteJid, queryParam, rawMsg }) {
    const profiles = await getAvailableProfiles();
    const profileList = profiles.map(p => `• \`${p.key}\` - *${p.nombre}*: ${p.descripcion}`).join('\n');

    if (!queryParam) {
        return `⚠️ *Uso:* \`/perfil <perfil>\` (global) | \`/perfil <perfil> <num>\` (contacto) | \`/perfil ver <perfil>\` | \`/perfil exportar <perfil>\` | \`/perfil eliminar <perfil>\`\nPerfil actual: *${state.CURRENT_PROFILE}*\n\n*Perfiles disponibles:*\n${profileList || "No se pudieron cargar (¿brain encendido?)"}`;
    }

    // 📄 /perfil ver <key> → muestra el system prompt compilado
    if (queryParam.toLowerCase().startsWith('ver ')) {
        const keyToShow = queryParam.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
        if (!keyToShow) {
            return `⚠️ Uso: \`/perfil ver <perfil>\`. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no cargados'}.`;
        }
        const detail = await getProfileDetail(keyToShow);
        if (detail && detail.prompt) {
            return `📄 *Perfil ${detail.nombre} (\`${detail.key}\`)*\n━━━━━━━━━━━━━━━━━━━━━━\n${detail.prompt}`;
        }
        return `⚠️ Perfil *"${keyToShow}"* no encontrado o brain apagado. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ')}.`;
    }

    // 🗑️ /perfil eliminar <key> → borra el .md del perfil en el brain
    if (['eliminar', 'borrar', 'delete', 'del', 'rm'].includes(queryParam.toLowerCase().split(/\s+/)[0])) {
        const keyToDelete = queryParam.toLowerCase().split(/\s+/).slice(1).join(' ').trim();
        if (!keyToDelete) {
            return `⚠️ Uso: \`/perfil eliminar <perfil>\`. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no cargados'}.`;
        }
        const delResult = await deleteProfileFile(keyToDelete);
        if (delResult && delResult.success) {
            return `🗑️ *Perfil \`${keyToDelete}\` eliminado.*\n\nRecuerda: si un contacto tenía ese perfil asignado, el brain caerá a \`default\`.`;
        }
        return `⚠️ No pude borrar *"${keyToDelete}"*: ${(delResult && delResult.detail) || 'no encontrado o brain apagado'}.`;
    }

    // 📤 /perfil exportar <key> → envía el .md al self-chat para editar
    if (queryParam.toLowerCase().startsWith('exportar ') || queryParam.toLowerCase() === 'exportar') {
        const keyToExport = queryParam.toLowerCase().startsWith('exportar ')
            ? queryParam.split(/\s+/).slice(1).join(' ').trim().toLowerCase()
            : '';
        if (!keyToExport) {
            return `⚠️ Uso: \`/perfil exportar <perfil>\`. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no cargados'}.`;
        }
        const exported = await exportProfileFile(keyToExport);
        if (!exported) {
            return `⚠️ Perfil *"${keyToExport}"* no encontrado o brain apagado.`;
        }
        try {
            await sock.sendMessage(remoteJid, {
                document: Buffer.from(exported.content, 'utf8'),
                mimetype: 'text/markdown',
                fileName: exported.filename,
                caption: `📤 Perfil *${keyToExport}*. Edítalo y envíalo citando este archivo con \`/update\`.`
            });
            return null; // La respuesta es el propio documento
        } catch (e) {
            logError.error("⚠️ Error al enviar documento de perfil:", e.message);
            return `⚠️ Error al enviar el archivo de perfil: ${e.message}`;
        }
    }

    const argsParts = queryParam.split(/\s+/);
    const profileKey = argsParts[0].toLowerCase();
    const valid = profiles.find(p => p.key === profileKey);

    if (!valid) {
        return `⚠️ Perfil *"${profileKey}"* no encontrado. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no hay perfiles cargados'}.`;
    }

    // 🎯 Asignación por contacto: /perfil <key> <num/lid> o cita con número
    let contactTarget = argsParts.slice(1).join(' ').trim();

    // Si no hay target explícito pero el admin cita un mensaje con teléfono → per-contacto
    if (!contactTarget && rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const context = rawMsg.message.extendedTextMessage.contextInfo;
        const quotedText = context.quotedMessage?.conversation ||
                           context.quotedMessage?.extendedTextMessage?.text ||
                           "";
        const phoneMatch = quotedText.match(/(?:\+?\d[\d\s-]{6,20}\d|\b\d{7,16}\b)/);
        if (phoneMatch) contactTarget = parsePhoneOrLid(phoneMatch[0]);
    }

    if (contactTarget) {
        const res = setContactProfile(contactTarget, profileKey);
        if (res.success) {
            return `🎭 Perfil *${valid.nombre}* (\`${profileKey}\`) asignado al contacto:\n\`${res.target}\``;
        }
        return `⚠️ Error al asignar perfil: ${res.message}`;
    }

    // 🌐 Perfil global
    const globalRes = setCurrentProfile(profileKey);
    if (globalRes.success) {
        return `🎭 Perfil global de bot cambiado a: *${valid.nombre}* (\`${profileKey}\`)`;
    }
    return `⚠️ ${globalRes.message}`;
}

async function runUpdate({ sock, remoteJid, rawMsg }) {
    // El admin cita un documento .md con /update, o envía el documento con caption /update
    const quotedDoc = rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage ||
                      rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentWithCaptionMessage?.message?.documentMessage;
    const ownDoc = rawMsg?.message?.documentMessage || rawMsg?.message?.documentWithCaptionMessage?.message?.documentMessage;
    const docMsg = quotedDoc || ownDoc;
    const docKey = quotedDoc ? {
        key: {
            remoteJid,
            id: rawMsg.message.extendedTextMessage.contextInfo.stanzaId,
            participant: rawMsg.message.extendedTextMessage.contextInfo.participant || undefined
        },
        message: rawMsg.message.extendedTextMessage.contextInfo.quotedMessage
    } : rawMsg;

    if (!docMsg) {
        return usageOf('update');
    }

    await handleProfileUpload(sock, remoteJid, docMsg, docKey);
    return null; // handleProfileUpload ya respondió
}

module.exports = [
    { aliases: ['/perfil', '/pf', '/profile'], run: runPerfil },
    { aliases: ['/update', '/upd', '/import'], run: runUpdate }
];

module.exports.handleProfileUpload = handleProfileUpload;
