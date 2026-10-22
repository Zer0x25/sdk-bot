/** Purge before transport admission, then daily. SQL batches stay bounded and
 * yield between calls. This is archive retention; F5 owns derived context. */
async function startRetention(archive, onError) {
    let stopped = false, timer, running;
    function sweep() {
        running = (async () => {
            const now = new Date().toISOString();
            do {
                const result = await archive.purge({ now, limit: 500 });
                if (!result.remaining || stopped) break;
                await new Promise(resolve => setImmediate(resolve));
            } while (!stopped);
        })();
        return running;
    }
    await sweep();
    timer = setInterval(() => { void sweep().catch(onError); }, 24 * 60 * 60 * 1000);
    timer.unref();
    return { async close() { stopped = true; clearInterval(timer); await running.catch(() => {}); } };
}
module.exports = { startRetention };
