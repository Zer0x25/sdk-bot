const { BRAIN_API_BASE, BRAIN_API_URL, BRAIN_API_KEY, state, registerSentMessage } = require('../config');
const { cat } = require("../services/logger");
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
        logError.error("Error al enviar alerta a Self-Chat del Admin:", err.message);
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

    const data = await response.json();

    if (!response.ok) {
        // FastAPI devuelve {"detail": [...]} en 422 (validación) — loguear la causa real
        const detail = (data && data.detail) ? JSON.stringify(data.detail) : `HTTP ${response.status}`;
        const err = new Error(`Brain rechazó la petición (${response.status}): ${detail}`);
        err.status = response.status;
        throw err;
    }

    if (!data.response && data.error) {
        const err = new Error(data.error);
        err.status = 502; // error del proveedor de IA = transitorio, reintentar
        throw err;
    }

    return data;
}

async function processAIChat(textMessage, remoteJid, metadata, sock) {
    const displayName = metadata.savedName || metadata.pushName || 'Usuario';
    const langLog = metadata.language ? ` | Idioma: ${metadata.language}` : '';
    log.info(`\n[ENVIANDO A IA] De: ${displayName} (${remoteJid}) | País: ${metadata.country}${langLog}`);
    
    const payload = {
        user_id: remoteJid,
        message: textMessage,
        bot_profile: metadata.perfil || state.CURRENT_PROFILE,
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
            if (!error.status || error.status >= 500) {
                log.warn(`↻ Error transitorio del cerebro (${error.message}). Reintentando (1/1)...`);
                await new Promise(r => setTimeout(r, 1500));
                data = await requestBrain(payload);
            } else {
                throw error;
            }
        }

        if (data.response) {
            log.info(`[BOT RESPONDE A ${displayName}]: ${data.response}`);
            
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
            await notifyAdminError(sock, metadata, textMessage, data.error || "Respuesta vacía del cerebro IA");
        }
    } catch (error) {
        logError.error("Error al conectar con el cerebro:", error.message);
        await notifyAdminError(sock, metadata, textMessage, error.message);
    } finally {
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }
}

async function clearAIMemory(userJid) {
    try {
        const response = await fetch(`${BRAIN_API_BASE}/reset-memory`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ user_id: userJid })
        });
        const data = await response.json();
        return data && data.status === 'ok';
    } catch (e) {
        logError.error("Error al resetear memoria en Brain:", e.message);
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
        const data = await response.json();
        cachedProfiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
        cachedProfilesAt = Date.now();
        return cachedProfiles;
    } catch (e) {
        logError.error("Error al obtener perfiles del Brain:", e.message);
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
        logError.error("Error al obtener detalle de perfil:", e.message);
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
        logError.error("Error al exportar archivo de perfil:", e.message);
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
        const result = await response.json();
        if (result && result.success) {
            // 🔄 Invalidar caché: un perfil nuevo/modificado debe verse de inmediato
            cachedProfiles = null;
            cachedProfilesAt = 0;
        }
        return result;
    } catch (e) {
        logError.error("Error al importar perfil al Brain:", e.message);
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
        const result = await response.json();
        if (result && result.success) {
            // 🔄 Invalidar caché: el perfil ya no debe verse
            cachedProfiles = null;
            cachedProfilesAt = 0;
        }
        return result;
    } catch (e) {
        logError.error("Error al eliminar perfil del Brain:", e.message);
        return null;
    }
}

module.exports = {
    processAIChat,
    clearAIMemory,
    getAvailableProfiles,
    getProfileDetail,
    exportProfileFile,
    importProfileFile,
    deleteProfileFile
};
