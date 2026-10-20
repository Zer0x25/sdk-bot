const StandardMessage = require('../../core/StandardMessage');

/**
 * Replays messages captured with their archive transaction. The archive is the
 * source of truth; adapter events only wake this bounded, single-owner pump.
 */
function createLegacyDispatchPump({ archive, dispatch, isReady, onError = () => {}, batchSize = 100 }) {
    let running = false, rerun = false, closed = false, retryTimer = null;
    const active = new Set();

    function report(error, messageId) {
        try { onError(error, messageId); } catch { /* logging must not stop replay */ }
    }

    function scheduleRetry(delayMs) {
        if (closed || retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void trigger();
        }, delayMs);
        retryTimer.unref?.();
    }

    async function trigger() {
        if (closed) return;
        if (running) { rerun = true; return; }
        running = true;
        try {
            do {
                rerun = false;
                let pending;
                try { pending = await archive.pendingLegacyDispatches({ limit: batchSize }); }
                catch (error) { report(error, null); scheduleRetry(5000); break; }
                if (!pending.length) break;
                let progressed = 0;
                for (const entry of pending) {
                    if (closed) break;
                    if (active.has(entry.messageId)) continue;
                    let ready = false;
                    try { ready = Boolean(isReady(entry.message.channel)); } catch { /* keep pending */ }
                    if (!ready) continue;
                    const message = new StandardMessage({ ...entry.message, archiveMessageId: entry.messageId });
                    let acknowledged = false;
                    const acknowledge = async () => {
                        if (acknowledged) return;
                        acknowledged = true;
                        try {
                            const result = await archive.markLegacyDispatched({ messageId: entry.messageId });
                            active.delete(entry.messageId);
                            if (result.status === 'dispatched') {
                                progressed++;
                                void trigger();
                            } else {
                                report(Object.assign(new Error('LEGACY_DISPATCH_ACK_UNCERTAIN'), { code: 'LEGACY_DISPATCH_ACK_UNCERTAIN' }), entry.messageId);
                                scheduleRetry(5000);
                            }
                        } catch (error) {
                            active.delete(entry.messageId);
                            report(error, entry.messageId);
                            scheduleRetry(5000);
                        }
                    };
                    acknowledge.retry = async error => {
                        acknowledged = true;
                        active.delete(entry.messageId);
                        try { await archive.retryLegacyDispatch({ messageId: entry.messageId, code: error?.code }); }
                        catch (archiveError) { report(archiveError, entry.messageId); }
                        report(error, entry.messageId);
                        scheduleRetry(Math.min(60000, 1000 * (2 ** Math.min(entry.attempts, 6))));
                    };
                    try {
                        const result = await dispatch(message, acknowledge);
                        if (result === 'deferred') {
                            active.add(entry.messageId);
                            continue;
                        }
                    } catch (error) {
                        try { await archive.retryLegacyDispatch({ messageId: entry.messageId, code: error?.code }); }
                        catch (archiveError) { report(archiveError, entry.messageId); }
                        report(error, entry.messageId);
                        scheduleRetry(Math.min(60000, 1000 * (2 ** Math.min(entry.attempts, 6))));
                        break;
                    }
                    // Immediate branches (ignore, handoff, commands) complete in
                    // the handler. Respond branches can defer ACK until processing.
                    await acknowledge();
                }
                if (pending.length >= batchSize && progressed > 0) rerun = true;
            } while (rerun && !closed);
        } finally {
            running = false;
            if (rerun && !closed) void trigger();
        }
    }

    return {
        trigger,
        async close() {
            closed = true;
            rerun = false;
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            while (running) await new Promise(resolve => setTimeout(resolve, 1));
        }
    };
}

module.exports = { createLegacyDispatchPump };
