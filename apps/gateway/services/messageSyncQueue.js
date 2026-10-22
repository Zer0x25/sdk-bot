// @ts-check
// Cola de procesamiento del HISTORIAL de mensajes (sync inicial de WhatsApp)
// por chunks que CEDEN el event loop entre lote y lote.
//
// IGUAL que contactSyncQueue pero para mensajes: al vincular, Baileys entrega
// el historial completo de TODOS los chats en messaging-history.set (miles de
// mensajes). Procesarlos de una sola vez satura el event loop, el socket no
// responde los pings y WhatsApp corta la conexión — interrumpiendo la sync a
// medio descargar (por eso antes solo cargaban 59 contactos + 534 msgs).
// La sync completa SOLO ocurre al vincular (no hay re-sync), así que debe
// terminar entera.
const { cat, errMsg } = require('./logger');

const logError = cat('ERROR');

const CHUNK_SIZE = 100; // mensajes por tick (más conservador que la agenda:
                        // seedMessages hace Map.set + _enforceCaps por cada lote,
                        // y la sync inicial puede traer miles; 100 mantiene el
                        // event loop libre para responder los pings de Baileys).

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
            logError.error(`💬 [MSG-SYNC] Error procesando chunk de mensajes: ${errMsg(e)}`);
        }
    }
    setImmediate(tick);
}

/** Cantidad total de mensajes aún en cola (observabilidad). @returns {number} */
function pendingCount() {
    return queue.reduce((acc, batch) => acc + batch.length, 0);
}

/** Solo tests: vaciar cola y estado. */
function resetForTests() {
    queue = [];
    running = false;
    processor = null;
}

module.exports = { setProcessor, push, pendingCount, resetForTests, CHUNK_SIZE };
