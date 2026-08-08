const { state, isBotSentMessage, registerSentMessage } = require('../config');
const { extractUserMetadata, enrichContactExtraData, isSelfChat } = require('../services/metadataService');
const { 
    upsertContactMetadata, 
    getIgnoredNumbers, 
    getAllowedNumbers, 
    isContactHandoff, 
    setContactHandoff 
} = require('../services/storageService');
const { processAIChat } = require('../services/brainService');
const { handleAdminCommand } = require('./commandHandler');

// 🧠 DE-BOUNCE QUEUE (Acumulador Anti-Spam de mensajes ráfaga)
const messageBuffers = new Map();
const DEBOUNCE_DELAY_MS = 2500; // 2.5 segundos de ventana de acumulación

// Palabras clave para derivación automática a atención humana
const HUMAN_REQUEST_KEYWORDS = [
    'hablar con una persona',
    'hablar con persona',
    'hablar con humano',
    'atencion humana',
    'atención humana',
    'quiero un asesor',
    'hablar con un asesor',
    'hablar con asesor',
    'persona real',
    'necesito un ejecutivo',
    'hablar con ejecutivo',
    'hablar con un agente'
];

function checkHumanRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return HUMAN_REQUEST_KEYWORDS.some(keyword => lower.includes(keyword));
}

async function handleIncomingMessage(m, sock) {
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
            await handleAdminCommand(textMessage.trim(), remoteJid, sock, metadata);
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
        console.log(`\n⏸️ [MENSAJE IGNORADO] Bot pausado globalmente. Mensaje de: ${displayName}`);
        return;
    }

    // 🛑 REGLA 1 (PRIORIDAD ALTA): COMPROBAR IGNORE_LIST (LISTA NEGRA)
    const ignoredNumbers = getIgnoredNumbers();
    const isIgnored = ignoredNumbers.some(num => {
        const cleanNum = String(num).replace(/[^0-9]/g, '');
        return candidateIds.some(cid => cid.includes(cleanNum));
    });

    if (isIgnored) {
        console.log(`\n🚫 [MENSAJE IGNORADO - IGNORELIST] De: ${displayName} | Teléfono: ${phoneNumber || 'N/A'} | LID: ${lid || 'N/A'} - Está en ignored_numbers.json`);
        return;
    }

    // 🔒 REGLA 2: COMPROBAR ALLOWED_LIST (LISTA BLANCA)
    const allowedNumbers = getAllowedNumbers();
    const isAllowed = allowedNumbers.includes("*") || allowedNumbers.some(num => {
        const cleanNum = String(num).replace(/[^0-9]/g, '');
        return candidateIds.some(cid => cid.includes(cleanNum));
    });

    if (!isAllowed) {
        console.log(`\n🚫 [MENSAJE IGNORADO - NO ALLOWED] De: ${displayName} | IDs: ${candidateIds.join(' / ')} - No está en allowed_numbers.json`);
        return;
    }

    // -------------------------------------------------------------
    // 🤝 REGLA 3: DERIVACIÓN Y HANDOFF A ATENCIÓN HUMANA
    // -------------------------------------------------------------

    // A) Verificar si el cliente activó palabras clave de atención humana
    const wantsHuman = checkHumanRequest(textMessage);
    if (wantsHuman) {
        console.log(`\n🚨 [HANDOFF ACTIVADO] Cliente ${displayName} (${phoneNumber || lid}) solicitó atención humana.`);
        setContactHandoff(metadata, true);

        // 1. Notificar al Admin en Self-Chat
        const adminNotify = `🚨 **SOLICITUD DE ATENCIÓN HUMANA:**\n` +
            `- **Cliente:** ${displayName}\n` +
            `- **Teléfono:** ${phoneNumber || 'N/A'} | LID: ${lid || 'N/A'}\n` +
            `- **Mensaje:** "${textMessage}"\n\n` +
            `ℹ️ *La IA se ha pausado ÚNICAMENTE para este cliente.* Usa \`/auto ${phoneNumber || lid}\` para reanudar la IA para este usuario.`;

        if (state.ADMIN_PHONE || state.ADMIN_LID) {
            const adminJid = state.ADMIN_PHONE ? `${state.ADMIN_PHONE}@s.whatsapp.net` : `${state.ADMIN_LID}@lid`;
            sock.sendMessage(adminJid, { text: adminNotify }).catch(() => {});
        }

        // 2. Avisar al cliente
        const clientNotice = ` Un momento por favor. He notificado a un asesor humano para que revise tu solicitud a la brevedad.`;
        const sentNotice = await sock.sendMessage(remoteJid, { text: clientNotice });
        registerSentMessage(sentNotice);
        return;
    }

    // B) Verificar si el cliente ya tiene Handoff Activo (pausado individualmente)
    if (isContactHandoff(metadata)) {
        console.log(`\n🙈 [HANDOFF ACTIVO] IA pausada para cliente individual: ${displayName} (${phoneNumber || lid})`);
        return;
    }

    // -------------------------------------------------------------
    // 🧠 DE-BOUNCE QUEUE: ACUMULAR MENSAJES RÁFAGA ANTES DE LLAMAR A LA IA
    // -------------------------------------------------------------
    let existingBuffer = messageBuffers.get(remoteJid);

    if (existingBuffer) {
        clearTimeout(existingBuffer.timer);
        existingBuffer.messages.push(textMessage);
    } else {
        existingBuffer = {
            messages: [textMessage],
            timer: null
        };
        messageBuffers.set(remoteJid, existingBuffer);
    }

    existingBuffer.timer = setTimeout(async () => {
        const fullBufferedText = existingBuffer.messages.join('\n');
        messageBuffers.delete(remoteJid);

        console.log(`\n📦 [DE-BOUNCE BATCH] Procesando ${existingBuffer.messages.length} mensaje(s) acumulados de ${displayName}: "${fullBufferedText}"`);
        await processAIChat(fullBufferedText, remoteJid, metadata, sock);
    }, DEBOUNCE_DELAY_MS);
}

module.exports = {
    handleIncomingMessage
};
