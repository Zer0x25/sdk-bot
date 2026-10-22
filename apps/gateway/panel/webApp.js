// @ts-check
const fs = require('node:fs');
const path = require('node:path');

const WEB_APP_PREFIX = '/inbox';
const DEFAULT_BUILD_DIR = path.join(__dirname, 'web', 'dist');
const MIME = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
function sendText(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(message);
}

/**
 * Serve the separately built React app below /inbox without changing legacy routes.
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {{enabled: boolean; rootDir?: string}} options
 * @returns {boolean} true when this route was handled
 */
function serveConversationsApp(res, pathname, { enabled, rootDir = DEFAULT_BUILD_DIR }) {
    if (pathname !== WEB_APP_PREFIX && !pathname.startsWith(`${WEB_APP_PREFIX}/`)) return false;
    if (!enabled) { sendText(res, 404, 'No encontrado.'); return true; }

    let root;
    try { root = fs.realpathSync(rootDir); }
    catch { sendText(res, 503, 'La nueva bandeja aún no está construida.'); return true; }
    const indexFile = path.join(root, 'index.html');
    if (!fs.existsSync(indexFile)) { sendText(res, 503, 'La nueva bandeja aún no está construida.'); return true; }

    let relative;
    try { relative = decodeURIComponent(pathname.slice(WEB_APP_PREFIX.length)); }
    catch { sendText(res, 400, 'Ruta inválida.'); return true; }
    if (!relative || relative === '/') relative = '/index.html';
    const requested = path.resolve(root, `.${relative}`);
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
        sendText(res, 403, 'Acceso denegado.');
        return true;
    }

    let file = requested;
    try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
        // Browser routes fall back to index.html; missing built assets remain 404.
        if (path.extname(requested)) { sendText(res, 404, 'No encontrado.'); return true; }
        file = indexFile;
    }

    let realFile;
    try { realFile = fs.realpathSync(file); }
    catch { sendText(res, 404, 'No encontrado.'); return true; }
    if (!realFile.startsWith(`${root}${path.sep}`)) {
        sendText(res, 403, 'Acceso denegado.');
        return true;
    }
    fs.readFile(realFile, (error, body) => {
        if (error) { sendText(res, 404, 'No encontrado.'); return; }
        const extension = path.extname(realFile).toLowerCase();
        const html = extension === '.html';
        res.writeHead(200, {
            'Content-Type': MIME[extension] || 'application/octet-stream',
            'Cache-Control': html ? 'no-cache' : 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(body);
    });
    return true;
}

module.exports = { serveConversationsApp, WEB_APP_PREFIX };
