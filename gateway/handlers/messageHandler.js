const { state, isBotSentMessage } = require('../config');
const { extractUserMetadata, enrichContactExtraData, isSelfChat } = require('../services/metadataService');
const { upsertContactMetadata, getIgnoredNumbers, getAllowedNumbers } = require('../services/storageService');
const { processAIChat } = require('../services/brainService');
const { handleAdminCommand } = require('./commandHandler');

async function handleIncomingMessage(m, sock, store) {
    const msg = m.messages[0];
    if (!msg || !msg.message) return;

    // 🛑 ANTI-BUCLE: Ignorar mensajes generados por el propio bot
    if (msg.key.id && isBotSentMessage(msg.key.id)) {
        return;
    }

    const isFromMe = msg.key.fromMe;
    const metadata = extractUserMetadata(msg);
    const { remoteJid, phoneNumber, lid, savedName, pushName, candidateIds } = metadata;

    // 🗂️ GUARDAR / ACTUALIZAR CONTACTO EN BASE DE DATOS
    upsertContactMetadata(metadata);

    // 🔄 Enriquecimiento asíncrono en segundo plano (Foto de Perfil & Bio)
    enrichContactExtraData(sock, remoteJid, metadata);

    // Extraer texto del mensaje
    const textMessage = msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        msg.message?.imageMessage?.caption || 
                        "";
        
    if (!textMessage) return; // Ignorar si no hay texto

    const isSelf = isSelfChat(remoteJid, isFromMe);
    const displayName = savedName ? `${savedName} (Agenda)` : pushName;

    console.log(`\n🔍 [DEBUG CHAT] JID: ${remoteJid} | Phone: ${phoneNumber || 'N/A'} | LID: ${lid || 'N/A'} | From: "${displayName}" | isSelf: ${isSelf} | Texto: "${textMessage}"`);

    // -------------------------------------------------------------
    // SCENARIO 1: MENSAJES EN TU CHAT PROPIO (Self-Chat / Mensaje a ti mismo)
    // -------------------------------------------------------------
    if (isSelf) {
        if (textMessage.trim().startsWith('/')) {
            await handleAdminCommand(textMessage.trim(), remoteJid, sock, metadata, store);
            return;
        }

        console.log(`\n🤖 [ASISTENTE PERSONAL EN SELF-CHAT]: "${textMessage}"`);
        await processAIChat(textMessage, remoteJid, metadata, sock);
        return;
    }

    // -------------------------------------------------------------
    // SCENARIO 2: MENSAJES ENVIADOS POR TI EN CHATS DE CLIENTES
    // -------------------------------------------------------------
    if (isFromMe) {
        console.log(`\n🙈 [IGNORADO FORZADO] Escribiste en chat de cliente (${remoteJid}). Bot en silencio.`);
        return;
    }

    // -------------------------------------------------------------
    // SCENARIO 3: MENSAJES RECIBIDOS DE CLIENTES / TERCEROS
    // -------------------------------------------------------------

    // 🛡️ SEGURIDAD: Bloquear intentos de comandos / desde clientes
    if (textMessage.trim().startsWith('/')) {
        console.log(`\n🚫 [SEGURIDAD] Cliente (${displayName} - ${remoteJid}) intentó ejecutar comando admin: ${textMessage}`);
        return;
    }

    // 🛑 Si el bot está pausado globalmente, no responder a clientes
    if (state.IS_BOT_PAUSED) {
        console.log(`\n⏸️ [MENSAJE IGNORADO] Bot pausado. Mensaje de: ${displayName}`);
        return;
    }

    // -------------------------------------------------------------
    // 🛑 REGLA 1 (PRIORIDAD ALTA): COMPROBAR IGNORE_LIST (LISTA NEGRA)
    // -------------------------------------------------------------
    const ignoredNumbers = getIgnoredNumbers();
    const isIgnored = ignoredNumbers.some(num => {
        const cleanNum = String(num).replace(/[^0-9]/g, '');
        return candidateIds.some(cid => cid.includes(cleanNum));
    });

    if (isIgnored) {
        console.log(`\n🚫 [MENSAJE IGNORADO - IGNORELIST] De: ${displayName} | Teléfono: ${phoneNumber || 'N/A'} | LID: ${lid || 'N/A'} - Está en ignored_numbers.json`);
        return;
    }

    // -------------------------------------------------------------
    // 🔒 REGLA 2: COMPROBAR ALLOWED_LIST (LISTA BLANCA)
    // -------------------------------------------------------------
    const allowedNumbers = getAllowedNumbers();
    const isAllowed = allowedNumbers.includes("*") || allowedNumbers.some(num => {
        const cleanNum = String(num).replace(/[^0-9]/g, '');
        return candidateIds.some(cid => cid.includes(cleanNum));
    });

    if (!isAllowed) {
        console.log(`\n🚫 [MENSAJE IGNORADO - NO ALLOWED] De: ${displayName} | IDs: ${candidateIds.join(' / ')} - No está en allowed_numbers.json`);
        return;
    }

    // Procesar respuesta IA para el cliente con metadatos completos
    await processAIChat(textMessage, remoteJid, metadata, sock);
}

module.exports = {
    handleIncomingMessage
};
