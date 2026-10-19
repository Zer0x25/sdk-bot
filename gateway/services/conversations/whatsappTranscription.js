/* global AbortController */
// Bounded enrichment, separate from the capture FIFO. No transport or SQL here.
const { assertValid } = require('@sdk-bot/contracts');

async function abortable(operation, signal) {
    signal.throwIfAborted();
    let listener;
    const aborted = new Promise((_, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', listener); }
}

function createWhatsappTranscription(archive, report, { limit = 4, timeoutMs = 150000 } = {}) {
    const jobs = new Set();
    let closed = false, failed = false;
    async function update(input) {
        try { return await archive.updateTranscription(input); }
        catch (error) {
            // Never retry an uncertain write, including completed/failed.
            failed = true;
            report(error.code || 'WA_TRANSCRIPTION_ARCHIVE_FAILED');
            throw error;
        }
    }
    async function skip(messageId) {
        if (closed || failed || !messageId) return;
        await update({ messageId, expectedStatus: 'not_requested', status: 'failed' });
    }
    function run(messageId, execute, isCurrent, onCompleted) {
        if (closed || failed) return Promise.resolve();
        if (jobs.size >= limit) {
            report('WA_STT_SATURATED');
            return skip(messageId);
        }
        const controller = new AbortController();
        const job = { controller, workSettled: true, finished: false, outcome: null };
        jobs.add(job);
        const release = () => { if (job.finished && job.workSettled) jobs.delete(job); };
        const timer = setTimeout(() => controller.abort(new Error('STT deadline')), timeoutMs);
        job.outcome = Promise.resolve().then(async () => {
            // Self-chat administration deliberately has no customer archive ID;
            // it shares cancellation/capacity but never creates archive records.
            const pending = messageId ? await update({ messageId, expectedStatus: 'not_requested', status: 'pending' }) : { status: 'updated' };
            if (pending.status !== 'updated') return;
            let transcript;
            try {
                if (!isCurrent()) controller.abort(new Error('Socket replaced'));
                controller.signal.throwIfAborted();
                job.workSettled = false;
                const work = Promise.resolve().then(() => execute(controller.signal));
                // A provider/mock ignoring AbortSignal keeps its slot until it
                // really settles. Deadlines cannot create unlimited orphan work.
                void work.then(() => { job.workSettled = true; release(); }, () => { job.workSettled = true; release(); });
                transcript = await abortable(work, controller.signal);
                assertValid('StoredText', transcript);
                if (!transcript.trim() || !isCurrent()) throw new Error('Invalid or stale transcript');
                controller.signal.throwIfAborted();
            } catch {
                if (messageId) await update({ messageId, expectedStatus: 'pending', status: 'failed' });
                return;
            }
            const completed = messageId ? await update({ messageId, expectedStatus: 'pending', status: 'completed', transcript }) : { status: 'updated' };
            if (completed.status !== 'updated' || controller.signal.aborted || !isCurrent()) return;
            const conversation = messageId ? await archive.conversation(completed.message.conversationId) : null;
            if (!conversation?.requires_review && isCurrent() && !controller.signal.aborted) onCompleted(transcript);
        }).finally(() => { clearTimeout(timer); job.finished = true; release(); });
        return job.outcome;
    }
    function cancel() { for (const job of jobs) job.controller.abort(new Error('Socket replaced')); }
    return { run, skip, cancel,
        idle: () => Promise.allSettled([...jobs].map(job => job.outcome)),
        queue: () => ({ active: jobs.size, failed }),
        async close() { closed = true; cancel(); await Promise.allSettled([...jobs].map(job => job.outcome)); }
    };
}

module.exports = { createWhatsappTranscription };
