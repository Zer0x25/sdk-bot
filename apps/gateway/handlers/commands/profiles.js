/**
 * 🎭 PERFILES SOUL (/perfil, /update, /import) + subida de .md desde WhatsApp
 */
const { registerSentMessage } = require('../../config');
const { cat, safeErrorLabel } = require("../../services/logger");
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { setCurrentProfile, setContactProfile } = require('../../services/stateService');
const { getAvailableProfiles, getProfileDetail, exportProfileFile, importProfileFile, deleteProfileFile } = require('../../services/brainService');
const { usageOf, syntaxError, extractPhoneFromQuoted } = require('../commandHelpers');

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
async function handleProfileUpload(adapter, remoteJid, docMessage, msgKey) {
    try {
        const fileName = docMessage?.fileName || 'perfil.md';
        const match = fileName.match(/^([a-z0-9_-]+)\.(md|txt)$/i);
        if (!match) {
            await adapter.sendMessage(remoteJid, `⚠️ *Archivo no válido:* \`${fileName}\`. Debe llamarse \`perfil.md\` o \`<key>.md\` (ej: \`lucia.md\`).`);
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
            await adapter.sendMessage(remoteJid, `⚠️ No pude descargar el archivo \`${fileName}\`. Intenta reenviarlo citándolo con \`/update\`.`);
            return false;
        }

        const content = buffer.toString('utf8');
        const result = await importProfileFile(profileKey, content);

        if (result && result.success) {
            const sent = await adapter.sendMessage(remoteJid, `✅ *Perfil \`${profileKey}\` actualizado:*\n` +
                    `• *Nombre:* ${result.nombre}\n` +
                    `• *Reglas:* ${result.reglas} | *Ejemplos:* ${result.ejemplos}\n\n` +
                    `Comprueba el prompt: \`/perfil ver ${profileKey}\``);
            registerSentMessage(sent);
            return true;
        }

        const sent = await adapter.sendMessage(remoteJid, `⚠️ *Rechazado* (${fileName}): ${result?.message || 'Brain apagado o error de importación'}. El perfil no fue modificado.`);
        registerSentMessage(sent);
        return false;
    } catch (e) {
        logError.error(`⚠️ Error al importar perfil desde documento (${safeErrorLabel(e)}).`);
        await adapter.sendMessage(remoteJid, `⚠️ Error al importar el perfil: ${e.message}`).catch(() => {});
        return false;
    }
}

async function runPerfil({ adapter, remoteJid, queryParam, rawMsg }) {
    const profiles = await getAvailableProfiles();

    if (!queryParam) {
        return usageOf('perfil');
    }

    // 📄 /perfil ver <key> → muestra el system prompt compilado
    if (queryParam.toLowerCase().startsWith('ver ')) {
        const keyToShow = queryParam.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
        if (!keyToShow) {
            return usageOf('perfil');
        }
        const detail = await getProfileDetail(keyToShow);
        if (detail && detail.prompt) {
            return `📄 *Perfil ${detail.nombre} (\`${detail.key}\`)*\n━━━━━━━━━━━━━━━━━━━━━━\n${detail.prompt}`;
        }
        return syntaxError('perfil', `Perfil *"${keyToShow}"* no encontrado o brain apagado. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ')}.`);
    }

    // 🗑️ /perfil eliminar <key> → borra el .md del perfil en el brain
    if (['eliminar', 'borrar', 'delete', 'del', 'rm'].includes(queryParam.toLowerCase().split(/\s+/)[0])) {
        const keyToDelete = queryParam.toLowerCase().split(/\s+/).slice(1).join(' ').trim();
        if (!keyToDelete) {
            return usageOf('perfil');
        }
        const delResult = await deleteProfileFile(keyToDelete);
        if (delResult && delResult.success) {
            return `🗑️ *Perfil \`${keyToDelete}\` eliminado.*\n\nRecuerda: si un contacto tenía ese perfil asignado, el brain caerá a \`default\`.`;
        }
        return syntaxError('perfil', `No pude borrar *"${keyToDelete}"*: ${(delResult && delResult.detail) || 'no encontrado o brain apagado'}.`);
    }

    // 📤 /perfil exportar <key> → envía el .md al self-chat para editar
    if (queryParam.toLowerCase().startsWith('exportar ') || queryParam.toLowerCase() === 'exportar') {
        const keyToExport = queryParam.toLowerCase().startsWith('exportar ')
            ? queryParam.split(/\s+/).slice(1).join(' ').trim().toLowerCase()
            : '';
        if (!keyToExport) {
            return usageOf('perfil');
        }
        const exported = await exportProfileFile(keyToExport);
        if (!exported) {
            return syntaxError('perfil', `Perfil *"${keyToExport}"* no encontrado o brain apagado.`);
        }
        try {
            await adapter.sendMessage(remoteJid, {
                document: Buffer.from(exported.content, 'utf8'),
                fileName: exported.filename,
                caption: `📤 Perfil *${keyToExport}*. Edítalo y envíalo citando este archivo con \`/update\`.`
            }, { mimetype: 'text/markdown' });
            return null; // La respuesta es el propio documento
        } catch (e) {
            logError.error(`⚠️ Error al enviar documento de perfil (${safeErrorLabel(e)}).`);
            return `⚠️ Error al enviar el archivo de perfil: ${e.message}`;
        }
    }

    const argsParts = queryParam.split(/\s+/);
    const profileKey = argsParts[0].toLowerCase();
    const valid = profiles.find(p => p.key === profileKey);

    if (!valid) {
        return syntaxError('perfil', `Perfil *"${profileKey}"* no encontrado. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no hay perfiles cargados'}.`);
    }

    // 🎯 Asignación por contacto: /perfil <key> <num/lid> o cita con número
    let contactTarget = argsParts.slice(1).join(' ').trim();

    // Si no hay target explícito pero el admin cita un mensaje con teléfono → per-contacto
    if (!contactTarget) {
        const quoted = extractPhoneFromQuoted(rawMsg);
        if (quoted) contactTarget = quoted;
    }

    if (contactTarget) {
        const res = await setContactProfile(contactTarget, profileKey, {
            channel: adapter?.channel || 'whatsapp', accountId: adapter?.accountId || null
        });
        if (res.success) {
            return `🎭 Perfil *${valid.nombre}* (\`${profileKey}\`) asignado al contacto:\n\`${res.target}\``;
        }
        return `⚠️ Error al asignar perfil: ${res.message}`;
    }

    // 🌐 Perfil global
    const globalRes = await setCurrentProfile(profileKey);
    if (globalRes.success) {
        return `🎭 Perfil global de bot cambiado a: *${valid.nombre}* (\`${profileKey}\`)`;
    }
    return `⚠️ ${globalRes.message}`;
}

async function runUpdate({ adapter, remoteJid, rawMsg }) {
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

    await handleProfileUpload(adapter, remoteJid, docMsg, docKey);
    return null; // handleProfileUpload ya respondió
}

module.exports = [
    { aliases: ['/perfil', '/pf', '/profile'], run: runPerfil },
    { aliases: ['/update', '/upd', '/import'], run: runUpdate }
];

module.exports.handleProfileUpload = handleProfileUpload;
