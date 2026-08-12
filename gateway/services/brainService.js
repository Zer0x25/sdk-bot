// @ts-check
const { BRAIN_API_BASE, BRAIN_API_URL, BRAIN_API_KEY, state, registerSentMessage } = require('../config');
const { cat, errMsg } = require("../services/logger");
const { enqueue, scheduleFlush } = require("./messageQueue");
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
const PROFILES_CACHE_TTL_MS = 60 * 1000; // 1 minuto: refresco para ver perfiles nuevos sin reiniciar

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
 * 🧩 Dividir respuestas largas de la IA en globos de chat naturales (Multi-Bubble)
 * Divide párrafos largos por oraciones (. ! ?) si superan los ~220 caracteres.
 */
function splitIntoHumanBubbles(text) {
    if (!text || typeof text !== 'string') return [text];
    const trimmed = text.trim();
    if (trimmed.length <= 220) return [trimmed];

    // 1. Separar por párrafos / saltos de línea
    const rawBlocks = trimmed.split(/\n+/).map(b => b.trim()).filter(Boolean);
    let chunks = [];

    for (const block of rawBlocks) {
        if (block.length <= 250) {
            chunks.push(block);
        } else {
            // Si el bloque es muy largo (>250 chars) sin saltos de línea, dividir por oraciones (. ! ?)
            const sentences = block.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
            let currentChunk = '';

            for (const s of sentences) {
                if (!currentChunk) {
                    currentChunk = s;
                } else if ((currentChunk.length + s.length + 1) <= 220) {
                    currentChunk += ' ' + s;
                } else {
                    chunks.push(currentChunk);
                    currentChunk = s;
                }
            }
            if (currentChunk) chunks.push(currentChunk);
        }
    }

    // 2. Reagrupar fragmentos manteniendo un tamaño cómodo por globo (~220 chars máx)
    const finalBubbles = [];
    let currentBubble = '';

    for (const chunk of chunks) {
        if (!currentBubble) {
            currentBubble = chunk;
        } else if ((currentBubble.length + chunk.length + 1) <= 220) {
            currentBubble += ' ' + chunk;
        } else {
            finalBubbles.push(currentBubble);
            currentBubble = chunk;
        }
    }
    if (currentBubble) finalBubbles.push(currentBubble);

    return finalBubbles.length > 0 ? finalBubbles : [trimmed];
}

/**
 * 🧠 Calcular tiempo de lectura/pensamiento inicial antes de empezar a teclear
 */
function calculateReadDelay(incomingText) {
    const len = (incomingText || '').length;
    const baseReadMs = Math.min(Math.max(len * 15, 1000), 3000);
    const readJitter = (Math.random() - 0.5) * 600; // ±300ms de varianza
    return Math.max(Math.round(baseReadMs + readJitter), 800);
}

/**
 * ⌨️ Calcular tiempo de tecleo ultra-realista con ruido estocástico (Jitter)
 * Basado en velocidad rápida de teclado móvil: ~7 a 10 caracteres por segundo (100ms a 135ms por carácter)
 */
function calculateTypingDelay(bubbleText) {
    const len = (bubbleText || '').length;
    const msPerChar = 100 + Math.random() * 35; // 100ms a 135ms por carácter (7 - 10 char/s)
    const baseTypingMs = len * msPerChar;
    const typingJitter = (Math.random() - 0.5) * 1000; // ±500ms de ruido estocástico
    return Math.min(Math.max(Math.round(baseTypingMs + typingJitter), 1500), 16000);
}

/**
 * 🚨 Notificar al Administrador en Self-Chat en caso de error técnico o fallo de IA
 */
async function notifyAdminError(sock, metadata, textMessage, errorDetails) {
    if (!state.ADMIN_PHONE && !state.ADMIN_LID) {
        logError.error("⚠️ [ERROR ADMIN] No se detectó ADMIN_PHONE ni ADMIN_LID para enviar alerta de error.");
        return;
    }

    const adminJid = state.ADMIN_PHONE ? `${state.ADMIN_PHONE}@s.whatsapp.net` : `${state.ADMIN_LID}@lid`;
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
                       `📌 *Causa:* El servidor Python (\`brain/main.py\`) no está corriendo en http://127.0.0.1:8000/chat.\n` +
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
        const sentAlert = await sock.sendMessage(adminJid, { text: adminAlert });
        registerSentMessage(sentAlert);
    } catch (err) {
        logError.error("Error al enviar alerta a Self-Chat del Admin: " + errMsg(err));
    }
}

/**
 * 🤝 Petición al brain con reintento 1x en errores TRANSITORIOS.
 * No se reintentan errores 4xx (422 de validación = bug, no transitorio).
 */
async function requestBrain(payload) {
    const response = await fetch(BRAIN_API_URL, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        signal: AbortSignal.timeout(90000), // 90 segundos de timeout para permitir generación de textos largos o modelos lentos
        body: JSON.stringify(payload)
    });

    const data = /** @type {any} */ (await response.json());

    if (!response.ok) {
        // FastAPI devuelve {"detail": [...]} en 422 (validación) — loguear la causa real
        const detail = (data && data.detail) ? JSON.stringify(data.detail) : `HTTP ${response.status}`;
        const err = /** @type {Error & {status?: number}} */ (new Error(`Brain rechazó la petición (${response.status}): ${detail}`));
        err.status = response.status;
        throw err;
    }

    if (!data.response && data.error) {
        const err = /** @type {Error & {status?: number}} */ (new Error(data.error));
        err.status = 502; // error del proveedor de IA = transitorio, reintentar
        throw err;
    }

    return data;
}

async function processAIChat(textMessage, remoteJid, metadata, sock, opts = {}) {
    // opts.fromQueue = true cuando el mensaje viene de la cola persistente (F4-P4):
    // no re-encolar y no repetir la alerta al admin (el flush lo gestiona).
    brainStats.aiCalls += 1;
    brainStats.lastAiAt = new Date().toISOString();
    const displayName = metadata.savedName || metadata.pushName || 'Usuario';
    const langLog = metadata.language ? ` | Idioma: ${metadata.language}` : '';
    log.info(`\n[ENVIANDO A IA] De: ${displayName} (${remoteJid}) | País: ${metadata.country}${langLog}`);
    
    const payload = {
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

    try {
        let data;
        try {
            data = await requestBrain(payload);
        } catch (error) {
            // ↻ Retry 1x solo en errores transitorios (red, timeout, 5xx). 4xx = bug, no reintentar.
            const err = /** @type {Error & {status?: number}} */ (error);
            if (!err.status || err.status >= 500) {
                brainStats.retries += 1;
                log.warn(`↻ Error transitorio del cerebro (${err.message}). Reintentando (1/1)...`);
                await new Promise(r => setTimeout(r, 1500));
                data = await requestBrain(payload);
            } else {
                throw err;
            }
        }

        if (data.response) {
            brainStats.lastOkAt = new Date().toISOString();
            log.info(`[BOT RESPONDE A ${displayName}]: ${data.response}`);

            // 📥 F4-P4: si había mensajes encolados y el brain volvió, procesarlos
            if (!opts.fromQueue) scheduleFlush();

            // 🧠 1. Simulación de Lectura / Pensamiento Humano (antes de teclear)
            const readDelay = calculateReadDelay(textMessage);
            log.info(`[SIMULACIÓN HUMANA] 📖 Leyendo/pensando durante ${(readDelay / 1000).toFixed(2)}s...`);
            await new Promise(r => setTimeout(r, readDelay));

            // 🧩 2. Divisón inteligente en globos (Multi-Bubble)
            const bubbles = splitIntoHumanBubbles(data.response);

            // ⌨️ 3. Secuencia de Escritura + Envío por Globo
            for (let i = 0; i < bubbles.length; i++) {
                const bubble = bubbles[i];
                const typingDelay = calculateTypingDelay(bubble);

                log.info(`[SIMULACIÓN HUMANA] ⌨️ Tecleando globo ${i + 1}/${bubbles.length} (${bubble.length} chars) durante ${(typingDelay / 1000).toFixed(2)}s...`);
                
                await sock.sendPresenceUpdate('composing', remoteJid);
                await new Promise(r => setTimeout(r, typingDelay));

                const sentMsg = await sock.sendMessage(remoteJid, { text: bubble });
                registerSentMessage(sentMsg);

                // ☕ Pausa humana entre globos consecutivos
                if (i < bubbles.length - 1) {
                    await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
                    const pauseBetweenBubbles = 1000 + Math.floor(Math.random() * 1200); // 1.0s a 2.2s
                    log.info(`[SIMULACIÓN HUMANA] ☕ Pausa entre globos de ${(pauseBetweenBubbles / 1000).toFixed(2)}s...`);
                    await new Promise(r => setTimeout(r, pauseBetweenBubbles));
                }
            }
        } else {
            logError.error("Error del cerebro:", data.error);
            if (opts.fromQueue) {
                throw new Error(data.error || "Respuesta vacía del cerebro IA");
            }
            await notifyAdminError(sock, metadata, textMessage, data.error || "Respuesta vacía del cerebro IA");
        }
    } catch (error) {
        brainStats.lastErrorAt = new Date().toISOString();
        brainStats.lastErrorMsg = errMsg(error);
        logError.error("Error al conectar con el cerebro: " + errMsg(error));
        await handleBrainFailure(error, textMessage, remoteJid, metadata, sock, opts);
        // 📥 F4-P4: en modo cola, el error debe llegar al flush (que marca el intento
        // y reintenta después). En el flujo normal, el error queda manejado aquí.
        if (opts.fromQueue) throw error;
    } finally {
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }
}

// ⏱️ Alerta al admin como máximo cada 15 minutos (F4-P4: evita spam de mensajes
// "cerebro apagado" si el brain está caído mucho tiempo y llegan muchos clientes).
const BRAIN_ALERT_THROTTLE_MS = 15 * 60 * 1000;
let lastBrainAlertAt = 0;

/**
 * 🛠️ Fallo transitorio del brain: encola el mensaje en disco (F4-P4) y avisa al
 * admin con throttle. Los 4xx (bug) NO se encolan: se avisa tal cual.
 */
async function handleBrainFailure(error, textMessage, remoteJid, metadata, sock, opts) {
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
        queued = enqueue({ jid: remoteJid, text: textMessage, metadata });
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
    await notifyAdminError(sock, metadata, textMessage, msg + suffix);
}

async function clearAIMemory(userJid) {
    try {
        const response = await fetch(`${BRAIN_API_BASE}/reset-memory`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
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
 * proceso. Así el panel puede mostrar Running / Stopped / Stand-by en vez
 * del heurístico "ok/caído/sin llamadas" que solo miraba la última respuesta.
 * - Running: health 200 OK.
 * - Stopped: no responde / timeout / conexión rechazada.
 * - Stand-by: Running pero sin llamadas IA en los últimos BRAIN_STANDBY_MS.
 */
const BRAIN_HEALTH_INTERVAL_MS = Number(process.env.SDK_BRAIN_HEALTH_INTERVAL_MS || 10000);
const BRAIN_HEALTH_TIMEOUT_MS = Number(process.env.SDK_BRAIN_HEALTH_TIMEOUT_MS || 4000);
const BRAIN_STANDBY_MS = Number(process.env.SDK_BRAIN_STANDBY_MS || 5 * 60 * 1000);

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
 * Estado derivado para el panel: Running / Stopped / Stand-by.
 * @returns {'Running'|'Stopped'|'Stand-by'}
 */
function getBrainState() {
    if (!brainHealth.reachable) return 'Stopped';
    const lastAi = brainStats.lastAiAt ? Date.parse(brainStats.lastAiAt) : null;
    if (lastAi && (Date.now() - lastAi) < BRAIN_STANDBY_MS) return 'Running';
    return 'Stand-by';
}

function getBrainHealth() {
    return { ...brainHealth, state: getBrainState() };
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
    splitIntoHumanBubbles,
    calculateReadDelay,
    calculateTypingDelay,
    getBrainStats,
    getBrainHealth,
    getBrainState,
    startBrainHealthWatch
};
