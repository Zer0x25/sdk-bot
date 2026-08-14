// @ts-check
/**
 * 🖥️ PANEL WEB — TERCER PROCESO INDEPENDIENTE del gateway y del brain.
 *
 * Antes el panel vivía DENTRO del proceso del gateway (adminWebServer).
 * Ahora es su propio proceso: se comunica con el gateway EXCLUSIVAMENTE
 * por el bus interno HTTP (GATEWAY_INTERNAL_URL, default 127.0.0.1:5400).
 *
 * El front (admin-web/index.html) sigue llamando a /api/*; este server las
 * proxy al bus interno. Si el gateway cae, el panel sigue vivo y el front
 * se reconecta solo cuando el gateway (y su bus) vuelve.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const WEB_DIR = path.join(__dirname, '..', 'admin-web');
const INTERNAL = process.env.GATEWAY_INTERNAL_URL || 'http://127.0.0.1:5400';
const PORT = Number(process.env.ADMIN_WEB_PORT || 5201);
const HOST = process.env.ADMIN_WEB_HOST || '0.0.0.0';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

/** Proxy de un request al bus interno, transmitiendo la respuesta tal cual. */
function proxy(req, res, busPathname, busParams) {
    const url = new URL(INTERNAL);
    url.pathname = busPathname;
    if (busParams) url.search = busParams;
    const preq = http.request(url, { method: req.method }, (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
    });
    preq.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bus interno caído: ' + e.message }));
    });
    if (req.method === 'POST' || req.method === 'DELETE') {
        req.pipe(preq);
    } else {
        preq.end();
    }
}

function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const { pathname, search } = u;

    // SSE: el front los consume como /api/qr y /api/logs; los proxy al bus.
    if (pathname === '/api/qr' && req.method === 'GET') { proxy(req, res, '/qr'); return; }
    if (pathname === '/api/logs' && req.method === 'GET') { proxy(req, res, '/logs' + search); return; }
    if (pathname === '/api/logs' && req.method === 'DELETE') { proxy(req, res, '/logs' + search); return; }
    if (pathname === '/api/status' && req.method === 'GET') { proxy(req, res, '/status'); return; }
    if (pathname === '/api/pairing' && req.method === 'POST') { proxy(req, res, '/pairing'); return; }
    if (pathname === '/api/command' && req.method === 'POST') { proxy(req, res, '/command'); return; }
    if (pathname === '/api/reset' && req.method === 'POST') { proxy(req, res, '/reset'); return; }
    if (pathname === '/api/restart' && req.method === 'POST') { proxy(req, res, '/restart'); return; }
    if (pathname === '/api/brain/start' && req.method === 'POST') { proxy(req, res, '/brain/start'); return; }

    // Estáticos del front.
    serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
    console.log(`🖥️ [PANEL] Panel web en http://${HOST}:${PORT} (consumiendo bus interno ${INTERNAL})`);
});
