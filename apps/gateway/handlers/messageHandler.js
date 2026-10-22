/* global AbortController */
const { state, registerSentMessage } = require('../config');
const { enrichContactExtraData, isSelfChat } = require('../services/metadataService');
const { upsertContactMetadata, isHandoffActive } = require('../services/contactsRepository');
const { setNumberState, getControlService } = require('../services/stateService');
const { processAIChat } = require('../services/brainService');
const { enqueueAI, poolStats } = require('../services/aiQueue');
const messageQueue = require('../services/messageQueue');
const { getAdaptiveDebounceMs, getCandidateIdsForPresence, decideMessageFlow } = require('../services/pipeline');
const { handleAdminCommand } = require('./commandHandler');
const { tryConfirm } = require('../services/broadcastService');
const { tryCleanConfirm } = require('../services/resetCleanFlow');
const { cat, safeErrorLabel } = require('../services/logger');
const chatStore = require('../store/chatStore'); // Opción C: store RAM de mensajes de Baileys (precarga web-like)
const { num, str } = require('../tuning');
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
const conversationByRemote = new Map();
const drainWaiters = new Map();
const activeGenerationControllers = new Map();
const TYPING_TTL_MS = num('GATEWAY_TYPING_TTL_MS', 5000);           // 5.0 segundos: el estado de tecleo expira si el teclado queda inactivo (tunable vía .env.tuning)

function workKeyForRemote(remoteJid) {
    return conversationByRemote.get(remoteJid) || remoteJid;
}

function clearConversationMappings(conversationId) {
    for (const [remoteJid, id] of conversationByRemote) {
        if (id === conversationId) conversationByRemote.delete(remoteJid);
    }
}

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
const PRELOAD_SOURCE = (str('GATEWAY_PRELOAD_SOURCE', 'baileys') || 'baileys').toLowerCase(); // 'baileys' | 'brain'
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

/** JID es 1-a-1 (WhatsApp: @s.whatsapp.net / @lid, Telegram: sin prefijo - de grupo) vs grupo. */
function isDirectJid(jid) {
    if (!jid) return false;
    if (jid.startsWith('telegram:')) {
        const id = jid.slice(9);
        return !id.startsWith('-');
    }
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
        logPresencia.info(`🔎 [PRECARGA] source=baileys msgs=${history.length}.`);
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

    logPresencia.info(`📡 [PRESENCIA RECIBIDA] Estado: ${presenceState}; candidatos revisados: ${candidates.length}.`);

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
        const bufferRemote = buffer.remoteJid || bufferJid;
        const cleanBuffer = bufferRemote.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const isMatch = candidates.some(cid => bufferRemote.includes(cid) || cleanBuffer.includes(cid));
        
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
                log.info(`\n⌨️ [DE-BOUNCE MEMORIA] Actividad de escritura detectada (${presenceState}); timer pausado.`);

                // Expiración automática a los 5s si deja de presionar teclas sin enviar evento paused
                if (buffer.typingExpiryTimer) clearTimeout(buffer.typingExpiryTimer);
                buffer.typingExpiryTimer = setTimeout(() => {
                    if (buffer && buffer.isTyping) {
                        buffer.isTyping = false;
                        const delayMs = getAdaptiveDebounceMs(buffer.messages);
                        log.info(`\n⏱️ [TECLADO LIBERADO] Iniciando timer de ${(delayMs / 1000).toFixed(1)}s.`);
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
                log.info(`\n⏳ [PRESENCIA PAUSADA] Estado ${presenceState}; timer reiniciado a ${(delayMs / 1000).toFixed(1)}s.`);
            }
        }
    }
}

async function handleIncomingMessage(stdMsg, { onDurableComplete } = {}) {
    if (!stdMsg || !stdMsg.text) return;

    runtimeStats.receivedMessages += 1;

    const isFromMe = stdMsg.metadata.isFromMe;
    const metadata = stdMsg.metadata;
    // We use the unified ID as the remoteJid now (e.g. 'whatsapp:123', 'telegram:456')
    const remoteJid = stdMsg.remoteId; 
    const sourceMessageId = stdMsg.archiveMessageId || null;
    const { phoneNumber, lid } = metadata;
    const textMessage = stdMsg.text;

    // Get the correct adapter
    const { getAdapter } = require('../index');
    const adapter = getAdapter(stdMsg.channel);
    if (!adapter) {
        logError.error(`Adapter not found for channel ${stdMsg.channel}`);
        return;
    }

    const isSelf = isSelfChat(remoteJid)
        || (stdMsg.channel === 'telegram' && !!(metadata && metadata.isAdminChannel));

    // 🔔 SUSCRIBIR EN TIEMPO REAL A EVENTOS DE PRESENCIA (composing/paused) DE ESTE CLIENTE AL INICIAR
    // Solo si es whatsapp
    if (stdMsg.channel === 'whatsapp') {
        const sock = adapter.sock; // fallback for native methods
        if (sock) {
            sock.presenceSubscribe(stdMsg.rawId).catch(e => logError.error(`⚠️ Error al suscribir presencia (${safeErrorLabel(e)}).`));
            if (phoneNumber) sock.presenceSubscribe(`${phoneNumber}@s.whatsapp.net`).catch(e => logError.error(`⚠️ Error al suscribir presencia (${safeErrorLabel(e)}).`));
            if (lid) sock.presenceSubscribe(`${lid}@lid`).catch(e => logError.error(`⚠️ Error al suscribir presencia (${safeErrorLabel(e)}).`));
        }
    }

    // 🗂️ GUARDAR / ACTUALIZAR CONTACTO EN BASE DE DATOS
    let contactRecord = upsertContactMetadata(metadata, remoteJid) || { estado: 'neutro' };
    let controlSnapshot = null;

    // Tras el corte, SQLite es la autoridad. Resolver por canal, cuenta e ID
    // exactos; si falta esa fila, fallar cerrado y reconocer la entrada durable.
    if (!isSelf && stdMsg.rawId && adapter.accountId) {
        try {
            const controlService = getControlService();
            const kind = stdMsg.channel === 'telegram' ? 'telegram_chat_id'
                : stdMsg.rawId.endsWith('@lid') ? 'whatsapp_lid' : 'whatsapp_jid';
            const result = await controlService?.readForIdentity({ accountId: adapter.accountId,
                channel: stdMsg.channel, kind, exactValue: stdMsg.rawId });
            if (result?.authority === 'sqlite') {
                if (!result.target) {
                    logError.error(`Control SQLite: identidad exacta sin conversación (${stdMsg.channel}).`);
                    await onDurableComplete?.();
                    return;
                }
                controlSnapshot = result.controlSnapshot;
                conversationByRemote.set(remoteJid, result.target.conversationId);
                if (conversationByRemote.size > 5000) conversationByRemote.delete(conversationByRemote.keys().next().value);
                const control = result.target.control;
                if (sourceMessageId && control.automationMode === 'ai'
                    && !await adapter.archive.shouldProcessArchivedInbound({ messageId: sourceMessageId })) {
                    await onDurableComplete?.();
                    return;
                }
                let estado = 'neutro';
                if (control.requiresReview || control.lifecycle === 'resolved' || control.accessPolicy === 'ignored'
                    || (control.accessPolicy === 'allowed' && control.automationMode === 'off')) estado = 'ignorado';
                else if (control.automationMode === 'human') estado = 'handoff';
                else if (control.accessPolicy === 'allowed') estado = 'permitido';
                contactRecord = { ...contactRecord, estado, handoffAt: null,
                    perfil: control.profileKey };
            }
        } catch (error) {
            logError.error(`No se pudo leer el control durable; respuesta bloqueada (${safeErrorLabel(error)}).`);
            await onDurableComplete?.();
            return;
        }
    }

    // 🔄 Enriquecimiento asíncrono en segundo plano (Foto de Perfil & Bio) solo para WA
    if (stdMsg.channel === 'whatsapp' && adapter.sock) {
        enrichContactExtraData(adapter.sock, stdMsg.rawId, metadata);
    }

    // Self-chat de WhatsApp (JID propio) o canal admin de Telegram: ambos son
    // "el admin hablando consigo mismo" y comparten SCENARIO 1 del pipeline
    // (comandos '/' + Asistente Personal IA + confirmaciones broadcast/F7).
    logAI.info(`\n🔍 [MENSAJE] Canal: ${stdMsg.channel} | self-chat: ${isSelf}.`);

    // 🚦 PIPELINE PURO: decidir qué hacer con este mensaje
    const decision = decideMessageFlow({ textMessage, metadata, contactRecord, isSelf, isFromMe });
    if (decision.type === 'respond') {
        runtimeStats.aiMessages += 1;
        // 🧹 Handoff expirado: el decisor ya lo trató como neutro; persistimos
        // el reset para que no "reviva" tras reiniciar (el decisor no muta BD).
        if (contactRecord && contactRecord.estado === 'handoff' && !isHandoffActive(contactRecord)) {
            await setNumberState(phoneNumber || lid, 'neutral', { channel: stdMsg.channel, accountId: adapter.accountId });
        }
    }

    switch (decision.type) {
        case 'admin_command': {
            await handleAdminCommand(decision.text, remoteJid, adapter, metadata, stdMsg, getAdapter('whatsapp'));
            return;
        }

        case 'self_chat_ai': {
            // 📢 F4-P5: si hay una confirmación de broadcast pendiente y el admin
            // respondió "si"/"cancelar", se consume aquí (no va a la IA).
            if (await tryConfirm(textMessage, adapter, remoteJid)) return;
            // 🧨 F7: confirmación del reset limpio (palabra mágica con timers) —
            // se consume aquí igual que la de broadcast (no va a la IA).
            if (await tryCleanConfirm(textMessage, adapter, remoteJid)) return;
            logAI.info('\n🤖 [ASISTENTE PERSONAL EN SELF-CHAT] Mensaje admitido.');
            await enqueueAI(() => processAIChat(decision.text, remoteJid, metadata, adapter));
            return;
        }

        case 'handoff': {
            logAI.info('\n🚨 [HANDOFF ACTIVADO] Solicitud de atención humana recibida.');
            const handoff = await setNumberState(stdMsg.rawId, 'handoff', {
                channel: stdMsg.channel, accountId: adapter.accountId, reason: 'customer_request'
            });
            if (!handoff.success) {
                logError.error('No se pudo persistir la solicitud de atención humana (HANDOFF_FAILED).');
                await onDurableComplete?.();
                return;
            }

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
                log.info('\n🙈 [IGNORADO FORZADO] Mensaje propio en conversación de cliente; bot en silencio.');
            } else if (decision.reason === 'client_command') {
                logComando.info('\n🚫 [SEGURIDAD] Intento de comando administrativo desde cliente.');
            } else if (decision.reason === 'paused') {
                log.info('\n⏸️ [MENSAJE IGNORADO] Bot pausado globalmente.');
            } else if (decision.reason === 'estado_ignorado') {
                log.info('\n🚫 [MENSAJE IGNORADO - ESTADO IGNORADO].');
            } else if (decision.reason === 'modo_global_estricto') {
                log.info('\n🚫 [MENSAJE IGNORADO - MODO GLOBAL ESTRICTO].');
            } else if (decision.reason === 'handoff_activo') {
                logAI.info('\n🙈 [HANDOFF ACTIVO] IA pausada para esta conversación.');
            }
            return;
        }

        case 'respond': {
            // 🔒 SERIALIZACIÓN POR CHAT: si la IA ya está respondiendo para este cliente,
            // acumulamos mensajes sin timer; al terminar la llamada se programa el siguiente lote.
            const bufferKey = workKeyForRemote(remoteJid);
            if (chatInFlight.has(bufferKey)) {
                let inflightBuffer = messageBuffers.get(bufferKey);
                if (inflightBuffer) {
                    inflightBuffer.messages.push(decision.text);
                    if (sourceMessageId) (inflightBuffer.archiveMessageIds ||= []).push(sourceMessageId);
                    if (onDurableComplete) (inflightBuffer.dispatchAcks ||= []).push(onDurableComplete);
                    inflightBuffer.lastActivity = Date.now();
                    inflightBuffer.remoteJid = remoteJid;
                    inflightBuffer.metadata = metadata;
                    inflightBuffer.adapter = adapter;
                    inflightBuffer.controlSnapshot = controlSnapshot;
                    inflightBuffer.onTimeout = createBufferTimeout(bufferKey, metadata, adapter);
                    if (inflightBuffer.timer) clearTimeout(inflightBuffer.timer);
                    if (inflightBuffer.typingExpiryTimer) clearTimeout(inflightBuffer.typingExpiryTimer);
                    inflightBuffer.timer = null;
                } else {
                    messageBuffers.set(bufferKey, {
                        messages: [decision.text],
                        archiveMessageIds: sourceMessageId ? [sourceMessageId] : [],
                        dispatchAcks: onDurableComplete ? [onDurableComplete] : [],
                        remoteJid, metadata, adapter, controlSnapshot,
                        isTyping: false,
                        lastTypingTime: null,
                        lastActivity: Date.now(),
                        onTimeout: createBufferTimeout(bufferKey, metadata, adapter),
                        timer: null,
                        typingExpiryTimer: null
                    });
                }
                logAI.info(`⏳ [IA EN CURSO] ${messageBuffers.get(bufferKey).messages.length} mensaje(s) en espera.`);
                return onDurableComplete ? 'deferred' : undefined;
            }

            let existingBuffer = messageBuffers.get(bufferKey);

            const onTimeout = createBufferTimeout(bufferKey, metadata, adapter);

            if (existingBuffer) {
                if (existingBuffer.timer) clearTimeout(existingBuffer.timer);
                existingBuffer.messages.push(decision.text);
                if (sourceMessageId) (existingBuffer.archiveMessageIds ||= []).push(sourceMessageId);
                if (onDurableComplete) (existingBuffer.dispatchAcks ||= []).push(onDurableComplete);
                existingBuffer.onTimeout = onTimeout;
                existingBuffer.remoteJid = remoteJid;
                existingBuffer.metadata = metadata;
                existingBuffer.adapter = adapter;
                existingBuffer.controlSnapshot = controlSnapshot;
                existingBuffer.lastActivity = Date.now();

                // Resetear timer al recibir mensaje físico con delay estocástico/adaptativo
                const delayMs = getAdaptiveDebounceMs(existingBuffer.messages);
                existingBuffer.timer = setTimeout(onTimeout, delayMs);
                log.info(`⏳ [DE-BOUNCE RESET] Timer de ${(delayMs / 1000).toFixed(1)}s iniciado.`);
            } else {
                const newBuffer = {
                    messages: [decision.text],
                    archiveMessageIds: sourceMessageId ? [sourceMessageId] : [],
                    dispatchAcks: onDurableComplete ? [onDurableComplete] : [],
                    remoteJid, metadata, adapter, controlSnapshot,
                    isTyping: false,
                    lastTypingTime: null,
                    lastActivity: Date.now(),
                    onTimeout: onTimeout,
                    timer: null,
                    typingExpiryTimer: null
                };

                const delayMs = getAdaptiveDebounceMs(newBuffer.messages);
                newBuffer.timer = setTimeout(onTimeout, delayMs);
                messageBuffers.set(bufferKey, newBuffer);
                log.info(`⏳ [DE-BOUNCE START] Timer de ${(delayMs / 1000).toFixed(1)}s iniciado.`);
            }
            return onDurableComplete ? 'deferred' : undefined;
        }

        // @@PART2@@
    }
}

/**
 * ⏱️ Crea el cierre (closure) del timer de de-bounce para un chat específico.
 * Al expirar el silencio, verifica presencia local, envía a la IA y, si durante
 * la llamada llegaron mensajes nuevos, programa el siguiente lote (serializado).
 */
function createBufferTimeout(bufferKey, fallbackMetadata, fallbackAdapter) {
    return async function onTimeout() {
        const buf = messageBuffers.get(bufferKey);
        if (!buf) return;
        const remoteJid = buf.remoteJid || bufferKey;
        const metadata = buf.metadata || fallbackMetadata;
        const adapter = buf.adapter || fallbackAdapter;
        const phoneNumber = metadata.phoneNumber;
        const lid = metadata.lid;

        // 🔒 Guarda: si otra llamada de IA sigue en curso para este chat, no hacer nada
        // (el lote pendiente se reprograma cuando finalice la llamada activa).
        if (chatInFlight.has(bufferKey)) return;

        const controlSnapshot = buf.controlSnapshot;
        const controlService = controlSnapshot ? getControlService() : null;
        if (controlSnapshot && !await controlService?.isSnapshotCurrent(controlSnapshot).catch(() => false)) {
            if (buf.timer) clearTimeout(buf.timer);
            if (buf.typingExpiryTimer) clearTimeout(buf.typingExpiryTimer);
            const acknowledgements = buf.dispatchAcks?.splice(0) || [];
            messageBuffers.delete(bufferKey);
            await Promise.allSettled(acknowledgements.map(acknowledge => Promise.resolve().then(() => acknowledge())));
            clearConversationMappings(controlSnapshot.conversationId);
            notifyDrained(bufferKey);
            return;
        }

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
            log.info(`\n🔄 [MEMORIA LOCAL] Escritura en curso; envío a IA postergado ${(delayMs / 1000).toFixed(1)}s.`);
            if (buf.timer) clearTimeout(buf.timer);
            buf.timer = setTimeout(buf.onTimeout, delayMs);
            return;
        }

        // LUZ VERDE: SILENCIO DE DEBOUNCE CUMPLIDO REALMENTE
        if (buf.typingExpiryTimer) clearTimeout(buf.typingExpiryTimer);
        if (buf.timer) clearTimeout(buf.timer);

        const fullBufferedText = buf.messages.join('\n');
        const batchCount = buf.messages.length;
        buf.messages = []; // Los mensajes procesados salen del buffer; no se borra el buffer aún
        const sourceMessageIds = buf.archiveMessageIds?.splice(0) || [];
        const dispatchAcks = buf.dispatchAcks?.splice(0) || [];

        log.info(`\n📦 [DE-BOUNCE BATCH FINAL] Procesando lote de ${batchCount} mensaje(s) tras el silencio.`);

        const controller = new AbortController();
        chatInFlight.add(bufferKey);
        activeGenerationControllers.set(bufferKey, controller);
        try {
            // 🎯 La cola FIFO global limita las llamadas simultáneas a la IA
            const { active, queued } = poolStats();
            logAI.info(`🎯 [POOL AI] Esperando turno en cola global (activas: ${active}, en cola: ${queued})...`);
            const jobOptions = controlSnapshot ? { controlSnapshot, sourceMessageIds, signal: controller.signal,
                isCurrent: () => controlService.isSnapshotCurrent(controlSnapshot) } : { signal: controller.signal };
            await enqueueAI(() => processAIChat(fullBufferedText, remoteJid, metadata, adapter, jobOptions));
            for (const acknowledge of dispatchAcks) await acknowledge();
        } catch (error) {
            for (const acknowledge of dispatchAcks) await acknowledge.retry?.(error);
            logError.error(`⚠️ Error procesando mensaje durable (${safeErrorLabel(error)}).`);
        } finally {
            chatInFlight.delete(bufferKey);
            if (activeGenerationControllers.get(bufferKey) === controller) activeGenerationControllers.delete(bufferKey);

            // Si llegaron mensajes durante la llamada de IA, programar el siguiente lote
            const bufAfter = messageBuffers.get(bufferKey);
            if (bufAfter && bufAfter.messages.length > 0) {
                if (bufAfter.timer) clearTimeout(bufAfter.timer);
                const delayMs = getAdaptiveDebounceMs(bufAfter.messages);
                bufAfter.timer = setTimeout(bufAfter.onTimeout, delayMs);
                logAI.info(`⏳ [IA TERMINADA] ${bufAfter.messages.length} mensaje(s) en espera; timer de ${(delayMs / 1000).toFixed(1)}s iniciado.`);
            } else if (bufAfter) {
                if (bufAfter.timer) clearTimeout(bufAfter.timer);
                if (bufAfter.typingExpiryTimer) clearTimeout(bufAfter.typingExpiryTimer);
                messageBuffers.delete(bufferKey);
                if (controlSnapshot) clearConversationMappings(controlSnapshot.conversationId);
                else conversationByRemote.delete(remoteJid);
            }
            notifyDrained(bufferKey);
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

function notifyDrained(bufferKey) {
    if (chatInFlight.has(bufferKey)) return;
    const waiters = drainWaiters.get(bufferKey);
    if (!waiters) return;
    drainWaiters.delete(bufferKey);
    for (const resolve of waiters) resolve();
}

function drainConversation(conversationId) {
    const acknowledgements = [];
    const buffer = messageBuffers.get(conversationId);
    if (buffer) {
        if (buffer.timer) clearTimeout(buffer.timer);
        if (buffer.typingExpiryTimer) clearTimeout(buffer.typingExpiryTimer);
        acknowledgements.push(...(buffer.dispatchAcks?.splice(0) || []));
        messageBuffers.delete(conversationId);
    }
    const active = chatInFlight.has(conversationId);
    activeGenerationControllers.get(conversationId)?.abort();
    if (!active && !acknowledgements.length) {
        clearConversationMappings(conversationId);
        return { drained: true, uncertainMessageIds: [] };
    }
    const activeDrain = active ? new Promise(resolve => {
        const waiters = drainWaiters.get(conversationId) || new Set();
        waiters.add(resolve);
        drainWaiters.set(conversationId, waiters);
    }) : Promise.resolve();
    return (async () => {
        await Promise.allSettled(acknowledgements.map(acknowledge => Promise.resolve().then(() => acknowledge())));
        await activeDrain;
        clearConversationMappings(conversationId);
        return { drained: true, uncertainMessageIds: [] };
    })();
}

async function drainAllConversations() {
    const conversations = new Set(conversationByRemote.values());
    for (const key of activeGenerationControllers.keys()) {
        if (conversationByRemote.get(key)) conversations.add(conversationByRemote.get(key));
        else if (key.length === 36) conversations.add(key);
    }
    const results = await Promise.all([...conversations].map(conversationId => drainConversation(conversationId)));
    return { drained: results.every(result => result?.drained !== false), conversations: conversations.size };
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
        if (!item) return;
        const adapter = messageQueue.resolveAdapter(item.jid);
        if (!adapter) return;

        const controlService = getControlService();
        const authority = await controlService?.authority().catch(() => null);
        if (controlService && !authority) return;
        if (authority?.mode === 'sqlite') {
            if (!item.controlSnapshot || !await controlService.isSnapshotCurrent(item.controlSnapshot).catch(() => false)) {
                messageQueue.removeHead();
                continue;
            }
            conversationByRemote.set(item.jid, item.controlSnapshot.conversationId);
        }
        const bufferKey = item.controlSnapshot?.conversationId || item.jid;

        // No pisar un chat con IA en curso (buffer timer activo)
        if (chatInFlight.has(bufferKey)) return;

        if (item.attempts >= MAX_QUEUE_ATTEMPTS) {
            messageQueue.removeHead();
            logError.error(`📥 [COLA] Mensaje descartado tras ${MAX_QUEUE_ATTEMPTS} intentos fallidos.`);
            continue;
        }

        log.warn('📥 [COLA] Procesando mensaje encolado.');

        const controller = new AbortController();
        chatInFlight.add(bufferKey);
        activeGenerationControllers.set(bufferKey, controller);
        try {
            const jobOptions = item.controlSnapshot ? { fromQueue: true, controlSnapshot: item.controlSnapshot,
                sourceMessageIds: item.sourceMessageIds || [],
                generationId: item.id, signal: controller.signal,
                isCurrent: () => controlService.isSnapshotCurrent(item.controlSnapshot) }
                : { fromQueue: true, generationId: item.id, sourceMessageIds: item.sourceMessageIds || [], signal: controller.signal };
            await enqueueAI(() => processAIChat(item.text, item.jid, item.metadata, adapter, jobOptions));
            messageQueue.removeHead();
            // ⏱️ Pausa humana entre mensajes encolados (2-5s)
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        } catch (error) {
            if (error?.outboundIntentId || error?.outboundState
                || error?.outboundState === 'delivery_unknown' || error?.outboundState === 'sending'
                || ['OUTBOUND_DELIVERY_UNKNOWN','OUTBOUND_IN_PROGRESS','OUTBOUND_CLAIM_UNCERTAIN'].includes(error?.code)) {
                messageQueue.removeHead();
                logError.error(`📥 [COLA] ${item.id} tiene una salida incierta; se retira para impedir un reenvío automático.`);
                continue;
            }
            // processAIChat gestiona sus propios errores internos; aquí solo se
            // marca el intento y se detiene el flush (el brain sigue caído).
            item.attempts += 1;
            messageQueue.saveHead();
            return;
        } finally {
            chatInFlight.delete(bufferKey);
            if (activeGenerationControllers.get(bufferKey) === controller) activeGenerationControllers.delete(bufferKey);
            if (item.controlSnapshot) {
                clearConversationMappings(item.controlSnapshot.conversationId);
            }
            notifyDrained(bufferKey);
        }
    }
}

messageQueue.setFlushHandler(flushQueuedMessages);

module.exports = {
    handleIncomingMessage,
    handlePresenceUpdate,
    drainConversation,
    drainAllConversations,
    getRuntimeStats
};
