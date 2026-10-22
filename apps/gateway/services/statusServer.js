// @ts-check
/**
 * 📊 Servidor de métricas local del gateway (F4-P3).
 * HTTP mínimo en 127.0.0.1 (nunca expuesto a la red):
 *   GET /status  → JSON completo con estado, contadores y métricas de runtime
 *   GET /health  → {"status":"ok", uptime} para healthchecks simples
 * Puerto: env STATUS_PORT (default 5300, rango dev misc 5300-5399). Para la futura dashboard.
 */
const http = require('http');
const { state, counters } = require('../config');
const { getContactsDB, getSettingsDB } = require('./db');
const { getBrainStats, getBrainHealth } = require('./brainService');
const { getRuntimeStats } = require('../handlers/messageHandler');
const { getCommandStats } = require('../handlers/commandHandler');
const { getQueueStats } = require('./messageQueue');
const { getBroadcastStats } = require('./broadcastService');
const { cat, safeErrorLabel } = require('./logger');

const log = cat('CORE');
const logError = cat('ERROR');
const PUBLIC_DISCONNECT_REASONS = new Set([
    'logged_out', 'normal', 'sin_sesion', 'sin_token', 'token_invalido', 'identidad_no_verificada',
    'archivo_no_disponible', 'error_archivo', 'error_polling', 'error_captura'
]);

function publicCaptureStatus(capture) {
    if (!capture || capture.status !== 'degraded') return null;
    return {
        status: 'degraded',
        code: safeErrorLabel({ code: capture.code }),
        at: capture.at || null
    };
}

function publicChannelStatus(channel) {
    const reason = channel.lastDisconnectReason;
    return {
        connection: channel.connection,
        lastConnectAt: channel.lastConnectAt,
        reconnectAttempt: channel.reconnectAttempt,
        lastDisconnectReason: reason ? (PUBLIC_DISCONNECT_REASONS.has(reason) ? reason : 'error') : null,
        capture: publicCaptureStatus(channel.capture)
    };
}

// Estado de conexión que index.js actualiza (no accesible desde aquí)
const channels = {
    whatsapp: {
        connection: 'starting',   // starting | open | close | reconnecting | standby
        lastConnectAt: null,
        reconnectAttempt: 0,
        lastDisconnectReason: null
    },
    telegram: {
        connection: 'starting',   // starting | open | close
        lastConnectAt: null,
        reconnectAttempt: 0,
        lastDisconnectReason: null
    }
};

function buildStatus() {
    const contacts = getContactsDB();
    const settings = getSettingsDB();
    const mem = process.memoryUsage();
    const byState = { neutro: 0, permitido: 0, ignorado: 0, handoff: 0 };
    for (const contact of Object.values(contacts)) {
        const status = contact && byState[contact.estado] !== undefined ? contact.estado : 'neutro';
        byState[status] += 1;
    }
    return {
        status: 'ok',
        uptime_seconds: Math.round(process.uptime()),
        pid: process.pid,
        node: process.version,
        channels: {
            whatsapp: publicChannelStatus(channels.whatsapp),
            telegram: publicChannelStatus(channels.telegram)
        },
        bot: {
            adminLinked: Boolean(state.ADMIN_PHONE || state.ADMIN_LID),
            profile: state.CURRENT_PROFILE,
            globalMode: state.GLOBAL_MODE,
            paused: state.IS_BOT_PAUSED
        },
        database: {
            contacts: Object.keys(contacts).length,
            byState,
            globalMode: settings.globalMode || null,
            currentProfile: settings.currentProfile || null
        },
        counters,
        brain: {
            ...getBrainStats(),
            health: getBrainHealth()
        },
        commands: getCommandStats(),
        runtimeStats: getRuntimeStats(),
        queue: getQueueStats(),
        broadcast: getBroadcastStats(),
        memory: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external
        }
    };
}

/**
 * @param {{port?: number}} opts
 * @returns {http.Server}
 */
function startStatusServer(opts = {}) {
    const port = opts.port ?? Number(process.env.STATUS_PORT || 5300);
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (req.url === '/health') {
            res.end(JSON.stringify({ status: 'ok', uptime_seconds: Math.round(process.uptime()) }));
            return;
        }
        if (req.url !== '/status' && req.url !== '/') {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'not found' }));
            return;
        }
        res.end(JSON.stringify(buildStatus(), null, 2));
    });

    server.on('error', (e) => logError.error(`📊 [STATUS] Error en el servidor de métricas (${safeErrorLabel(e)}).`));
    const host = process.env.STATUS_HOST || '127.0.0.1';
    server.listen(port, host, () => {
        log.info(`📊 [STATUS] Métricas en http://${host}:${port}/status`);
    });
    return server;
}

module.exports = { startStatusServer, channels, buildStatus };
