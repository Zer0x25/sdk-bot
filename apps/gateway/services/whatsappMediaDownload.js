const { Agent } = require('undici');

/**
 * Baileys 7.0.0-rc14 forwards `dispatcher` to fetch but drops AbortSignal.
 * A private dispatcher per download gives the caller a physical abort boundary
 * without replacing process-wide fetch behavior.
 * @param {Function} downloadMediaMessage
 * @param {() => {close: () => Promise<void>, destroy: (error?: Error) => Promise<void>}} [createAgent]
 */
function createAbortableMediaDownload(downloadMediaMessage, createAgent = () => new Agent({ connections: 1 })) {
    if (typeof downloadMediaMessage !== 'function') throw new TypeError('DOWNLOAD_FUNCTION_REQUIRED');
    return async function download(message, type, options = {}, context) {
        const signal = options?.options?.signal;
        signal?.throwIfAborted();
        const agent = createAgent();
        let stream = null;
        let settled = false;
        let disposal = null;
        const dispose = error => {
            if (disposal) return disposal;
            settled = true;
            signal?.removeEventListener('abort', abort);
            disposal = Promise.resolve(error ? agent.destroy(error) : agent.close()).catch(() => {});
            return disposal;
        };
        const abort = () => {
            const error = signal.reason instanceof Error ? signal.reason : new Error('WA_MEDIA_DOWNLOAD_ABORTED');
            stream?.destroy?.(error);
            void dispose(error);
        };
        signal?.addEventListener('abort', abort, { once: true });

        try {
            const result = await downloadMediaMessage(message, type, {
                ...options,
                options: { ...options.options, dispatcher: agent }
            }, context);
            if (signal?.aborted) {
                if (result && !Buffer.isBuffer(result) && typeof result.once === 'function') {
                    result.once('error', () => {});
                }
                result?.destroy?.(signal.reason);
                await dispose(signal.reason);
                signal.throwIfAborted();
            }
            if (type !== 'stream' || !result || Buffer.isBuffer(result) || typeof result.once !== 'function') {
                await dispose();
                return result;
            }

            stream = result;
            let ended = false;
            stream.once('end', () => { ended = true; void dispose(); });
            stream.once('error', error => { void dispose(error); });
            stream.once('close', () => {
                if (!ended && !stream.readableEnded) {
                    void dispose(signal?.reason || new Error('WA_MEDIA_STREAM_CLOSED'));
                } else void dispose();
            });
            return stream;
        } catch (error) {
            await dispose(error instanceof Error ? error : new Error('WA_MEDIA_DOWNLOAD_FAILED'));
            throw error;
        } finally {
            // `dispose` removes the signal listener on every terminal path. A
            // returned stream owns the dispatcher until end/error/close.
            if (settled) signal?.removeEventListener('abort', abort);
        }
    };
}

module.exports = { createAbortableMediaDownload };
