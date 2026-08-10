// @ts-check
/**
 * ⏱️ Rate limiter con ventana deslizante por clave (Fase 2, S2).
 * createRateLimiter(max, windowMs) → fn(key) devuelve true si EXCEDE el límite.
 * La tabla se poda cuando crece (memoria contenida; los 0 hits expiran solos).
 */
function createRateLimiter(maxCalls, windowMs) {
    const hits = new Map(); // key -> [timestamps]

    function prune(now) {
        if (hits.size <= 10000) return;
        for (const [key, arr] of hits) {
            const fresh = arr.filter(t => now - t < windowMs);
            if (fresh.length === 0) hits.delete(key);
            else hits.set(key, fresh);
        }
    }

    return function isLimited(key) {
        const now = Date.now();
        prune(now);
        const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
        if (arr.length >= maxCalls) {
            hits.set(key, arr);
            return true;
        }
        arr.push(now);
        hits.set(key, arr);
        return false;
    };
}

module.exports = { createRateLimiter };
