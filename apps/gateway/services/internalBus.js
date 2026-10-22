// @ts-check
/* global AbortController */
/**
 * 🔌 BUS INTERNO del gateway (tercer proceso: el panel web lo consume).
 *
 * Antes el panel (adminWebServer) vivía DENTRO del proceso del gateway y
 * recibía el socket/QR por llamadas directas en memoria. Eso acoplaba el
 * panel al bot: al detener el gateway se caía el panel.
 *
 * Ahora el gateway EXPONE un bus HTTP local (solo 127.0.0.1) por el que el
 * panel (proceso aparte) se entera del QR, los logs y el estado, y envía
 * comandos/pairing/reset. El gateway sigue siendo dueño del socket de
 * Baileys; el bus es solo el canal de transporte entre procesos.
 *
 * Endpoints legacy (firma obligatoria al configurar SDK_PANEL_GATEWAY_SECRET;
 * compatibilidad sin secreto solo para instalación local no expuesta):
 *   API v1     → requiere actor firmado y capacidad; incluye sesión y lectura
 *   GET  /qr       → SSE estado del QR (data URL PNG o null) + sesión
 *   GET  /logs     → SSE stream del log del gateway (y /logs?component=brain)
 *   GET  /status   → JSON buildStatus()
 *   POST /pairing  → body {phone} → pide código de enlace o abre ventana QR
 *   POST /command  → body {command} → ejecuta comando admin (sock virtual)
 *   POST /reset    → body {confirm,clean} → borra sesión / reset limpio
 *   POST /restart  → body {confirm} → reinicia el gateway (sin borrar sesión)
 *
 * El gateway llama a setSock(sock) / handleConnectionUpdate(update) cuando
 * Baileys emite eventos; el bus los difunde por SSE a los clientes (panel).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { GATEWAY_STATE_DIR, BRAIN_STATE_DIR } = require('../lib/repoPaths');
const { createVerifier } = require('../lib/panelContext');
const { readBytes, sendError, BoundaryError } = require('../lib/httpBoundary');
const { createSessionApi } = require('./sessionApi');
const { getGlobalPolicy } = require('../config');
const verifiedBodies = new WeakMap();
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { buildStatus } = require('./statusServer');
const {
    getBrainHealth, getAvailableProfiles, getProfileDetail, exportProfileFile,
    importProfileFile, deleteProfileFile, reloadProfiles
} = require('./brainService');
const { getContactsDB, getSettingsDB, saveSettingsDB } = require('./db');
const { requestJson: telegramRequest, failure: telegramFailure } = require('./telegramHttp');
const { runAdminCommand } = require('./adminCommandRunner');
const { findKeyByDigits } = require('./contactsRepository');
const { setNumberState, setContactProfile } = require('./stateService');
const { num } = require('../tuning');
const {
    performFactoryReset, prepareFactoryReset, setWiping, restartGatewayProcess, restartBrainIfSystemd
} = require('./factoryReset');
const { cat, errMsg, safeErrorLabel } = require('./logger');

const log = cat('CORE');
const logError = cat('ERROR');

/** Mapea el valor de estado de ContactRecord o acción UI al stateType de setNumberState */
const ESTADO_TO_TYPE = {
    neutro: 'neutral',
    neutral: 'neutral',
    permitido: 'allowed',
    permitir: 'allowed',
    allowed: 'allowed',
    ignorado: 'ignored',
    ignorar: 'ignored',
    ignored: 'ignored',
    handoff: 'handoff'
};

/** @param {string} key @param {import('./contactsRepository.js').ContactRecord} c */
function publicContact(key, c) {
    return {
        key,
        phone: c.phone || null,
        lid: c.lid || null,
        savedName: c.savedName || null,
        estado: c.estado || 'neutro',
        perfil: c.perfil || null,
        isContact: !!c.isContact,
        firstSeen: c.firstSeen || null,
        lastSeen: c.lastSeen || null
    };
}

/** @param {import('./contactsRepository.js').ContactRecord} c @param {string} q */
function contactMatches(c, q) {
    if (!q) return true;
    const hay = [c.savedName, c.phone, c.lid].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
}

/**
 * GET /contacts?q=&estado=&page=&limit=
 * @param {URLSearchParams} params
 */
function listContacts(params) {
    const q = (params.get('q') || '').trim();
    const estado = (params.get('estado') || '').trim();
    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
    const page = Math.max(Number(params.get('page')) || 1, 1);

    let items = [];
    for (const [key, c] of Object.entries(getContactsDB())) {
        if (c && contactMatches(c, q) && (!estado || (c.estado || 'neutro') === estado)) {
            items.push(publicContact(key, c));
        }
    }
    items.sort((a, b) => (a.savedName || '').localeCompare(b.savedName || '') || a.key.localeCompare(b.key));

    const total = items.length;
    const slice = items.slice((page - 1) * limit, page * limit);
    return { total, page, limit, contacts: slice };
}

/** @param {string} key */
function getContactDetail(key) {
    const clean = String(key).replace(/[^0-9]/g, '');
    if (!clean) return null;
    const found = findKeyByDigits(clean);
    if (!found) return null;
    return publicContact(found, getContactsDB()[found]);
}

/** @param {string} key @param {string} estado @param {{channel?:string,accountId?:string|null}} [context] */
async function setContactEstado(key, estado, context = {}) {
    const stateType = ESTADO_TO_TYPE[estado];
    if (!stateType) return { success: false, message: `Estado inválido: ${estado}` };
    return setNumberState(key, stateType, { channel: context.channel || 'whatsapp', accountId: context.accountId || null });
}

/** @param {string} key @param {string} perfil @param {{channel?:string,accountId?:string|null}} [context] */
async function setContactPerfil(key, perfil, context = {}) {
    if (perfil === '' || perfil === 'default' || perfil === 'none' || perfil === null) {
        return setContactProfile(key, 'default', { channel: context.channel || 'whatsapp', accountId: context.accountId || null });
    }
    if (!perfil || !/^[a-z0-9_-]{1,32}$/i.test(perfil)) {
        return { success: false, message: 'Perfil no válido' };
    }
    return setContactProfile(key, perfil, { channel: context.channel || 'whatsapp', accountId: context.accountId || null });
}

// Rutas de logs con override por env (tests con archivos fake, nunca tocar los reales)
const LOG_DIRS = {
    get gateway() { return process.env.SDK_ADMIN_WEB_LOG_GATEWAY || path.join(GATEWAY_STATE_DIR, 'logs'); },
    get brain() { return process.env.SDK_ADMIN_WEB_LOG_BRAIN || path.join(BRAIN_STATE_DIR, 'logs'); }
};
const LOG_PATTERNS = { gateway: /^gateway(\.\d+)?\.log(\.\d+)?$/, brain: /^brain(\.\d+)?\.log(\.\d+)?$/ };
const LINE_CAP = 8192;

// --- estado del QR (idéntico al de adminWebServer, ahora en el bus) ---
const AUTH_DIR_RESOLVER = () => process.env.SDK_AUTH_DIR || path.join(GATEWAY_STATE_DIR, 'auth_info_baileys');
/** @type {any} */
let activeSock = null;
let socketGeneration = 0;
/** @type {string | null} */
let lastQrDataUrl = null;
const qrClients = new Set();
/** @type {any} Callback que el gateway inyecta para forzar re-emisión de QR (refresh). */
let qrRefreshCb = null;
/** @type {any} Callback que el gateway inyecta para re-hacer el pairing tras un reset de sesión (no clean). */
let resetReconnectCb = null;
/** @type {any} Callback que el gateway inyecta para pedir código de pairing por número. */
let pairingCodeRequester = null;
/** @type {any} Callback que el gateway inyecta para reconectar Telegram tras cambiar la config. */
let telegramReloader = null;
/** @type {((token:string, options:{signal:AbortSignal}) => Promise<string>)|null} */
let telegramChatIdResolver = null;
/** Estado compartido para que el panel pueda restaurar el método pendiente. */
/** @type {'qr'|'code'|null} */
let pairingMethod = null;
/** @type {string|null} */
let pairingCodeValue = null;
/** @type {string|null} */
let pairingPhone = null;
let pairingCodeRequestInProgress = false;
let pairingCodeIssuedAt = 0;
const QR_TTL_MS = num('GATEWAY_QR_TTL_MS', 140000);
// El código de 8 caracteres no tiene TTL en Baileys, pero rota al poco de
// emitirse: tras esta ventana el panel avisa de que conviene pedir otro.
const PAIRING_CODE_TTL_MS = num('GATEWAY_PAIRING_CODE_TTL_MS', 180000);
// Techo para la promesa del código: si Baileys no responde (socket
// recreándose, red caída) no dejar el flujo bloqueado para siempre.
const PAIRING_CODE_TIMEOUT_MS = num('GATEWAY_PAIRING_CODE_TIMEOUT_MS', 20000);
let pairingCodeTimeoutMs = PAIRING_CODE_TIMEOUT_MS;
let qrExpiresAt = 0;
let qrTtlMs = QR_TTL_MS;
/** @type {any} */
let qrExpiryTimer = null;
/** @type {any} */
let qrRefreshTimer = null;
let qrWindowOpen = true;
let resetInProgress = false;
let qrSequence = 0;
let qrIssuedAt = 0;
let qrRefreshInProgress = false;

// --- Anti-abuso de pairing (rate-limit por IP en /qr/refresh) ---
// Evita que un cliente pulso "Generar QR" docenas de veces seguidas (golpea a
// WhatsApp y puede provocar baneo). Ventana deslizante: max N intentos por
// ventana; al exceder, 429 hasta que expire el más viejo.
const PAIRING_RATE_LIMIT_MAX = Number(process.env.PAIRING_RATE_LIMIT_MAX || 5);
const PAIRING_RATE_LIMIT_WINDOW_MS = Number(process.env.PAIRING_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
/** @type {Map<string, number[]>} ip -> timestamps de intentos */
const pairingAttempts = new Map();
function getClientIp(req) {
    const xff = (req.headers && req.headers['x-forwarded-for']);
    const raw = Array.isArray(xff) ? xff[0] : (xff || '');
    const ip = raw.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
    return ip;
}
function checkPairingRateLimit(ip) {
    const now = Date.now();
    const hits = (pairingAttempts.get(ip) || []).filter(t => now - t < PAIRING_RATE_LIMIT_WINDOW_MS);
    if (hits.length >= PAIRING_RATE_LIMIT_MAX) {
        pairingAttempts.set(ip, hits);
        const oldest = hits[0];
        const retryAfterSec = Math.ceil((PAIRING_RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000);
        return { allowed: false, retryAfterSec };
    }
    hits.push(now);
    pairingAttempts.set(ip, hits);
    return { allowed: true, retryAfterSec: 0 };
}

// --- Notificación al admin (panel/log + Telegram si está configurado) ---
function notifyAdmin(message) {
    log.warn('🔔 [ADMIN] Notificación administrativa emitida.');
    try {
        const s = getSettingsDB();
        if (s.telegramToken && s.telegramChatId) {
            const adapter = require('../index').getAdapter('telegram');
            if (!adapter) return;
            adapter.sendMessage(`telegram:${s.telegramChatId}`, `🔔 *SDK-Bot*\n\n${message}`, { source: 'notice' })
                .catch((/** @type {any} */ e) => logError.error(`🔔 [ADMIN] No se pudo avisar por Telegram (${safeErrorLabel(e)}).`));
        }
    } catch (/** @type {any} */ e) {
        logError.error(`🔔 [ADMIN] Error leyendo settings para notificar (${safeErrorLabel(e)}).`);
    }
}

function wsReadyState(sock) {
    if (!sock) return null;
    if (typeof sock.readyState !== 'undefined') return sock.readyState;
    
    const ws = sock.ws;
    if (!ws) return null;
    if (typeof ws.readyState === 'number') return ws.readyState;
    if (typeof ws.isOpen === 'boolean') {
        if (ws.isOpen) return 1;
        if (ws.isClosed) return 3;
        if (ws.isClosing) return 2;
        if (ws.isConnecting) return 0;
        return null;
    }
    if (typeof ws.isOpen === 'function') {
        if (ws.isOpen()) return 1;
        if (ws.isClosed()) return 3;
        if (ws.isClosing()) return 2;
        if (ws.isConnecting()) return 0;
    }
    return null;
}

function hasActiveSession() {
    if (!activeSock) return false;
    if (typeof activeSock.isSessionRegistered === 'function') return activeSock.isSessionRegistered();
    // Fallback for native sock
    return !!(activeSock && activeSock.user && (activeSock.user.id || activeSock.user.lid));
}

function pairingStatus() {
    if (pairingMethod === 'code') {
        const issuedAt = pairingCodeIssuedAt || null;
        const expiresAt = pairingCodeIssuedAt ? pairingCodeIssuedAt + PAIRING_CODE_TTL_MS : null;
        return {
            active: true,
            method: 'code',
            busy: pairingCodeRequestInProgress,
            code: pairingCodeValue,
            phone: pairingPhone,
            issuedAt,
            expiresAt,
            expired: !!(expiresAt && Date.now() >= expiresAt)
        };
    }
    return {
        active: pairingMethod !== null,
        method: pairingMethod,
        busy: pairingMethod === 'qr' ? qrRefreshInProgress : false,
        code: null,
        phone: null,
        issuedAt: pairingMethod === 'qr' ? qrIssuedAt || null : null,
        expiresAt: pairingMethod === 'qr' ? qrExpiresAt || null : null,
        expired: false
    };
}

function clearPairingState() {
    pairingMethod = null;
    pairingCodeValue = null;
    pairingPhone = null;
    pairingCodeRequestInProgress = false;
    pairingCodeIssuedAt = 0;
}

function qrPayload() {
    const active = qrWindowOpen && !!lastQrDataUrl;
    return active
        ? { qr: lastQrDataUrl, issuedAt: qrIssuedAt, expiresAt: qrExpiresAt || Date.now() + qrTtlMs, expired: false, session: hasActiveSession(), pairing: pairingStatus() }
        : { qr: null, issuedAt: null, expiresAt: null, expired: !qrWindowOpen, session: hasActiveSession(), pairing: pairingStatus() };
}

function broadcastQrState() {
    const data = JSON.stringify(qrPayload());
    for (const client of qrClients) {
        try { client.write(`data: ${data}\n\n`); } catch (e) { qrClients.delete(client); }
    }
}

function openQrWindow() {
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrWindowOpen = true;
    pairingMethod = 'qr';
    pairingCodeValue = null;
    pairingPhone = null;
    pairingCodeRequestInProgress = false;
    qrExpiresAt = Date.now() + qrTtlMs;
    qrIssuedAt = Date.now();
    qrExpiryTimer = setTimeout(() => {
        qrWindowOpen = false;
        lastQrDataUrl = null;
        qrIssuedAt = 0;
        qrExpiresAt = 0;
        qrRefreshInProgress = false;
        if (pairingMethod === 'qr') clearPairingState();
        broadcastQrState();
    }, qrTtlMs);
    if (qrExpiryTimer.unref) qrExpiryTimer.unref();
}

/** El gateway entrega el socket activo de Baileys al bus. */
/** Reinicia el estado de la ventana del QR (sin tocar pairing por código). */
function resetQrWindowState() {
    qrSequence = 0;
    lastQrDataUrl = null;
    qrIssuedAt = 0;
    // Reabrir la ventana es OBLIGATORIO: si un QR anterior expiró dejó
    // qrWindowOpen=false y el guard de handleConnectionUpdate descartaría
    // para siempre todo QR nuevo ("Generar QR" no produciría imagen nunca).
    qrWindowOpen = true;
    qrExpiresAt = 0;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrExpiryTimer = null;
}

/** @param {any} sock */
function setSock(sock) {
    activeSock = sock;
    socketGeneration += 1;
    resetQrWindowState();
    broadcastQrState();
}

/** Invalida el socket cerrado y cualquier QR que haya emitido. */
/** @param {any} sock */
function clearSock(sock = null) {
    if (sock && sock !== activeSock) return;
    activeSock = null;
    socketGeneration += 1;
    resetQrWindowState();
    if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
    qrRefreshTimer = null;
    qrRefreshInProgress = false;
    clearPairingState();
    broadcastQrState();
}

/** Reenvío del connection.update de Baileys: captura y difunde el QR. */
/** @param {any} update @param {any} sourceSock */
async function handleConnectionUpdate(update, sourceSock = null) {
    if (!update) return;
    const generation = socketGeneration;
    if (sourceSock && sourceSock !== activeSock) return;
    if (update.connection === 'close') {
        clearSock(sourceSock);
        return;
    }
    if (update.connection === 'open') {
        clearPairingState();
        broadcastQrState();
        return;
    }
    if (typeof update.qr !== 'string') return;
    if (pairingMethod === 'code') return;
    if (update.connection === 'open') return;
    const sequence = ++qrSequence;
    // Una tanda de Baileys puede traer varios QRs (el siguiente reemplaza al
    // anterior). Todos comparten la misma ventana total: solo el primer QR
    // inicia el timer; un QR tardío después de expirar no abre otra ventana.
    if (!qrWindowOpen || (qrExpiresAt && Date.now() >= qrExpiresAt)) return;
    if (!qrExpiresAt) openQrWindow();
    pairingMethod = 'qr';
    let dataUrl;
    try {
        dataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
    } catch (e) {
        logError.error(`🔌 [BUS] Error renderizando QR (${safeErrorLabel(e)}).`);
        if (generation === socketGeneration && sequence === qrSequence && (!sourceSock || sourceSock === activeSock)) {
            lastQrDataUrl = null;
            qrRefreshInProgress = false;
            broadcastQrState();
        }
        return;
    }
    // Baileys emite una ráfaga de QR y el render es asíncrono. No permitir
    // que un QR antiguo termine después y sobrescriba al último válido.
    if (generation !== socketGeneration || sequence !== qrSequence || (sourceSock && sourceSock !== activeSock)) return;
    lastQrDataUrl = dataUrl;
    qrRefreshInProgress = false;
    if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
    qrRefreshTimer = null;
    broadcastQrState();
}

function isGatewayServiceActive() {
    if (!process.env.SYSTEMD_EXEC_PID) return true;
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('systemctl', ['is-active', process.env.SDK_GATEWAY_SERVICE || 'sdk-bot-gateway'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        return out === 'active';
    } catch (e) {
        return true;
    }
}

function scheduleRestart() {
    restartGatewayProcess();
}

/** El gateway inyecta un callback para forzar re-emisión de QR fresco. */
function setQrRefresh(cb) {
    if (typeof cb === 'function') qrRefreshCb = cb;
}

/**
 * El gateway inyecta un callback para re-hacer el pairing tras un reset de
 * sesión (no clean) disparado desde el panel. En vez de matar el proceso
 * (process.exit) — que en dev/dejaría el gateway muerto sin supervisor —,
 * reconecta el adaptador de WhatsApp en caliente y emite un QR nuevo. El
 * panel (producto final) queda usable sin consola.
 */
function setResetReconnect(cb) {
    if (typeof cb === 'function') resetReconnectCb = cb;
}

/** El gateway inyecta un callback para pedir código de pairing por número. */
function setPairingCodeRequester(cb) {
    pairingCodeRequester = typeof cb === 'function' ? cb : null;
}

/** El gateway inyecta un callback para (re)conectar Telegram al cambiar la config sin reiniciar. */
function setTelegramReloader(cb) {
    telegramReloader = typeof cb === 'function' ? cb : null;
}

/** Read-only discovery port; only the configured transport owner observes chats. */
function setTelegramChatIdResolver(cb) {
    telegramChatIdResolver = typeof cb === 'function' ? cb : null;
}

/** Reconnecta el adaptador de Telegram si el gateway registró el reload. */
async function reloadTelegramAdapter() {
    if (typeof telegramReloader !== 'function') return false;
    try {
        await telegramReloader();
        return true;
    } catch (e) {
        logError.error(`🔌 [BUS] Error reconectando Telegram (${safeErrorLabel(e)}).`);
        return false;
    }
}

/**
 * Enciende el brain (proceso Python) si está caído. No bloquea: el spawn
 * corre desacoplado y el healthcheck del gateway lo detectará en ~10s.
 * Usa las mismas env que el desarrollo manual y el despliegue legacy
 * (BRAIN_PORT=5100, bind 0.0.0.0).
 * @returns {{success: boolean, message: string}}
 */
function startBrainProcess() {
    const brainDir = BRAIN_STATE_DIR;
    const env = Object.assign({}, process.env, {
        BRAIN_PORT: process.env.BRAIN_PORT || 5100,
        BRAIN_HOST: process.env.BRAIN_HOST || '0.0.0.0',
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'America/Santiago'
    });
    try {
        const child = spawn(path.join(brainDir, 'venv', 'bin', 'python'), ['main.py'], { cwd: brainDir, env, detached: true, stdio: 'ignore' });
        child.unref();
        log.info('🔌 [BUS] Brain encendido bajo demanda (spawn python3 main.py)');
        return { success: true, message: 'Brain encendiéndose… estará listo en ~10s (el dashboard lo reflejará).' };
    } catch (e) {
        return { success: false, message: `No se pudo encender el brain: ${errMsg(e)}` };
    }
}

/** Rechaza si la promesa no resuelve en ms (evita bloquear el flujo de pairing). */
function withTimeout(promise, ms, message) {
    /** @type {any} */
    let timer = null;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
            if (timer && timer.unref) timer.unref();
        })
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function requestPairing(phone) {
    const clean = String(phone || '').replace(/[^0-9]/g, '');
    const brainUp = !!(getBrainHealth() && getBrainHealth().status === 'ok');
    if (clean.length > 0 && clean.length < 9) {
        return { success: false, brainUp, message: 'Número inválido: se espera el número completo con código de país (ej: 56912345678)' };
    }
    const qrPending = qrRefreshInProgress || (pairingMethod === 'qr' && qrWindowOpen && qrExpiresAt > Date.now());
    // 🔑 Pairing por NÚMERO: ir directo a pedir el código de 8 caracteres. El requester del
    // gateway recrea el socket si está cerrado (tras agotar QR) y espera a
    // que esté listo. NO pasar por la guarda de "socket cerrado" de abajo,
    // que devolvería "el QR llegará" y nunca pediría el código.
    if (clean.length >= 9) {
        if (qrPending) {
            const s = qrExpiresAt > Date.now() ? Math.ceil((qrExpiresAt - Date.now()) / 1000) : 0;
            return {
                success: false,
                brainUp,
                method: 'qr',
                busy: qrRefreshInProgress,
                issuedAt: qrIssuedAt || null,
                expiresAt: qrExpiresAt || null,
                message: s > 0
                    ? `Hay un QR vigente: escanéalo (${s}s restantes) o espera a que expire para pedir un código.`
                    : 'Hay una solicitud de QR en curso: espera a que aparezca antes de pedir un código.'
            };
        }
        if (pairingCodeRequestInProgress) {
            return { success: false, brainUp, message: 'Ya hay una solicitud de código en curso; espera su resultado.' };
        }
        pairingMethod = 'code';
        pairingCodeValue = null;
        pairingPhone = clean;
        pairingCodeIssuedAt = 0;
        pairingCodeRequestInProgress = true;
        try {
            let codePromise;
            if (typeof pairingCodeRequester === 'function') {
                codePromise = Promise.resolve(pairingCodeRequester(clean));
            } else {
                if (!activeSock) {
                    clearPairingState();
                    return { success: false, brainUp, message: 'No hay socket activo para pedir el código.' };
                }
                codePromise = Promise.resolve(activeSock.requestPairingCode(clean));
            }
            const code = await withTimeout(
                codePromise,
                pairingCodeTimeoutMs,
                `WhatsApp no respondió al pedir el código (${Math.round(pairingCodeTimeoutMs / 1000)}s). Revisa la conexión e inténtalo de nuevo.`
            );
            pairingCodeValue = String(code);
            pairingCodeIssuedAt = Date.now();
            return { success: true, brainUp, code: pairingCodeValue, issuedAt: pairingCodeIssuedAt, expiresAt: pairingCodeIssuedAt + PAIRING_CODE_TTL_MS };
        } catch (e) {
            clearPairingState();
            return { success: false, brainUp, message: `No se pudo pedir el código de enlace: ${errMsg(e)}` };
        } finally {
            pairingCodeRequestInProgress = false;
        }
    }
    if (pairingCodeRequestInProgress || pairingMethod === 'code') {
        return { success: false, brainUp, message: 'Hay una solicitud de código pendiente: usa el código mostrado o espera a que termine.' };
    }
    if (qrWindowOpen && Date.now() < qrExpiresAt) {
        const s = Math.ceil((qrExpiresAt - Date.now()) / 1000);
        return { success: false, brainUp, message: `QR vigente: escanéalo (${s}s restantes) o espera a que expire para pedir otro.` };
    }
    const sockClosed = wsReadyState(activeSock) === 3;
    if (!activeSock || sockClosed) {
        if (!isGatewayServiceActive()) {
            scheduleRestart();
            return { success: false, needsRestart: true, message: 'El gateway no está corriendo. Lanzando gateway…' };
        }
        openQrWindow();
        return { success: true, brainUp, message: 'Gateway activo: el QR llegará por SSE en unos segundos.' };
    }
    openQrWindow();
    return { success: true, brainUp, message: 'QR generado — escanéalo antes de que expire (2 min 20 s).' };
}


async function performReset(clean = false) {
    if (resetInProgress) return { success: false, message: 'Reset ya en curso…' };
    resetInProgress = true;
    if (clean) {
        setWiping(true);
        try { await prepareFactoryReset(); }
        catch {
            setWiping(false); resetInProgress = false;
            return { success: false, message: 'No se pudo cerrar el archivo de conversaciones.' };
        }
        const report = performFactoryReset();
        if (report.errors.length > 0) {
            setWiping(false);
            resetInProgress = false;
            return { success: false, message: `Reset limpio abortado: ${report.errors[0]}` };
        }
        restartBrainIfSystemd();
        scheduleRestart();
        return { success: true, message: `Reset limpio: ${report.deleted.length} elementos borrados; reiniciando.` };
    }
    let deleted = false;
    try {
        const authDir = AUTH_DIR_RESOLVER();
        if (fs.existsSync(authDir)) { fs.rmSync(authDir, { recursive: true, force: true }); deleted = true; }
    } catch (e) {
        resetInProgress = false;
        return { success: false, message: `No se pudo borrar la sesión: ${errMsg(e)}` };
    }
    // Reset de pairing (no clean): reconectar WhatsApp en caliente y emitir
    // QR nuevo, SIN matar el gateway. El panel (producto final) queda usable
    // sin consola. Si no hay callback inyectado (raro), cae al restart clásico.
    if (typeof resetReconnectCb === 'function') {
        try {
            await resetReconnectCb();
        } catch (e) {
            logError.error(`🧹 reset-reconnect falló (${safeErrorLabel(e)}); haciendo restart clásico.`);
            scheduleRestart();
        }
        return { success: true, message: `Sesión ${deleted ? 'eliminada' : 'ya borrada'}; escanea el QR nuevo en el panel.` };
    }
    scheduleRestart();
    return { success: true, message: `Sesión ${deleted ? 'eliminada' : 'ya borrada'}; reiniciando gateway…` };
}

async function performRestart() {
    if (resetInProgress) return { success: false, message: 'Reinicio ya en curso…' };
    resetInProgress = true;
    scheduleRestart();
    return { success: true, message: 'Lanzando gateway…' };
}

/**
 * Encuentra la ruta del archivo de log activo más reciente para un componente.
 * @param {'gateway'|'brain'} component
 * @returns {string|null}
 */
function findActiveLogFile(component) {
    const dir = LOG_DIRS[component];
    const pattern = LOG_PATTERNS[component];
    /** @type {string|null} */
    let best = null;
    let bestMtime = -1;
    let files;
    try { files = fs.readdirSync(dir); } catch { return null; }
    for (const f of files) {
        if (!pattern.test(f)) continue;
        const p = path.join(dir, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            best = p;
        }
    }
    return best;
}

// --- SSE de logs (lee el archivo de log en vivo y difunde JSON { component, line }) ---
/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URLSearchParams} params
 */
function streamLogs(req, res, params) {
    const component = params.get('component') === 'brain' ? 'brain' : 'gateway';
    const rawHist = params.get('history');
    const history = rawHist == null ? 100 : Math.min(Math.max(Number(rawHist) || 0, 0), 500);
    const dir = LOG_DIRS[component];
    const pattern = LOG_PATTERNS[component];

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');

    let closed = false;
    /** @type {Map<string, {size: number, mtimeMs: number}>} posición por archivo */
    const positions = new Map();

    const send = (line) => {
        if (closed) return;
        const text = line.length > LINE_CAP ? line.slice(0, LINE_CAP) + '…' : line;
        res.write(`data: ${JSON.stringify({ component, line: text })}\n\n`);
    };

    // Heartbeat: mantiene la conexión viva a través de proxies
    const hb = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000).unref();

    /**
     * Lee las últimas N líneas del archivo más reciente como historial.
     */
    function sendHistory() {
        const best = findActiveLogFile(component);
        if (!best) return;
        let st;
        try { st = fs.statSync(best); } catch { return; }
        const chunk = Math.max(0, st.size - 64 * 1024);
        const fd = fs.openSync(best, 'r');
        const buf = Buffer.alloc(st.size - chunk);
        try { fs.readSync(fd, buf, 0, buf.length, chunk); } finally { fs.closeSync(fd); }
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        const hist = history > 0 ? lines.slice(-history) : [];
        for (const l of hist) send(l);
        positions.set(best, { size: st.size, mtimeMs: st.mtimeMs });
    }

    /**
     * Lee las líneas nuevas de todos los archivos que crecieron, se truncaron
     * o se reescribieron (mismo tamaño pero mtime distinto).
     */
    function tick() {
        if (closed) return;
        let files;
        try { files = fs.readdirSync(dir); } catch { return; }
        const seen = new Set();
        for (const f of files) {
            if (!pattern.test(f)) continue;
            const p = path.join(dir, f);
            seen.add(p);
            let st;
            try { st = fs.statSync(p); } catch { positions.delete(p); continue; }
            const prev = positions.get(p);
            if (!prev) { positions.set(p, { size: st.size, mtimeMs: st.mtimeMs }); continue; }
            let start;
            if (st.size < prev.size) start = 0;                      // truncación real (clear-logs) -> recarga todo
            else if (st.size > prev.size) start = prev.size;         // crecimiento normal -> solo lo nuevo
            else if (st.mtimeMs !== prev.mtimeMs) start = 0;         // igual tamaño pero mtime distinto = re-escritura -> recarga todo
            else continue;                                           // igual tamaño y mtime: sin cambios
            const fd = fs.openSync(p, 'r');
            const buf = Buffer.alloc(st.size - start);
            try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
            const lines = buf.toString('utf8').split('\n');
            for (const l of lines) if (l) send(l);
            positions.set(p, { size: st.size, mtimeMs: st.mtimeMs });
        }
        for (const p of positions.keys()) if (!seen.has(p)) positions.delete(p);
    }

    const iv = setInterval(tick, 1000).unref();
    req.on('close', () => {
        closed = true;
        clearInterval(iv);
        clearInterval(hb);
    });
    sendHistory();
    tick();
}

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    if (verifiedBodies.has(req)) {
        try { return Promise.resolve(JSON.parse(verifiedBodies.get(req).toString('utf8') || '{}')); }
        catch { return Promise.resolve({}); }
    }
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    });
}

function routeApi(req, res, pathname, params) {
    if (pathname === '/status' && req.method === 'GET') { sendJson(res, 200, buildStatus()); return; }
    if (pathname === '/logs' && req.method === 'GET') { streamLogs(req, res, params); return; }
    if (pathname === '/logs' && req.method === 'DELETE') {
        const component = params.get('component') === 'brain' ? 'brain' : 'gateway';
        const dir = LOG_DIRS[component];
        try {
            fs.mkdirSync(dir, { recursive: true });
            const active = findActiveLogFile(component);
            const target = active || path.join(dir, component === 'brain' ? 'brain.log' : 'gateway.log');
            if (fs.existsSync(target)) {
                fs.truncateSync(target, 0);
            }
            fs.writeFileSync(target, 'Logs borrados correctamente desde el panel web.\n', 'utf8');
            sendJson(res, 200, { success: true, component });
        } catch (e) { sendJson(res, 500, { success: false, message: errMsg(e) }); }
        return;
    }
    if (pathname === '/qr' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        try { res.write(`data: ${JSON.stringify(qrPayload())}\n\n`); } catch (e) {}
        qrClients.add(res);
        const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000).unref();
        req.on('close', () => { qrClients.delete(res); clearInterval(hb); });
        return;
    }
    if (pathname === '/pairing' && req.method === 'POST') {
        readBody(req).then((b) => requestPairing(b.phone).then((r) => sendJson(res, 200, r)));
        return;
    }
    if (pathname === '/qr/refresh' && req.method === 'POST') {
        // Anti-abuso: rate-limit por IP. Un cliente que pulsa "Generar QR"
        // docenas de veces seguidas golpea a WhatsApp y puede provocar baneo.
        const clientIp = getClientIp(req);
        const rl = checkPairingRateLimit(clientIp);
        if (!rl.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfterSec) });
            res.end(JSON.stringify({ success: false, rateLimited: true, retryAfterSec: rl.retryAfterSec, message: `Demasiados intentos de pairing. Espera ${rl.retryAfterSec}s antes de volver a generar un QR.` }));
            return;
        }
        // No repetir el comando mientras hay un QR válido o una tanda en curso.
        // El bloqueo vive en el bus, no solo en el botón del navegador.
        if (pairingCodeRequestInProgress || pairingMethod === 'code') {
            sendJson(res, 200, { success: false, method: 'code', code: pairingCodeValue, message: 'Hay un pairing por código pendiente: usa el código mostrado antes de pedir un QR.' });
            return;
        }
        if (qrRefreshInProgress) {
            sendJson(res, 200, { success: false, busy: true, message: 'QR en generación: espera a que aparezca.' });
            return;
        }
        if (qrWindowOpen && lastQrDataUrl && Date.now() < qrExpiresAt) {
            const seconds = Math.ceil((qrExpiresAt - Date.now()) / 1000);
            sendJson(res, 200, { success: false, issuedAt: qrIssuedAt, expiresAt: qrExpiresAt, message: `QR vigente: escanéalo (${seconds}s restantes).` });
            return;
        }
        if (typeof qrRefreshCb === 'function') {
            // Pedir un QR fresco REABRE la ventana: venía de un click explícito
            // y el guard de handleConnectionUpdate exige qrWindowOpen=true.
            resetQrWindowState();
            pairingMethod = 'qr';
            pairingCodeValue = null;
            pairingPhone = null;
            pairingCodeRequestInProgress = false;
            broadcastQrState();
            qrRefreshInProgress = true;
            // Reabre la ventana QR: tras expirar la ráfaga inicial del arranque
            // (standby por sin_sesion), qrWindowOpen queda en false y la guarda
            // de handleConnectionUpdate descarta el QR fresco del refresh. Sin
            // esto el panel nunca recibe el QR aunque Baileys lo emita.
            openQrWindow();
            if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
            qrRefreshTimer = setTimeout(() => {
                qrRefreshInProgress = false;
                qrRefreshTimer = null;
                broadcastQrState();
            }, 10000);
            if (qrRefreshTimer.unref) qrRefreshTimer.unref();
            try {
                Promise.resolve(qrRefreshCb()).catch(() => {
                    qrRefreshInProgress = false;
                    if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
                    qrRefreshTimer = null;
                });
                sendJson(res, 200, { success: true, message: 'Regenerando QR…' });
            }
            catch (e) {
                qrRefreshInProgress = false;
                if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
                qrRefreshTimer = null;
                sendJson(res, 500, { success: false, message: errMsg(e) });
            }
        } else {
            sendJson(res, 200, { success: false, message: 'No hay socket activo para regenerar el QR.' });
        }
        return;
    }
    if (pathname === '/pairing/status' && req.method === 'GET') {
        sendJson(res, 200, pairingStatus());
        return;
    }
    if (pathname === '/brain/start' && req.method === 'POST') {
        sendJson(res, 200, startBrainProcess());
        return;
    }
    if (pathname === '/telegram/settings' && req.method === 'GET') {
        const s = getSettingsDB();
        sendJson(res, 200, { token: s.telegramToken || '', chatId: s.telegramChatId || '' });
        return;
    }
    if (pathname === '/telegram/settings/meta' && req.method === 'GET') {
        const s = getSettingsDB();
        sendJson(res, 200, { configured: !!s.telegramToken, chatIdConfigured: !!s.telegramChatId });
        return;
    }
    if (pathname === '/telegram/settings' && req.method === 'POST') {
        readBody(req).then(async (b) => {
            const token = String(b.token || '').trim();
            const chatId = String(b.chatId || '').trim();
            const s = getSettingsDB();
            const hadToken = !!s.telegramToken;
            s.telegramToken = token;
            s.telegramChatId = chatId;
            saveSettingsDB(s);
            if (!token) {
                // Desconectar: soltar el adaptador y avisar en el mensaje.
                await reloadTelegramAdapter();
                sendJson(res, 200, { success: true, connected: false, message: 'Telegram desconectado: se borró la configuración del bot.' });
                return;
            }
            // Guardar token = conectar al instante (sin reiniciar el gateway).
            const reloaded = await reloadTelegramAdapter();
            sendJson(res, 200, {
                success: true,
                connected: true,
                reloaded,
                chatId,
                message: reloaded
                    ? 'Configuración guardada: el bot de Telegram se está conectando… Si no llega el test, envía /start a tu bot y reintenta.'
                    : `Configuración guardada. ${hadToken ? 'Reinicia el gateway para aplicarla.' : 'El poller la tomará automáticamente; reinicia el gateway si no responde.'}`
            });
        }).catch(e => sendJson(res, 500, { success: false, message: errMsg(e) }));
        return;
    }
    if (pathname === '/telegram/test' && req.method === 'POST') {
        const controller = new AbortController();
        const closed = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', closed);
        readBody(req).then(async b => {
            if (typeof b.token !== 'string' || !b.token.trim()) throw telegramFailure('TG_TOKEN_REQUIRED', 'Se requiere el token del bot');
            const token = b.token.trim();
            if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(token)) throw telegramFailure('TG_TOKEN_INVALID', 'El token tiene un formato inválido.');
            let chatId = b.chatId;
            if (!chatId) {
                if (!telegramChatIdResolver) throw telegramFailure('TG_DISCOVERY_UNAVAILABLE', 'Guarda primero el token con el gateway activo, envía /start al bot y vuelve a probar.');
                chatId = await telegramChatIdResolver(token, { signal: controller.signal });
            }
            if (typeof chatId === 'number' && !Number.isSafeInteger(chatId)) throw telegramFailure('TG_CHAT_ID_INVALID', 'Introduce el Chat ID como texto decimal exacto.');
            chatId = String(chatId);
            if (!/^-?[1-9]\d*$/.test(chatId)) throw telegramFailure('TG_CHAT_ID_INVALID', 'El Chat ID debe ser un identificador decimal válido.');
            if (controller.signal.aborted) return;
            const result = await telegramRequest({ path: `/bot${token}/sendMessage`, method: 'POST',
                body: { chat_id: chatId, text: '🤖 Test de notificaciones SDK-Bot. ¡La integración de Telegram se ha configurado con éxito!' },
                signal: controller.signal, timeoutMs: 2000 });
            if (!result?.ok) throw telegramFailure('TG_TEST_REJECTED', 'Telegram rechazó el mensaje de prueba. Revisa el token y el Chat ID.');
            if (!controller.signal.aborted) sendJson(res, 200, { success: true, chatId });
        }).catch(e => {
            if (!controller.signal.aborted) sendJson(res, 400, { success: false,
                message: typeof e.code === 'string' && e.code.startsWith('TG_') ? e.message : 'No se pudo procesar la prueba de Telegram.' });
        }).finally(() => { res.removeListener('close', closed); });
        return;
    }

    if (pathname === '/command' && req.method === 'POST') {
        readBody(req).then((b) => runAdminCommand(b.command,
            { channel: 'whatsapp', accountId: activeSock?.accountId || null }).then((r) => sendJson(res, 200, r)));
        return;
    }
    if (pathname === '/notify' && req.method === 'POST') {
        readBody(req).then(async (b) => {
            if (!activeSock) return sendJson(res, 500, { success: false, message: 'No socket activo' });
            if (!b.jid || !b.message) return sendJson(res, 400, { success: false, message: 'Falta jid o message' });
            const idempotencyKey = b.idempotencyKey || req.headers['idempotency-key'];
            if (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 256) {
                return sendJson(res, 400, { success: false, code: 'IDEMPOTENCY_KEY_REQUIRED',
                    message: 'Falta idempotencyKey para evitar envíos duplicados ante un timeout.' });
            }
            try {
                const sent = await activeSock.sendMessage(b.jid, b.message, {
                    source: 'notice', idempotencyKey,
                    policy: { kind: 'internal_notify' }
                });
                sendJson(res, 200, { success: true, outbound: sent?._outbox || null });
            } catch (e) {
                const error = /** @type {any} */ (e);
                sendJson(res, 500, { success: false, code: error?.code || 'NOTIFY_FAILED',
                    idempotencyKey, outboundState: error?.outboundState || null, message: errMsg(error) });
            }
        });
        return;
    }
    if (pathname === '/reset' && req.method === 'POST') {
        readBody(req).then((b) => {
            if (b.confirm !== true) return sendJson(res, 400, { success: false, message: 'Se requiere confirm: true (el front pide confirmación antes de llamar)' });
            performReset(!!b.clean).then((r) => sendJson(res, 200, r));
        });
        return;
    }
    if (pathname === '/restart' && req.method === 'POST') {
        readBody(req).then((b) => {
            if (b.confirm !== true) return sendJson(res, 400, { success: false, message: 'Se requiere confirm: true (el front pide confirmación antes de llamar)' });
            performRestart().then((r) => sendJson(res, 200, r));
        });
        return;
    }

    // Agenda: /contacts, /contacts/<key>, /contacts/<key>/estado|perfil
    const cm = /^(?:\/api)?\/contacts(?:\/([^/]+))?(?:\/(estado|perfil))?$/.exec(pathname);
    if (cm) {
        if (req.method === 'GET' && !cm[1]) {
            sendJson(res, 200, listContacts(params));
            return;
        }
        if (req.method === 'GET' && cm[1] && !cm[2]) {
            const detail = getContactDetail(cm[1]);
            if (!detail) return sendJson(res, 404, { error: 'contacto no encontrado' });
            sendJson(res, 200, detail);
            return;
        }
        if (req.method === 'POST' && cm[1] && cm[2]) {
            readBody(req).then(async (parsed) => {
                const context = { channel: 'whatsapp', accountId: activeSock?.accountId || null };
                const result = cm[2] === 'estado'
                    ? await setContactEstado(cm[1], String(parsed.estado || ''), context)
                    : await setContactPerfil(cm[1], String(parsed.perfil || ''), context);
                sendJson(res, result.success ? 200 : 400, result);
            }).catch((e) => sendJson(res, 500, { ok: false, error: errMsg(e) }));
            return;
        }
    }

    // Perfiles SOUL: /profiles, /profiles/reload, /profiles/import, /profiles/<key>, /profiles/<key>/file
    if ((pathname === '/profiles' || pathname === '/api/profiles') && req.method === 'GET') {
        getAvailableProfiles()
            .then(list => sendJson(res, 200, { profiles: list }))
            .catch(e => sendJson(res, 500, { error: errMsg(e) }));
        return;
    }
    if ((pathname === '/profiles/reload' || pathname === '/api/profiles/reload') && req.method === 'POST') {
        reloadProfiles()
            .then(r => sendJson(res, 200, r || { success: false, message: 'Brain sin respuesta' }))
            .catch(e => sendJson(res, 500, { error: errMsg(e) }));
        return;
    }
    if ((pathname === '/profiles/import' || pathname === '/api/profiles/import') && req.method === 'POST') {
        readBody(req).then((parsed) => {
            const key = String(parsed.key || '').trim();
            const content = String(parsed.content || '');
            if (!key || !content) {
                sendJson(res, 400, { success: false, message: 'Se requiere key y content' });
                return;
            }
            importProfileFile(key, content).then(result => {
                if (!result) return sendJson(res, 502, { success: false, message: 'Brain sin respuesta' });
                if (result.success !== true) {
                    return sendJson(res, 400, { success: false, message: result.detail || result.message || 'El brain rechazó el perfil' });
                }
                sendJson(res, 200, result);
            }).catch(e => sendJson(res, 500, { error: errMsg(e) }));
        }).catch(e => sendJson(res, 500, { success: false, message: errMsg(e) }));
        return;
    }

    const pm = /^(?:\/api)?\/profiles\/([\w.-]+)(?:\/file)?$/.exec(pathname);
    if (pm) {
        const key = decodeURIComponent(pm[1]);
        if (req.method === 'GET' && pathname.endsWith('/file')) {
            exportProfileFile(key)
                .then(f => {
                    if (!f) return sendJson(res, 404, { error: `Perfil '${key}' no encontrado` });
                    sendJson(res, 200, f);
                })
                .catch(e => sendJson(res, 500, { error: errMsg(e) }));
            return;
        }
        if (req.method === 'GET') {
            getProfileDetail(key)
                .then(detail => {
                    if (!detail) return sendJson(res, 404, { error: `Perfil '${key}' no encontrado` });
                    sendJson(res, 200, detail);
                })
                .catch(e => sendJson(res, 500, { error: errMsg(e) }));
            return;
        }
        if (req.method === 'DELETE') {
            deleteProfileFile(key)
                .then(result => {
                    if (!result) return sendJson(res, 502, { success: false, message: 'Brain sin respuesta' });
                    if (result.success !== true) {
                        return sendJson(res, 400, { success: false, message: result.detail || result.message || 'Perfil no eliminado' });
                    }
                    sendJson(res, 200, result);
                })
                .catch(e => sendJson(res, 500, { error: errMsg(e) }));
            return;
        }
    }

    sendJson(res, 404, { error: 'not found' });
}

/** Arranca el bus interno. Siempre (no depende de SDK_ADMIN_WEB_ENABLED). */
function startInternalBus(opts = {}) {
    const port = opts.port ?? Number(process.env.INTERNAL_BUS_PORT || 5400);
    const host = process.env.INTERNAL_BUS_HOST || '127.0.0.1';
    const secret = process.env.SDK_PANEL_GATEWAY_SECRET || '';
    const signedRequired = Boolean(secret) || process.env.NODE_ENV === 'production' ||
        !['127.0.0.1', '::1', 'localhost'].includes(host);
    const verify = createVerifier({ secret });
    const sessionApi = createSessionApi(() => { getSettingsDB(); return getGlobalPolicy(); }, opts.archive,
        getContactsDB, opts.getChannelStatus, opts.controlService, opts.getAdapter,
        async () => (await getAvailableProfiles()) || [], opts.attachmentStore);
    const server = http.createServer(async (req, res) => {
        let u;
        try { u = new URL(req.url || '/', 'http://gateway.local'); }
        catch { sendError(res, new BoundaryError(422, 'VALIDATION_ERROR', 'URL inválida.')); return; }
        const params = u.searchParams;
        const pathname = u.pathname;
        const v1 = pathname === '/v1' || pathname.startsWith('/v1/');
        let requestId;
        try {
            // v1 siempre exige firma. Al configurar secreto, también las rutas
            // anteriores quedan protegidas sin cambiar su contrato de respuesta.
            if (v1 || signedRequired) {
                if (!secret) throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Frontera del panel sin configurar.');
                const body = await readBytes(req);
                const context = verify(req, body);
                requestId = context.requestId;
                verifiedBodies.set(req, body);
                if (v1) { await sessionApi(req, res, context, pathname, verifiedBodies.get(req) || Buffer.alloc(0)); return; }
            }
            routeApi(req, res, pathname, params);
        } catch (e) {
            if (v1 || signedRequired) sendError(res, e, requestId);
            else sendJson(res, 500, { error: errMsg(e) });
        }
    });
    server.on('error', (e) => logError.error(`🔌 [BUS] Error en bus interno (${safeErrorLabel(e)}).`));
    server.listen(port, host, () => {
        log.info(`🔌 [BUS] Bus interno en http://${host}:${port} (panel web lo consume aquí)`);
    });
    
    return server;
}

module.exports = {
    startInternalBus, setSock, clearSock, handleConnectionUpdate, setQrRefresh, setPairingCodeRequester,
    setResetReconnect, setTelegramReloader, setTelegramChatIdResolver, requestPairing, runAdminCommand, performReset, performRestart, wsReadyState,
    qrPayload, resetInProgressForTests, setQrTtlForTests, resetQrForTests, setPairingCodeTimeoutForTests,
    isQrWindowOpen: () => qrWindowOpen && !!lastQrDataUrl && Date.now() < qrExpiresAt,
    notifyAdmin
};

// --- Test Helpers ---
function resetInProgressForTests() {
    resetInProgress = false;
}
function setQrTtlForTests(ms) {
    qrTtlMs = ms;
}
function setPairingCodeTimeoutForTests(ms) {
    pairingCodeTimeoutMs = ms;
}
function resetQrForTests() {
    qrWindowOpen = true;
    qrExpiresAt = 0;
    lastQrDataUrl = null;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrExpiryTimer = null;
    clearPairingState();
}
