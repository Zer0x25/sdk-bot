// @ts-check
/**
 * 🖥️ PANEL WEB — TERCER PROCESO INDEPENDIENTE del gateway y del brain.
 *
 * Antes el panel vivía DENTRO del proceso del gateway (adminWebServer).
 * Ahora es su propio proceso: se comunica con el gateway EXCLUSIVAMENTE
 * por el bus interno HTTP (GATEWAY_INTERNAL_URL, default 127.0.0.1:5400).
 *
 * El front (public/index.html) sigue llamando a /api/*; este server las
 * proxy al bus interno. Si el gateway cae, el panel sigue vivo y el front
 * se reconecta solo cuando el gateway (y su bus) vuelve.
 *
 * 🔐 OAuth 2.0 con Google (OPCIONAL, controlado por env):
 *   - Si PANEL_GOOGLE_CLIENT_ID y PANEL_GOOGLE_CLIENT_SECRET están presentes,
 *     TODAS las rutas (excepto /auth/*) exigen sesión Google.
 *   - Si no, el panel queda ABIERTO (comportamiento legacy) y avisa en consola.
 *   - Usa solo Node built-ins (fetch + crypto), sin dependencias extra.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Carga gateway/panel/.env (no versionado) si existe. No sobreescribe env ya definidas.
const DOTENV = path.join(__dirname, '.env');
if (fs.existsSync(DOTENV)) {
    for (const line of fs.readFileSync(DOTENV, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
}

const WEB_DIR = path.join(__dirname, 'public');

// Si se define, el redirect_uri de OAuth SIEMPRE usa esta URL canónica
// (evita que entrar por IP/Tailscale genere un redirect_uri no autorizado en Google).
const PUBLIC_URL = process.env.PANEL_PUBLIC_URL || '';
const INTERNAL = process.env.GATEWAY_INTERNAL_URL || 'http://127.0.0.1:5400';
const PORT = Number(process.env.ADMIN_WEB_PORT || 5201);
const HOST = process.env.ADMIN_WEB_HOST || '0.0.0.0';

// --- Configuración OAuth ---
const GOOGLE_CLIENT_ID = process.env.PANEL_GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.PANEL_GOOGLE_CLIENT_SECRET || '';
// Si no se define, se genera uno efímero por arranque (las sesiones se invalidan al reiniciar).
const SESSION_SECRET = process.env.PANEL_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// OAuth se activa solo en PRODUCCIÓN (NODE_ENV=production) o si se fuerza con PANEL_REQUIRE_AUTH=***.
// En desarrollo el panel queda ABIERTO (mock) aunque haya credenciales, para no frenar el trabajo.
const NODE_ENV = process.env.NODE_ENV || 'development';
const FORCE_AUTH = process.env.PANEL_REQUIRE_AUTH === '***' || process.env.PANEL_REQUIRE_AUTH === 'true';
const OAUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) && (NODE_ENV === 'production' || FORCE_AUTH);
// Si se define, solo estos correos (csv, minúsculas) pueden entrar. Vacío = cualquier cuenta Google verificada.
const ALLOWED_EMAILS = (process.env.PANEL_ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const COOKIE_NAME = 'sdkbot_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 horas

// --- Seguridad de panel: STATUS_TOKEN y Validación de Origin (Fase 9) ---
const STATUS_TOKEN = process.env.STATUS_TOKEN || process.env.PANEL_STATUS_TOKEN || '';

/**
 * Valida si una petición de mutación (POST/PUT/DELETE/PATCH) está autorizada:
 * 1. Si STATUS_TOKEN está configurado, header X-Status-Token válido autoriza.
 * 2. Si Sec-Fetch-Site es 'cross-site', se rechaza.
 * 3. Si hay Origin o Referer, debe coincidir con el Host o PUBLIC_URL.
 * 4. Si STATUS_TOKEN está configurado y no se envió token, exige sesión válida.
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function isWriteAuthorized(req) {
    const headerToken = req.headers['x-status-token'];
    if (STATUS_TOKEN && typeof headerToken === 'string' && headerToken === STATUS_TOKEN) {
        return true;
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite === 'cross-site') {
        return false;
    }

    const originHeader = req.headers.origin;
    const refererHeader = req.headers.referer;
    const origin = typeof originHeader === 'string' ? originHeader : (typeof refererHeader === 'string' ? new URL(refererHeader).origin : null);
    if (origin) {
        try {
            const originUrl = new URL(origin);
            const reqHost = req.headers.host || '';
            const matchesHost = originUrl.host === reqHost;
            let matchesPublic = false;
            if (PUBLIC_URL) {
                matchesPublic = originUrl.origin === new URL(PUBLIC_URL).origin;
            }
            if (!matchesHost && !matchesPublic) {
                return false;
            }
        } catch {
            return false;
        }
    }

    if (STATUS_TOKEN) {
        const session = parseSession(req);
        if (!session) return false;
    }

    return true;
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// ---------- Firmado de cookies (HMAC-SHA256, base64url) ----------
function sign(value) {
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
    return `${value}.${sig}`;
}
function unsign(signed) {
    const idx = signed.lastIndexOf('.');
    if (idx < 0) return null;
    const value = signed.slice(0, idx);
    const sig = signed.slice(idx + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    } catch {
        return null;
    }
    return value;
}
function parseSession(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (!m) return null;
    const payload = unsign(decodeURIComponent(m[1]));
    if (!payload) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.exp || Date.now() > data.exp) return null;
        return data;
    } catch {
        return null;
    }
}
function externalUrl(req, pathname) {
    if (PUBLIC_URL) {
        const base = PUBLIC_URL.replace(/\/+$/, '');
        return `${base}${pathname}`;
    }
    const rawProto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const proto = rawProto || 'https';
    const host = req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}${pathname}`;
}
function cookieFlags(secure) {
    // Sesión: SameSite=Lax (se usa en navegaciones same-site bot.zer0x.org -> bot.zer0x.org).
    // Lax evita el bloqueo de "cookies de terceros"/privacidad estricta que rompía la
    // sesión con SameSite=None. Secure solo si venimos por HTTPS (prod via Cloudflare).
    const parts = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}
function sessionCookie(data, secure) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const signed = sign(payload);
    const exp = new Date(data.exp).toUTCString();
    // Max-Age además de Expires: algunos navegadores (modo estricto/incógnito)
    // ignoran Expires sin Max-Age y tratan la cookie como sesión de navegador
    // (se borra al cerrar). Max-Age la hace persistente el TTL real.
    const maxAge = Math.floor((data.exp - Date.now()) / 1000);
    return `${COOKIE_NAME}=${encodeURIComponent(signed)}; ${cookieFlags(secure)} Expires=${exp}; Max-Age=${maxAge}`;
}
function clearCookie(secure) {
    return `${COOKIE_NAME}=; ${cookieFlags(secure)} Max-Age=0`;
}

// ---------- Proxy al bus interno ----------
function proxy(req, res, targetPath) {
    const targetUrl = new URL(targetPath, INTERNAL);
    const headers = { ...req.headers, host: targetUrl.host };
    const preq = http.request(targetUrl, { method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode || 500, pres.headers);
        pres.pipe(res);
    });
    preq.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bus interno caído: ' + e.message }));
    });
    if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT' || req.method === 'PATCH') {
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
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(data);
    });
}

function serveLogin(res) {
    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SDK-Bot · Acceso</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:#1a1d27;border:1px solid #2a2f3d;border-radius:14px;padding:36px 40px;text-align:center;max-width:360px}
  h1{font-size:20px;margin:0 0 6px}
  p{color:#9aa3b2;font-size:14px;margin:0 0 24px}
  a.btn{display:inline-block;background:#2f6df6;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;font-size:15px}
  a.btn:hover{background:#245ae0}
</style>
</head>
<body>
  <div class="card">
    <h1>🔐 SDK-Bot Panel</h1>
    <p>Inicia sesión con tu cuenta de Google para continuar.</p>
    <a class="btn" href="/auth/google">Entrar con Google</a>
  </div>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

// ---------- Handlers de autenticación ----------
// State de OAuth guardado server-side (en memoria). Evita depender de cookies
// para el state, que el navegador a veces no reenvía en el callback cross-site
// desde Google (bloqueo de cookies de terceros / privacidad estricta).
const OAUTH_STATE_TTL_MS = 1000 * 60 * 10; // 10 min
const oauthStates = new Map(); // state -> expiry timestamp (ms)
function saveOAuthState(state) {
    oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    // limpieza básica de expirados
    if (oauthStates.size > 100) {
        const now = Date.now();
        for (const [k, exp] of oauthStates) if (exp < now) oauthStates.delete(k);
    }
}
function consumeOAuthState(state) {
    if (!state) return false;
    const exp = oauthStates.get(state);
    if (!exp) return false;
    oauthStates.delete(state);
    return exp >= Date.now();
}
function startLogin(req, res) {
    const state = crypto.randomBytes(16).toString('hex');
    saveOAuthState(state);
    const redirectUri = externalUrl(req, '/auth/callback');
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'select_account');
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
}

async function finishLogin(req, res) {
    const secure = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() === 'https';
    const u = new URL(req.url || '/', `http://${req.headers.host || HOST + ':' + PORT}`);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    // State verificado server-side (no depende de cookies del navegador).
    const stateOk = consumeOAuthState(state);
    if (!code || !stateOk) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Estado OAuth inválido o faltante.');
        return;
    }
    const redirectUri = externalUrl(req, '/auth/callback');
    try {
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        const token = /** @type {{ access_token?: string }} */ (await tokenResp.json());
        if (!token.access_token) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('No se pudo obtener el token de Google.');
            return;
        }
        const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${token.access_token}` }
        });
        const user = /** @type {{ email?: string, name?: string, picture?: string }} */ (await userResp.json());
        if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes((user.email || '').toLowerCase())) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Tu cuenta de Google no está autorizada para este panel.');
            return;
        }
        const data = {
            email: user.email,
            name: user.name,
            picture: user.picture,
            exp: Date.now() + SESSION_TTL_MS
        };
        res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(data, secure) });
        res.end();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error en el intercambio OAuth: ' + msg);
    }
}

function handleLogout(req, res) {
    const secure = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() === 'https';
    res.writeHead(302, { Location: '/', 'Set-Cookie': clearCookie(secure) });
    res.end();
}

// ---------- Router principal ----------
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host || HOST + ':' + PORT}`);
    const { pathname } = u;

    // Rutas de auth solo existen cuando OAuth está habilitado (prod/forzado).
    // En dev (abierto) estas rutas no hacen nada y el panel queda accesible.
    if (OAUTH_ENABLED) {
        if (pathname === '/auth/google') return startLogin(req, res);
        if (pathname === '/auth/callback') return finishLogin(req, res);
        if (pathname === '/auth/logout') return handleLogout(req, res);
    }

    // Seguridad de escrituras en API (Fase 9: Origin check + STATUS_TOKEN)
    if (pathname.startsWith('/api/') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method || '')) {
        if (!isWriteAuthorized(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Acceso de escritura rechazado: Origin no autorizado o STATUS_TOKEN inválido' }));
            return;
        }
    }

    // Legacy: OAuth deshabilitado => comportamiento original (panel abierto).
    if (!OAUTH_ENABLED) {
        if (pathname.startsWith('/api/')) {
            const busPath = (req.url ?? '/').replace(/^\/api/, '') || '/';
            return proxy(req, res, busPath);
        }
        return serveStatic(req, res, pathname);
    }

    // OAuth habilitado: exigir sesión.
    const session = parseSession(req);
    if (!session) {
        if (pathname.startsWith('/api/')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'no autenticado' }));
            return;
        }
        if (req.method === 'GET') {
            if (pathname === '/') return serveLogin(res);
            // Cualquier otra ruta estática sin sesión => al login.
            res.writeHead(302, { Location: '/' });
            res.end();
            return;
        }
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('no autenticado');
        return;
    }

    // Autenticado:
    if (pathname.startsWith('/api/')) {
        const busPath = (req.url ?? '/').replace(/^\/api/, '') || '/';
        return proxy(req, res, busPath);
    }
    return serveStatic(req, res, pathname);
});

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        if (OAUTH_ENABLED) {
            const restrict = ALLOWED_EMAILS.length ? `solo: ${ALLOWED_EMAILS.join(', ')}` : 'cualquier cuenta Google';
            console.log(`🖥️ [PANEL] Panel web en http://${HOST}:${PORT} (OAuth Google ACTIVO, ${restrict}; bus interno ${INTERNAL})`);
        } else {
            console.log(`🖥️ [PANEL] Panel web en http://${HOST}:${PORT} (OAuth DESHABILITADO — panel abierto; bus interno ${INTERNAL})`);
        }
    });
}

module.exports = { server, isWriteAuthorized, parseSession };
