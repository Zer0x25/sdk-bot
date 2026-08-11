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
const { handleAdminCommand } = require('../handlers/commandHandler');
const { buildStatus } = require('./statusServer');
const { getContactsDB } = require('./db');
const { findKeyByDigits } = require('./contactsRepository');
const { setNumberState, setContactProfile } = require('./stateService');
const { cat, errMsg } = require('./logger');

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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
    server.listen(port, '127.0.0.1', () => {
        log.info(`🖥️ [ADMIN-WEB] Panel en http://127.0.0.1:${port}/ (solo local)`);
    });
    return server;
}

module.exports = { startAdminWebServer, runAdminCommand, makeVirtualSock };
