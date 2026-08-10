// @ts-check
const { cat } = require('./logger');

const log = cat('AI');

/**
 * 🎯 Pool de concurrencia global (B6/R7).
 * Máximo MAX_CONCURRENCY llamadas a la IA a la vez; el resto espera en cola FIFO.
 * Evita saturar a los proveedores (Groq/OpenRouter/Gemini) con clientes simultáneos.
 */

const MAX_CONCURRENCY = 3;
let active = 0;
const queue = [];

function enqueueAI(task) {
    return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        pump();
    });
}

function pump() {
    while (active < MAX_CONCURRENCY && queue.length > 0) {
        const { task, resolve, reject } = queue.shift();
        active += 1;
        log.info(`🎯 [POOL AI] ${active}/${MAX_CONCURRENCY} llamadas activas | ${queue.length} en cola.`);
        task()
            .then(resolve, reject)
            .finally(() => {
                active -= 1;
                pump();
            });
    }
}

function poolStats() {
    return { active, queued: queue.length, max: MAX_CONCURRENCY };
}

module.exports = { enqueueAI, poolStats };
