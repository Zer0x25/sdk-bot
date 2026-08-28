const { state, registerSentMessage } = require('../config');
const { enrichContactExtraData, isSelfChat } = require('../services/metadataService');
const { upsertContactMetadata, isHandoffActive } = require('../services/contactsRepository');
const { setNumberState } = require('../services/stateService');
const { processAIChat } = require('../services/brainService');
const { enqueueAI, poolStats } = require('../services/aiQueue');
const messageQueue = require('../services/messageQueue');
const { getAdaptiveDebounceMs, getCandidateIdsForPresence, decideMessageFlow } = require('../services/pipeline');
const { handleAdminCommand } = require('./commandHandler');
const { tryConfirm } = require('../services/broadcastService');
const { tryCleanConfirm } = require('../services/resetCleanFlow');
const { cat } = require('../services/logger');
const chatStore = require('../store/chatStore'); // Opción C: store RAM de mensajes de Baileys (precarga web-like)
const { num } = require('../tuning');
const { getChatHistory } = require('../services/brainService');

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
const TYPING_TTL_MS = num('GATEWAY_TYPING_TTL_MS', 5000);           // 5.0 segundos: el estado de tecleo expira si el teclado queda inactivo (tunable vía .env.tuning)

// 🧠 PRECARGA DE HISTORIAL EN PRESENCIA (Opción C, "señal de intervención web-like")
// Al detectar que el cliente está escribiendo (composing), precargamos el
// historial de ese chat. La fuente se elige con GATEWAY_PRELOAD_SOURCE:
//   - 'baileys' (default): lee el hilo REAL desde el store RAM de Baileys
//     (lo que el web muestra al abrir el chat: tuyo + cliente + bot). On-demand
//     por chat, NO masivo (no se extrae la historia de los 1000 contactos).
//   - 'brain': legacy, va al brain SQLite (solo lo que el bot respondió).
// La precarga es SOLO señal: NO se inyecta en /chat (etapa 2 usa el contexto
// COMPLETO del brain). El dedup por TTL evita recargas innecesarias.
const PRELOAD_ENABLED = num('GATEWAY_PRELOAD_ENABLED', 0) === 1;
const PRELOAD_TTL_MS = num('GATEWAY_PRELOAD_TTL_MS', 180000);       // 3 min: el precargo caliente dura esto antes de refrescar (tunable vía .env.tuning)
const PRELOAD_ONLY_DIRECT = num('GATEWAY_PRELOAD_ONLY_DIRECT', 1) === 1; // solo chats 1-a-1 (no grupos) por defecto
const PRELOAD_SOURCE = (num('GATEWAY_PRELOAD_SOURCE', 'baileys') || 'baileys').toString().toLowerCase(); // 'baileys' | 'brain'
// Límites de la "primera página" de la precarga (etapa 1, web-like). Son MENORES
// que los de respuesta: la precarga es solo señal de intervención
// (el bot "ya sabe de qué va" al abrir el chat) y NO se usa para contestar.
// /chat sigue usando el contexto COMPLETO (BRAIN_MEMORY_* = 7d / 5000 tok).
// Precarga por CANTIDAD de mensajes (igual que el web, que pagina por mensajes
// visibles, no por tokens). El tope de tokens se deja en 0: en la respuesta
// (etapa 2) ya lo gobierna BRAIN_MEMORY_MAX_TOKENS.
const PRELOAD_MAX_MESSAGES = num('GATEWAY_PRELOAD_MAX_MESSAGES', 25);
const PRELOAD_MAX_TOKENS = num('GATEWAY_PRELOAD_MAX_TOKENS', 0);
/** @type {Map<string, { history: Array<any>, cachedAt: number }>} */
const preloadCache = new Map();

/** JID es 1-a-1 (termina en @s.whatsapp.net / @lid) vs grupo (@g.us). */
function isDirectJid(jid) {
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

/**
 * Dispara la precarga del historial de un chat (solo si está habilitada y el
 * cache está frío). No bloquea. La precarga es SOLO señal de intervención
 * (etapa 1, web-like): al abrir/señalar el chat ya sabemos de qué va.
 * NO se inyecta en /chat (etapa 2 usa el contexto completo del brain).
 *
 * Fuente de la precarga (GATEWAY_PRELOAD_SOURCE):
 *   - 'baileys' (default, Opción C): lee el hilo REAL desde el store RAM de
 *     Baileys (lo que el web muestra al abrir el chat: tuyo + cliente + bot).
 *     On-demand por chat, no masivo.
 *   - 'brain': legacy, va al brain SQLite (solo lo que el bot respondió).
 * @param {string} remoteJid
 */
function preloadHistory(remoteJid) {
    if (!PRELOAD_ENABLED) return;
    if (PRELOAD_ONLY_DIRECT && !isDirectJid(remoteJid)) return;
    const cached = preloadCache.get(remoteJid);
    if (cached && (Date.now() - cached.cachedAt) < PRELOAD_TTL_MS) return; // ya caliente
    // Marcar inmediatamente para evitar descargas paralelas del mismo chat
    preloadCache.set(remoteJid, { history: cached ? cached.history : [], cachedAt: Date.now() });

    if (PRELOAD_SOURCE === 'baileys') {
        // Opción C: hilo real desde el store RAM de Baileys (on-demand, web-like).
        const history = chatStore.getRecent(remoteJid, PRELOAD_MAX_MESSAGES);
        preloadCache.set(remoteJid, { history, cachedAt: Date.now(), source: 'baileys' });
        logPresencia.info(`🔎 [PRECARGA DEBUG] source=baileys jid=${remoteJid} msgs=${history.length} (etapa1, hilo real de Baileys)`);
        return;
    }
    // Legacy: ir al brain por el historial de lo que el bot respondió.
    getChatHistory(remoteJid, { maxMessages: PRELOAD_MAX_MESSAGES, maxTokens: PRELOAD_MAX_TOKENS })
        .then(history => { preloadCache.set(remoteJid, { history, cachedAt: Date.now(), source: 'brain' }); })
        .catch(() => { /* el cache queda con [] y se reintenta tras TTL */ });
}

// 📊 Contadores y métricas para GET /status (F4-P3)
const runtimeStats = { receivedMessages: 0, aiMessages: 0, adminCommands: 0 };

// 🧹 Limpieza automática de RAM para evitar memory leaks en activePresences y messageBuffers
const PRESENCE_CLEANUP_INTERVAL_MS = num('GATEWAY_PRESENCE_CLEANUP_INTERVAL_MS', 10 * 60 * 1000); // 10 minutos (tunable vía .env.tuning)
const PRESENCE_MAX_AGE_MS = num('GATEWAY_PRESENCE_MAX_AGE_MS', 15 * 60 * 1000); // 15 minutos (tunable vía .env.tuning)
const BUFFER_MAX_AGE_MS = num('GATEWAY_BUFFER_MAX_AGE_MS', 15 * 60 * 1000); // 15 minutos: buffer huérfano se descarta (tunable vía .env.tuning)

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
}, PRESENCE_CLEANUP_INTERVAL_MS).unref();

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

    // 🧠 Precarga del historial del chat en cuanto el cliente empieza a escribir
    // (señal de intervención web-like). El dedup por TTL evita llamar al brain
    // en cada evento de presencia.
    if (isTyping) preloadHistory(id);

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

async function handleIncomingMessage(stdMsg) {
    if (!stdMsg || !stdMsg.text) return;

    runtimeStats.receivedMessages += 1;

    const isFromMe = stdMsg.metadata.isFromMe;
    const metadata = stdMsg.metadata;
    // We use the unified ID as the remoteJid now (e.g. 'whatsapp:123', 'telegram:456')
    const remoteJid = stdMsg.remoteId; 
    const { phoneNumber, lid, savedName, pushName } = metadata;
    const textMessage = stdMsg.text;

    // Get the correct adapter
    const { getAdapter } = require('../index');
    const adapter = getAdapter(stdMsg.channel);
    if (!adapter) {
        logError.error(`Adapter not found for channel ${stdMsg.channel}`);
        return;
    }

    // 🔔 SUSCRIBIR EN TIEMPO REAL A EVENTOS DE PRESENCIA (composing/paused) DE ESTE CLIENTE AL INICIAR
    // Solo si es whatsapp
    if (stdMsg.channel === 'whatsapp') {
        const sock = adapter.sock; // fallback for native methods
        if (sock) {
            sock.presenceSubscribe(stdMsg.rawId).catch(e => logError.error(`⚠️ Error al suscribir presencia de ${stdMsg.rawId}:`, e.message));
            if (phoneNumber) sock.presenceSubscribe(`${phoneNumber}@s.whatsapp.net`).catch(e => logError.error(`⚠️ Error al suscribir presencia (Phone) de ${phoneNumber}:`, e.message));
            if (lid) sock.presenceSubscribe(`${lid}@lid`).catch(e => logError.error(`⚠️ Error al suscribir presencia (LID) de ${lid}:`, e.message));
        }
    }

    // 🗂️ GUARDAR / ACTUALIZAR CONTACTO EN BASE DE DATOS
    const contactRecord = upsertContactMetadata(metadata, remoteJid) || { estado: 'neutro' };

    // 🔄 Enriquecimiento asíncrono en segundo plano (Foto de Perfil & Bio) solo para WA
    if (stdMsg.channel === 'whatsapp' && adapter.sock) {
        enrichContactExtraData(adapter.sock, stdMsg.rawId, metadata);
    }

    // Self-chat de WhatsApp (JID propio) o canal admin de Telegram: ambos son
    // "el admin hablando consigo mismo" y comparten SCENARIO 1 del pipeline
    // (comandos '/' + Asistente Personal IA + confirmaciones broadcast/F7).
    const isSelf = isSelfChat(remoteJid)
        || (stdMsg.channel === 'telegram' && !!(metadata && metadata.isAdminChannel));
    const displayName = savedName ? `${savedName} (Agenda)` : pushName;

    logAI.info(`\n🔍 [DEBUG CHAT] JID: ${remoteJid} | Phone: ${phoneNumber || 'N/A'} | LID: ${lid || 'N/A'} | From: "${displayName}" | isSelf: ${isSelf} | Texto: "${textMessage}"`);

    // 🚦 PIPELINE PURO: decidir qué hacer con este mensaje
    const decision = decideMessageFlow({ textMessage, metadata, contactRecord, isSelf, isFromMe });
    if (decision.type === 'respond') {
        runtimeStats.aiMessages += 1;
        // 🧹 Handoff expirado: el decisor ya lo trató como neutro; persistimos
        // el reset para que no "reviva" tras reiniciar (el decisor no muta BD).
        if (contactRecord && contactRecord.estado === 'handoff' && !isHandoffActive(contactRecord)) {
            setNumberState(phoneNumber || lid, 'neutral');
        }
    }

    switch (decision.type) {
        case 'admin_command': {
            await handleAdminCommand(decision.text, remoteJid, adapter, metadata, stdMsg);
            return;
        }

        case 'self_chat_ai': {
            // 📢 F4-P5: si hay una confirmación de broadcast pendiente y el admin
            // respondió "si"/"cancelar", se consume aquí (no va a la IA).
            if (await tryConfirm(textMessage, adapter, remoteJid)) return;
            // 🧨 F7: confirmación del reset limpio (palabra mágica con timers) —
            // se consume aquí igual que la de broadcast (no va a la IA).
            if (await tryCleanConfirm(textMessage, adapter, remoteJid)) return;
            logAI.info(`\n🤖 [ASISTENTE PERSONAL EN SELF-CHAT]: "${decision.text}"`);
            await enqueueAI(() => processAIChat(decision.text, remoteJid, metadata, adapter));
            return;
        }

        case 'handoff': {
            logAI.info(`\n🚨 [HANDOFF ACTIVADO] Cliente ${decision.displayName} (${decision.targetId}) solicitó atención humana.`);
            setNumberState(decision.targetId, 'handoff');

            // 1. Notificar al Admin en Self-Chat
            if (state.ADMIN_PHONE || state.ADMIN_LID) {
                const adminJid = state.ADMIN_PHONE ? `whatsapp:${state.ADMIN_PHONE}` : `whatsapp:${state.ADMIN_LID}`;
                adapter.sendMessage(adminJid, decision.adminNotify).catch(() => {});
            }

            // 2. Avisar al cliente
            const clientNotice = ` Un momento por favor. He notificado a un asesor humano para que revise tu solicitud a la brevedad.`;
            const sentNotice = await adapter.sendMessage(remoteJid, clientNotice);
            registerSentMessage(sentNotice);
            return;
        }

        case 'ignore': {
            if (decision.reason === 'from_me') {
                log.info(`\n🙈 [IGNORADO FORZADO] Escribiste en chat de cliente (${remoteJid}). Bot en silencio.`);
            } else if (decision.reason === 'client_command') {
                logComando.info(`\n🚫 [SEGURIDAD] Cliente (${displayName} - ${remoteJid}) intentó ejecutar comando admin: ${textMessage}`);
            } else if (decision.reason === 'paused') {
                log.info(`\n⏸️ [MENSAJE IGNORADO] Bot pausado globalmente. Mensaje de: ${displayName}`);
            } else if (decision.reason === 'estado_ignorado') {
                log.info(`\n🚫 [MENSAJE IGNORADO - ESTADO IGNORADO] De: ${displayName}`);
            } else if (decision.reason === 'modo_global_estricto') {
                log.info(`\n🚫 [MENSAJE IGNORADO - MODO GLOBAL ESTRICTO] De: ${displayName}`);
            } else if (decision.reason === 'handoff_activo') {
                logAI.info(`\n🙈 [HANDOFF ACTIVO] IA pausada para cliente individual: ${displayName} (${phoneNumber || lid})`);
            }
            return;
        }

        case 'respond': {
            // 🔒 SERIALIZACIÓN POR CHAT: si la IA ya está respondiendo para este cliente,
            // acumulamos mensajes sin timer; al terminar la llamada se programa el siguiente lote.
            if (chatInFlight.has(remoteJid)) {
                let inflightBuffer = messageBuffers.get(remoteJid);
                if (inflightBuffer) {
                    inflightBuffer.messages.push(decision.text);
                    inflightBuffer.lastActivity = Date.now();
                    inflightBuffer.onTimeout = createBufferTimeout(remoteJid, metadata, adapter);
                    if (inflightBuffer.timer) clearTimeout(inflightBuffer.timer);
                    if (inflightBuffer.typingExpiryTimer) clearTimeout(inflightBuffer.typingExpiryTimer);
                    inflightBuffer.timer = null;
                } else {
                    messageBuffers.set(remoteJid, {
                        messages: [decision.text],
                        isTyping: false,
                        lastTypingTime: null,
                        lastActivity: Date.now(),
                        onTimeout: createBufferTimeout(remoteJid, metadata, adapter),
                        timer: null,
                        typingExpiryTimer: null
                    });
                }
                logAI.info(`⏳ [IA EN CURSO] Cliente (${displayName}) escribió mientras la IA responde. ${messageBuffers.get(remoteJid).messages.length} msg(s) en espera.`);
                return;
            }

            let existingBuffer = messageBuffers.get(remoteJid);

            const onTimeout = createBufferTimeout(remoteJid, metadata, adapter);

            if (existingBuffer) {
                if (existingBuffer.timer) clearTimeout(existingBuffer.timer);
                existingBuffer.messages.push(decision.text);
                existingBuffer.onTimeout = onTimeout;
                existingBuffer.lastActivity = Date.now();

                // Resetear timer al recibir mensaje físico con delay estocástico/adaptativo
                const delayMs = getAdaptiveDebounceMs(existingBuffer.messages);
                existingBuffer.timer = setTimeout(onTimeout, delayMs);
                log.info(`⏳ [DE-BOUNCE RESET] Nuevo mensaje recibido de ${displayName}. Timer de ${(delayMs / 1000).toFixed(1)}s de silencio iniciado.`);
            } else {
                const newBuffer = {
                    messages: [decision.text],
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
            return;
        }

        // @@PART2@@
    }
}

/**
 * ⏱️ Crea el cierre (closure) del timer de de-bounce para un chat específico.
 * Al expirar el silencio, verifica presencia local, envía a la IA y, si durante
 * la llamada llegaron mensajes nuevos, programa el siguiente lote (serializado).
 */
function createBufferTimeout(remoteJid, metadata, adapter) {
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
            await enqueueAI(() => processAIChat(fullBufferedText, remoteJid, metadata, adapter));
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

/**
 * 📊 Métricas de runtime para GET /status (F4-P3)
 */
function getRuntimeStats() {
    return {
        ...runtimeStats,
        buffers: messageBuffers.size,
        presences: activePresences.size,
        chatInFlight: chatInFlight.size,
        aiPool: poolStats()
    };
}

// 📥 F4-P4: procesar mensajes encolados cuando el brain vuelve
const MAX_QUEUE_ATTEMPTS = 5; // un mensaje encolado se intenta hasta 5 veces antes de descartarse

/**
 * Procesa la cola persistente de mensajes (FIFO, uno a la vez).
 * - Respeta la serialización por chat (chatInFlight): si el cliente está en una
 *   llamada IA viva, se detiene y reintenta en el próximo flush.
 * - Pausa de 2-5s entre mensajes para no parecer un bot spam.
 */
async function flushQueuedMessages() {
    while (true) {
        const item = messageQueue.peek();
        const adapter = messageQueue.getSock(); // Fallback for old name, will need adapter!
        if (!item || !adapter) return;

        // No pisar un chat con IA en curso (buffer timer activo)
        if (chatInFlight.has(item.jid)) return;

        if (item.attempts >= MAX_QUEUE_ATTEMPTS) {
            messageQueue.removeHead();
            logError.error(`📥 [COLA] Descartado mensaje de ${item.jid} tras ${MAX_QUEUE_ATTEMPTS} intentos fallidos: "${item.text.slice(0, 60)}"`);
            continue;
        }

        const displayName = item.metadata.savedName || item.metadata.pushName || 'Desconocido';
        log.warn(`📥 [COLA] Respondiendo mensaje encolado de ${displayName} (${item.jid})...`);

        chatInFlight.add(item.jid);
        try {
            await enqueueAI(() => processAIChat(item.text, item.jid, item.metadata, adapter, { fromQueue: true }));
            messageQueue.removeHead();
            // ⏱️ Pausa humana entre mensajes encolados (2-5s)
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        } catch {
            // processAIChat gestiona sus propios errores internos; aquí solo se
            // marca el intento y se detiene el flush (el brain sigue caído).
            item.attempts += 1;
            messageQueue.saveHead();
            return;
        } finally {
            chatInFlight.delete(item.jid);
        }
    }
}

messageQueue.setFlushHandler(flushQueuedMessages);

module.exports = {
    handleIncomingMessage,
    handlePresenceUpdate,
    getRuntimeStats
};
