const { state, isBotSentMessage, registerSentMessage } = require('../config');
const { extractUserMetadata, enrichContactExtraData, isSelfChat } = require('../services/metadataService');
const { 
    upsertContactMetadata
} = require('../services/contactsRepository');
const { 
    getSettingsDB,
    getContactsDB
} = require('../services/db');
const { setNumberState } = require('../services/stateService');
const { processAIChat } = require('../services/brainService');
const { enqueueAI, poolStats } = require('../services/aiQueue');
const { handleAdminCommand } = require('./commandHandler');
const { cat } = require('../services/logger');

// 📢 Logging por categoría ([AI], [DEBOUNCE], [PRESENCIA], [COMANDO], [ERROR])
const log = cat('DEBOUNCE');
const logAI = cat('AI');
const logPresencia = cat('PRESENCIA');
const logComando = cat('COMANDO');
const logError = cat('ERROR');

// 🧠 DE-BOUNCE QUEUE CON VINCULACIÓN DUAL PHONE/LID EN PRESENCIA Y MEMORIA LOCAL
const messageBuffers = new Map();
const activePresences = new Map();   // Mapa global en memoria RAM del estado de presencia
const chatInFlight = new Set();      // JIDs con una llamada de IA en curso (serialización por chat)
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
        log.info(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado/distraído (AFK). Esperando ${(afkMs / 1000).toFixed(0)}s (${(afkMs / 60000).toFixed(1)}m)...`);
        return afkMs;
    }

    // 2. Probabilidad del 12% de estar medianamente ocupado (1 - 2 min)
    if (roll < 0.17) { // 0.05 + 0.12 = 0.17
        const busyMs = Math.floor(60000 + Math.random() * 60000); // 60s a 120s
        log.info(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado brevemente. Esperando ${(busyMs / 1000).toFixed(0)}s (${(busyMs / 60000).toFixed(1)}m)...`);
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

// 🧹 Limpieza automática de RAM para evitar memory leaks en activePresences y messageBuffers
const PRESENCE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos
const PRESENCE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos
const BUFFER_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos: buffer huérfano se descarta

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of activePresences.entries()) {
        if (now - value.time > PRESENCE_MAX_AGE_MS) {
            activePresences.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) log.info(`🧹 [LIMPIEZA RAM] Eliminados ${cleaned} registros de presencia antiguos.`);

    // Descartar buffers huérfanos (bot pausado, handoff, caída de conexión, etc.)
    let cleanedBuffers = 0;
    for (const [jid, buf] of messageBuffers.entries()) {
        if (chatInFlight.has(jid)) continue; // No tocar chats con IA en curso
        if (now - buf.lastActivity > BUFFER_MAX_AGE_MS) {
            if (buf.timer) clearTimeout(buf.timer);
            if (buf.typingExpiryTimer) clearTimeout(buf.typingExpiryTimer);
            messageBuffers.delete(jid);
            cleanedBuffers++;
        }
    }
    if (cleanedBuffers > 0) log.info(`🧹 [LIMPIEZA RAM] Descartados ${cleanedBuffers} buffers de mensajes huérfanos.`);
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

    logPresencia.info(`📡 [PRESENCIA RECIBIDA] ID: ${id} | Candidatos: [${candidates.join(', ')}] | Estado: "${presenceState}"`);

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
            buffer.lastActivity = Date.now();
            if (isTyping) {
                buffer.isTyping = true;
                buffer.lastTypingTime = Date.now();
                
                // Destruir el timer de 8s mientras el usuario siga tecleando/grabando
                if (buffer.timer) {
                    clearTimeout(buffer.timer);
                    buffer.timer = null;
                }
                log.info(`\n⌨️ [DE-BOUNCE MEMORIA] Cliente (${bufferJid}) ESTÁ ESCRIBIENDO (${presenceState}). Timer de 8s en pausa.`);

                // Expiración automática a los 5s si deja de presionar teclas sin enviar evento paused
                if (buffer.typingExpiryTimer) clearTimeout(buffer.typingExpiryTimer);
                buffer.typingExpiryTimer = setTimeout(() => {
                    if (buffer && buffer.isTyping) {
                        buffer.isTyping = false;
                        const delayMs = getAdaptiveDebounceMs(buffer.messages);
                        log.info(`\n⏱️ [TECLADO LIBERADO] 5s inactivo en teclado (${bufferJid}). Iniciando timer de ${(delayMs / 1000).toFixed(1)}s.`);
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
                log.info(`\n⏳ [PRESENCIA PAUSADA] Cliente (${bufferJid}) PAUSÓ escritura (${presenceState}). Reseteando timer a ${(delayMs / 1000).toFixed(1)}s.`);
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
    sock.presenceSubscribe(remoteJid).catch(e => logError.error(`⚠️ Error al suscribir presencia de ${remoteJid}:`, e.message));
    if (phoneNumber) sock.presenceSubscribe(`${phoneNumber}@s.whatsapp.net`).catch(e => logError.error(`⚠️ Error al suscribir presencia (Phone) de ${phoneNumber}:`, e.message));
    if (lid) sock.presenceSubscribe(`${lid}@lid`).catch(e => logError.error(`⚠️ Error al suscribir presencia (LID) de ${lid}:`, e.message));

    // 🗂️ GUARDAR / ACTUALIZAR CONTACTO EN BASE DE DATOS
    const contactRecord = upsertContactMetadata(metadata) || { estado: 'neutro' };

    // 🔄 Enriquecimiento asíncrono en segundo plano (Foto de Perfil & Bio)
    enrichContactExtraData(sock, remoteJid, metadata);

    // Extraer texto del mensaje
    const textMessage = msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        msg.message?.imageMessage?.caption || 
                        msg.message?.documentMessage?.caption || 
                        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption || 
                        "";
        
    if (!textMessage) return; // Ignorar si no hay texto

    const isSelf = isSelfChat(remoteJid, isFromMe);
    const displayName = savedName ? `${savedName} (Agenda)` : pushName;

    logAI.info(`\n🔍 [DEBUG CHAT] JID: ${remoteJid} | Phone: ${phoneNumber || 'N/A'} | LID: ${lid || 'N/A'} | From: "${displayName}" | isSelf: ${isSelf} | Texto: "${textMessage}"`);

    // -------------------------------------------------------------
    // SCENARIO 1: MENSAJES EN TU CHAT PROPIO (Self-Chat / Mensaje a ti mismo)
    // -------------------------------------------------------------
    if (isSelf) {
        if (textMessage.trim().startsWith('/')) {
            await handleAdminCommand(textMessage.trim(), remoteJid, sock, metadata, msg);
            return;
        }

        logAI.info(`\n🤖 [ASISTENTE PERSONAL EN SELF-CHAT]: "${textMessage}"`);
        await enqueueAI(() => processAIChat(textMessage, remoteJid, metadata, sock));
        return;
    }

    // -------------------------------------------------------------
    // SCENARIO 2: MENSAJES ENVIADOS POR TI EN CHATS DE CLIENTES
    // -------------------------------------------------------------
    if (isFromMe) {
        log.info(`\n🙈 [IGNORADO FORZADO] Escribiste en chat de cliente (${remoteJid}). Bot en silencio.`);
        return;
    }

    // -------------------------------------------------------------
    // SCENARIO 3: MENSAJES RECIBIDOS DE CLIENTES / TERCEROS
    // -------------------------------------------------------------

    // 🛡️ SEGURIDAD: Bloquear intentos de comandos / desde clientes
    if (textMessage.trim().startsWith('/')) {
        logComando.info(`\n🚫 [SEGURIDAD] Cliente (${displayName} - ${remoteJid}) intentó ejecutar comando admin: ${textMessage}`);
        return;
    }

    // 🛑 Si el bot está pausado globalmente, no responder a clientes
    if (state.IS_BOT_PAUSED) {
        log.info(`\n⏸️ [MENSAJE IGNORADO] Bot pausado globalmente. Mensaje de: ${displayName}`);
        return;
    }

    // -------------------------------------------------------------
    // 🛡️ REGLAS DE ESTADOS EN BASE DE DATOS (ContactsDB)
    // -------------------------------------------------------------
    const settings = getSettingsDB();
    const estado = contactRecord.estado || 'neutro';

    if (estado === 'ignorado') {
        log.info(`\n🚫 [MENSAJE IGNORADO - ESTADO IGNORADO] De: ${displayName}`);
        return;
    }

    if (estado === 'permitido') {
        log.info(`\n✅ [PERMITIDO EXPLÍCITAMENTE] De: ${displayName}`);
        // Puede proceder, se salta la evaluación del modo global
    } else if (estado === 'neutro') {
        // Evaluar Modo Global
        const globalMode = state.GLOBAL_MODE || settings.globalMode || 'allowed_all';
        if (globalMode === 'ignored_all') {
            log.info(`\n🚫 [MENSAJE IGNORADO - MODO GLOBAL ESTRICTO] De: ${displayName}`);
            return;
        }
    }

    // -------------------------------------------------------------
    // 🤝 REGLA 3: DERIVACIÓN Y HANDOFF A ATENCIÓN HUMANA
    // -------------------------------------------------------------

    // A) Verificar si el cliente activó palabras clave de atención humana
    const wantsHuman = checkHumanRequest(textMessage);
    if (wantsHuman) {
        logAI.info(`\n🚨 [HANDOFF ACTIVADO] Cliente ${displayName} (${phoneNumber || lid}) solicitó atención humana.`);
        const targetId = phoneNumber || lid;
        setNumberState(targetId, 'handoff');

        // 1. Notificar al Admin en Self-Chat
        const adminNotify = `🚨 *SOLICITUD DE ATENCIÓN HUMANA*\n\n` +
            `• *Cliente:* ${displayName}\n` +
            `• *Teléfono:* \`${phoneNumber || 'N/A'}\`\n` +
            `• *LID:* \`${lid || 'N/A'}\`\n` +
            `• *Mensaje:* "${textMessage}"\n\n` +
            `📋 *Comando para reanudar IA (Toca para copiar):*\n` +
            `\`\`\`/auto ${targetId}\`\`\`\n\n` +
            `💡 *Tip:* También puedes responder (citar) a esta alerta escribiendo solo \`/auto\` o \`/a\`.`;

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
    if (estado === 'handoff') {
        logAI.info(`\n🙈 [HANDOFF ACTIVO] IA pausada para cliente individual: ${displayName} (${phoneNumber || lid})`);
        return;
    }

    // -------------------------------------------------------------
    // 🧠 DE-BOUNCE QUEUE CON VERIFICACIÓN EN MEMORIA LOCAL Y EN SEGUNDO PLANO
    // -------------------------------------------------------------

    // 🔒 SERIALIZACIÓN POR CHAT: si la IA ya está respondiendo para este cliente,
    // acumulamos mensajes sin timer; al terminar la llamada se programa el siguiente lote.
    if (chatInFlight.has(remoteJid)) {
        let inflightBuffer = messageBuffers.get(remoteJid);
        if (inflightBuffer) {
            inflightBuffer.messages.push(textMessage);
            inflightBuffer.lastActivity = Date.now();
            inflightBuffer.onTimeout = createBufferTimeout(remoteJid, metadata, sock);
            if (inflightBuffer.timer) clearTimeout(inflightBuffer.timer);
            if (inflightBuffer.typingExpiryTimer) clearTimeout(inflightBuffer.typingExpiryTimer);
            inflightBuffer.timer = null;
        } else {
            messageBuffers.set(remoteJid, {
                messages: [textMessage],
                isTyping: false,
                lastTypingTime: null,
                lastActivity: Date.now(),
                onTimeout: createBufferTimeout(remoteJid, metadata, sock),
                timer: null,
                typingExpiryTimer: null
            });
        }
        logAI.info(`⏳ [IA EN CURSO] Cliente (${displayName}) escribió mientras la IA responde. ${messageBuffers.get(remoteJid).messages.length} msg(s) en espera.`);
        return;
    }

    let existingBuffer = messageBuffers.get(remoteJid);

    const onTimeout = createBufferTimeout(remoteJid, metadata, sock);

    if (existingBuffer) {
        if (existingBuffer.timer) clearTimeout(existingBuffer.timer);
        existingBuffer.messages.push(textMessage);
        existingBuffer.onTimeout = onTimeout;
        existingBuffer.lastActivity = Date.now();

        // Resetear timer al recibir mensaje físico con delay estocástico/adaptativo
        const delayMs = getAdaptiveDebounceMs(existingBuffer.messages);
        existingBuffer.timer = setTimeout(onTimeout, delayMs);
        log.info(`⏳ [DE-BOUNCE RESET] Nuevo mensaje recibido de ${displayName}. Timer de ${(delayMs / 1000).toFixed(1)}s de silencio iniciado.`);
    } else {
        const newBuffer = {
            messages: [textMessage],
            isTyping: false,
            lastTypingTime: null,
            lastActivity: Date.now(),
            onTimeout: onTimeout,
            timer: null,
            typingExpiryTimer: null
        };

        const delayMs = getAdaptiveDebounceMs(newBuffer.messages);
        newBuffer.timer = setTimeout(onTimeout, delayMs);
        messageBuffers.set(remoteJid, newBuffer);
        log.info(`⏳ [DE-BOUNCE START] Primer mensaje de ${displayName}. Timer de ${(delayMs / 1000).toFixed(1)}s de silencio iniciado.`);
    }
}

/**
 * ⏱️ Crea el cierre (closure) del timer de de-bounce para un chat específico.
 * Al expirar el silencio, verifica presencia local, envía a la IA y, si durante
 * la llamada llegaron mensajes nuevos, programa el siguiente lote (serializado).
 */
function createBufferTimeout(remoteJid, metadata, sock) {
    const displayName = metadata.savedName ? `${metadata.savedName} (Agenda)` : (metadata.pushName || 'Desconocido');
    const phoneNumber = metadata.phoneNumber;
    const lid = metadata.lid;

    return async function onTimeout() {
        const buf = messageBuffers.get(remoteJid);
        if (!buf) return;

        // 🔒 Guarda: si otra llamada de IA sigue en curso para este chat, no hacer nada
        // (el lote pendiente se reprograma cuando finalice la llamada activa).
        if (chatInFlight.has(remoteJid)) return;

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
            log.info(`\n🔄 [MEMORIA LOCAL] Cliente (${displayName}) sigue escribiendo ('${latestPresence?.state || 'composing'}'). Postergando envío a IA por ${(delayMs / 1000).toFixed(1)}s...`);
            if (buf.timer) clearTimeout(buf.timer);
            buf.timer = setTimeout(buf.onTimeout, delayMs);
            return;
        }

        // LUZ VERDE: SILENCIO DE DEBOUNCE CUMPLIDO REALMENTE
        if (buf.typingExpiryTimer) clearTimeout(buf.typingExpiryTimer);
        if (buf.timer) clearTimeout(buf.timer);

        const fullBufferedText = buf.messages.join('\n');
        buf.messages = []; // Los mensajes procesados salen del buffer; no se borra el buffer aún

        log.info(`\n📦 [DE-BOUNCE BATCH FINAL] Silencio confirmado. Procesando mensaje(s) de ${displayName}:\n"${fullBufferedText}"`);

        chatInFlight.add(remoteJid);
        try {
            // 🎯 La cola FIFO global limita las llamadas simultáneas a la IA
            const { active, queued } = poolStats();
            logAI.info(`🎯 [POOL AI] Esperando turno en cola global (activas: ${active}, en cola: ${queued})...`);
            await enqueueAI(() => processAIChat(fullBufferedText, remoteJid, metadata, sock));
        } finally {
            chatInFlight.delete(remoteJid);

            // Si llegaron mensajes durante la llamada de IA, programar el siguiente lote
            const bufAfter = messageBuffers.get(remoteJid);
            if (bufAfter && bufAfter.messages.length > 0) {
                if (bufAfter.timer) clearTimeout(bufAfter.timer);
                const delayMs = getAdaptiveDebounceMs(bufAfter.messages);
                bufAfter.timer = setTimeout(bufAfter.onTimeout, delayMs);
                logAI.info(`⏳ [IA TERMINADA] Cliente (${displayName}) tiene ${bufAfter.messages.length} msg(s) en espera. Timer de ${(delayMs / 1000).toFixed(1)}s iniciado.`);
            } else if (bufAfter) {
                if (bufAfter.timer) clearTimeout(bufAfter.timer);
                messageBuffers.delete(remoteJid);
            }
        }
    };
}

module.exports = {
    handleIncomingMessage,
    handlePresenceUpdate
};
