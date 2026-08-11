const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const t = withTempDbPaths();

// Logs fake: el panel NUNCA toca los logs reales del gateway/brain.
// OJO: el require del módulo va DESPUÉS de setear las env vars (el módulo
// captura LOG_DIRS al cargarse; cargarlo antes rompería el override).
const fakeLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-logs-'));
process.env.SDK_ADMIN_WEB_LOG_GATEWAY = fakeLogs;
process.env.SDK_ADMIN_WEB_LOG_BRAIN = fakeLogs;
const LOG = path.join(fakeLogs, 'gateway.log');
fs.writeFileSync(LOG, '');
const { startAdminWebServer } = require('../services/adminWebServer');

let server;
let port;

function startTestServer() {
    return new Promise(resolve => {
        server = startAdminWebServer({ port: 0 });
        server.once('listening', () => {
            port = server.address().port;
            resolve();
        });
    });
}

before(() => startTestServer());
after(() => {
    server.close();
    fs.rmSync(fakeLogs, { recursive: true, force: true });
    delete process.env.SDK_ADMIN_WEB_LOG_GATEWAY;
    t.restore();
});

/**
 * Conecta al SSE y acumula eventos hasta cumplir el predicado o el timeout.
 * @param {string} url
 * @param {(lines: string[]) => boolean} done
 * @param {number} [timeoutMs]
 */
function collectSse(url, done, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const lines = [];
        const req = http.get(url, res => {
            res.setEncoding('utf8');
            res.on('error', reject);
            res.on('data', chunk => {
                for (const m of chunk.matchAll(/data: (.*)/g)) {
                    if (m[1].startsWith('{')) lines.push(JSON.parse(m[1]).line);
                    if (done(lines)) {
                        req.destroy();
                        resolve(lines);
                        return;
                    }
                }
            });
        });
        req.on('error', reject);
        const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout, líneas: ' + JSON.stringify(lines))); }, timeoutMs);
        req.on('close', () => clearTimeout(timer));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('SSE envía el historial y luego las líneas nuevas', async () => {
    fs.writeFileSync(LOG, '{"level":30,"time":1000,"msg":"vieja 1","cat":"AI"}\n{"level":30,"time":2000,"msg":"vieja 2","cat":"AI"}\n');

    const got = collectSse(`http://127.0.0.1:${port}/api/logs?component=gateway&history=100`, lines => lines.some(l => l.includes('vieja 2')) && lines.some(l => l.includes('nueva 1')));

    await sleep(300);
    fs.appendFileSync(LOG, '{"level":30,"time":3000,"msg":"nueva 1","cat":"CORE"}\n');

    const lines = await got;
    assert.ok(lines.some(l => l.includes('vieja 1')) && lines.some(l => l.includes('vieja 2')), 'historial incluido');
    assert.ok(lines.some(l => l.includes('nueva 1')), 'líneas nuevas llegan en vivo');
});

test('rotación: el tail sigue al archivo renombrado y al nuevo', async () => {
    // Simula rotación estilo pino-roll: gateway.log → gateway.1.log + gateway.log nuevo
    const got = collectSse(`http://127.0.0.1:${port}/api/logs?component=gateway&history=0`, lines => lines.some(l => l.includes('POST-ROTACION')), 6000);

    await sleep(300);
    fs.renameSync(LOG, path.join(fakeLogs, 'gateway.log.1'));
    fs.writeFileSync(LOG, '{"level":30,"time":4000,"msg":"POST-ROTACION","cat":"CORE"}\n');

    const lines = await got;
    assert.ok(lines.some(l => l.includes('POST-ROTACION')), 'línea del archivo nuevo tras rotar');
});

test('truncación: si el archivo se achica, recomienza desde 0 sin colgarse', async () => {
    fs.writeFileSync(LOG, '{"level":30,"time":5000,"msg":"tras truncar A","cat":"CORE"}\n');

    const got = collectSse(`http://127.0.0.1:${port}/api/logs?component=gateway&history=0`, lines => lines.some(l => l.includes('tras truncar B')), 6000);
    await sleep(300);
    // Escritura fantasma: se descarta (no llega), luego truncación completa
    fs.appendFileSync(LOG, '{"level":30,"time":6000,"msg":"fantasma","cat":"CORE"}\n');
    await sleep(300);
    fs.writeFileSync(LOG, '{"level":30,"time":7000,"msg":"tras truncar B","cat":"CORE"}\n');

    const lines = await got;
    assert.ok(lines.some(l => l.includes('tras truncar B')), 'se retoma tras truncación');
});

test('component=brain usa el directorio del brain', async () => {
    const brainLog = path.join(fakeLogs, 'brain.log');
    fs.writeFileSync(brainLog, '2026-08-11 12:00:01 INFO [brain.main] arrancó\n');

    const got = collectSse(`http://127.0.0.1:${port}/api/logs?component=brain&history=10`, lines => lines.some(l => l.includes('arrancó')), 4000);
    const lines = await got;
    assert.ok(lines.some(l => l.includes('arrancó')), 'historial del brain llega');
});

test('sin parámetro history usa el default (100 líneas)', async () => {
    fs.writeFileSync(LOG, '{"level":30,"time":9999,"msg":"default-hist","cat":"CORE"}\n');

    const got = collectSse(`http://127.0.0.1:${port}/api/logs?component=gateway`, lines => lines.some(l => l.includes('default-hist')), 4000);
    const lines = await got;
    assert.ok(lines.some(l => l.includes('default-hist')), 'default (100) envía el historial');
});