// @ts-check
/**
 * 🧠 CLIENTE DEL BRAIN (HTTP) + ORQUESTACIÓN DE RESPUESTA IA.
 *
 * Responsabilidades (una sola dirección de dependencia: gateway → brain):
 *   1. Cliente REST hacia brain/main.py con timeouts y clasificación de
 *      errores 4xx (bug, no reintentar) vs 5xx/red (transitorio).
 *   2. Política de resiliencia: reintento 1x, cola en disco ante caída,
 *      alerta al admin con throttle.
 *   3. Simulación humana al entregar la respuesta (delegada a humanSim.js,
 *      funciones puras).
 * Aquí NO hay API keys de proveedores ni memoria conversacional: eso vive
 * en el proceso Python del brain.
 */
const { BRAIN_API_BASE, BRAIN_API_URL, BRAIN_API_KEY, state, registerSentMessage } = require('../config');
const { createHash, randomUUID } = require('node:crypto');
const { cat, errMsg } = require("../services/logger");
const { num } = require('../tuning');
const { enqueue, scheduleFlush } = require("./messageQueue");
const {
    splitIntoHumanBubbles, calculateReadDelay, calculateTypingDelay, calculatePauseBetweenBubbles
} = require('./humanSim');
const log = cat("AI");
const logError = cat("ERROR");

// 🔐 S1 — Header de autenticación hacia el brain (no-op si no hay key definida)
function authHeaders(extra = {}) {
    if (BRAIN_API_KEY) extra['X-API-Key'] = BRAIN_API_KEY;
    return extra;
}

// Caché en memoria de perfiles SOUL disponibles en el brain
let cachedProfiles = null;
let cachedProfilesAt = 0;
const PROFILES_CACHE_TTL_MS = num('GATEWAY_PROFILES_CACHE_TTL_MS', 60 * 1000); // 1 minuto: refresco para ver perfiles nuevos sin reiniciar (tunable vía .env.tuning)

// 📊 Métricas de llamadas a la IA para GET /status (F4-P3)
/** @type {{aiCalls: number, retries: number, lastAiAt: string|null, lastOkAt: string|null, lastErrorAt: string|null, lastErrorMsg: string|null}} */
const brainStats = {
    aiCalls: 0,
    retries: 0,
    lastAiAt: null,       // última vez que se inició una llamada
    lastOkAt: null,       // última respuesta exitosa del brain
    lastErrorAt: null,    // último error
    lastErrorMsg: null
};

/**
 * Stats de llamadas a la IA + estado de salud derivado:
 * `ok`: null (nunca se llamó), true (el último evento fue un éxito),
 * false (el último evento fue un error → brain caído/no responde).
 */
function getBrainStats() {
    const lastOk = brainStats.lastOkAt ? Date.parse(brainStats.lastOkAt) : null;
    const lastErr = brainStats.lastErrorAt ? Date.parse(brainStats.lastErrorAt) : null;
    /** @type {boolean|null} */
    let ok = null;
    if (lastOk) ok = lastErr && lastErr > lastOk ? false : true;
    return { ...brainStats, ok };
}

/**
 * 🚨 Notificar al Administrador en Self-Chat en caso de error técnico o fallo de IA
 */
async function notifyAdminError(adapter, metadata, textMessage, errorDetails) {
    if (!state.ADMIN_PHONE && !state.ADMIN_LID) {
        logError.error("⚠️ [ERROR ADMIN] No se detectó ADMIN_PHONE ni ADMIN_LID para enviar alerta de error.");
        return;
    }

    const adminJid = state.ADMIN_PHONE ? `whatsapp:${state.ADMIN_PHONE}` : `whatsapp:${state.ADMIN_LID}`;
    const displayName = metadata.savedName || metadata.pushName || 'Desconocido';
    const phone = metadata.phoneNumber || 'N/A';
    const lid = metadata.lid || 'N/A';
    const country = metadata.country || 'Desconocido';
    const targetKey = metadata.phoneNumber || metadata.lid || 'N/A';

    // Diagnóstico explícito de tipo de error para el administrador
    let errorSummary = `❌ **Error Técnico en IA:** ${errorDetails}`;
    const errStr = String(errorDetails || '').toLowerCase();

    if (errStr.includes('aborted') || errStr.includes('timeout')) {
        errorSummary = `⏳ **TIMEOUT DE IA (Tiempo de espera agotado tras 90s)**\n` +
                       `📌 *Causa:* El Gateway esperó 90 segundos a que la IA generara el texto, pero el modelo tardó demasiado (servidor saturado o respuesta sumamente extensa).\n` +
                       `🔧 *Detalle técnico:* ${errorDetails}`;
    } else if (errStr.includes('fetch failed') || errStr.includes('econnrefused')) {
        errorSummary = `🚨 **CEREBRO APAGADO / DESCONECTADO (Brain Offline)**\n` +
                       `📌 *Causa:* El servidor Python (\`brain/main.py\`) no está corriendo en ${BRAIN_API_BASE}/chat.\n` +
                       `🔧 *Detalle técnico:* ${errorDetails}`;
    }

    const adminAlert = 
        `⚠️ **ALERTA DE ERROR EN CEREBRO IA**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 **Cliente:** ${displayName}\n` +
        `📱 **Teléfono:** ${phone} | LID: ${lid}\n` +
        `🌎 **País:** ${country}\n` +
        `💬 **Mensaje del Cliente:** "${textMessage}"\n` +
        `${errorSummary}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *El bot esperó pero NO respondió al cliente.* Inicia el servidor Brain o responde manualmente. Pausar IA:\n` +
        `\`/handoff ${targetKey}\``;

    try {
        const sentAlert = await adapter.sendMessage(adminJid, adminAlert);
        registerSentMessage(sentAlert);
    } catch (err) {
        logError.error("Error al enviar alerta a Self-Chat del Admin: " + errMsg(err));
    }
}

/**
 * 🤝 Petición al brain con reintento 1x en errores TRANSITORIOS.
 * No se reintentan errores 4xx (422 de validación = bug, no transitorio).
 */
async function requestBrain(payload, jobSignal = null, endpoint = BRAIN_API_URL) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        signal: jobSignal ? AbortSignal.any([jobSignal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
        body: JSON.stringify(payload)
    });

    const data = /** @type {any} */ (await response.json());

    if (!response.ok) {
        // FastAPI devuelve {"detail": [...]} en 422 (validación) — loguear la causa real
        const detail = (data && data.detail) ? JSON.stringify(data.detail) : `HTTP ${response.status}`;
        const err = /** @type {Error & {status?: number; code?: string}} */ (new Error(`Brain rechazó la petición (${response.status}): ${detail}`));
        err.status = response.status;
        if (typeof data?.detail === 'string') err.code = data.detail;
        throw err;
    }

    if (!data.response && data.error) {
        const err = /** @type {Error & {status?: number}} */ (new Error(data.error));
        err.status = 502; // error del proveedor de IA = transitorio, reintentar
        throw err;
    }

    return data;
}

async function invalidateBrainGeneration(generationId, contextVersion) {
    try {
        await fetch(`${BRAIN_API_BASE}/invalidate-generation`, {
            method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({ generation_id: generationId, context_version: contextVersion })
        });
    } catch (error) {
        log.warn(`No se pudo registrar la invalidación de ${generationId}: ${errMsg(error)}`);
    }
}

function stableGenerationId(conversationId, contextVersion, sourceMessageIds) {
    const digest = createHash('sha256').update(JSON.stringify({ conversationId, contextVersion, sourceMessageIds })).digest('hex');
    return `gen_${digest}`;
}

function cancelledJob() {
    return Object.assign(new Error('La generación quedó obsoleta por un cambio de control.'), { code: 'CONTROL_JOB_CANCELLED' });
}

async function assertJobCurrent(opts) {
    if (opts.signal?.aborted) throw cancelledJob();
    if (typeof opts.isCurrent === 'function' && !await opts.isCurrent()) throw cancelledJob();
    if (state.IS_BOT_PAUSED && opts.controlSnapshot) throw cancelledJob();
}

/** @returns {Promise<void>} */
function waitForJob(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(cancelledJob()); return; }
        const onAbort = () => {
            clearTimeout(timer);
            reject(cancelledJob());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** @param {any} opts */
async function processAIChat(textMessage, remoteJid, metadata, adapter, opts = {}) {
    // opts.fromQueue = true cuando el mensaje viene de la cola persistente (F4-P4):
    // no re-encolar y no repetir la alerta al admin (el flush lo gestiona).
    // Nota: la precarga en presencia (Opción A) es SOLO señal de intervención;
    // NO se inyecta aquí. /chat siempre usa get_history() completo (7d/5000tok).
    brainStats.aiCalls += 1;
    brainStats.lastAiAt = new Date().toISOString();
    const displayName = metadata.savedName || metadata.pushName || 'Usuario';
    const sourceMessageIds = Array.isArray(opts.sourceMessageIds) ? [...new Set(opts.sourceMessageIds)] : [];
    const generationId = opts.generationId || (opts.controlSnapshot?.conversationId && sourceMessageIds.length
        ? stableGenerationId(opts.controlSnapshot.conversationId, opts.controlSnapshot.contextVersion, sourceMessageIds)
        : randomUUID());
    const explicitContext = Boolean(opts.controlSnapshot && adapter.archive && sourceMessageIds.length);
    const langLog = metadata.language ? ` | Idioma: ${metadata.language}` : '';
    log.info(`\n[ENVIANDO A IA] De: ${displayName} (${remoteJid}) | País: ${metadata.country}${langLog}`);
    
    let payload = {
        user_id: remoteJid,
        message: textMessage,
        bot_profile: metadata.perfil || state.CURRENT_PROFILE,
        bot_id: state.ADMIN_PHONE || state.ADMIN_LID || 'single', // F4-P2: aislamiento de memoria por bot
        saved_name: metadata.savedName,
        push_name: metadata.pushName,
        user_name: displayName,
        phone_number: metadata.phoneNumber,
        lid: metadata.lid,
        country: metadata.country,
        language: metadata.language,
        bio: metadata.bio,
        is_business: metadata.isBusiness
    };
    let endpoint = BRAIN_API_URL;
    let contextVersion = opts.controlSnapshot?.contextVersion || null;

    try {
        if (opts.controlSnapshot && !explicitContext) {
            throw Object.assign(new Error('AI_CONTEXT_SOURCE_REQUIRED'), { code: 'AI_CONTEXT_SOURCE_REQUIRED' });
        }
        if (explicitContext) {
            const context = await adapter.archive.aiContext({
                conversationId: opts.controlSnapshot.conversationId,
                expectedContextVersion: opts.controlSnapshot.contextVersion,
                throughMessageId: sourceMessageIds[sourceMessageIds.length - 1],
                excludeMessageIds: sourceMessageIds, excludeGenerationId: generationId
            });
            if (!context || !context.throughMessageId) throw Object.assign(new Error('AI_CONTEXT_ANCHOR_MISSING'), { code: 'AI_CONTEXT_ANCHOR_MISSING' });
            contextVersion = context.contextVersion;
            payload = { ...payload, generation_id: generationId, conversation_id: context.conversationId,
                context_version: context.contextVersion, through_message_id: context.throughMessageId,
                context: context.messages.flatMap(message => {
                    const content = message.content;
                    const text = content.type === 'text' ? content.text : content.transcript || content.caption || '';
                    if (!text) return [];
                    return [{ role: message.authorKind === 'customer' ? 'user' : 'assistant',
                        author_kind: message.authorKind, content: text }];
                }) };
            endpoint = `${BRAIN_API_BASE}/generate-reply`;
        }
        let data;
        try {
            await assertJobCurrent(opts);
            data = await requestBrain(payload, opts.signal, endpoint);
        } catch (error) {
            if (opts.signal?.aborted || /** @type {any} */ (error)?.code === 'CONTROL_JOB_CANCELLED') throw cancelledJob();
            // ↻ Retry 1x solo en errores transitorios (red, timeout, 5xx). 4xx = bug, no reintentar.
            const err = /** @type {Error & {status?: number}} */ (error);
            if (!err.status || err.status >= 500) {
                brainStats.retries += 1;
                log.warn(`↻ Error transitorio del cerebro (${err.message}). Reintentando (1/1)...`);
                await waitForJob(1500, opts.signal);
                await assertJobCurrent(opts);
                data = await requestBrain(payload, opts.signal, endpoint);
            } else {
                throw err;
            }
        }

        await assertJobCurrent(opts);
        if (data.response) {
            brainStats.lastOkAt = new Date().toISOString();
            log.info(`[BOT RESPONDE A ${displayName}]: ${data.response}`);

            // 📥 F4-P4: si había mensajes encolados y el brain volvió, procesarlos
            if (!opts.fromQueue) scheduleFlush();

            // 🧠 1. Simulación de Lectura / Pensamiento Humano (antes de teclear)
            const readDelay = calculateReadDelay(textMessage);
            log.info(`[SIMULACIÓN HUMANA] 📖 Leyendo/pensando durante ${(readDelay / 1000).toFixed(2)}s...`);
            await waitForJob(readDelay, opts.signal);
            await assertJobCurrent(opts);

            // 🧩 2. Divisón inteligente en globos (Multi-Bubble)
            const bubbles = splitIntoHumanBubbles(data.response);

            // ⌨️ 3. Secuencia de Escritura + Envío por Globo
            for (let i = 0; i < bubbles.length; i++) {
                const bubble = bubbles[i];
                const typingDelay = calculateTypingDelay(bubble);

                log.info(`[SIMULACIÓN HUMANA] ⌨️ Tecleando globo ${i + 1}/${bubbles.length} (${bubble.length} chars) durante ${(typingDelay / 1000).toFixed(2)}s...`);
                await assertJobCurrent(opts);
                await adapter.sendPresenceUpdate('composing', remoteJid);
                await waitForJob(typingDelay, opts.signal);
                await assertJobCurrent(opts);

                const sentMsg = await adapter.sendMessage(remoteJid, bubble, {
                    source: 'ai', generationId, bubbleIndex: i,
                    idempotencyKey: `${generationId}:bubble:${i}`,
                    isCurrent: async () => !state.IS_BOT_PAUSED && (!opts.isCurrent || await opts.isCurrent()),
                    ...(opts.controlSnapshot ? { controlSnapshot: opts.controlSnapshot,
                        conversationId: opts.controlSnapshot.conversationId } : {})
                });
                registerSentMessage(sentMsg);

                // ☕ Pausa humana entre globos consecutivos
                if (i < bubbles.length - 1) {
                    await assertJobCurrent(opts);
                    await adapter.sendPresenceUpdate('paused', remoteJid).catch(() => {});
                    const pauseBetweenBubbles = calculatePauseBetweenBubbles();
                    log.info(`[SIMULACIÓN HUMANA] ☕ Pausa entre globos de ${(pauseBetweenBubbles / 1000).toFixed(2)}s...`);
                    await waitForJob(pauseBetweenBubbles, opts.signal);
                    await assertJobCurrent(opts);
                }
            }
        } else {
            logError.error("Error del cerebro:", data.error);
            if (opts.fromQueue) {
                throw new Error(data.error || "Respuesta vacía del cerebro IA");
            }
            await notifyAdminError(adapter, metadata, textMessage, data.error || "Respuesta vacía del cerebro IA");
        }
    } catch (error) {
        const caught = /** @type {Error & {status?: number; code?: string}} */ (error);
        if (opts.signal?.aborted || /** @type {any} */ (error)?.code === 'CONTROL_JOB_CANCELLED') {
            if (explicitContext && contextVersion) await invalidateBrainGeneration(generationId, contextVersion);
            log.info(`[CONTROL F5] Trabajo IA cancelado para ${remoteJid}; no se continúa con otros globos.`);
            return;
        }
        if (explicitContext && ['OUTBOUND_CONTROL_STALE','AI_CONTEXT_VERSION_STALE','AI_CONTEXT_ANCHOR_MISSING','GENERATION_INVALIDATED'].includes(caught.code || '')) {
            if (contextVersion) await invalidateBrainGeneration(generationId, contextVersion);
            log.info(`[CONTROL F5] Generación ${generationId} invalidada para ${remoteJid}; no se continúa con otros globos.`);
            return;
        }
        if (opts.controlSnapshot && ['AI_CONTEXT_SOURCE_REQUIRED','AI_CONTEXT_ANCHOR_MISSING'].includes(caught.code || '')) {
            caught.status = 422;
        }
        brainStats.lastErrorAt = new Date().toISOString();
        brainStats.lastErrorMsg = errMsg(error);
        logError.error("Error al conectar con el cerebro: " + errMsg(error));
        if (hasOutboundAttempt(error)) {
            const outboundError = /** @type {any} */ (error);
            const detail = isAmbiguousOutbound(error) ? 'incierta' : 'fallida';
            logError.error(`Salida IA ${detail} (${outboundError?.outboundIntentId || 'sin id'}); se suspende el replay automático de la generación.`);
            if (opts.fromQueue) throw error;
            return;
        }
        await handleBrainFailure(error, textMessage, remoteJid, metadata, adapter, opts);
        // 📥 F4-P4: en modo cola, el error debe llegar al flush (que marca el intento
        // y reintenta después). En el flujo normal, el error queda manejado aquí.
        if (opts.fromQueue) throw error;
    } finally {
        await adapter.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }
}

function isAmbiguousOutbound(error) {
    return error?.outboundState === 'delivery_unknown' || error?.outboundState === 'sending'
        || ['OUTBOUND_DELIVERY_UNKNOWN','OUTBOUND_IN_PROGRESS','OUTBOUND_CLAIM_UNCERTAIN'].includes(error?.code);
}

function hasOutboundAttempt(error) {
    return Boolean(error?.outboundIntentId || error?.outboundState);
}

// ⏱️ Alerta al admin como máximo cada 15 minutos (F4-P4: evita spam de mensajes
// "cerebro apagado" si el brain está caído mucho tiempo y llegan muchos clientes).
const BRAIN_ALERT_THROTTLE_MS = num('GATEWAY_BRAIN_ALERT_THROTTLE_MS', 15 * 60 * 1000);
let lastBrainAlertAt = 0;

/**
 * 🛠️ Fallo transitorio del brain: encola el mensaje en disco (F4-P4) y avisa al
 * admin con throttle. Los 4xx (bug) NO se encolan: se avisa tal cual.
 */
async function handleBrainFailure(error, textMessage, remoteJid, metadata, adapter, opts) {
    const err = /** @type {Error & {status?: number}} */ (error);
    const transitory = !err.status || err.status >= 500;
    const msg = errMsg(error);
    const now = Date.now();

    if (opts.fromQueue) {
        // El flush reintentará o descartará según attempts; solo loguear aquí.
        return;
    }

    let queued = false;
    if (transitory) {
        // 📥 Encolar en disco: el mensaje del cliente no se pierde
        queued = enqueue({ jid: remoteJid, text: textMessage, metadata,
            ...(Array.isArray(opts.sourceMessageIds) && opts.sourceMessageIds.length ? { sourceMessageIds: opts.sourceMessageIds } : {}),
            ...(opts.controlSnapshot ? { controlSnapshot: opts.controlSnapshot } : {}) });
        scheduleFlush();
    }

    if (now - lastBrainAlertAt < BRAIN_ALERT_THROTTLE_MS) {
        log.warn(`⏳ [COLA] Alerta al admin omitida (throttle 15 min). Mensaje ${queued ? 'ENCOLADO' : 'fallido'}: ${msg}`);
        return;
    }
    lastBrainAlertAt = now;

    const suffix = queued
        ? '\n📥 *El mensaje del cliente quedó ENCOLADO en disco y se responderá automáticamente cuando el brain vuelva.*'
        : (transitory
            ? '\n❌ *Cola de mensajes llena — este mensaje del cliente se PERDIÓ.*'
            : '');
    await notifyAdminError(adapter, metadata, textMessage, msg + suffix);
}

async function clearAIMemory(userJid) {
    try {
        const response = await fetch(`${BRAIN_API_BASE}/reset-memory`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            signal: AbortSignal.timeout(5000), // comando admin: nunca colgar el handler
            body: JSON.stringify({ user_id: userJid, bot_id: state.ADMIN_PHONE || state.ADMIN_LID || 'single' })
        });
        const data = /** @type {any} */ (await response.json());
        return data && data.status === 'ok';
    } catch (e) {
        logError.error("Error al resetear memoria en Brain: " + errMsg(e));
        return false;
    }
}

/**
 * 📚 Obtener perfiles SOUL disponibles en el brain (GET /profiles)
 * Cacheado en memoria; si el brain está apagado, devuelve lista vacía
 * (el comando /perfil informará que no puede listarlos).
 */
async function getAvailableProfiles() {
    if (cachedProfiles && (Date.now() - cachedProfilesAt < PROFILES_CACHE_TTL_MS)) return cachedProfiles;
    try {
        const profilesUrl = `${BRAIN_API_BASE}/profiles`;
        const response = await fetch(profilesUrl, {
            method: 'GET',
            headers: authHeaders(),
            signal: AbortSignal.timeout(5000)
        });
        const data = /** @type {any} */ (await response.json());
        cachedProfiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
        cachedProfilesAt = Date.now();
        return cachedProfiles;
    } catch (e) {
        logError.error("Error al obtener perfiles del Brain: " + errMsg(e));
        return [];
    }
}

/**
 * 📄 Obtener detalle/prompt compilado de un perfil (GET /profiles/{key})
 */
async function getProfileDetail(profileKey) {
    try {
        const detailUrl = `${BRAIN_API_BASE}/profiles/${encodeURIComponent(profileKey)}`;
        const response = await fetch(detailUrl, {
            method: 'GET',
            headers: authHeaders(),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        logError.error("Error al obtener detalle de perfil: " + errMsg(e));
        return null;
    }
}

/**
 * 📤 Exportar el .md crudo de un perfil (GET /profiles/{key}/file)
 * Devuelve { content, filename } o null.
 */
async function exportProfileFile(profileKey) {
    try {
        const fileUrl = `${BRAIN_API_BASE}/profiles/${encodeURIComponent(profileKey)}/file`;
        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: authHeaders(),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return null;
        const content = await response.text();
        return { content, filename: `${profileKey}.md` };
    } catch (e) {
        logError.error("Error al exportar archivo de perfil: " + errMsg(e));
        return null;
    }
}

/**
 * 📥 Importar un perfil .md editado (POST /profiles/import)
 * Devuelve el JSON del brain o null.
 */
async function importProfileFile(profileKey, content) {
    try {
        const importUrl = `${BRAIN_API_BASE}/profiles/import`;
        const response = await fetch(importUrl, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({ key: profileKey, content })
        });
        const result = /** @type {any} */ (await response.json());
        if (result && result.success) {
            // 🔄 Invalidar caché: un perfil nuevo/modificado debe verse de inmediato
            cachedProfiles = null;
            cachedProfilesAt = 0;
        }
        return result;
    } catch (e) {
        logError.error("Error al importar perfil al Brain: " + errMsg(e));
        return null;
    }
}

/**
 * 🔄 Forzar la recarga de la carpeta profiles/ del brain (POST /profiles/reload)
 * Devuelve el JSON del brain o null.
 */
async function reloadProfiles() {
    try {
        const reloadUrl = `${BRAIN_API_BASE}/profiles/reload`;
        const response = await fetch(reloadUrl, {
            method: 'POST',
            headers: authHeaders(),
            signal: AbortSignal.timeout(5000)
        });
        const result = /** @type {any} */ (await response.json());
        cachedProfiles = null;
        cachedProfilesAt = 0;
        return result;
    } catch (e) {
        logError.error("Error al recargar perfiles del Brain: " + errMsg(e));
        return null;
    }
}

/**
 * 🗑️ Eliminar un perfil .md del brain (DELETE /profiles/{key})
 * Devuelve el JSON del brain o null.
 */
async function deleteProfileFile(profileKey) {
    try {
        const deleteUrl = `${BRAIN_API_BASE}/profiles/${encodeURIComponent(profileKey)}`;
        const response = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: authHeaders(),
            signal: AbortSignal.timeout(5000)
        });
        const result = /** @type {any} */ (await response.json());
        if (result && result.success) {
            // 🔄 Invalidar caché: el perfil ya no debe verse
            cachedProfiles = null;
            cachedProfilesAt = 0;
        }
        return result;
    } catch (e) {
        logError.error("Error al eliminar perfil del Brain: " + errMsg(e));
        return null;
    }
}

/**
 * 💓 Healthcheck activo del brain (F6-P3 dashboard): el gateway sondea
 * GET /health cada BRAIN_HEALTH_INTERVAL_MS y guarda el estado real del
 * proceso. Así el panel puede mostrar Running / Stopped / Idle en vez
 * del heurístico "ok/caído/sin llamadas" que solo miraba la última respuesta.
 * - Running: health 200 OK y llamadas IA en los últimos BRAIN_IDLE_MS.
 * - Stopped: no responde / timeout / conexión rechazada.
 * - Idle: Running pero sin llamadas IA en los últimos BRAIN_IDLE_MS.
 */
const BRAIN_HEALTH_INTERVAL_MS = Number(process.env.SDK_BRAIN_HEALTH_INTERVAL_MS || 10000);
const BRAIN_HEALTH_TIMEOUT_MS = Number(process.env.SDK_BRAIN_HEALTH_TIMEOUT_MS || 4000);
const BRAIN_IDLE_MS = Number(process.env.SDK_BRAIN_IDLE_MS || process.env.SDK_BRAIN_STANDBY_MS || 5 * 60 * 1000);

/** @type {{reachable: boolean, status: string|null, checkedAt: number, health: any, lastError: string|null}} */
const brainHealth = {
    reachable: false,
    status: null,      // 'ok' del endpoint, o null si no respondió
    checkedAt: 0,
    health: null,      // payload completo de /health
    lastError: null
};

async function checkBrainHealth() {
    try {
        const response = await fetch(`${BRAIN_API_BASE}/health`, {
            method: 'GET',
            headers: authHeaders(),
            signal: AbortSignal.timeout(BRAIN_HEALTH_TIMEOUT_MS)
        });
        const data = /** @type {any} */ (await response.json());
        brainHealth.reachable = true;
        brainHealth.status = (data && data.status) || 'ok';
        brainHealth.health = data;
        brainHealth.lastError = null;
        brainHealth.checkedAt = Date.now();
    } catch (e) {
        brainHealth.reachable = false;
        brainHealth.status = null;
        brainHealth.health = null;
        brainHealth.lastError = errMsg(e);
        brainHealth.checkedAt = Date.now();
    }
    return brainHealth;
}

/**
 * Estado derivado para el panel: Running / Stopped / Idle.
 * @returns {'Running'|'Stopped'|'Idle'}
 */
function getBrainState() {
    if (!brainHealth.reachable) return 'Stopped';
    const lastAi = brainStats.lastAiAt ? Date.parse(brainStats.lastAiAt) : null;
    if (lastAi && (Date.now() - lastAi) < BRAIN_IDLE_MS) return 'Running';
    return 'Idle';
}

function getBrainHealth() {
    return { ...brainHealth, state: getBrainState() };
}

/**
 * 📚 Precarga del historial de un chat (GET /history) para la precarga en
 * presencia (Opción A). No genera respuesta: solo devuelve el contexto que el
 * brain ya tendría vía get_history(). Devuelve [] si el brain está caído.
 * @param {string} userJid
 * @returns {Promise<Array<{role:string, content:string}>>}
 */
async function getChatHistory(userJid, opts = {}) {
    try {
        let url = `${BRAIN_API_BASE}/history?user_id=${encodeURIComponent(userJid)}&bot_id=${encodeURIComponent(state.ADMIN_PHONE || state.ADMIN_LID || 'single')}`;
        // Límites de la precarga (etapa 1, "primera página" web-like). Si no vienen,
        // el brain usa sus límites globales. Estos NO se inyectan en /chat.
        if (opts.maxMessages) url += `&max_messages=${encodeURIComponent(String(opts.maxMessages))}`;
        if (opts.maxTokens) url += `&max_tokens=${encodeURIComponent(String(opts.maxTokens))}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: authHeaders(),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return [];
        const data = /** @type {any} */ (await response.json());
        return Array.isArray(data.history) ? data.history : [];
    } catch (e) {
        logError.error("Error al precargar historial del Brain: " + errMsg(e));
        return [];
    }
}

/**
 * Arranca el sondeo periódico. No mantiene el proceso vivo (unref).
 * Llamar una vez al iniciar el gateway.
 */
function startBrainHealthWatch() {
    // Sondeo inmediato para no arrancar el panel con estado desconocido.
    checkBrainHealth().catch(() => {});
    const t = setInterval(() => { checkBrainHealth().catch(() => {}); }, BRAIN_HEALTH_INTERVAL_MS);
    if (t.unref) t.unref();
}

module.exports = {
    processAIChat,
    clearAIMemory,
    getAvailableProfiles,
    getProfileDetail,
    exportProfileFile,
    importProfileFile,
    deleteProfileFile,
    reloadProfiles,
    // Simulación humana: re-exportada por compatibilidad; fuente canónica en services/humanSim.js
    splitIntoHumanBubbles,
    calculateReadDelay,
    calculateTypingDelay,
    calculatePauseBetweenBubbles,
    getBrainStats,
    getBrainHealth,
    getBrainState,
    getChatHistory,
    startBrainHealthWatch
};
