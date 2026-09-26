// @ts-check
/**
 * 📢 Servicio de broadcasts y mensajes programados (F4-P5).
 *
 * Un broadcast es un mensaje masivo a los contactos de la agenda (isContact)
 * que NO están ignorados ni en handoff. Protección anti-ban:
 *   - Límite diario por número (env SDK_BROADCAST_DAILY_LIMIT, default 2):
 *     un contacto recibe como máximo ese nº de mensajes de broadcast por día.
 *   - Pacing: un mensaje por tick (10s en index.js) - resume-safe (cursor).
 *
 * Persistencia: broadcast_db.json (env SDK_BROADCAST_DB_PATH para tests),
 * escritura atómica tmp+rename con debounce (patrón de db.js). Un broadcast
 * a mitad de envío se retoma tras reiniciar el gateway.
 *
 * /programar: misma máquina, con scheduledAt en el futuro (hoy si la hora no
 * pasó, si no mañana).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { state, registerSentMessage } = require('../config');
const { getContactsDB } = require('./db');
const { cat, errMsg } = require('./logger');
const { num } = require('../tuning');

const log = cat('BROADCAST');
const logError = cat('ERROR');

const DB_FILE = process.env.SDK_BROADCAST_DB_PATH || path.join(__dirname, '..', 'broadcast_db.json');
const DAILY_LIMIT = Number(process.env.SDK_BROADCAST_DAILY_LIMIT || 2);
const CONFIRMATION_TTL_MS = num('GATEWAY_BROADCAST_CONFIRMATION_TTL_MS', 60000); // 1 minuto para confirmar con "si" (tunable vía .env.tuning)

/**
 * @typedef {Object} BroadcastEntry
 * @property {string} id
 * @property {string} text
 * @property {string|null} scheduledAt   // ISO; null = inmediato
 * @property {('pending'|'sending'|'done'|'cancelled')} status
 * @property {number} cursor             // índice del próximo contacto a enviar
 * @property {number} eligible           // total de contactos aptos al inicio
 * @property {number} sent
 * @property {number} skipped            // omitidos por límite diario
 * @property {number} failed             // errores de envío
 * @property {string} createdAt
 */

/**
 * @typedef {Object} BroadcastDB
 * @property {BroadcastEntry[]} broadcasts
 * @property {Object<string, {date: string, count: number}>} dailySends
 * @property {boolean} [enabled]   // F4-P6: broadcasts apagados por defecto
 */

let db = /** @type {BroadcastDB} */ ({ broadcasts: [], dailySends: {} });
/** @type {any} */
let sock = null;
let isConnectedFn = () => false;

// -------------------------------------------------------------
// PERSISTENCIA (atómica síncrona: tmp + rename)
// El cursor se escribe tras CADA envío: un crash nunca provoca re-envíos.
// -------------------------------------------------------------
function persist() {
    try {
        const tmp = `${DB_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, DB_FILE);
    } catch (e) {
        logError.error('📢 [BROADCAST] Error al guardar broadcast_db.json: ' + errMsg(e));
    }
}

function load() {
    try {
        if (fs.existsSync(DB_FILE)) {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!Array.isArray(db.broadcasts)) db.broadcasts = [];
            if (!db.dailySends || typeof db.dailySends !== 'object') db.dailySends = {};
            // Un broadcast que quedó a medias vuelve a 'pending' para retomarse
            for (const b of db.broadcasts) {
                if (b.status === 'sending') b.status = 'pending';
            }
            const pending = db.broadcasts.filter(b => b.status === 'pending').length;
            if (pending > 0) log.warn(`📢 [BROADCAST] ${pending} broadcast(s) pendiente(s) retomados de disco.`);
        }
    } catch (e) {
        logError.error('📢 [BROADCAST] Error al leer broadcast_db.json: ' + errMsg(e));
    }
    // 🔴 F4-P6: apagado por defecto. El valor persistido manda; si no existe,
    // el admin lo enciende con /broadcast on o el deploy con SDK_BROADCAST_ENABLED=1.
    if (db.enabled === undefined) {
        db.enabled = process.env.SDK_BROADCAST_ENABLED === '1';
    }
    if (!db.enabled) log.warn('📢 [BROADCAST] Desactivado por defecto. Actívalo con `/broadcast on` (o SDK_BROADCAST_ENABLED=1).');
}
load();

// -------------------------------------------------------------
// PURE: lógica de elegibilidad y límites (testeable sin socket)
// -------------------------------------------------------------
const JUNK_JID_PATTERN = /@g\.us$|status@broadcast|@newsletter/;

function todayStr(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Contactos aptos para recibir un broadcast: de la agenda (isContact),
 * sin estado ignorado/handoff y con JID envíable (teléfono o LID).
 * @param {Object} [contactsDb] - override para tests
 * @returns {Array<{jid: string, phone: string|null}>}
 */
function getEligibleContacts(contactsDb = getContactsDB()) {
    const out = [];
    for (const record of Object.values(contactsDb)) {
        if (!record || record.isContact !== true) continue;
        if (record.estado === 'ignorado' || record.estado === 'handoff') continue;
        let jid = /** @type {string|null} */ (null);
        if (record.phone) {
            jid = `${record.phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        } else if (record.lid) {
            jid = `${record.lid.replace(/[^0-9]/g, '')}@lid`;
        }
        if (!jid || JUNK_JID_PATTERN.test(jid)) continue;
        const phone = record.phone ? record.phone.replace(/[^0-9]/g, '') : null;
        out.push({ jid, phone });
    }
    return out;
}

/**
 * ¿Se le puede enviar un broadcast a este teléfono hoy? (límite diario)
 * @param {string|null} phone
 * @param {Object<string, {date: string, count: number}>} [dailySends]
 * @param {Date} [now]
 * @returns {boolean}
 */
function canSendTo(phone, dailySends = db.dailySends, now = new Date()) {
    if (!phone) return true; // LID sin teléfono: no hay contador que consultar
    const entry = dailySends[phone];
    if (!entry) return true;
    if (entry.date !== todayStr(now)) return true;
    return entry.count < DAILY_LIMIT;
}

function markSent(phone, dailySends, now = new Date()) {
    if (!phone) return;
    const date = todayStr(now);
    const entry = dailySends[phone];
    if (entry && entry.date === date) {
        entry.count += 1;
    } else {
        dailySends[phone] = { date, count: 1 };
    }
}

/**
 * Parsea "HH:MM" a la próxima ocurrencia (hoy si aún no pasó, si no mañana).
 * Devuelve null si el formato es inválido.
 * @param {string} input
 * @param {Date} [now]
 * @returns {string|null}
 */
function parseScheduleTime(input, now = new Date()) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(input).trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1); // la hora ya pasó → mañana
    }
    return target.toISOString();
}

// -------------------------------------------------------------
// API para comandos
// -------------------------------------------------------------
/** @returns {boolean} */
function isEnabled() {
    return db.enabled === true;
}

/**
 * Enciende/apaga los broadcasts. Al apagar se cancelan los pendientes/en curso.
 * @param {boolean} on
 */
function setEnabled(on) {
    db.enabled = on;
    if (!on) {
        for (const b of db.broadcasts) {
            if (b.status === 'pending' || b.status === 'sending') b.status = 'cancelled';
        }
    }
    persist();
    log.warn(`📢 [BROADCAST] ${on ? 'Activado' : 'Desactivado'} por el admin.`);
}

/** @returns {BroadcastDB['dailySends']} */
function getDailySends() {
    return db.dailySends;
}

/** @returns {BroadcastEntry[]} */
function getBroadcasts() {
    return db.broadcasts;
}

/**
 * Encola un broadcast (inmediato si scheduledAt es null).
 * Devuelve null si los broadcasts están desactivados.
 * @param {string} text
 * @param {string|null} scheduledAt
 * @returns {BroadcastEntry|null}
 */
function enqueueBroadcast(text, scheduledAt = null) {
    if (!isEnabled()) return null;
    const eligible = getEligibleContacts();
    const entry = /** @type {BroadcastEntry} */ ({
        id: crypto.randomUUID(),
        text,
        scheduledAt,
        status: 'pending',
        cursor: 0,
        eligible: eligible.length,
        sent: 0,
        skipped: 0,
        failed: 0,
        createdAt: new Date().toISOString()
    });
    db.broadcasts.push(entry);
    persist();
    log.warn(`📢 [BROADCAST] Programado: "${text.slice(0, 60)}" → ${eligible.length} contactos aptos${scheduledAt ? ` a las ${scheduledAt}` : ' (inmediato)'}.`);
    return entry;
}

/**
 * Cancela broadcasts pendientes/programados (los que no se han enviado aún).
 * Devuelve cuántos se cancelaron.
 * @returns {number}
 */
function cancelPending() {
    const before = db.broadcasts.length;
    for (const b of db.broadcasts) {
        if (b.status === 'pending' || b.status === 'sending') {
            b.status = 'cancelled';
        }
    }
    const cancelled = db.broadcasts.filter(b => b.status === 'cancelled').length;
    persist();
    log.warn(`📢 [BROADCAST] Cancelados ${cancelled} broadcast(s) (de ${before} en registro).`);
    return cancelled;
}

/** Resumen para /broadcast estado */
function buildStatusText() {
    const now = new Date();
    const date = todayStr(now);
    const todaySends = Object.entries(db.dailySends)
        .filter(([, e]) => e.date === date)
        .reduce((acc, [, e]) => acc + e.count, 0);
    const pending = db.broadcasts.filter(b => b.status === 'pending');
    const lines = [];
    for (const b of pending) {
        const when = b.scheduledAt
            ? `programado para ${new Date(b.scheduledAt).toLocaleString('es-CL')}`
            : 'inmediato (pendiente de confirmar)';
        lines.push(`• \`${b.text.slice(0, 50)}...\` - ${when} (${b.eligible} contactos)`);
    }
    return `📢 *Broadcasts:*\n` +
        `• *Estado:* ${isEnabled() ? '✅ ACTIVADO' : '🔴 DESACTIVADO'}\n` +
        `• *Límite diario por contacto:* ${DAILY_LIMIT} mensaje(s)\n` +
        `• *Enviados hoy:* ${todaySends}\n` +
        (pending.length
            ? `• *Pendientes:* ${pending.length}\n${lines.join('\n')}`
            : '• *Pendientes:* ninguno\n') +
        `\n📝 Uso: \`/broadcast <texto>\` o \`/programar <HH:MM> <texto>\`. Confirma con *si*.`;
}

// -------------------------------------------------------------
// WORKER (tick cada ~10s desde index.js; 1 mensaje por tick)
// -------------------------------------------------------------
/** @param {() => boolean} fn */
function setIsConnected(fn) {
    isConnectedFn = fn;
}

function setSock(activeSock) {
    sock = activeSock;
}

/** Métricas para GET /status */
function getBroadcastStats() {
    const pending = db.broadcasts.filter(b => b.status === 'pending').length;
    const sending = db.broadcasts.filter(b => b.status === 'sending').length;
    return { enabled: isEnabled(), pending, sending, total: db.broadcasts.length, dailyLimit: DAILY_LIMIT };
}

/**
 * Un paso del worker: si hay un broadcast por empezar/enviando, manda un mensaje.
 * Resume-safe: el cursor se persiste tras cada envío. No hace nada si los
 * broadcasts están desactivados.
 */
async function sendMessageSafe(targetJid, text) {
    if (!sock) return null;
    // Si sock es un ChannelAdapter que espera (normalizedJid, text)
    if (typeof sock.channelName === 'string') {
        const normalized = targetJid.startsWith('whatsapp:') || targetJid.startsWith('telegram:')
            ? targetJid
            : `whatsapp:${targetJid}`;
        return await sock.sendMessage(normalized, text);
    }
    // Socket raw de Baileys o mock de test
    return await sock.sendMessage(targetJid, { text });
}

let tickRunning = false;

async function tickUnsafe() {
    if (!isEnabled()) return;
    if (!sock || !isConnectedFn()) return;

    const now = new Date();
    let active = db.broadcasts.find(b => b.status === 'sending');

    if (!active) {
        // Promover el primer broadcast pendiente cuyo momento llegó
        const due = db.broadcasts.find(b =>
            b.status === 'pending' &&
            (b.scheduledAt === null || new Date(b.scheduledAt).getTime() <= now.getTime())
        );
        if (!due) return;
        active = due;
        due.status = 'sending';
        if (due.eligible === 0) {
            due.status = 'done';
            persist();
            await notifyAdmin(`📢 *Broadcast finalizado (0 contactos aptos):* ${due.text.slice(0, 80)}`);
            return;
        }
        log.warn(`📢 [BROADCAST] Comenzando envío a ${due.eligible} contactos: "${due.text.slice(0, 60)}"`);
        persist();
    }

    const contacts = getEligibleContacts();
    let target = contacts[active.cursor];
    if (!target) {
        // La agenda cambió o se terminó: cerrar
        active.status = 'done';
        persist();
        await notifyAdmin(
            `📢 *Broadcast finalizado:*\n${active.sent} enviados • ${active.skipped} omitidos (límite diario) • ${active.failed} fallidos\n💬 *Texto:* ${active.text.slice(0, 80)}`
        );
        return;
    }

    if (!canSendTo(target.phone)) {
        active.skipped += 1;
        active.cursor += 1;
        persist();
        return; // sin envío; el próximo tick continúa
    }

    try {
        const sentMsg = await sendMessageSafe(target.jid, active.text);
        if (sentMsg) registerSentMessage(sentMsg);
        active.sent += 1;
        markSent(target.phone, db.dailySends);
        log.info(`📢 [BROADCAST] (${active.sent}/${active.eligible}) → ${target.jid}`);
    } catch (e) {
        // Contacto problemático: se salta (evita bucles infinitos) y se cuenta
        active.failed += 1;
        logError.error(`📢 [BROADCAST] Fallo al enviar a ${target.jid}: ` + errMsg(e));
    }
    active.cursor += 1;
    persist();
}

/**
 * Ejecuta como máximo un tick a la vez. El intervalo del gateway no espera
 * al Promise devuelto por tick(); sin este guard, un sendMessage lento podía
 * hacer que dos ticks usaran el mismo cursor y duplicaran el mensaje.
 */
async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try {
        return await tickUnsafe();
    } finally {
        tickRunning = false;
    }
}

async function notifyAdmin(text) {
    if (!sock) return;
    const adminJid = state.ADMIN_PHONE ? `${state.ADMIN_PHONE}@s.whatsapp.net` : (state.ADMIN_LID ? `${state.ADMIN_LID}@lid` : null);
    if (!adminJid) return;
    try {
        const sent = await sendMessageSafe(adminJid, text);
        if (sent) registerSentMessage(sent);
    } catch (e) {
        logError.error('📢 [BROADCAST] No se pudo notificar al admin: ' + errMsg(e));
    }
}

// -------------------------------------------------------------
// CONFIRMACIÓN EN 2 PASOS (el admin responde "si" o "cancelar")
// -------------------------------------------------------------
/** @type {{text: string, scheduledAt: string|null, expiresAt: number} | null} */
let pendingConfirmation = null;

function requestConfirmation(text, scheduledAt) {
    pendingConfirmation = { text, scheduledAt, expiresAt: Date.now() + CONFIRMATION_TTL_MS };
}

function hasPendingConfirmation() {
    if (!pendingConfirmation) return false;
    if (Date.now() > pendingConfirmation.expiresAt) {
        pendingConfirmation = null;
        return false;
    }
    return true;
}

/**
 * Intercepta la respuesta del admin al pedido de confirmación.
 * Devuelve true si consumió el mensaje (respondió con si/cancelar).
 * @param {string} text
 * @param {any} activeSock
 * @param {string} remoteJid
 * @returns {Promise<boolean>}
 */
async function tryConfirm(text, activeSock, remoteJid) {
    if (!hasPendingConfirmation() || !pendingConfirmation) return false;
    const norm = text.trim().toLowerCase();

    if (norm === 'si' || norm === 'confirmar' || norm === 'sí' || norm === 'ok' || norm === 'confirmo') {
        const conf = pendingConfirmation;
        pendingConfirmation = null;
        const entry = enqueueBroadcast(conf.text, conf.scheduledAt);
        if (!entry) {
            await activeSock.sendMessage(remoteJid, { text: '🔴 *Broadcasts desactivados.* Actívalos con `/broadcast on`.' });
            return true;
        }
        await activeSock.sendMessage(remoteJid, {
            text: conf.scheduledAt
                ? `📅 *Broadcast programado* para ${new Date(conf.scheduledAt).toLocaleString('es-CL')} (${entry.eligible} contactos aptos).`
                : `✅ *Broadcast confirmado.* Se enviará a ${entry.eligible} contactos (${DAILY_LIMIT}/día máx. por contacto).`
        });
        return true;
    }

    if (norm === 'cancelar' || norm === 'cancel' || norm === 'no') {
        pendingConfirmation = null;
        await activeSock.sendMessage(remoteJid, { text: '✖️ *Broadcast cancelado.*' });
        return true;
    }

    return false;
}

module.exports = {
    enqueueBroadcast,
    cancelPending,
    buildStatusText,
    getEligibleContacts,
    canSendTo,
    markSent,
    parseScheduleTime,
    tick,
    setSock,
    setIsConnected,
    getBroadcastStats,
    requestConfirmation,
    hasPendingConfirmation,
    tryConfirm,
    getDailySends,
    getBroadcasts,
    isEnabled,
    setEnabled,
    todayStr,
    DAILY_LIMIT
};
