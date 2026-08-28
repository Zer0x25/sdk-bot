// @ts-check
const { state } = require('../config');
const { getSettingsDB, getContactsDB } = require('./db');
const { isHandoffActive } = require('./contactsRepository');
const { cat } = require('./logger');
const { num } = require('../tuning');
const log = cat('DEBOUNCE');

// 🎲 Distracción/Ocupación humana (AFK) — TUNABLE vía .env.tuning.
// Capa 1: ~AFK_PROB de estar "muy ocupado/AFK" (espera AFK_MIN..AFK_MAX).
// Capa 2: ~BUSY_PROB de estar "ocupado breve" (espera BUSY_MIN..BUSY_MAX).
// Capa 3 (resto): adaptativo normal según longitud del mensaje.
const AFK_PROB = num('GATEWAY_AFK_PROB', 0.05);
const AFK_MIN_MS = num('GATEWAY_AFK_MIN_MS', 180000);
const AFK_MAX_MS = num('GATEWAY_AFK_MAX_MS', 240000);
const BUSY_PROB = num('GATEWAY_BUSY_PROB', 0.12);
const BUSY_MIN_MS = num('GATEWAY_BUSY_MIN_MS', 60000);
const BUSY_MAX_MS = num('GATEWAY_BUSY_MAX_MS', 120000);
const NORMAL_SHORT_MIN_MS = num('GATEWAY_NORMAL_SHORT_MIN_MS', 5000);
const NORMAL_SHORT_MAX_MS = num('GATEWAY_NORMAL_SHORT_MAX_MS', 7000);
const NORMAL_SHORT_MAX_LEN = num('GATEWAY_NORMAL_SHORT_MAX_LEN', 20);
const NORMAL_LONG_MIN_MS = num('GATEWAY_NORMAL_LONG_MIN_MS', 7500);
const NORMAL_LONG_MAX_MS = num('GATEWAY_NORMAL_LONG_MAX_MS', 12000);

/**
 * 🧠 PIPELINE DE DECISIÓN DE MENSAJES (F3-P3)
 * Lógica pura y testeable: recibe un mensaje normalizado y devuelve la ACCIÓN
 * a tomar. Sin timers, sin buffers, sin I/O de WhatsApp. Los side effects
 * (enviar, agendar, cambiar estado) los ejecuta el orquestador
 * (handlers/messageHandler.js).
 *
 * Acciones posibles:
 *   { type: 'ignore' }            — no hacer nada (con `reason`)
 *   { type: 'admin_command', ...} — comando admin del self-chat
 *   { type: 'self_chat_ai', ...}  — texto normal en self-chat → asistente IA
 *   { type: 'handoff', ...}       — cliente pidió atención humana
 *   { type: 'respond', ...}       — cliente normal → de-bounce + IA
 */

/**
 * 🎲 CALCULAR DEBOUNCE ADAPTATIVO CON DISTRACCIÓN/OCUPACIÓN HUMANA (RANDOM SOBRE RANDOM)
 * Capa 1 (Distracción/Ocupación):
 *   - ~5%  probabilidad: "Muy Ocupado / AFK" -> Espera de 3 a 4 min (180s - 240s)
 *   - ~12% probabilidad: "Ocupado / Distraído" -> Espera de 1 a 2 min (60s - 120s)
 * Capa 2 (Adaptativo Normal ~83%):
 *   - 1 mensaje corto (<20 chars): Espera de 5s a 7s
 *   - Múltiples mensajes o texto largo: Espera de 7.5s a 12s
 * @param {Array<string>} [messagesArray] - mensajes acumulados del chat
 * @param {Function} [rng] - generador de aleatorio inyectable para tests (default: Math.random)
 */
function getAdaptiveDebounceMs(messagesArray = [], rng = Math.random) {
    const roll = rng(); // 0.0 a 1.0

    // 1. Probabilidad de estar muy ocupado / AFK (GATEWAY_AFK_MIN_MS - GATEWAY_AFK_MAX_MS)
    if (roll < AFK_PROB) {
        const afkMs = Math.floor(AFK_MIN_MS + rng() * (AFK_MAX_MS - AFK_MIN_MS));
        log.info(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado/distraído (AFK). Esperando ${(afkMs / 1000).toFixed(0)}s (${(afkMs / 60000).toFixed(1)}m)...`);
        return afkMs;
    }

    // 2. Probabilidad de estar medianamente ocupado (GATEWAY_BUSY_MIN_MS - GATEWAY_BUSY_MAX_MS)
    if (roll < AFK_PROB + BUSY_PROB) {
        const busyMs = Math.floor(BUSY_MIN_MS + rng() * (BUSY_MAX_MS - BUSY_MIN_MS));
        log.info(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado brevemente. Esperando ${(busyMs / 1000).toFixed(0)}s (${(busyMs / 60000).toFixed(1)}m)...`);
        return busyMs;
    }

    // 3. Adaptativo Normal (~restante)
    const msgs = Array.isArray(messagesArray) ? messagesArray : [];
    const totalLength = msgs.join(' ').length;
    const msgCount = msgs.length;

    let normalMs;
    if (msgCount === 1 && totalLength < NORMAL_SHORT_MAX_LEN) {
        // Mensaje único y corto ("Hola", "Precio", etc.) -> NORMAL_SHORT_MIN..MAX
        normalMs = Math.floor(NORMAL_SHORT_MIN_MS + rng() * (NORMAL_SHORT_MAX_MS - NORMAL_SHORT_MIN_MS));
    } else {
        // Mensajes largos o múltiples -> NORMAL_LONG_MIN..MAX
        normalMs = Math.floor(NORMAL_LONG_MIN_MS + rng() * (NORMAL_LONG_MAX_MS - NORMAL_LONG_MIN_MS));
    }

    return normalMs;
}

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
 * 📝 Extraer el texto plano de cualquier tipo de mensaje de WhatsApp
 */
function extractTextMessage(msg) {
    return msg?.message?.conversation || 
           msg?.message?.extendedTextMessage?.text || 
           msg?.message?.imageMessage?.caption || 
           msg?.message?.documentMessage?.caption || 
           msg?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption || 
           "";
}

/**
 * 🚦 DECIDIR EL FLUJO DE UN MENSAJE ENTRANTE (puro, sin side effects)
 * @param {object} ctx
 * @param {string} ctx.textMessage - texto extraído del mensaje
 * @param {import('./metadataService.js').UserMetadata} ctx.metadata - salida de extractUserMetadata()
 * @param {import('./contactsRepository.js').ContactRecord} ctx.contactRecord - registro actual del contacto (upsert previo)
 * @param {boolean} ctx.isSelf - true si es el self-chat del admin
 * @param {boolean} ctx.isFromMe - true si el mensaje lo envió el propio admin
 * @param {number} [ctx.nowMs]
 * @param {number} [ctx.handoffTtlMs]
 * @returns {object} descriptor de acción (ver cabecera del módulo)
 */
function decideMessageFlow({ textMessage, metadata, contactRecord, isSelf, isFromMe, nowMs, handoffTtlMs }) {
    // -------------------------------------------------------------
    // SCENARIO 1: MENSAJES EN TU CHAT PROPIO (Self-Chat / Mensaje a ti mismo)
    // -------------------------------------------------------------
    if (isSelf) {
        if (textMessage.trim().startsWith('/')) {
            return { type: 'admin_command', text: textMessage.trim() };
        }
        return { type: 'self_chat_ai', text: textMessage };
    }

    // -------------------------------------------------------------
    // SCENARIO 2: MENSAJES ENVIADOS POR TI EN CHATS DE CLIENTES
    // -------------------------------------------------------------
    if (isFromMe) {
        return { type: 'ignore', reason: 'from_me' };
    }

    // -------------------------------------------------------------
    // SCENARIO 3: MENSAJES RECIBIDOS DE CLIENTES / TERCEROS
    // -------------------------------------------------------------

    // 🛡️ SEGURIDAD: Bloquear intentos de comandos / desde clientes
    if (textMessage.trim().startsWith('/')) {
        return { type: 'ignore', reason: 'client_command' };
    }

    // 🛑 Si el bot está pausado globalmente, no responder a clientes
    if (state.IS_BOT_PAUSED) {
        return { type: 'ignore', reason: 'paused' };
    }

    // 🛡️ REGLAS DE ESTADOS EN BASE DE DATOS (ContactsDB)
    const settings = getSettingsDB();
    let estado = (contactRecord && contactRecord.estado) || 'neutro';

    // ⏳ Verificación de expiración de Handoff (24 horas -> vuelve a neutro)
    if (estado === 'handoff') {
        if (isHandoffActive(contactRecord, nowMs, handoffTtlMs)) {
            return { type: 'ignore', reason: 'handoff_activo' };
        }
        // Handoff expirado: transiciona a neutro
        estado = 'neutro';
        if (contactRecord) {
            contactRecord.estado = 'neutro';
            contactRecord.handoffAt = null;
        }
    }

    if (estado === 'ignorado') {
        return { type: 'ignore', reason: 'estado_ignorado' };
    }

    if (estado !== 'permitido') {
        // Evaluar Modo Global (solo para no-permitidos: neutro y otros)
        const globalMode = state.GLOBAL_MODE || settings.globalMode || 'allowed_all';
        if (globalMode === 'ignored_all') {
            return { type: 'ignore', reason: 'modo_global_estricto' };
        }
    }

    // 🤝 REGLA 3: DERIVACIÓN Y HANDOFF A ATENCIÓN HUMANA

    // A) Verificar si el cliente activó palabras clave de atención humana
    if (checkHumanRequest(textMessage)) {
        const displayName = metadata.savedName ? `${metadata.savedName} (Agenda)` : (metadata.pushName || 'Desconocido');
        const targetId = metadata.phoneNumber || metadata.lid;

        const adminNotify = `🚨 *SOLICITUD DE ATENCIÓN HUMANA*\n\n` +
            `• *Cliente:* ${displayName}\n` +
            `• *Teléfono:* \`${metadata.phoneNumber || 'N/A'}\`\n` +
            `• *LID:* \`${metadata.lid || 'N/A'}\`\n` +
            `• *Mensaje:* "${textMessage}"\n` +
            `• *Duración:* 24 horas (volverá a neutro automáticamente)\n\n` +
            `📋 *Comando para reanudar IA antes (Toca para copiar):*\n` +
            `\`\`\`/auto ${targetId}\`\`\`\n\n` +
            `💡 *Tip:* También puedes responder (citar) a esta alerta escribiendo solo \`/auto\` o \`/a\`.`;

        return { type: 'handoff', targetId, displayName, adminNotify };
    }

    // 🧠 CLIENTE NORMAL: entra al de-bounce para responder con IA
    return { type: 'respond', text: textMessage };
}

/**
 * 🚦 ¿RECONECTAR TRAS UN CIERRE DE CONEXIÓN? (puro, F6-P4)
 * Reglas de reconexión automática tras `connection === 'close'`:
 *   - loggedOut (sesión revocada/cerrada en el teléfono): NO reconectar,
 *     el admin debe escanear un QR nuevo a propósito.
 *   - Sin sesión guardada Y sin identidad de emparejamiento: NO reconectar
 *     en loop — WhatsApp espera un QR/pairing y el loop solo martillea al
 *     servidor (riesgo de baneo). El QR nuevo lo dispara el admin.
 *   - Con identidad de emparejamiento a medias (`hasPairedIdentity`: creds
 *     con `me` pero `registered` aún false): SÍ reconectar — es el baile
 *     normal de WhatsApp tras escanear el QR o usar un código (cierra el
 *     stream con restartRequired/515 y exige reconexión para terminar el
 *     vínculo). Tratarlo como "sin_sesion" dejaba el pairing muerto a medio
 *     camino aunque el teléfono ya lo hubiera aceptado.
 *   - Con sesión válida: reconectar con backoff (caso normal).
 * @param {{hasSession: boolean, loggedOut: boolean, hasPairedIdentity?: boolean}} ctx
 * @returns {{reconnect: boolean, reason: string}}
 */
function decideReconnect({ hasSession, loggedOut, hasPairedIdentity }) {
    if (loggedOut) return { reconnect: false, reason: 'logged_out' };
    if (!hasSession && !hasPairedIdentity) return { reconnect: false, reason: 'sin_sesion' };
    return { reconnect: true, reason: 'normal' };
}

module.exports = {
    getAdaptiveDebounceMs,
    checkHumanRequest,
    getCandidateIdsForPresence,
    extractTextMessage,
    decideMessageFlow,
    decideReconnect,
    isHandoffActive
};
