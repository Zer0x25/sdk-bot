// @ts-check
// Cola de procesamiento de la agenda (sync de contactos) por chunks que
// CEDEN el event loop entre lote y lote. La sync inicial de WhatsApp al
// vincular puede entregar MILES de contactos (contacts.upsert + contactos
// de messaging-history.set); procesarlos de una sola vez en un tick
// satura el event loop, el socket no responde los pings y WhatsApp corta
// la conexión — interrumpiendo la agenda a medio descargar. Y esa sync
// completa SOLO ocurre la primera vez que se vincula (no hay re-sync).
const { cat, safeErrorLabel } = require('./logger');

const logError = cat('ERROR');

const CHUNK_SIZE = 100; // contactos por tick (bajado de 300: la sync inicial
                        // puede entregar miles; 100 mantiene el event loop libre
                        // para que Baileys responda los pings y no corte la sync).
/** @type {any[][]} cola FIFO de lotes pendientes */
let queue = [];
let running = false;
/** @type {((chunk: any[]) => void) | null} procesador de cada chunk */
let processor = null;

/** @param {(chunk: any[]) => void} fn */
function setProcessor(fn) {
    processor = fn;
}

/** @param {any[]} items */
function push(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    queue.push(items);
    if (!running) {
        running = true;
        setImmediate(tick);
    }
}

function tick() {
    if (queue.length === 0) {
        running = false;
        return;
    }
    const batch = queue[0];
    const chunk = batch.splice(0, CHUNK_SIZE);
    if (batch.length === 0) queue.shift();
    if (processor) {
        try {
            processor(chunk);
        } catch (e) {
            logError.error(`📇 [AGENDA] Error procesando lote (${safeErrorLabel(e)}).`);
        }
    }
    setImmediate(tick);
}

/** Cantidad total de contactos aún en cola (observabilidad). @returns {number} */
function pendingCount() {
    return queue.reduce((acc, batch) => acc + batch.length, 0);
}

/** Solo tests: vaciar cola y estado (módulo compartido por archivo de test). */
function resetForTests() {
    queue = [];
    running = false;
}

module.exports = { setProcessor, push, pendingCount, resetForTests, CHUNK_SIZE };
