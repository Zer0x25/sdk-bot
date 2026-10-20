// Experimento F0.2: solo fixtures temporales; no importa el bootstrap del gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData, threadId } = require('node:worker_threads');

function runDatabaseWorker() {
    // Solo este hilo abre la conexión. VACUUM INTO evita depender de APIs añadidas
    // después de Node 22.13 y crea una instantánea incluyendo commits en WAL.
    const { DatabaseSync } = require('node:sqlite');
    let db;
    function open() {
        db = new DatabaseSync(workerData.dbPath);
        db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 1000;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL REFERENCES accounts(id),
                remote_chat_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                occurred_at INTEGER NOT NULL,
                content TEXT NOT NULL,
                UNIQUE(account_id, remote_chat_id, provider_id)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS messages_timeline
                ON messages(account_id, remote_chat_id, occurred_at, id);
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY,
                message_id TEXT NOT NULL REFERENCES messages(id)
            ) STRICT;
            INSERT OR IGNORE INTO accounts VALUES ('tg-main', 'telegram');
            INSERT OR IGNORE INTO accounts VALUES ('tg-other', 'telegram');
            INSERT OR IGNORE INTO accounts VALUES ('wa-main', 'whatsapp');
            PRAGMA user_version = 1;
        `);
    }
    function write(rows) {
        const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
        const event = db.prepare('INSERT INTO events(message_id) VALUES (?)');
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of rows) {
                insert.run(row.id, row.accountId, row.chatId, row.providerId, row.at, row.text);
                event.run(row.id);
            }
            db.exec('COMMIT');
            return rows.length;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    function execute(op, args) {
        switch (op) {
            case 'metadata':
                return {
                    threadId,
                    sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
                    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
                    foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
                    schemaVersion: db.prepare('PRAGMA user_version').get().user_version
                };
            case 'write': return write(args);
            case 'count':
                return {
                    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
                    events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n
                };
            case 'read': return db.prepare('SELECT * FROM messages WHERE id = ?').get(args);
            case 'page':
                return db.prepare(`SELECT id, occurred_at FROM messages
                    WHERE account_id = ? AND remote_chat_id = ?
                    AND (occurred_at, id) > (?, ?)
                    ORDER BY occurred_at, id LIMIT ?
                `).all(args.accountId, args.chatId, args.at, args.id, args.limit);
            case 'invalidEvent':
                return db.prepare('INSERT INTO events(message_id) VALUES (?)').run('missing');
            case 'backup':
                db.prepare('VACUUM INTO ?').run(args);
                return true;
            case 'integrity': return db.prepare('PRAGMA integrity_check').get().integrity_check;
            case 'reopen':
                db.close();
                open();
                return true;
            case 'close':
                db.close();
                db = null;
                return true;
            default: throw new Error(`Operación de fixture desconocida: ${op}`);
        }
    }
    open();
    parentPort.on('message', ({ id, op, args }) => {
        try {
            parentPort.postMessage({ id, result: execute(op, args) });
        } catch (error) {
            parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
        }
    });
}

function databaseClient(dbPath) {
    const worker = new Worker(__filename, { workerData: { dbPath } });
    const pending = new Map();
    let nextId = 0;
    let failure;
    function rejectPending(error) {
        failure = error;
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        pending.clear();
    }
    worker.on('error', rejectPending);
    worker.on('exit', code => rejectPending(new Error(`Worker cerrado (${code})`)));
    worker.on('message', ({ id, result, error }) => {
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        clearTimeout(item.timer);
        if (error) item.reject(Object.assign(new Error(error.message), { code: error.code }));
        else item.resolve(result);
    });
    return {
        request(op, args = null) {
            if (failure) return Promise.reject(failure);
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                const timer = setTimeout(() => {
                    rejectPending(new Error(`Timeout del fixture SQLite: ${op}`));
                    worker.terminate().catch(() => {});
                }, 30000);
                pending.set(id, { resolve, reject, timer });
                worker.postMessage({ id, op, args });
            });
        },
        async dispose() {
            try {
                if (!failure) await this.request('close');
            } finally {
                await worker.terminate();
            }
        }
    };
}

async function runSpike() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    assert.ok(major > 22 || (major === 22 && minor >= 13), 'Requiere Node >=22.13 sin flags SQLite');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-sqlite-spike-'));
    const dbPath = path.join(directory, 'messages.db');
    const clients = [];
    const checks = [];
    const errors = [];
    let report;
    function clientFor(filename) {
        const client = databaseClient(filename);
        clients.push(client);
        return client;
    }
    const row = (id, overrides = {}) => ({
        id, accountId: 'tg-main', chatId: '-1001234567890123', providerId: id,
        at: 1700000000000, text: "Hola 'cliente'; DROP TABLE messages; --", ...overrides
    });
    try {
        const client = clientFor(dbPath);
        const metadata = await client.request('metadata');
        assert.notEqual(metadata.threadId, threadId);
        assert.equal(metadata.journalMode, 'wal');
        assert.equal(metadata.foreignKeys, 1);
        assert.equal(metadata.schemaVersion, 1);
        checks.push('worker propietario, WAL y schema');

        await client.request('write', [row('m01'), row('m02'), row('m03')]);
        const stored = await client.request('read', 'm01');
        assert.equal(stored.content, row('m01').text);
        assert.equal(stored.remote_chat_id, row('m01').chatId);
        assert.deepEqual(await client.request('count'), { messages: 3, events: 3 });
        checks.push('roundtrip parametrizado y mensaje/evento atómicos');
        if (process.argv.includes('--simulate-failure')) throw new Error('Fallo simulado después de escribir');

        await assert.rejects(client.request('write', [row('duplicate', { providerId: 'm01' })]), /UNIQUE/);
        await client.request('write', [
            row('other-chat', { chatId: '-200', providerId: 'm01' }),
            row('other-account', { accountId: 'tg-other', providerId: 'm01' }),
            row('other-channel', { accountId: 'wa-main', providerId: 'm01' })
        ]);
        assert.deepEqual(await client.request('count'), { messages: 6, events: 6 });
        checks.push('unicidad por cuenta/chat y aislamiento de canales');

        await assert.rejects(client.request('write', [row('rollback'), row('m01')]), /UNIQUE/);
        assert.equal(await client.request('read', 'rollback'), undefined);
        assert.deepEqual(await client.request('count'), { messages: 6, events: 6 });
        await assert.rejects(client.request('invalidEvent'), /FOREIGN KEY/);
        checks.push('rollback de lote completo y claves foráneas');

        const pageArgs = { accountId: 'tg-main', chatId: row('m01').chatId, at: 0, id: '', limit: 2 };
        const first = await client.request('page', pageArgs);
        const last = first[first.length - 1];
        const second = await client.request('page', { ...pageArgs, at: last.occurred_at, id: last.id });
        assert.deepEqual([...first, ...second].map(item => item.id), ['m01', 'm02', 'm03']);
        checks.push('cursor compuesto estable con timestamps iguales');

        await Promise.all(Array.from({ length: 20 }, (_, i) => client.request('write', [row(`parallel-${i}`)])));
        assert.deepEqual(await client.request('count'), { messages: 26, events: 26 });
        checks.push('peticiones concurrentes serializadas en worker');

        let heartbeats = 0;
        const timer = setInterval(() => { heartbeats++; }, 1);
        const started = performance.now();
        try {
            await client.request('write', Array.from({ length: 5000 }, (_, i) => row(`bulk-${i}`)));
        } finally {
            clearInterval(timer);
        }
        const bulkMs = Math.round(performance.now() - started);
        assert.ok(heartbeats > 0, 'El event loop principal sigue atendiendo timers durante el lote');
        const counts = await client.request('count');
        assert.deepEqual(counts, { messages: 5026, events: 5026 });
        checks.push('lote de 5000 sin detener timers del hilo principal');

        // El backup se toma ANTES de cerrar/checkpoint: los commits siguen en WAL.
        assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);
        const backupPath = path.join(directory, 'backup.db');
        await client.request('backup', backupPath);
        assert.equal(fs.existsSync(`${backupPath}-wal`), false);
        const restorePath = path.join(directory, 'restored.db');
        fs.copyFileSync(backupPath, restorePath);
        const restored = clientFor(restorePath);
        assert.deepEqual(await restored.request('count'), counts);
        assert.equal(await restored.request('integrity'), 'ok');
        assert.equal((await restored.request('read', 'm01')).content, row('m01').text);
        checks.push('backup VACUUM INTO y restauración con WAL activo');

        await client.request('write', [row('after-backup')]);
        assert.deepEqual(await restored.request('count'), counts);
        await client.request('reopen');
        assert.deepEqual(await client.request('count'), { messages: 5027, events: 5027 });
        assert.equal(await client.request('integrity'), 'ok');
        await client.request('write', [row('after-reopen')]);
        checks.push('snapshot estable, cierre/reapertura y nueva escritura');

        await assert.rejects(client.request('unsupported'), /desconocida/);
        assert.equal(await client.request('integrity'), 'ok');
        checks.push('errores propagados sin inutilizar el worker');
        report = { node: process.version, platform: process.platform, arch: process.arch,
            sqlite: metadata.sqlite, checks, bulk: { messages: 5000, durationMs: bulkMs, heartbeats } };
    } catch (error) {
        errors.push(error);
    }
    const disposed = await Promise.allSettled(clients.map(client => client.dispose()));
    for (const result of disposed) if (result.status === 'rejected') errors.push(result.reason);
    try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
        errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Falló el experimento SQLite');
    assert.equal(fs.existsSync(directory), false);
    return { ...report, temporaryDirectoryRemoved: true };
}

if (isMainThread) {
    runSpike().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
} else {
    runDatabaseWorker();
}
