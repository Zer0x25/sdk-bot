// @ts-check
/**
 * 🧨 F7: Reset limpio desde el self-chat de WhatsApp (`/reset-clean`).
 * Mismo estándar que el panel web: DOBLE confirmación + timers de lectura
 * y escritura de la palabra mágica:
 *   1. El admin envía /reset-clean → recibe el aviso completo (qué se borra).
 *   2. Timer de LECTURA (`READ_MS`, default 10s): la palabra NO se acepta
 *      antes — fuerza a leer el aviso antes de tipear.
 *   3. Timer de ESCRITURA (`TTL_MS`, default 60s desde el aviso): debe
 *      escribir `BORRAR-TODO` antes de que venza, o se cancela solo.
 *   4. "cancelar"/"no" en cualquier momento cancela; cualquier otro texto
 *      sigue normal (va a la IA del self-chat) sin cancelar el timer.
 * Intercepción en messageHandler.js (mismo patrón que broadcastService):
 * `tryCleanConfirm` se consume ANTES de la IA en self-chat.
 * Al confirmar: performFactoryReset + reinicio del gateway (y del brain si
 * es service de systemd).
 */
const { prepareFactoryReset, performFactoryReset, setWiping, isWiping, restartGatewayProcess, restartBrainIfSystemd } = require('./factoryReset');
const { cat } = require('./logger');

const log = cat('CORE');
const logError = cat('ERROR');

/** Palabra mágica — igual en web (`BORRAR-TODO`), CLI y self-chat. */
const MAGIC_WORD = 'BORRAR-TODO';
/** Timer de lectura: mínimo de espera antes de aceptar la palabra. */
const READ_MS = Number(process.env.SDK_RESET_CLEAN_READ_MS || 10_000);
/** Timer de escritura: ventana total para confirmar (desde el aviso). */
const TTL_MS = Number(process.env.SDK_RESET_CLEAN_TTL_MS || 60_000);

/**
 * @typedef {Object} CleanResetPending
 * @property {string} remoteJid
 * @property {any} sock
 * @property {number} minAcceptAt — no aceptar la palabra antes (lectura)
 * @property {number} expiresAt — ventana de escritura
 * @property {NodeJS.Timeout} timer — aviso de expiración
 */

/** @type {CleanResetPending|null} */
let pending = null;
let executed = false; // ya confirmado: el proceso está por reiniciarse

function clearPending() {
    if (pending && pending.timer) clearTimeout(pending.timer);
    pending = null;
}

/** ¿Hay un pedido pendiente y vigente? (limpia si expiró) */
function hasPendingCleanReset() {
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
        clearPending();
        return false;
    }
    return true;
}

/**
 * Devuelve el texto del aviso (lo envía el dispatcher de comandos en
 * chunks) y deja el pedido pendiente con sus timers.
 * @param {any} sock
 * @param {string} remoteJid
 * @returns {string}
 */
function requestCleanReset(sock, remoteJid) {
    if (executed || isWiping()) {
        return '🧨 *Reset limpio ya en curso* — el gateway se está reiniciando. Espera a que la página/chat vuelva en ~15s.';
    }
    if (hasPendingCleanReset() && pending) {
        const s = Math.ceil((pending.expiresAt - Date.now()) / 1000);
        return `⏳ *Ya hay un reset limpio pendiente* (${s}s para vencer). Escribe la palabra de confirmación o *cancelar*.`;
    }

    /** @type {NodeJS.Timeout} */
    const timer = setTimeout(async () => {
        if (!pending) return;
        const { sock: s, remoteJid: jid } = pending;
        clearPending();
        try { await s.sendMessage(jid, { text: '⏰ *Tiempo agotado* — el reset limpio fue cancelado. Envía /reset-clean de nuevo si quieres intentarlo.' }); } catch (e) { /* socket caído */ }
    }, TTL_MS);
    if (timer.unref) timer.unref();

    pending = { remoteJid, sock, minAcceptAt: Date.now() + READ_MS, expiresAt: Date.now() + TTL_MS, timer };

    log.warn(`🧨 [RESET-CLEAN] Pedido de reset limpio de ${remoteJid} — ventana de confirmación activa (lectura ${Math.round(READ_MS / 1000)}s + escritura ${Math.round(TTL_MS / 1000)}s).`);
    return `🧨 *RESET LIMPIO (FÁBRICA)*\n\nSe borrará *TODO* el estado de runtime:\n• Sesión de WhatsApp actual\n• Agenda de contactos (*contacts_db.json*)\n• Configuración (estados, perfil global)\n• Broadcasts programados y cola de mensajes\n• Archivo de conversaciones (SQLite)\n• Memoria del brain (*memory.db*)\n• Logs de gateway y brain\n\n✅ Los *perfiles SOUL* se conservan.\n\n⚠️ La app quedará *como recién instalada*: habrá que volver a vincular con QR o con número (default *ignored_all*).\n\n⏳ *Doble confirmación con timers:*\n1. *Lee* este aviso (la palabra no se acepta antes de ${Math.round(READ_MS / 1000)}s).\n2. Escribe ${'`' + MAGIC_WORD + '`'} antes de ${Math.round(TTL_MS / 1000)}s.\n\n✖️ Para cancelar: escribe *cancelar*.`;
}

/**
 * Intercepta la respuesta del admin a un reset limpio pendiente.
 * Devuelve true si consumió el mensaje (palabra/cancelar/espera).
 * @param {string} text
 * @param {any} activeSock
 * @param {string} remoteJid
 * @returns {Promise<boolean>}
 */
async function tryCleanConfirm(text, activeSock, remoteJid) {
    if (executed) return true; // ya confirmado: consumir todo hasta morir
    if (!hasPendingCleanReset() || !pending) return false;
    const norm = String(text).trim().toLowerCase();

    if (norm === 'cancelar' || norm === 'cancel' || norm === 'no') {
        clearPending();
        await activeSock.sendMessage(remoteJid, { text: '✖️ *Reset limpio cancelado.* No se borró nada.' });
        log.warn('🧨 [RESET-CLEAN] Cancelado por el admin.');
        return true;
    }

    if (norm !== MAGIC_WORD.toLowerCase()) return false; // va a la IA, sigue pendiente

    // Timer de LECTURA: la palabra se rechaza y el pedido sigue vigente
    if (Date.now() < pending.minAcceptAt) {
        const s = Math.ceil((pending.minAcceptAt - Date.now()) / 1000);
        await activeSock.sendMessage(remoteJid, { text: `⏳ *Timer de lectura:* lee el aviso completo antes de confirmar. Espera ${s}s e intenta de nuevo (tienes ${Math.ceil((pending.expiresAt - Date.now()) / 1000)}s en total).` });
        return true;
    }

    // Confirmado: ejecutar el reset limpio
    clearPending();
    setWiping(true);
    log.warn('🧨 [RESET-CLEAN] Confirmado por el admin. Ejecutando reset limpio...');
    try { await prepareFactoryReset(); }
    catch {
        setWiping(false);
        await activeSock.sendMessage(remoteJid, { text: '🔴 Reset limpio abortado: no se pudo cerrar el archivo de conversaciones.' });
        return true;
    }
    const report = performFactoryReset();
    if (report.errors.length > 0) {
        setWiping(false);
        logError.error(`🧨 [RESET-CLEAN] ABORTADO: ${report.errors[0]}`);
        await activeSock.sendMessage(remoteJid, { text: `🔴 *Reset limpio abortado:* no se pudo borrar ${report.errors[0]}` });
        return true;
    }
    executed = true;
    const brainNote = restartBrainIfSystemd()
        ? ' y brain'
        : '.\n👋 Si el brain corre manual, reinícialo para limpiar su memoria en RAM';
    await activeSock.sendMessage(remoteJid, {
        text: `🧨 *Reset limpio ejecutado:* ${report.deleted.length} elementos borrados (${report.missing.length} no existían).\n\n♻️ Reiniciando gateway${brainNote}… La app queda como recién instalada: vincula de nuevo con QR o con número.`
    });
    restartGatewayProcess();
    return true;
}

/** Solo tests: limpia estado pendiente y flags (módulo compartido). */
function resetForTests() {
    clearPending();
    executed = false;
    setWiping(false);
}

module.exports = { requestCleanReset, tryCleanConfirm, hasPendingCleanReset, resetForTests, MAGIC_WORD };