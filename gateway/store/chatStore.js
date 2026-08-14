// Store RAM de mensajes de WhatsApp (Opción C: precarga web-like desde Baileys).
//
// Baileys rc14 NO exporta makeInMemoryStore, así que mantenemos nuestro propio
// store en RAM. Se siembra con los mensajes del evento `messaging-history.set`
// (al vincular, trae el historial de TODOS los chats UNA vez) y se actualiza con
// cada `messages.upsert` en vivo.
//
// La precarga (etapa 1) lee de AQUÍ, on-demand por chat (igual que el web:
// al abrir/señalar un chat, muestra el hilo real de ESE chat, no los 1000).
// NO es masivo: solo se lee el jid que está en `composing`.
//
// Limpieza de RAM: cada chat guarda como máximo MAX_PER_CHAT mensajes (los más
// recientes). Si un chat no se toca en CHAT_TTL_MS, se evicta del Map. Así 1000
// contactos no explotan la memoria: cada uno tiene tope y los fríos se botan.

const DEFAULT_MAX_PER_CHAT = 200;   // tope por chat en RAM (el web muestra menos, pero guardamos margen)
const DEFAULT_CHAT_TTL_MS = 30 * 60 * 1000; // 30 min sin actividad -> evict

let MAX_PER_CHAT = DEFAULT_MAX_PER_CHAT;
let CHAT_TTL_MS = DEFAULT_CHAT_TTL_MS;

// Map<jid, { msgs: Map<msgKey, msg>, lastTouch: number }>
const store = new Map();

function configure(opts = {}) {
    if (opts.maxPerChat && opts.maxPerChat > 0) MAX_PER_CHAT = opts.maxPerChat;
    if (opts.chatTtlMs && opts.chatTtlMs > 0) CHAT_TTL_MS = opts.chatTtlMs;
}

function _entry(jid) {
    let e = store.get(jid);
    if (!e) {
        e = { msgs: new Map(), lastTouch: Date.now() };
        store.set(jid, e);
    }
    e.lastTouch = Date.now();
    return e;
}

// Extrae el jid "real" de un mensaje (remitente en 1-a-1, o id del chat en grupo).
function _jidOf(msg) {
    const m = msg?.key;
    if (!m) return null;
    // En 1-a-1 el chat es key.remoteJid; en grupos también.
    return m.remoteJid || null;
}

// Normaliza un mensaje de Baileys a { role, content, timestamp, fromMe } para la precarga.
function _normalize(msg) {
    const body = msg?.message;
    let text = '';
    if (body?.conversation) text = body.conversation;
    else if (body?.extendedTextMessage?.text) text = body.extendedTextMessage.text;
    else if (body?.imageMessage?.caption) text = body.imageMessage.caption;
    else if (body?.documentMessage?.caption) text = body.documentMessage.caption;
    if (!text) return null; // ignorar media sin caption, stickers, etc.
    const key = msg?.key;
    return {
        role: key?.fromMe ? 'assistant' : 'user',
        content: text,
        fromMe: !!key?.fromMe,
        timestamp: msg?.messageTimestamp || 0,
    };
}

// Sembrar desde messaging-history.set (historial completo de un chat).
function seedMessages(messages = []) {
    for (const msg of messages) {
        const jid = _jidOf(msg);
        if (!jid) continue;
        const norm = _normalize(msg);
        if (!norm) continue;
        const e = _entry(jid);
        // clave estable = id del mensaje (para dedupe)
        const k = msg?.key?.id || `${norm.timestamp}:${norm.content}`;
        e.msgs.set(k, norm);
    }
    _enforceCaps();
}

// Agregar un mensaje en vivo (messages.upsert).
function upsertMessage(msg) {
    const jid = _jidOf(msg);
    if (!jid) return;
    const norm = _normalize(msg);
    if (!norm) return;
    const e = _entry(jid);
    const k = msg?.key?.id || `${norm.timestamp}:${norm.content}`;
    e.msgs.set(k, norm);
    _enforceCaps();
}

// Leer los últimos n mensajes de un jid (web-like, on-demand).
function getRecent(jid, n = 25) {
    const e = store.get(jid);
    if (!e || e.msgs.size === 0) return [];
    const arr = Array.from(e.msgs.values());
    // ordenar por timestamp ascendente (más viejo -> más nuevo)
    arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const slice = arr.slice(-Math.max(1, n));
    return slice;
}

// Recortar cada chat al tope y evictar chats fríos.
function _enforceCaps() {
    const now = Date.now();
    for (const [jid, e] of store.entries()) {
        if (now - e.lastTouch > CHAT_TTL_MS) {
            store.delete(jid);
            continue;
        }
        if (e.msgs.size > MAX_PER_CHAT) {
            const arr = Array.from(e.msgs.values())
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            const keep = arr.slice(-MAX_PER_CHAT);
            e.msgs = new Map(keep.map(m => [m.timestamp + ':' + m.content, m]));
        }
    }
}

// Limpieza periódica (llamar desde index.js con un intervalo).
function startCleanup(intervalMs = 10 * 60 * 1000) {
    const t = setInterval(() => _enforceCaps(), intervalMs);
    if (t.unref) t.unref();
    return t;
}

function size() {
    return store.size;
}

module.exports = {
    configure,
    seedMessages,
    upsertMessage,
    getRecent,
    startCleanup,
    size,
    _store: store, // solo para tests/debug
};
