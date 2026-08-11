// @ts-check
/**
 * 📊 Servidor de métricas local del gateway (F4-P3).
 * HTTP mínimo en 127.0.0.1 (nunca expuesto a la red):
 *   GET /status  → JSON completo con estado, contadores y métricas de runtime
 *   GET /health  → {"status":"ok", uptime} para healthchecks simples
 * Puerto: env STATUS_PORT (default 3100). Para la futura dashboard.
 */
const http = require('http');
const { state, counters } = require('../config');
const { getContactsDB, getSettingsDB } = require('./db');
const { getBrainStats } = require('./brainService');
const { getRuntimeStats } = require('../handlers/messageHandler');
const { getCommandStats } = require('../handlers/commandHandler');
const { getQueueStats } = require('./messageQueue');
const { getBroadcastStats } = require('./broadcastService');
const { cat } = require('./logger');

const log = cat('CORE');
const logError = cat('ERROR');

// Estado de conexión que index.js actualiza (no accesible desde aquí)
const runtime = {
    connection: 'starting',   // starting | open | close | reconnecting
    lastConnectAt: null,
    reconnectAttempt: 0,
    lastDisconnectReason: null
};

function buildStatus() {
    const contacts = getContactsDB();
    const settings = getSettingsDB();
    const mem = process.memoryUsage();
    return {
        status: 'ok',
        uptime_seconds: Math.round(process.uptime()),
        pid: process.pid,
        node: process.version,
        runtime,
        bot: {
            number: state.ADMIN_PHONE || state.ADMIN_LID || null,
            lid: state.ADMIN_LID || null,
            profile: state.CURRENT_PROFILE,
            globalMode: state.GLOBAL_MODE,
            paused: state.IS_BOT_PAUSED
        },
        database: {
            contacts: Object.keys(contacts).length,
            globalMode: settings.globalMode || null,
            currentProfile: settings.currentProfile || null
        },
        counters,
        brain: getBrainStats(),
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
    const port = opts.port ?? Number(process.env.STATUS_PORT || 3100);
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

    server.on('error', (e) => logError.error('📊 [STATUS] Error en el servidor de métricas: ' + (e && e.message)));
    server.listen(port, '127.0.0.1', () => {
        log.info(`📊 [STATUS] Métricas en http://127.0.0.1:${port}/status (solo local)`);
    });
    return server;
}

module.exports = { startStatusServer, runtime, buildStatus };
