const StandardMessage = require('../../core/StandardMessage');

/**
 * Delivers Telegram admin text only after its update and cursor committed in the
 * same SQLite transaction. A claimed command is never replayed after restart:
 * an unfinished claim becomes `uncertain` during archive initialization.
 */
function createTelegramAdminInboxPump({ archive, dispatch, isReady, onError = () => {}, onUncertain = () => {}, batchSize = 50 }) {
    if (!archive || typeof dispatch !== 'function' || typeof isReady !== 'function') {
        throw Object.assign(new Error('TELEGRAM_ADMIN_INBOX_UNAVAILABLE'), { code: 'TELEGRAM_ADMIN_INBOX_UNAVAILABLE' });
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw Object.assign(new Error('INVALID_TELEGRAM_ADMIN_INBOX_BATCH_SIZE'), { code: 'INVALID_LIMIT' });
    }

    let running = false, rerun = false, closed = false, retryTimer = null, lastUncertainCount = null;

    function report(error, idempotencyKey = null) {
        try { onError(error, idempotencyKey); } catch { /* diagnostics must not stop inbox work */ }
    }
    function scheduleRetry() {
        if (closed || retryTimer) return;
        retryTimer = setTimeout(() => { retryTimer = null; void trigger(); }, 5000);
        retryTimer.unref?.();
    }

    async function trigger() {
        if (closed) return;
        if (running) { rerun = true; return; }
        running = true;
        try {
            do {
                rerun = false;
                let status;
                try { status = await archive.telegramAdminInboxStatus(); }
                catch (error) { report(error); scheduleRetry(); break; }
                if (lastUncertainCount === null || lastUncertainCount !== status.uncertain) {
                    lastUncertainCount = status.uncertain;
                    if (status.uncertain) {
                        try { onUncertain(status.uncertain); } catch { /* logging only */ }
                    }
                }
                let pending;
                try { pending = await archive.pendingTelegramAdminInbox({ limit: batchSize }); }
                catch (error) { report(error); scheduleRetry(); break; }
                if (!pending.length) break;
                let progressed = 0;
                for (const item of pending) {
                    if (closed) break;
                    let ready = false;
                    try { ready = Boolean(isReady('telegram')); } catch { /* leave queued */ }
                    if (!ready) continue;
                    let claimed;
                    try { claimed = await archive.claimTelegramAdminInbox({ accountId: item.accountId, updateId: item.updateId }); }
                    catch (error) { report(error, item.idempotencyKey); scheduleRetry(); break; }
                    if (claimed.status !== 'claimed') continue;
                    const message = new StandardMessage(claimed.message);
                    let resultCode = 'COMMAND_HANDLED';
                    let resultStatus = 'completed';
                    try { await dispatch(message, item.idempotencyKey); }
                    catch (error) {
                        resultStatus = 'uncertain';
                        resultCode = 'COMMAND_DISPATCH_FAILED';
                        report(error, item.idempotencyKey);
                    }
                    try {
                        const result = await archive.finishTelegramAdminInbox({ accountId: item.accountId,
                            updateId: item.updateId, status: resultStatus, resultCode });
                        if (result.status !== resultStatus) {
                            report(Object.assign(new Error('TELEGRAM_ADMIN_INBOX_ACK_UNCERTAIN'),
                                { code: 'TELEGRAM_ADMIN_INBOX_ACK_UNCERTAIN' }), item.idempotencyKey);
                            scheduleRetry();
                        } else progressed++;
                    } catch (error) {
                        // The effect may have run. Leave `processing`; restart will
                        // turn it into an explicit uncertain result, never replay it.
                        report(error, item.idempotencyKey);
                        scheduleRetry();
                    }
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

module.exports = { createTelegramAdminInboxPump };
