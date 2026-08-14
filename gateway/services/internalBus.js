// @ts-check
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
 * Endpoints (todos sin auth: es loopback local):
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
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { handleAdminCommand, makeVirtualSock } = require('../handlers/commandHandler');
const { buildStatus } = require('./statusServer');
const { getBrainHealth } = require('./brainService');
const { getContactsDB } = require('./db');
const { num } = require('../tuning');
const {
    performFactoryReset, setWiping, restartGatewayProcess, restartBrainIfSystemd
} = require('./factoryReset');
const { cat, errMsg } = require('./logger');

const log = cat('CORE');
const logError = cat('ERROR');

const LOG_DIRS = {
    gateway: path.join(__dirname, '..', 'logs'),
    brain: path.join(__dirname, '..', '..', 'brain', 'logs')
};

// --- estado del QR (idéntico al de adminWebServer, ahora en el bus) ---
const AUTH_DIR_RESOLVER = () => process.env.SDK_AUTH_DIR || path.join(__dirname, '..', 'auth_info_baileys');
let activeSock = null;
let lastQrDataUrl = null;
const qrClients = new Set();
const QR_TTL_MS = num('GATEWAY_QR_TTL_MS', 60000);
let qrExpiresAt = 0;
let qrTtlMs = QR_TTL_MS;
let qrExpiryTimer = null;
let qrWindowOpen = true;
let resetInProgress = false;

function wsReadyState(sock) {
    const ws = sock && sock.ws;
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
    return wsReadyState(activeSock) === 1;
}

function qrPayload() {
    const active = qrWindowOpen && !!lastQrDataUrl;
    return active
        ? { qr: lastQrDataUrl, expiresAt: qrExpiresAt || Date.now() + qrTtlMs, expired: false, session: hasActiveSession() }
        : { qr: null, expiresAt: null, expired: !qrWindowOpen, session: hasActiveSession() };
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
    qrExpiresAt = Date.now() + qrTtlMs;
    qrExpiryTimer = setTimeout(() => {
        qrWindowOpen = false;
        lastQrDataUrl = null;
        qrExpiresAt = 0;
        broadcastQrState();
    }, qrTtlMs);
    if (qrExpiryTimer.unref) qrExpiryTimer.unref();
}

/** El gateway entrega el socket activo de Baileys al bus. */
function setSock(sock) {
    activeSock = sock;
    lastQrDataUrl = null;
    qrWindowOpen = true;
    qrExpiresAt = 0;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    qrExpiryTimer = null;
    broadcastQrState();
}

/** Reenvío del connection.update de Baileys: captura y difunde el QR. */
async function handleConnectionUpdate(update) {
    if (!update) return;
    if (update.connection === 'open' || update.connection === 'close') {
        broadcastQrState();
        return;
    }
    if (typeof update.qr !== 'string') return;
    if (update.connection === 'open') return;
    if (!qrWindowOpen) openQrWindow();
    try {
        lastQrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
    } catch (e) {
        logError.error(`🔌 [BUS] Error renderizando QR: ${errMsg(e)}`);
        lastQrDataUrl = null;
    }
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

/**
 * Enciende el brain (proceso Python) si está caído. No bloquea: el spawn
 * corre desacoplado y el healthcheck del gateway lo detectará en ~10s.
 * Usa las mismas env que el systemd (BRAIN_PORT=5100, bind 0.0.0.0).
 * @returns {{success: boolean, message: string}}
 */
function startBrainProcess() {
    const brainDir = path.join(__dirname, '..', '..', 'brain');
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

async function requestPairing(phone) {
    const clean = String(phone || '').replace(/[^0-9]/g, '');
    const brainUp = !!(getBrainHealth() && getBrainHealth().status === 'ok');
    if (clean.length > 0 && clean.length < 9) {
        return { success: false, brainUp, message: 'Número inválido: se espera el número completo con código de país (ej: 56912345678)' };
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
    if (clean.length >= 9) {
        try {
            const code = await activeSock.requestPairingCode(clean);
            return { success: true, brainUp, code: String(code) };
        } catch (e) {
            return { success: false, brainUp, message: `No se pudo pedir el código de enlace: ${errMsg(e)}` };
        }
    }
    openQrWindow();
    return { success: true, brainUp, message: 'QR generado — escanéalo antes de que expire (1 min).' };
}

async function runAdminCommand(command) {
    try {
        const sock = makeVirtualSock(activeSock);
        const result = await handleAdminCommand(sock, String(command || ''));
        return { success: true, response: result };
    } catch (e) {
        return { success: false, message: `No se pudo ejecutar el comando: ${errMsg(e)}` };
    }
}

async function performReset(clean = false) {
    if (resetInProgress) return { success: false, message: 'Reset ya en curso…' };
    resetInProgress = true;
    if (clean) {
        setWiping(true);
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
    scheduleRestart();
    return { success: true, message: `Sesión ${deleted ? 'eliminada' : 'ya borrada'}; reiniciando gateway…` };
}

async function performRestart() {
    if (resetInProgress) return { success: false, message: 'Reinicio ya en curso…' };
    resetInProgress = true;
    scheduleRestart();
    return { success: true, message: 'Lanzando gateway…' };
}

// --- SSE de logs (lee el archivo de log en vivo) ---
function streamLogs(req, res, params) {
    const component = params.get('component') === 'brain' ? 'brain' : 'gateway';
    const base = component === 'brain' ? 'brain.log' : 'gateway.log';
    const p = path.join(LOG_DIRS[component], base);
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const send = (line) => { try { res.write(`data: ${line}\n\n`); } catch (e) {} };
    if (fs.existsSync(p)) {
        const init = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-100);
        init.forEach(send);
    }
    let tail = null;
    try {
        const { spawn } = require('child_process');
        tail = spawn('tail', ['-n', '+1', '-F', p], { stdio: ['ignore', 'pipe', 'ignore'] });
        tail.stdout.on('data', (buf) => buf.toString().split('\n').filter(Boolean).forEach(send));
    } catch (e) { /* tail no disponible */ }
    const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000).unref();
    req.on('close', () => { if (tail) tail.kill(); clearInterval(hb); });
}

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
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
        const p = path.join(LOG_DIRS[component], component === 'brain' ? 'brain.log' : 'gateway.log');
        try {
            fs.truncateSync(p, 0);
            fs.appendFileSync(p, `Logs borrados correctamente desde el panel web.\n`, 'utf8');
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
    if (pathname === '/brain/start' && req.method === 'POST') {
        sendJson(res, 200, startBrainProcess());
        return;
    }
    if (pathname === '/command' && req.method === 'POST') {
        readBody(req).then((b) => runAdminCommand(b.command).then((r) => sendJson(res, 200, r)));
        return;
    }
    if (pathname === '/reset' && req.method === 'POST') {
        readBody(req).then((b) => performReset(!!b.clean).then((r) => sendJson(res, 200, r)));
        return;
    }
    if (pathname === '/restart' && req.method === 'POST') {
        readBody(req).then((b) => performRestart().then((r) => sendJson(res, 200, r)));
        return;
    }
    sendJson(res, 404, { error: 'not found' });
}

/** Arranca el bus interno. Siempre (no depende de SDK_ADMIN_WEB_ENABLED). */
function startInternalBus(opts = {}) {
    const port = opts.port ?? Number(process.env.INTERNAL_BUS_PORT || 5400);
    const host = process.env.INTERNAL_BUS_HOST || '127.0.0.1';
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://${host}:${port}`);
        const params = u.searchParams;
        const pathname = u.pathname;
        try {
            routeApi(req, res, pathname, params);
        } catch (e) {
            sendJson(res, 500, { error: errMsg(e) });
        }
    });
    server.on('error', (e) => logError.error(`🔌 [BUS] Error en bus interno: ${e && e.message}`));
    server.listen(port, host, () => {
        log.info(`🔌 [BUS] Bus interno en http://${host}:${port} (panel web lo consume aquí)`);
    });
    return server;
}

module.exports = {
    startInternalBus, setSock, handleConnectionUpdate,
    requestPairing, runAdminCommand, performReset, performRestart
};
