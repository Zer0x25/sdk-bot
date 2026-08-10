const { state } = require('../config');
const { getSettingsDB, getContactsDB } = require('./db');
const { cat } = require('./logger');
const log = cat('DEBOUNCE');

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

    // 1. Probabilidad del 5% de estar muy ocupado / AFK (3 - 4 min)
    if (roll < 0.05) {
        const afkMs = Math.floor(180000 + rng() * 60000); // 180s a 240s
        log.info(`🎲 [HUMAN RANDOM] Roll ${(roll * 100).toFixed(1)}%: Bot ocupado/distraído (AFK). Esperando ${(afkMs / 1000).toFixed(0)}s (${(afkMs / 60000).toFixed(1)}m)...`);
        return afkMs;
    }

    // 2. Probabilidad del 12% de estar medianamente ocupado (1 - 2 min)
    if (roll < 0.17) { // 0.05 + 0.12 = 0.17
        const busyMs = Math.floor(60000 + rng() * 60000); // 60s a 120s
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
        normalMs = Math.floor(5000 + rng() * 2000);
    } else {
        // Mensajes largos o múltiples -> 7.5s a 12s
        normalMs = Math.floor(7500 + rng() * 4500);
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
 * @param {object} ctx.metadata - salida de extractUserMetadata()
 * @param {object} ctx.contactRecord - registro actual del contacto (upsert previo)
 * @param {boolean} ctx.isSelf - true si es el self-chat del admin
 * @param {boolean} ctx.isFromMe - true si el mensaje lo envió el propio admin
 * @returns {object} descriptor de acción (ver cabecera del módulo)
 */
function decideMessageFlow({ textMessage, metadata, contactRecord, isSelf, isFromMe }) {
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
    const estado = contactRecord.estado || 'neutro';

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
            `• *Mensaje:* "${textMessage}"\n\n` +
            `📋 *Comando para reanudar IA (Toca para copiar):*\n` +
            `\`\`\`/auto ${targetId}\`\`\`\n\n` +
            `💡 *Tip:* También puedes responder (citar) a esta alerta escribiendo solo \`/auto\` o \`/a\`.`;

        return { type: 'handoff', targetId, displayName, adminNotify };
    }

    // B) Verificar si el cliente ya tiene Handoff Activo (pausado individualmente)
    if (estado === 'handoff') {
        return { type: 'ignore', reason: 'handoff_activo' };
    }

    // 🧠 CLIENTE NORMAL: entra al de-bounce para responder con IA
    return { type: 'respond', text: textMessage };
}

module.exports = {
    getAdaptiveDebounceMs,
    checkHumanRequest,
    getCandidateIdsForPresence,
    extractTextMessage,
    decideMessageFlow
};
