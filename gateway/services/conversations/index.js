const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { databasePath } = require('./paths');

function unavailable(code = 'ARCHIVE_UNAVAILABLE') {
    return Object.assign(new Error('Archivo de conversaciones no disponible.'), { code });
}
/** Async, bounded RPC. DatabaseSync exists only in worker.js. No automatic retry:
 * a timed-out write may have committed; callers must deduplicate on redelivery. */
function createArchive(options = {}) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { path: options.path || databasePath(), restore: options.restore === true }
    });
    const pending = new Map();
    const eventListeners = new Set();
    let nextId = 0, elements = 0, bytes = 0, stopped = false, closing = false, closePromise;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Startup can fail before the session endpoint asks for readiness.
    ready.catch(() => {});
    function stop(error) {
        if (stopped) return;
        stopped = true; rejectReady(error);
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear(); elements = 0; bytes = 0;
    }
    const startupTimer = setTimeout(() => {
        stop(unavailable('ARCHIVE_START_TIMEOUT')); void worker.terminate();
    }, options.timeoutMs ?? 5000);
    worker.on('message', message => {
        if (message.ready) { clearTimeout(startupTimer); resolveReady(message.ready); return; }
        if (message.startupError) { clearTimeout(startupTimer); stop(unavailable(message.startupError.code)); return; }
        if (message.committedEvent) {
            for (const listener of eventListeners) {
                try { listener(message.committedEvent); } catch { /* One subscriber cannot affect archive writes. */ }
            }
            return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer); elements -= entry.elements; bytes -= entry.bytes;
        if (message.error) entry.reject(unavailable(message.error.code)); else entry.resolve(message.value);
    });
    worker.on('error', error => { clearTimeout(startupTimer); stop(unavailable(error.code)); });
    worker.on('exit', () => { clearTimeout(startupTimer); stop(unavailable('ARCHIVE_EXITED')); });
    function call(method, input = null) {
        if (stopped || closing && method !== 'close') return Promise.reject(unavailable());
        let encoded;
        try { encoded = JSON.stringify(input); }
        catch { return Promise.reject(unavailable('INVALID_INPUT')); }
        const size = Buffer.byteLength(encoded);
        // Snapshot caller-owned objects before asynchronous readiness/dispatch.
        input = JSON.parse(encoded);
        const count = method === 'ingestBatch' && Array.isArray(input) ? input.length
            : method === 'captureTelegramBatch' && Array.isArray(input?.updates) ? input.updates.length : 1;
        if (!count || elements + count > 1000 || bytes + size > 32 * 1024 * 1024) return Promise.reject(unavailable('ARCHIVE_SATURATED'));
        elements += count; bytes += size;
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // Stop admission and terminate instead of freeing a queue slot while
                // SQL is still running. Pending results are uncertain until reopen.
                stop(unavailable('ARCHIVE_TIMEOUT')); void worker.terminate();
            }, options.timeoutMs ?? 5000);
            pending.set(id, { resolve, reject, timer, elements: count, bytes: size });
            // Keep original admission order, including requests waiting for startup.
            ready.then(() => { if (!stopped) worker.postMessage({ id, method, input }); }).catch(() => {});
        });
    }
    return {
        ready,
        snapshot: () => call('snapshot'),
        registerAccount: input => call('registerAccount', input),
        telegramCursor: accountId => call('telegramCursor', accountId),
        captureTelegramBatch: input => call('captureTelegramBatch', input),
        resolve: input => call('resolve', input),
        bindAlias: input => call('bindAlias', input),
        ingestBatch: input => call('ingestBatch', input),
        updateTranscription: input => call('updateTranscription', input),
        pendingLegacyDispatches: (input = {}) => call('pendingLegacyDispatches', input),
        markLegacyDispatched: input => call('markLegacyDispatched', input),
        retryLegacyDispatch: input => call('retryLegacyDispatch', input),
        controlState: id => call('controlState', id),
        writeControlState: input => call('writeControlState', input),
        conversation: id => call('conversation', id),
        conversations: (input = {}) => call('conversations', input),
        conversationRows: (input = {}) => call('conversationRows', input),
        conversationView: input => call('conversationView', input),
        accounts: () => call('accounts'),
        messages: input => call('messages', input),
        messagePage: input => call('messagePage', input),
        markRead: input => call('markRead', input),
        events: (input = {}) => call('events', input),
        eventsPage: (input = {}) => call('eventsPage', input),
        onEvent(listener) {
            if (typeof listener !== 'function' || stopped || closing) return () => {};
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
        },
        diagnostics: () => call('diagnostics'),
        purge: (input = {}) => call('purge', input),
        backup: destination => call('backup', destination),
        close() {
            if (closePromise) return closePromise;
            closing = true;
            closePromise = (async () => {
                try { if (!stopped) await call('close'); }
                finally { await worker.terminate(); }
            })();
            return closePromise;
        },
        queue: () => ({ elements, bytes })
    };
}
module.exports = { createArchive };
