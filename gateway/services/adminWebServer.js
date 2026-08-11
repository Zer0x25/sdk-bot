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
 * Arranca el servidor del panel. EADDRINUSE se loguea y no tira el gateway.
 * @param {{port?: number}} [opts]
 * @returns {http.Server}
 */
function startAdminWebServer(opts = {}) {
    const port = opts.port ?? Number(process.env.ADMIN_WEB_PORT || 3200);
    const server = http.createServer((req, res) => {
        const pathname = (req.url || '/').split('?')[0];

        if (req.method === 'GET' && pathname === '/api/status') {
            sendJson(res, 200, buildStatus());
            return;
        }

        if (req.method === 'POST' && pathname === '/api/command') {
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

        if (req.method === 'GET' && !pathname.startsWith('/api/')) {
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
