/**
 * 📢 CATEGORÍA 5: BROADCASTS Y MENSAJES PROGRAMADOS
 * (/broadcast /programar /broadcast cancelar /broadcast estado)
 */
const {
    cancelPending,
    buildStatusText,
    getEligibleContacts,
    parseScheduleTime,
    requestConfirmation,
    hasPendingConfirmation,
    isEnabled,
    setEnabled,
    DAILY_LIMIT
} = require('../../services/broadcastService');

function runBroadcast({ queryParam }) {
    if (!queryParam) {
        return `⚠️ *Uso:* \`/broadcast <texto>\` — envía un mensaje a todos los contactos de la agenda (excepto ignorados/handoff).\n` +
            `🔒 Límite anti-ban: ${DAILY_LIMIT} mensaje(s)/día por contacto.\n` +
            `🔴 *Estado actual:* ${isEnabled() ? '✅ ACTIVADO' : 'DESACTIVADO'} — activa con \`/broadcast on\`.\n\n` +
            `Ejemplos:\n• \`/broadcast on\` — activar broadcasts\n• \`/broadcast Hola, ¿cómo estás?\`\n• \`/programar 20:00 Recordatorio de mañana\`\n• \`/broadcast cancelar\` — cancela lo pendiente\n• \`/broadcast estado\` — ver pendientes y envíos de hoy`;
    }

    if (queryParam === 'on' || queryParam === 'activar' || queryParam === 'activado') {
        setEnabled(true);
        return '✅ *Broadcasts ACTIVADOS.* Puedes enviar con `/broadcast <texto>` o `/programar <HH:MM> <texto>`.';
    }

    if (queryParam === 'off' || queryParam === 'apagar' || queryParam === 'desactivar' || queryParam === 'desactivado') {
        const cancelled = cancelPending();
        setEnabled(false);
        return `🔴 *Broadcasts DESACTIVADOS.* ${cancelled > 0 ? `${cancelled} broadcast(s) pendiente(s) cancelado(s).` : 'No había broadcasts pendientes.'}`;
    }

    if (queryParam === 'cancelar' || queryParam === 'cancel' || queryParam === 'cancelar todos') {
        const cancelled = cancelPending();
        return cancelled > 0
            ? `✖️ *Cancelados ${cancelled} broadcast(s)* pendientes o en curso.`
            : 'ℹ️ No hay broadcasts pendientes o en curso.';
    }

    if (queryParam === 'estado' || queryParam === 'status' || queryParam === 'info') {
        return buildStatusText();
    }

    if (!isEnabled()) {
        return '🔴 *Broadcasts desactivados.* Actívalos primero con `/broadcast on`.';
    }

    if (hasPendingConfirmation()) {
        return '⏳ Ya hay un broadcast esperando confirmación. Responde *si* para confirmar o *cancelar* para anularlo.';
    }

    const eligible = getEligibleContacts();
    if (eligible.length === 0) {
        return 'ℹ️ No hay contactos aptos para un broadcast (agenda vacía o todos ignorados/handoff).';
    }

    requestConfirmation(queryParam, null);
    return `📢 *¿Confirmas el broadcast?*\n\n💬 *Texto:* "${queryParam.slice(0, 200)}"\n👥 *Se enviará a:* ${eligible.length} contactos de la agenda\n🔒 *Máximo:* ${DAILY_LIMIT} mensaje(s)/día por contacto\n\n_Responde_ *si* _para confirmar o_ *cancelar* _para anular. Expira en 1 minuto._`;
}

function runProgramar({ queryParam }) {
    if (!isEnabled()) {
        return '🔴 *Broadcasts desactivados.* Actívalos primero con `/broadcast on`.';
    }

    const match = /^(\d{1,2}:\d{2})\s+(.+)$/s.exec(queryParam);
    if (!match) {
        return `⚠️ *Uso:* \`/programar <HH:MM> <texto>\` — programa un broadcast para una hora.\n\n` +
            `Ejemplo:\n• \`/programar 20:30 Recordatorio de la reunión de mañana\``;
    }

    const scheduledAt = parseScheduleTime(match[1]);
    if (!scheduledAt) {
        return '⚠️ Hora inválida. Usa formato *HH:MM* (ej: `20:30`).';
    }

    if (hasPendingConfirmation()) {
        return '⏳ Ya hay un broadcast esperando confirmación. Responde *si* o *cancelar*.';
    }

    const eligible = getEligibleContacts();
    if (eligible.length === 0) {
        return 'ℹ️ No hay contactos aptos para un broadcast (agenda vacía o todos ignorados/handoff).';
    }

    requestConfirmation(match[2], scheduledAt);
    const when = new Date(scheduledAt).toLocaleString('es-CL');
    return `📅 *¿Confirmas el broadcast programado?*\n\n💬 *Texto:* "${match[2].slice(0, 200)}"\n🕐 *Fecha/hora:* ${when}\n👥 *Se enviará a:* ${eligible.length} contactos\n\n_Responde_ *si* _para confirmar o_ *cancelar* _para anular._`;
}

module.exports = [
    { aliases: ['/broadcast', '/difundir', '/masivo', '/bd'], run: runBroadcast },
    { aliases: ['/programar', '/agendar', '/schedule'], run: runProgramar }
];
