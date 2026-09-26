// @ts-check
/**
 * 📥 Cola persistente de mensajes (F4-P4).
 * Si el brain está caído (error transitorio), el mensaje del cliente se encola
 * en disco (JSONL, una línea por mensaje) para responderlo cuando el brain
 * vuelva, en vez de perderlo.
 *
 * Path: env SDK_MESSAGE_QUEUE_PATH (default gateway/queue/pending_messages.jsonl)
 * Límites: env SDK_MESSAGE_QUEUE_MAX (default 50 items) y TTL 24h.
 * Toda escritura que modifica la cola reescribe el archivo de forma atómica
 * (tmp + rename, mismo patrón que db.js).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cat, errMsg } = require('./logger');

const log = cat('STORAGE');
const logError = cat('ERROR');

const QUEUE_FILE = process.env.SDK_MESSAGE_QUEUE_PATH || path.join(__dirname, '..', 'queue', 'pending_messages.jsonl');
const MAX_QUEUE_ITEMS = Number(process.env.SDK_MESSAGE_QUEUE_MAX || 50);
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000; // 24h: mensajes más viejos se descartan

/** @type {Array<{id: string, jid: string, text: string, metadata: Object, createdAt: number, attempts: number}>} */
let queue = [];

/** @type {((item: any) => Promise<void>) | null} */
let flushHandler = null;   // registrado por messageHandler.js (evita dependencia circular)
/** @type {any} */
let sock = null;           // socket activo para responder (lo setea index.js)
/** @type {NodeJS.Timeout | null} */
let flushTimer = null;     // debounce del flush
let flushInProgress = false;

/**
 * @returns {string}
 */
function queueFileDir() {
    return path.dirname(QUEUE_FILE);
}

function persist() {
    fs.mkdirSync(queueFileDir(), { recursive: true });
    const tmp = `${QUEUE_FILE}.tmp`;
    fs.writeFileSync(tmp, queue.map(entry => JSON.stringify(entry)).join('\n') + (queue.length ? '\n' : ''));
    fs.renameSync(tmp, QUEUE_FILE);
}

function loadFromDisk() {
    try {
        if (!fs.existsSync(QUEUE_FILE)) return;
        const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
        const now = Date.now();
        queue = raw.split('\n')
            .filter(line => line.trim())
            .map(line => {
                try { return JSON.parse(line); } catch { return null; }
            })
            .filter(Boolean)
            .filter(entry => (now - (entry.createdAt || 0)) < MAX_QUEUE_AGE_MS)
            .slice(0, MAX_QUEUE_ITEMS);
        if (queue.length > 0) {
            log.warn(`📥 [COLA] Cargados ${queue.length} mensaje(s) pendientes de la última caída del brain.`);
        }
    } catch (e) {
        logError.error('📥 [COLA] Error al leer la cola de disco: ' + errMsg(e));
        queue = [];
    }
}

loadFromDisk();

/**
 * Encola un mensaje del cliente. Devuelve true si entró en la cola,
 * false si la cola está llena (el mensaje se descarta).
 * @param {{jid: string, text: string, metadata: Object}} item
 * @returns {boolean}
 */
function enqueue(item) {
    if (queue.length >= MAX_QUEUE_ITEMS) {
        logError.error(`📥 [COLA] Cola llena (${MAX_QUEUE_ITEMS}). Descartado mensaje de ${item.jid}: "${item.text.slice(0, 60)}"`);
        return false;
    }
    const entry = {
        id: crypto.randomUUID(),
        jid: item.jid,
        text: item.text,
        metadata: item.metadata,
        createdAt: Date.now(),
        attempts: 0
    };
    queue.push(entry);
    try {
        persist();
    } catch (e) {
        logError.error('📥 [COLA] Error al escribir la cola: ' + errMsg(e));
        queue.pop();
        return false;
    }
    log.warn(`📥 [COLA] Mensaje de ${item.jid} encolado en disco (${queue.length}/${MAX_QUEUE_ITEMS}). Se responderá cuando el brain vuelva.`);
    return true;
}

/**
 * Primer mensaje pendiente sin sacarlo de la cola.
 * @returns {{id: string, jid: string, text: string, metadata: Object, createdAt: number, attempts: number} | null}
 */
function peek() {
    return queue.length ? queue[0] : null;
}

function removeHead() {
    if (!queue.length) return;
    queue.shift();
    try {
        persist();
    } catch (e) {
        logError.error('📥 [COLA] Error al persistir tras desencolar: ' + errMsg(e));
    }
}

/** Pide persistir en disco tras modificar la cabeza (p. ej. +1 a attempts). */
function saveHead() {
    try {
        persist();
    } catch (e) {
        logError.error('📥 [COLA] Error al persistir la cola: ' + errMsg(e));
    }
}

function getQueueStats() {
    const oldest = queue.reduce((min, e) => (min === 0 || e.createdAt < min ? e.createdAt : min), 0);
    return {
        pending: queue.length,
        max: MAX_QUEUE_ITEMS,
        oldestAt: oldest ? new Date(oldest).toISOString() : null
    };
}

/**
 * 🚀 Flush: proceso los mensajes encolados cuando el brain vuelve.
 * El handler lo registra messageHandler.js (tiene chatInFlight + enqueueAI).
 * @param {(item: Object) => Promise<void>} handler
 */
function setFlushHandler(handler) {
    flushHandler = handler;
}

/** @type {((channel: string) => any) | null} */
let adapterResolver = null;

function setAdapterResolver(resolver) {
    adapterResolver = resolver;
}

/**
 * Resuelve el adaptador adecuado para el JID (ej. 'telegram:...' -> TelegramAdapter).
 * Si no hay resolver registrado o no encuentra canal, hace fallback a `sock`.
 * @param {string} [jid]
 */
function resolveAdapter(jid) {
    if (jid && adapterResolver) {
        const channel = jid.includes(':') ? jid.split(':')[0] : 'whatsapp';
        const found = adapterResolver(channel);
        if (found) return found;
    }
    return sock;
}

/** index.js lo llama con el socket activo para poder responder. */
function setSock(activeSock) {
    sock = activeSock;
}

function getSock() {
    return sock;
}

/**
 * Programa el flush con debounce (no encadenar flushes si el brain sigue caído).
 */
function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!flushHandler || !sock) return;
        if (flushInProgress) return;
        flushInProgress = true;
        flushHandler(sock)
            .catch(e => logError.error('📥 [COLA] Error en flush: ' + errMsg(e)))
            .finally(() => { flushInProgress = false; });
    }, 3000);
    flushTimer.unref?.();
}

/** Para tests: estado interno y limpieza. */
function __debugState() {
    return { flushInProgress, hasHandler: !!flushHandler, hasSock: !!sock };
}

function clearQueueForTest() {
    queue = [];
    try { persist(); } catch { /* noop */ }
}

module.exports = {
    enqueue,
    peek,
    removeHead,
    saveHead,
    getQueueStats,
    setFlushHandler,
    setSock,
    getSock,
    setAdapterResolver,
    resolveAdapter,
    scheduleFlush,
    __debugState,
    clearQueueForTest,
    QUEUE_FILE,
    MAX_QUEUE_ITEMS
};
