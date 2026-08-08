const { state, isBotSentMessage, registerSentMessage } = require('../config');
const { extractUserMetadata, enrichContactExtraData, isSelfChat } = require('../services/metadataService');
const { 
    upsertContactMetadata, 
    getIgnoredNumbers, 
    getAllowedNumbers, 
    getContactsDB,
    isContactHandoff, 
    setContactHandoff 
} = require('../services/storageService');
const { processAIChat } = require('../services/brainService');
const { handleAdminCommand } = require('./commandHandler');

// 🧠 DE-BOUNCE QUEUE CON VINCULACIÓN DUAL PHONE/LID EN PRESENCIA Y MEMORIA LOCAL
const messageBuffers = new Map();
const activePresences = new Map();   // Mapa global en memoria RAM del estado de presencia
const TYPING_TTL_MS = 5000;           // 5.0 segundos: el estado de tecleo expira si el teclado queda inactivo

/**
 * 🎲 CALCULAR DEBOUNCE ADAPTATIVO CON DISTRACCIÓN/OCUPACIÓN HUMANA (RANDOM SOBRE RANDOM)
 * Capa 1 (Distracción/Ocupación):
 *   - ~5%  probabilidad: "Muy Ocupado / AFK" -> Espera de 3 a 4 min (180s - 240s)
 *   - ~12% probabilidad: "Ocupado / Distraído" -> Espera de 1 a 2 min (60s - 120s)
 * Capa 2 (Adaptativo Normal ~83%):
 *   - 1 mensaje corto (<20 chars): Espera de 5s a 7s
 *   - Múltiples mensajes o texto largo: Espera de 7.5s a 12s
 */
function getAdaptiveDebounceMs(messagesArray = []) {
    const roll = Math.random(); // 0.0 a 1.0

    // 1. Probabilidad del 5% de estar muy ocupado / AFK (3 - 4 min)
    if (roll < 0.05) {
        const afkMs = Math.floor(180000 + Math.random() * 60000); // 180s a 240s
        console.log(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado/distraído (AFK). Esperando ${(afkMs / 1000).toFixed(0)}s (${(afkMs / 60000).toFixed(1)}m)...`);
        return afkMs;
    }

    // 2. Probabilidad del 12% de estar medianamente ocupado (1 - 2 min)
    if (roll < 0.17) { // 0.05 + 0.12 = 0.17
        const busyMs = Math.floor(60000 + Math.random() * 60000); // 60s a 120s
        console.log(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado brevemente. Esperando ${(busyMs / 1000).toFixed(0)}s (${(busyMs / 60000).toFixed(1)}m)...`);
        return busyMs;
    }

    // 3. Adaptativo Normal (~83% restante)
    const msgs = Array.isArray(messagesArray) ? messagesArray : [];
    const totalLength = msgs.join(' ').length;
    const msgCount = msgs.length;

    let normalMs;
    if (msgCount === 1 && totalLength < 20) {
        // Mensaje único y corto ("Hola", "Precio", etc.) -> 5s a 7s
        normalMs = Math.floor(5000 + Math.random() * 2000);
    } else {
        // Mensajes largos o múltiples -> 7.5s a 12s
        normalMs = Math.floor(7500 + Math.random() * 4500);
    }

    return normalMs;
}

// 🧹 Limpieza automática de RAM para evitar memory leaks en activePresences
const PRESENCE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos
const PRESENCE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of activePresences.entries()) {
        if (now - value.time > PRESENCE_MAX_AGE_MS) {
            activePresences.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`🧹 [LIMPIEZA RAM] Eliminados ${cleaned} registros de presencia antiguos.`);
}, PRESENCE_CLEANUP_INTERVAL_MS);

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

/**
 * 🔀 Resolver todos los IDs vinculados (Phone y LID) para un JID entrante
 */
function getCandidateIdsForPresence(id) {
    const clean = String(id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const set = new Set([clean, String(id)]);

    const db = getContactsDB();
    const contact = Object.values(db).find(c => 
        (c.phone && c.phone.includes(clean)) || 
        (c.lid && c.lid.includes(clean))
    );

    if (contact) {
        if (contact.phone) set.add(contact.phone.replace(/[^0-9]/g, ''));
        if (contact.lid) set.add(contact.lid.replace(/[^0-9]/g, ''));
    }

    return Array.from(set);
}

/**
 * ⌨️ GESTIÓN DE PRESENCIA DE BAILEYS (composing / recording / paused / available)
 * Guarda el estado en la memoria RAM local (activePresences) vinculando Phone y LID.
 */
function handlePresenceUpdate(id, presences) {
    if (!id || !presences) return;
    
    const userPresence = presences[id] || Object.values(presences)[0];
    if (!userPresence) return;

    const presenceState = userPresence.lastKnownPresence;
    const candidates = getCandidateIdsForPresence(id);

    console.log(`📡 [PRESENCIA RECIBIDA] ID: ${id} | Candidatos: [${candidates.join(', ')}] | Estado: "${presenceState}"`);

    // 💾 Guardar estado exacto en memoria RAM para todos sus IDs (Phone y LID)
    candidates.forEach(cid => {
        activePresences.set(cid, { state: presenceState, time: Date.now() });
    });

    const isTyping = presenceState === 'composing' || presenceState === 'recording';
    const isPaused = presenceState === 'paused' || presenceState === 'available';

    // Buscar buffer que coincida con cualquiera de los candidatos (Phone o LID)
    for (const [bufferJid, buffer] of messageBuffers.entries()) {
        const cleanBuffer = bufferJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const isMatch = candidates.some(cid => bufferJid.includes(cid) || cleanBuffer.includes(cid));
        
        if (isMatch) {
            if (isTyping) {
                buffer.isTyping = true;
                buffer.lastTypingTime = Date.now();
                
                // Destruir el timer de 8s mientras el usuario siga tecleando/grabando
                if (buffer.timer) {
                    clearTimeout(buffer.timer);
                    buffer.timer = null;
                }
                console.log(`\n⌨️ [DE-BOUNCE MEMORIA] Cliente (${bufferJid}) ESTÁ ESCRIBIENDO (${presenceState}). Timer de 8s en pausa.`);

                // Expiración automática a los 5s si deja de presionar teclas sin enviar evento paused
                if (buffer.typingExpiryTimer) clearTimeout(buffer.typingExpiryTimer);
                buffer.typingExpiryTimer = setTimeout(() => {
                    if (buffer && buffer.isTyping) {
                        buffer.isTyping = false;
                        const delayMs = getAdaptiveDebounceMs(buffer.messages);
                        console.log(`\n⏱️ [TECLADO LIBERADO] 5s inactivo en teclado (${bufferJid}). Iniciando timer de ${(delayMs / 1000).toFixed(1)}s.`);
                        if (!buffer.timer) {
                            buffer.timer = setTimeout(buffer.onTimeout, delayMs);
                        }
                    }
                }, TYPING_TTL_MS);

            } else if (isPaused) {
                buffer.isTyping = false;
                if (buffer.typingExpiryTimer) clearTimeout(buffer.typingExpiryTimer);
                if (buffer.timer) clearTimeout(buffer.timer);
                
                const delayMs = getAdaptiveDebounceMs(buffer.messages);
                buffer.timer = setTimeout(buffer.onTimeout, delayMs);
                console.log(`\n⏳ [PRESENCIA PAUSADA] Cliente (${bufferJid}) PAUSÓ escritura (${presenceState}). Reseteando timer a ${(delayMs / 1000).toFixed(1)}s.`);
            }
        }
    }
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

    // 🔔 SUSCRIBIR EN TIEMPO REAL A EVENTOS DE PRESENCIA (composing/paused) DE ESTE CLIENTE AL INICIAR
    sock.presenceSubscribe(remoteJid).catch(e => console.error(`⚠️ Error al suscribir presencia de ${remoteJid}:`, e.message));
    if (phoneNumber) sock.presenceSubscribe(`${phoneNumber}@s.whatsapp.net`).catch(e => console.error(`⚠️ Error al suscribir presencia (Phone) de ${phoneNumber}:`, e.message));
    if (lid) sock.presenceSubscribe(`${lid}@lid`).catch(e => console.error(`⚠️ Error al suscribir presencia (LID) de ${lid}:`, e.message));

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
    // 🧠 DE-BOUNCE QUEUE CON VERIFICACIÓN EN MEMORIA LOCAL Y EN SEGUNDO PLANO
    // -------------------------------------------------------------
    let existingBuffer = messageBuffers.get(remoteJid);

    const onTimeout = async () => {
        const buf = messageBuffers.get(remoteJid);
        if (!buf) return;

        // 🧠 REVISAR ESTADO EN LA MEMORIA LOCAL DE LA APP (Candidatos Múltiples)
        const candidates = getCandidateIdsForPresence(remoteJid);
        if (phoneNumber) candidates.push(phoneNumber.replace(/[^0-9]/g, ''));
        if (lid) candidates.push(lid.replace(/[^0-9]/g, ''));

        let latestPresence = null;
        for (const cid of candidates) {
            const p = activePresences.get(cid);
            if (p) {
                if (!latestPresence || p.time > latestPresence.time) {
                    latestPresence = p;
                }
            }
        }

        const isTypingLocal = (latestPresence && (latestPresence.state === 'composing' || latestPresence.state === 'recording') && (Date.now() - latestPresence.time < TYPING_TTL_MS)) || buf.isTyping;

        if (isTypingLocal) {
            const delayMs = getAdaptiveDebounceMs(buf.messages);
            console.log(`\n🔄 [MEMORIA LOCAL] Cliente (${displayName}) sigue escribiendo ('${latestPresence?.state || 'composing'}'). Postergando envío a IA por ${(delayMs / 1000).toFixed(1)}s...`);
            if (buf.timer) clearTimeout(buf.timer);
            buf.timer = setTimeout(buf.onTimeout, delayMs);
            return;
        }

        // LUZ VERDE: SILENCIO DE DEBOUNCE CUMPLIDO REALMENTE
        if (buf.typingExpiryTimer) clearTimeout(buf.typingExpiryTimer);
        if (buf.timer) clearTimeout(buf.timer);

        const fullBufferedText = buf.messages.join('\n');
        messageBuffers.delete(remoteJid);

        console.log(`\n📦 [DE-BOUNCE BATCH FINAL] Silencio confirmado. Procesando ${buf.messages.length} mensaje(s) de ${displayName}:\n"${fullBufferedText}"`);
        await processAIChat(fullBufferedText, remoteJid, metadata, sock);
    };

    if (existingBuffer) {
        if (existingBuffer.timer) clearTimeout(existingBuffer.timer);
        existingBuffer.messages.push(textMessage);
        existingBuffer.onTimeout = onTimeout;

        // Resetear timer al recibir mensaje físico con delay estocástico/adaptativo
        const delayMs = getAdaptiveDebounceMs(existingBuffer.messages);
        existingBuffer.timer = setTimeout(onTimeout, delayMs);
        console.log(`⏳ [DE-BOUNCE RESET] Nuevo mensaje recibido de ${displayName}. Timer de ${(delayMs / 1000).toFixed(1)}s de silencio iniciado.`);
    } else {
        const newBuffer = {
            messages: [textMessage],
            isTyping: false,
            lastTypingTime: null,
            onTimeout: onTimeout,
            timer: null,
            typingExpiryTimer: null
        };

        const delayMs = getAdaptiveDebounceMs(newBuffer.messages);
        newBuffer.timer = setTimeout(onTimeout, delayMs);
        messageBuffers.set(remoteJid, newBuffer);
        console.log(`⏳ [DE-BOUNCE START] Primer mensaje de ${displayName}. Timer de ${(delayMs / 1000).toFixed(1)}s de silencio iniciado.`);
    }
}

module.exports = {
    handleIncomingMessage,
    handlePresenceUpdate
};
