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
const { startInternalBus } = require('../services/internalBus');

let server;
let port;

function startTestServer() {
    return new Promise(resolve => {
        server = startInternalBus({ port: 0 });
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

    const got = collectSse(`http://127.0.0.1:${port}/logs?component=gateway&history=100`, lines => lines.some(l => l.includes('vieja 2')) && lines.some(l => l.includes('nueva 1')));

    await sleep(300);
    fs.appendFileSync(LOG, '{"level":30,"time":3000,"msg":"nueva 1","cat":"CORE"}\n');

    const lines = await got;
    assert.ok(lines.some(l => l.includes('vieja 1')) && lines.some(l => l.includes('vieja 2')), 'historial incluido');
    assert.ok(lines.some(l => l.includes('nueva 1')), 'líneas nuevas llegan en vivo');
});

test('rotación: el tail sigue al archivo renombrado y al nuevo', async () => {
    // Simula rotación estilo pino-roll: gateway.log → gateway.1.log + gateway.log nuevo
    const got = collectSse(`http://127.0.0.1:${port}/logs?component=gateway&history=0`, lines => lines.some(l => l.includes('POST-ROTACION')), 6000);

    await sleep(300);
    fs.renameSync(LOG, path.join(fakeLogs, 'gateway.log.1'));
    fs.writeFileSync(LOG, '{"level":30,"time":4000,"msg":"POST-ROTACION","cat":"CORE"}\n');

    const lines = await got;
    assert.ok(lines.some(l => l.includes('POST-ROTACION')), 'línea del archivo nuevo tras rotar');
});

test('truncación: si el archivo se achica, recomienza desde 0 sin colgarse', async () => {
    fs.writeFileSync(LOG, '{"level":30,"time":5000,"msg":"tras truncar A","cat":"CORE"}\n');

    const got = collectSse(`http://127.0.0.1:${port}/logs?component=gateway&history=0`, lines => lines.some(l => l.includes('tras truncar B')), 6000);
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

    const got = collectSse(`http://127.0.0.1:${port}/logs?component=brain&history=10`, lines => lines.some(l => l.includes('arrancó')), 4000);
    const lines = await got;
    assert.ok(lines.some(l => l.includes('arrancó')), 'historial del brain llega');
});

test('sin parámetro history usa el default (100 líneas)', async () => {
    fs.writeFileSync(LOG, '{"level":30,"time":9999,"msg":"default-hist","cat":"CORE"}\n');

    const got = collectSse(`http://127.0.0.1:${port}/logs?component=gateway`, lines => lines.some(l => l.includes('default-hist')), 4000);
    const lines = await got;
    assert.ok(lines.some(l => l.includes('default-hist')), 'default (100) envía el historial');
});

function requestBus(method, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathname,
            method
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

test('DELETE /logs con formato pino-roll (gateway.1.log) borra y trunca sin error 500', async () => {
    const pinoRollFile = path.join(fakeLogs, 'gateway.1.log');
    fs.writeFileSync(pinoRollFile, '{"level":30,"time":1111,"msg":"linea pino-roll","cat":"AI"}\n');

    const res = await requestBus('DELETE', '/logs?component=gateway');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.component, 'gateway');

    const content = fs.readFileSync(pinoRollFile, 'utf8');
    assert.ok(content.includes('Logs borrados correctamente desde el panel web.'));
    assert.ok(!content.includes('linea pino-roll'), 'contenido anterior fue truncado');
});

test('DELETE /logs con component=brain trunca el log del brain correctamente', async () => {
    const brainLog = path.join(fakeLogs, 'brain.log');
    fs.writeFileSync(brainLog, '2026-08-11 12:00:01 INFO [brain.main] log del cerebro\n');

    const res = await requestBus('DELETE', '/logs?component=brain');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.component, 'brain');

    const content = fs.readFileSync(brainLog, 'utf8');
    assert.ok(content.includes('Logs borrados correctamente desde el panel web.'));
    assert.ok(!content.includes('log del cerebro'), 'contenido anterior fue truncado');
});

test('DELETE /logs sin archivos previos crea el archivo con el aviso de reseteo', async () => {
    const emptyLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-empty-logs-'));
    process.env.SDK_ADMIN_WEB_LOG_GATEWAY = emptyLogsDir;

    const res = await requestBus('DELETE', '/logs?component=gateway');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    const createdFile = path.join(emptyLogsDir, 'gateway.log');
    assert.ok(fs.existsSync(createdFile));
    assert.ok(fs.readFileSync(createdFile, 'utf8').includes('Logs borrados correctamente'));

    fs.rmSync(emptyLogsDir, { recursive: true, force: true });
    process.env.SDK_ADMIN_WEB_LOG_GATEWAY = fakeLogs;
});