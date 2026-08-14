// @ts-check
/**
 * 🖥️ Panel de administración web (F6-P1). Módulo OPCIONAL: el motor del bot
 * no lo conoce — solo se monta con SDK_ADMIN_WEB_ENABLED=1 (hook en index.js).
 * Consume servicios existentes sin modificarlos:
 *   - commandHandler (sock virtual: la respuesta del comando va al HTTP)
 *   - statusServer.buildStatus (métricas ya existentes)
 * Front estático en gateway/admin-web/, servido por este mismo proceso.
 * Puerto: env ADMIN_WEB_PORT (default 3200), solo 127.0.0.1.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { handleAdminCommand } = require('../handlers/commandHandler');
const { buildStatus } = require('./statusServer');
const { getContactsDB } = require('./db');
const { findKeyByDigits } = require('./contactsRepository');
const { setNumberState, setContactProfile } = require('./stateService');
const { getAvailableProfiles, getProfileDetail, exportProfileFile, importProfileFile, deleteProfileFile, reloadProfiles } = require('./brainService');
const { performFactoryReset, setWiping, restartGatewayProcess, restartBrainIfSystemd } = require('./factoryReset');
const { cat, errMsg } = require('./logger');
const { num } = require('../tuning');

const log = cat('CORE');
const logError = cat('ERROR');

const WEB_DIR = path.join(__dirname, '..', 'admin-web');

// ID fijo del "admin" para el rate limiter (20 comandos/min, igual que el self-chat)
const ADMIN_JID = 'admin-web@web';

/**
 * Sock virtual: captura las respuestas de los comandos admin en vez de
 * enviarlas a WhatsApp. Texto → bloques; documentos → base64 descargable.
 * @param {Array<{type: string, text?: string, fileName?: string, caption?: string, base64?: string}>} replies
 */
function makeVirtualSock(replies) {
    return {
        /** @param {any} msg */
        async sendMessage(_jid, msg) {
            if (msg && typeof msg.text === 'string') {
                replies.push({ type: 'text', text: msg.text });
            } else if (msg && msg.document) {
                const buf = Buffer.isBuffer(msg.document) ? msg.document : Buffer.from(msg.document);
                replies.push({
                    type: 'document',
                    fileName: msg.fileName || 'archivo',
                    caption: msg.caption || '',
                    base64: buf.toString('base64')
                });
            } else {
                replies.push({ type: 'other', text: JSON.stringify(msg).slice(0, 500) });
            }
            return null;
        }
    };
}

/**
 * Ejecuta un comando admin (ej: "/pausar" o "pausar") y devuelve sus respuestas.
 * @param {string} input
 * @returns {Promise<{ok: boolean, replies: Array<{type: string, text?: string, fileName?: string, caption?: string, base64?: string}>}>}
 */
async function runAdminCommand(input) {
    const text = String(input || '').trim();
    if (!text) return { ok: false, replies: [{ type: 'text', text: '⚠️ Comando vacío.' }] };
    const replies = [];
    const commandLine = text.startsWith('/') ? text : `/${text}`;
    await handleAdminCommand(commandLine, ADMIN_JID, makeVirtualSock(replies), /** @type {any} */ ({}));
    return { ok: true, replies };
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

/**
 * Sirve un archivo del front estático sin permitir path traversal.
 * @param {string} urlPath
 * @param {http.ServerResponse} res
 */
function serveStatic(urlPath, res) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
    }
    const ext = path.extname(file).toLowerCase();
    // Sin caché: el front es estático pero evoluciona con el server; un
    // cache sin revalidar mostró versiones viejas (pairing con sesión activa).
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}

/** @param {http.ServerResponse} res */
function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

/**
 * Parser mínimo de query string (evita dependencias y globals de Node).
 * @param {string} raw
 * @returns {Map<string, string>}
 */
function parseQuery(raw) {
    const out = new Map();
    for (const part of String(raw || '').split('&')) {
        if (!part) continue;
        const [k, v] = part.split('=');
        out.set(decodeURIComponent(k), decodeURIComponent(v || ''));
    }
    return out;
}

// -------------------------------------------------------------
// F6-P2: AGENDA DE CONTACTOS (consume contactsRepository/stateService)
// -------------------------------------------------------------

/** Mapea el valor de estado de ContactRecord al stateType de setNumberState */
const ESTADO_TO_TYPE = {
    neutro: 'neutral',
    permitido: 'allowed',
    ignorado: 'ignored',
    handoff: 'handoff'
};

/** @param {import('./contactsRepository.js').ContactRecord} c */
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

/** @param {string} q */
function contactMatches(c, q) {
    if (!q) return true;
    const hay = [c.savedName, c.phone, c.lid].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
}

/**
 * GET /api/contacts?q=&estado=&page=&limit=
 * @param {Map<string, string>} params
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

/** @param {string} key @param {string} estado */
function setContactEstado(key, estado) {
    const stateType = ESTADO_TO_TYPE[estado];
    if (!stateType) return { success: false, message: `Estado inválido: ${estado}` };
    return setNumberState(key, stateType);
}

/** @param {string} key @param {string} perfil */
function setContactPerfil(key, perfil) {
    if (!perfil || !/^[a-z0-9_-]{1,32}$/i.test(perfil)) {
        return { success: false, message: 'Perfil no válido' };
    }
    return setContactProfile(key, perfil);
}

// -------------------------------------------------------------
// F6-P3: LOGS EN VIVO POR SSE (tail de gateway.log y brain.log)
// El panel lee los archivos: el bot no se entera. Tolera cualquier
// esquema de rotación (rename, archivo nuevo, truncación).
// -------------------------------------------------------------

// Rutas de logs con override por env (tests con archivos fake, nunca tocar los reales)
const LOG_DIRS = {
    gateway: process.env.SDK_ADMIN_WEB_LOG_GATEWAY || path.join(__dirname, '..', 'logs'),
    brain: process.env.SDK_ADMIN_WEB_LOG_BRAIN || path.join(__dirname, '..', '..', 'brain', 'logs')
};
// Cubre gateway.log (activo), gateway.1.log (rotado pino-roll real, número
// antes de .log) y gateway.log.1 (formato que usa el test de rotación del suite).
const LOG_PATTERNS = { gateway: /^gateway(\.\d+)?\.log(\.\d+)?$/, brain: /^brain(\.\d+)?\.log(\.\d+)?$/ };
const LINE_CAP = 8192;

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Map<string, string>} params
 */
function streamLogs(req, res, params) {
    const component = params.get('component') === 'brain' ? 'brain' : 'gateway';
    // 0 = sin historial; ausente = 100 (default). `|| 100` convertiría 0 en 100,
    // haciendo imposible pedir "sin historial" (bug detectado en verificación F6-P3).
    const rawHist = params.get('history');
    // `Map.get` devuelve undefined (no null) para clave ausente → usar == null.
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
     * N=0 ⇒ sin historial (corrige slice(-0) que devolvía todo el archivo).
     */
    function sendHistory() {
        /** @type {string|null} */
        let best = null;
        let bestMtime = 0;
        let files;
        try { files = fs.readdirSync(dir); } catch { return; }
        for (const f of files) {
            if (!pattern.test(f)) continue;
            const p = path.join(dir, f);
            let st;
            try { st = fs.statSync(p); } catch (e) { continue; }
            if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; }
        }
        if (!best) return;
        const st = fs.statSync(best);
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
     * o se reescribieron (mismo tamaño pero mtime distinto). Tolerante a que el
     * cambio ocurra entre dos ticks: el mtime detecta reescrituras a igual tamaño
     * que el tamaño por sí solo no vería (ver test de truncación F6-P3).
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
            else continue;                                           // igual tamaño y mtime: sin cambios (evita recarga por flush/reescritura de pino al pausar/reanudar)
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

// -------------------------------------------------------------
// F6-P4: CONEXIÓN Y PAIRING DESDE EL PANEL
// El motor solo hace adminWeb?.setSock(sock) y reenvía el
// connection.update de Baileys; el panel re-renderiza el QR y lo
// difunde por SSE /api/qr, pide el código de enlace (pairing) y
// ofrece reset de sesión (borrar auth_info_baileys + reiniciar).
// -------------------------------------------------------------

const AUTH_DIR_RESOLVER = () => process.env.SDK_AUTH_DIR || path.join(__dirname, '..', 'auth_info_baileys');

/** @type {any|null} socket real de Baileys (patrón setSock de broadcastService) */
let activeSock = null;
/** @type {string|null} PNG data URL del último QR renderizado */
let lastQrDataUrl = null;
/** @type {Set<http.ServerResponse>} clientes SSE de /api/qr */
const qrClients = new Set();
// Ventana de QR: cada intento (arranque sin sesión, pairing manual) vale
// 1 min. Mientras la ventana está abierta el panel muestra el QR y el
// botón de pairing queda bloqueado; al expirar, se vuelve a "no
// disponible" y solo un pairing nuevo (SIEMPRE manual) la reabre.
const QR_TTL_MS = num('GATEWAY_QR_TTL_MS', 60000);
let qrExpiresAt = 0;
let qrTtlMs = QR_TTL_MS;
/** @type {NodeJS.Timeout|null} */
let qrExpiryTimer = null;
let qrWindowOpen = true; // socket nuevo/arranque: el QR puede aparecer solo

/**
 * Estado del WebSocket de Baileys (rc14: `sock.ws` es un WebSocketClient
 * wrapper con isOpen()/isClosed(); el readyState numérico ya no existe).
 * Soporta ambos: readyState estándar (tests/sock fakes) y wrapper rc14.
 * Devuelve: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED, null sin ws.
 * @param {any} sock
 * @returns {number|null}
 */
function wsReadyState(sock) {
    const ws = sock && sock.ws;
    if (!ws) return null;
    if (typeof ws.readyState === 'number') return ws.readyState;
    // rc14: WebSocketClient con getters booleanos isOpen/isClosed/isClosing/isConnecting
    if (typeof ws.isOpen === 'boolean') {
        if (ws.isOpen) return 1;
        if (ws.isClosed) return 3;
        if (ws.isClosing) return 2;
        if (ws.isConnecting) return 0;
        return null;
    }
    // fallback: métodos (otros wrappers)
    if (typeof ws.isOpen === 'function') {
        if (ws.isOpen()) return 1;
        if (ws.isClosed()) return 3;
        if (ws.isClosing()) return 2;
        if (ws.isConnecting()) return 0;
    }
    return null;
}

/**
 * Estado de sesión: socket de Baileys conectado (ws OPEN).
 * @returns {boolean}
 */
function hasActiveSession() {
    return wsReadyState(activeSock) === 1;
}

/** Payload actual del QR (null si no hay ventana/QR vigente) + estado de sesión. */
function qrPayload() {
    // Mostrar el QR si está capturado y la ventana abierta, sin depender de
    // qrExpiresAt (setSock lo resetea a 0 y lo invalidaba aunque el QR estuviera
    // vigente). El frontend maneja la expiración visual con su propio countdown.
    const active = qrWindowOpen && !!lastQrDataUrl;
    return active
        ? { qr: lastQrDataUrl, expiresAt: qrExpiresAt || Date.now() + qrTtlMs, expired: false, session: hasActiveSession() }
        : { qr: null, expiresAt: null, expired: !qrWindowOpen, session: hasActiveSession() };
}

/**
 * Difunde el estado del QR + sesión a todos los clientes de /api/qr.
 */
function broadcastQrState() {
    const data = JSON.stringify(qrPayload());
    for (const client of qrClients) {
        try { client.write(`data: ${data}\n\n`); } catch (e) { qrClients.delete(client); }
    }
}

/** Abre (o renueva) la ventana de 1 min del QR; al expirar, cierra y avisa. */
function openQrWindow() {
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrWindowOpen = true;
    qrExpiresAt = Date.now() + qrTtlMs;
    qrExpiryTimer = setTimeout(() => {
        qrWindowOpen = false;
        lastQrDataUrl = null;
        qrExpiresAt = 0;
        broadcastQrState();
    }, qrTtlMs);
    if (qrExpiryTimer.unref) qrExpiryTimer.unref();
}

/**
 * El motor entrega el socket activo (misma línea aditiva que el hook de
 * montaje: adminWeb?.setSock(sock)). Un socket nuevo = QR nuevo.
 * @param {any} sock
 */
function setSock(sock) {
    activeSock = sock;
    lastQrDataUrl = null;
    qrWindowOpen = true;
    qrExpiresAt = 0;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrExpiryTimer = null;
    broadcastQrState(); // sesión nueva: el front se entera del cambio en vivo
}

/**
 * Reenvío del connection.update de Baileys: captura el QR crudo, lo
 * renderiza a PNG (data URL) y lo difunde a los clientes de /api/qr.
 * El QR es solo un string: la "herramienta" (node-qrcode) dibuja donde
 * sea; aquí se convierte en imagen para el navegador.
 * Con la ventana cerrada los QRs regenerados de Baileys se IGNORAN:
 * tras expirar, solo un pairing manual (POST /api/pairing) la reabre.
 * @param {{qr?: string, connection?: string}} update
 */
async function handleConnectionUpdate(update) {
    if (!update) return;
    log.info(`[ADMIN-WEB-DEBUG] conn.update qr=${typeof update.qr === 'string' ? 'YES' : 'no'} conn=${update.connection || 'n/a'} qrWindowOpen=${qrWindowOpen}`);
    // Sesión abierta/cerrada: re-difunde el estado (el front decide qué
    // mostrar: pairing cuando no hay sesión, reset cuando la hay).
    if (update.connection === 'open' || update.connection === 'close') {
        broadcastQrState();
        return;
    }
    if (typeof update.qr !== 'string') return;
    // Capturar el QR SIEMPRE que Baileys lo emita y no haya sesión abierta.
    if (update.connection === 'open') return;
    if (!qrWindowOpen) openQrWindow();
    try {
        lastQrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
        log.info(`[ADMIN-WEB-DEBUG] QR capturado len=${lastQrDataUrl ? lastQrDataUrl.length : 'NULL'}`);
    } catch (e) {
        logError.error(`🖥️ [ADMIN-WEB] Error renderizando QR: ${errMsg(e)}`);
        lastQrDataUrl = null;
    }
    broadcastQrState();
}

/**
 * GET /api/qr — SSE: estado actual del QR (data URL PNG o null, con la
 * ventana de expiración) y actualizaciones en vivo. Misma técnica de
 * streaming que /api/logs.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function streamQr(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');

    try { res.write(`data: ${JSON.stringify(qrPayload())}\n\n`); } catch (e) { /* cerrado */ }

    qrClients.add(res);
    const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000).unref();
    req.on('close', () => {
        qrClients.delete(res);
        clearInterval(hb);
    });
}

/**
 * POST /api/pairing — pide el código de enlace de 8 dígitos a WhatsApp
 * (pairing con número de teléfono) o abre la ventana del QR (sin número).
 * Mientras haya un QR vigente NO permite otro: hay que esperar a que
 * expire (1 min) y pedirlo de nuevo, siempre manual. Si el gateway no
 * tiene socket activo (primera vez, o tras el anti-loop sin sesión), se
 * LANZA el gateway: reinicia el proceso para que conecte y genere el
 * QR/pairing. El front lo muestra como "lanzando gateway…".
 * @param {string} phone
 * @returns {Promise<{success: boolean, code?: string, message?: string, needsRestart?: boolean}>}
 */
async function requestPairing(phone) {
    const clean = String(phone || '').replace(/[^0-9]/g, '');
    if (clean.length > 0 && clean.length < 9) {
        return { success: false, message: 'Número inválido: se espera el número completo con código de país (ej: 56912345678)' };
    }
    if (qrWindowOpen && Date.now() < qrExpiresAt) {
        const s = Math.ceil((qrExpiresAt - Date.now()) / 1000);
        return { success: false, message: `QR vigente: escanéalo (${s}s restantes) o espera a que expire para pedir otro.` };
    }
    // Socket cerrado (Baileys CLOSED=3, p.ej. tras el anti-loop sin sesión)
    // cuenta como "sin socket": el QR no va a llegar solo, hay que relanzar.
    const sockClosed = wsReadyState(activeSock) === 3;
    if (!activeSock || sockClosed) {
        // Solo relanzar el gateway si el SERVICIO está MUERTO. Si systemd lo
        // tiene activo, el proceso está vivo y Baileys emitirá el QR por SSE
        // cuando conecte: relanzar aquí mata el proceso y pierde el QR (bug
        // "se me muere el QR"). En manual (sin systemd) el proceso vivo = activo.
        if (!isGatewayServiceActive()) {
            log.warn('🖥️ [ADMIN-WEB] Pairing sin socket activo y servicio caído: lanzando gateway…');
            scheduleRestart();
            return {
                success: false,
                needsRestart: true,
                message: 'El gateway no está corriendo. Lanzando gateway… el QR aparecerá aquí en unos segundos.'
            };
        }
        // Servicio vivo: abrir la ventana y esperar el QR por SSE (no relanzar).
        openQrWindow();
        return {
            success: true,
            message: 'Gateway activo: el QR llegará aquí por SSE en unos segundos (no reinicies). Si no aparece en ~20s, usa "Lanzar gateway".'
        };
    }
    if (clean.length >= 9) {
        try {
            const code = await activeSock.requestPairingCode(clean);
            return { success: true, code: String(code) };
        } catch (e) {
            return { success: false, message: `No se pudo pedir el código de enlace: ${errMsg(e)}` };
        }
    }
    // Sin teléfono: abrir la ventana del QR (si el socket ya lo emite,
    // llega por SSE; si no, el usuario usa "Lanzar gateway").
    openQrWindow();
    return { success: true, message: 'QR generado — escanéalo antes de que expire (1 min). Si el QR no aparece en ~20s, usa "Lanzar gateway".' };
}

let resetInProgress = false;

/**
 * Solo tests: libera el flag de "reinicio en curso" (los tests comparten el
 * módulo en el mismo proceso; en producción el proceso muere/reinicia antes).
 */
function resetInProgressForTests() {
    resetInProgress = false;
}

/**
 * Solo tests: acorta la ventana del QR para probar la expiración rápido.
 * @param {number} ms
 */
function setQrTtlForTests(ms) {
    qrTtlMs = ms;
}

/**
 * Solo tests: limpia el estado del QR (ventana abierta, sin QR vigente).
 * Los tests comparten el módulo en el mismo proceso; en producción el
 * estado lo gobierna el flujo real de Baileys.
 */
function resetQrForTests() {
    qrWindowOpen = true;
    qrExpiresAt = 0;
    lastQrDataUrl = null;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrExpiryTimer = null;
}

/**
 * Reinicia el proceso del gateway (para regenerar QR/pairing o tras reset):
 * mismo comportamiento de factoryReset.restartGatewayProcess (systemd o
 * exit); margen de 500ms para que el cliente HTTP reciba la respuesta.
 */
function scheduleRestart() {
    restartGatewayProcess();
}

/**
 * Indica si el servicio del gateway está VIVO (no hay que relanzarlo).
 * Bajo systemd consulta `systemctl is-active`; en manual/dev el proceso
 * actual está vivo por definición (si murió, systemd lo habría relanzado
 * con Restart=always, o el runner lo detecta).
 * @returns {boolean}
 */
function isGatewayServiceActive() {
    if (!process.env.SYSTEMD_EXEC_PID) return true; // manual/dev: proceso vivo = activo
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('systemctl', ['is-active', process.env.SDK_GATEWAY_SERVICE || 'sdk-bot-gateway'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        return out === 'active';
    } catch (e) {
        // systemctl is-active devuelve exit!=0 si no está active; en duda,
        // asumimos vivo para NO relanzar y matar el QR (comportamiento seguro).
        return true;
    }
}

/**
 * POST /api/reset — borra la sesión (auth_info_baileys) para forzar un
 * QR nuevo y reinicia el proceso. Requiere confirm: true (el front pide
 * confirmación).
 */
async function performReset() {
    if (resetInProgress) return { success: false, message: 'Reset ya en curso…' };
    resetInProgress = true;

    let deleted = false;
    try {
        const authDir = AUTH_DIR_RESOLVER();
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            deleted = true;
        }
    } catch (e) {
        return { success: false, message: `No se pudo borrar la sesión: ${errMsg(e)}` };
    }
    log.warn(`🖥️ [ADMIN-WEB] Reset de sesión: auth_info_baileys ${deleted ? 'eliminado' : 'no existía'}; reiniciando gateway…`);
    scheduleRestart();

    return { success: true, message: `Sesión ${deleted ? 'eliminada' : 'ya borrada'}; reiniciando gateway… La página se reconectará sola.` };
}

/**
 * F7: POST /api/reset con clean:true — RESET LIMPIO (factory reset): borra
 * TODO el estado de runtime (sesión, agenda, settings, broadcasts, cola,
 * memoria del brain, logs y locks) y reinicia. La app queda como recién
 * clonada; los perfiles SOUL se conservan. El flag `wiping` evita que el
 * cierre seguro vuelque la caché RAM a disco (resistiría el wipe).
 */
async function performCleanReset() {
    if (resetInProgress) return { success: false, message: 'Reset ya en curso…' };
    resetInProgress = true;
    setWiping(true);

    const report = performFactoryReset();
    if (report.errors.length > 0) {
        setWiping(false);
        resetInProgress = false;
        const reason = report.errors[0];
        logError.error(`🖥️ [ADMIN-WEB] Reset limpio ABORTADO: no se pudo borrar ${reason}`);
        return { success: false, message: `Reset limpio abortado: ${reason}` };
    }

    log.warn(`🖥️ [ADMIN-WEB] Reset limpio: ${report.deleted.length} elementos borrados (${report.missing.length} no existían); reiniciando…`);
    // El brain corre en la misma máquina: si es un service de systemd se
    // reinicia para que suelte el inodo de memory.db borrada (la recrea
    // vacía); en modo manual se reinicia con el próximo arranque del brain.
    const brainNote = restartBrainIfSystemd()
        ? ' y brain'
        : ' (reinicia el brain manualmente para limpiar su memoria en RAM)';
    scheduleRestart();

    return {
        success: true,
        message: `Reset limpio: ${report.deleted.length} elementos borrados; reiniciando gateway${brainNote}. La app queda como recién instalada.`
    };
}

/**
 * POST /api/restart — LANZA/REINICIA el gateway SIN borrar la sesión.
 * Sirve para la primera vez (gateway apagado o sin socket tras el
 * anti-loop sin sesión): reinicia el proceso y conecta → genera QR o
 * reusa la sesión. Requiere confirm: true.
 */
async function performRestart() {
    if (resetInProgress) return { success: false, message: 'Reinicio ya en curso…' };
    resetInProgress = true;
    log.warn('🖥️ [ADMIN-WEB] Lanzando/reiniciando gateway (sin borrar sesión)…');
    scheduleRestart();
    return { success: true, message: 'Lanzando gateway… La página se reconectará sola (~10s).' };
}

// -------------------------------------------------------------
// SERVICIOS HTTP
// -------------------------------------------------------------

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 * @param {Map<string, string>} params
 */
function routeApi(req, res, pathname, params) {
    if (pathname === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, buildStatus());
        return;
    }

    if (pathname === '/api/logs' && req.method === 'GET') {
        streamLogs(req, res, params);
        return;
    }

    if (pathname === '/api/logs' && req.method === 'DELETE') {
        const component = params.get('component') === 'brain' ? 'brain' : 'gateway';
        const dir = LOG_DIRS[component];
        const base = component === 'brain' ? 'brain.log' : 'gateway.log';
        const p = path.join(dir, base);
        try {
            fs.truncateSync(p, 0);
            // Marca de confirmación: el SSE la entrega al instante, así la
            // ventana no queda vacía y se ve que el flujo sigue vivo.
            // Hora local de Santiago (no UTC): toISOString() da UTC siempre,
            // por eso el mensaje de borrado se veia en UTC aunque el process
            // tenga TZ=America/Santiago. Usamos Intl con la zona explicita.
            const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()).replace('T', ' ');
            const cat = component === 'brain' ? '[brain.admin]' : '[CORE]';
            const stamp = ts + ' INFO ' + cat + ' Logs borrados correctamente desde el panel web.\n';
            fs.appendFileSync(p, stamp, 'utf8');
            sendJson(res, 200, { success: true, component, file: base });
        } catch (e) {
            sendJson(res, 500, { success: false, message: `No se pudo truncar ${base}: ${errMsg(e)}` });
        }
        return;
    }

    if (pathname === '/api/qr' && req.method === 'GET') {
        streamQr(req, res);
        return;
    }

    if (pathname === '/api/pairing' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 10_000) req.destroy();
        });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const result = await requestPairing(String(parsed.phone || ''));
                sendJson(res, result.success ? 200 : 400, result);
            } catch (e) {
                sendJson(res, 500, { success: false, message: `Error interno: ${errMsg(e)}` });
            }
        });
        return;
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 10_000) req.destroy();
        });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                if (parsed.confirm !== true) {
                    sendJson(res, 400, { success: false, message: 'Se requiere confirm: true (el front pide confirmación antes de llamar)' });
                    return;
                }
                const result = parsed.clean === true
                    ? await performCleanReset()
                    : await performReset();
                sendJson(res, result.success ? 200 : 400, result);
            } catch (e) {
                sendJson(res, 500, { success: false, message: `Error interno: ${errMsg(e)}` });
            }
        });
        return;
    }

    if (pathname === '/api/restart' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 10_000) req.destroy();
        });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                if (parsed.confirm !== true) {
                    sendJson(res, 400, { success: false, message: 'Se requiere confirm: true' });
                    return;
                }
                const result = await performRestart();
                sendJson(res, result.success ? 200 : 400, result);
            } catch (e) {
                sendJson(res, 500, { success: false, message: `Error interno: ${errMsg(e)}` });
            }
        });
        return;
    }

    if (pathname === '/api/command' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 10_000) req.destroy();
        });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const result = await runAdminCommand(parsed.command || '');
                sendJson(res, 200, result);
            } catch (e) {
                const msg = errMsg(e);
                logError.error('🖥️ [ADMIN-WEB] Error ejecutando comando: ' + msg);
                sendJson(res, 500, { ok: false, replies: [{ type: 'text', text: '⚠️ Error interno: ' + msg }] });
            }
        });
        return;
    }

    // Agenda: /api/contacts, /api/contacts/<key>, /api/contacts/<key>/estado|perfil
    const m = /^\/api\/contacts(?:\/(\d+))?(?:\/(estado|perfil))?$/.exec(pathname);
    if (m) {
        if (req.method === 'GET' && !m[1]) {
            sendJson(res, 200, listContacts(params));
            return;
        }
        if (req.method === 'GET' && m[1] && !m[2]) {
            const detail = getContactDetail(m[1]);
            if (!detail) return sendJson(res, 404, { error: 'contacto no encontrado' });
            sendJson(res, 200, detail);
            return;
        }
        if (req.method === 'POST' && m[1] && m[2]) {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 10_000) req.destroy();
            });
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body || '{}');
                    const result = m[2] === 'estado'
                        ? setContactEstado(m[1], String(parsed.estado || ''))
                        : setContactPerfil(m[1], String(parsed.perfil || ''));
                    sendJson(res, result.success ? 200 : 400, result);
                } catch (e) {
                    const msg = errMsg(e);
                    logError.error('🖥️ [ADMIN-WEB] Error en agenda: ' + msg);
                    sendJson(res, 500, { ok: false, error: msg });
                }
            });
            return;
        }
    }

    // Perfiles SOUL: proxy del brain — listar, ver/editar el .md, importar,
    // exportar, eliminar y recargar (el front de la pestaña #perfiles los usa).
    // Orden importa: /reload e /import van ANTES del regex de clave.
    if (pathname === '/api/profiles' && req.method === 'GET') {
        getAvailableProfiles()
            .then(list => sendJson(res, 200, { profiles: list }))
            .catch(e => sendJson(res, 500, { error: errMsg(e) }));
        return;
    }

    if (pathname === '/api/profiles/reload' && req.method === 'POST') {
        reloadProfiles()
            .then(r => sendJson(res, 200, r || { success: false, message: 'Brain sin respuesta' }))
            .catch(e => sendJson(res, 500, { error: errMsg(e) }));
        return;
    }

    if (pathname === '/api/profiles/import' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 100_000) req.destroy();
        });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const key = String(parsed.key || '').trim();
                const content = String(parsed.content || '');
                if (!key || !content) {
                    sendJson(res, 400, { success: false, message: 'Se requiere key y content' });
                    return;
                }
                importProfileFile(key, content).then(result => {
                    if (!result) return sendJson(res, 502, { success: false, message: 'Brain sin respuesta' });
                    // El brain falla con HTTPException {detail} (sin success): normalizar
                    if (result.success !== true) {
                        return sendJson(res, 400, { success: false, message: result.detail || result.message || 'El brain rechazó el perfil' });
                    }
                    sendJson(res, 200, result);
                }).catch(e => sendJson(res, 500, { error: errMsg(e) }));
            } catch (e) {
                sendJson(res, 500, { success: false, message: `Error interno: ${errMsg(e)}` });
            }
        });
        return;
    }

    const pm = /^\/api\/profiles\/([\w.-]+)(?:\/file)?$/.exec(pathname);
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
                    // El brain falla con HTTPException {detail} (sin success): normalizar
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

/**
 * Arranca el servidor del panel. EADDRINUSE se loguea y no tira el gateway.
 * @param {{port?: number}} [opts]
 * @returns {http.Server}
 */
function startAdminWebServer(opts = {}) {
    const port = opts.port ?? Number(process.env.ADMIN_WEB_PORT || 3200);
    const server = http.createServer((req, res) => {
        const pathname = (req.url || '/').split('?')[0];
        const params = parseQuery((req.url || '').split('?')[1] || '');

        if (pathname.startsWith('/api/')) {
            routeApi(req, res, pathname, params);
            return;
        }

        if (req.method === 'GET') {
            serveStatic(pathname, res);
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    });

    server.on('error', (e) => {
        const err = /** @type {any} */ (e);
        if (err && err.code === 'EADDRINUSE') {
            logError.error(`🖥️ [ADMIN-WEB] Puerto ${port} ocupado — el panel no se montó (SDK_ADMIN_WEB_ENABLED=${process.env.SDK_ADMIN_WEB_ENABLED || 'off'})`);
        } else {
            logError.error('🖥️ [ADMIN-WEB] Error del servidor: ' + errMsg(err));
        }
    });
    const host = process.env.ADMIN_WEB_HOST || '127.0.0.1';
    server.listen(port, host, () => {
        log.info(`🖥️ [ADMIN-WEB] Panel en http://${host}:${port}/`);
    });
    return server;
}

module.exports = { startAdminWebServer, runAdminCommand, makeVirtualSock, setSock, handleConnectionUpdate, resetInProgressForTests, setQrTtlForTests, resetQrForTests };
