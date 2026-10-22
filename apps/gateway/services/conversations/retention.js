/** Purge before transport admission, then daily. SQL batches stay bounded and
 * yield between calls. This is archive retention; F5 owns derived context. */
async function startRetention(archive, onError, attachmentStore = null) {
    let stopped = false, timer, running;
    function sweep() {
        if (running) return running;
        running = (async () => {
            const now = new Date().toISOString();
            do {
                const result = await archive.purge({ now, limit: 500 });
                let attachmentsRemaining = false;
                if (attachmentStore) {
                    let attachmentBatch;
                    do {
                        attachmentBatch = await attachmentStore.sweepExpired({ limit: 500 });
                        attachmentsRemaining = attachmentBatch.remaining;
                        if (attachmentsRemaining && !stopped) await new Promise(resolve => setImmediate(resolve));
                    } while (attachmentsRemaining && !stopped);
                }
                if ((!result.remaining && !attachmentsRemaining) || stopped) break;
                await new Promise(resolve => setImmediate(resolve));
            } while (!stopped);
        })().finally(() => { running = null; });
        return running;
    }
    await sweep();
    timer = setInterval(() => { void sweep().catch(onError); }, 24 * 60 * 60 * 1000);
    timer.unref();
    return { async close() { stopped = true; clearInterval(timer); await running?.catch(() => {}); } };
}
module.exports = { startRetention };
