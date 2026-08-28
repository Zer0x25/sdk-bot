/**
 * 🛡️ CATEGORÍA 2: SEGURIDAD Y LISTAS — PERMITIDOS Y BLOQUEADOS (/ignorar /permitir /quitar /listas)
 */
const { getContactsDB } = require('../../services/db');
const { setNumberState, ignoreAllAgendaContacts } = require('../../services/stateService');
const { resolveTarget, syntaxError, getGlobalMode, summarizeListCounts } = require('../commandHelpers');

function runIgnorar({ queryParam }) {
    if (!queryParam) return resolveTarget(null, 'ignorar').error;

    if (queryParam.toLowerCase() === 'agenda') {
        const res = ignoreAllAgendaContacts();
        return `🚫 *Ignorado Masivo de Agenda Ejecutado:*\nSe agregaron *${res.addedCount}* contactos de tu libreta a la Lista de Ignorados.\nTotal ignorados en lista: *${res.totalIgnored}*.`;
    }

    if (queryParam === '*' || queryParam.toLowerCase() === 'all') {
        const res = setNumberState('*', 'ignored');
        return `🔒 *Modo Global Cambiado:* ${res.message}.\nLa IA estará en *Modo Estricto (Whitelist)*. Solo responderá a los números explícitamente permitidos.`;
    }

    const t = resolveTarget(queryParam, 'ignorar');
    if (!t.ok) return t.error;
    const res = setNumberState(t.targetId, 'ignored');
    if (res.success) {
        return `🚫 ID/Número \`${res.target}\` asignado a la *Lista de Ignorados* (reubicado de permitidos si existía).`;
    }
    return syntaxError('ignorar', `No pude ignorar *${t.targetId}*.`);
}

function runPermitir({ queryParam }) {
    if (!queryParam) return resolveTarget(null, 'permitir').error;

    if (queryParam === '*' || queryParam.toLowerCase() === 'all') {
        const res = setNumberState('*', 'allowed');
        return `🌐 *Modo Global Cambiado:* ${res.message}.\nLa IA responderá a todos los clientes por defecto (excepto los que estén en la Lista de Ignorados).`;
    }

    const t = resolveTarget(queryParam, 'permitir');
    if (!t.ok) return t.error;
    const res = setNumberState(t.targetId, 'allowed');
    if (res.success) {
        return `✅ ID/Número \`${res.target}\` asignado a la *Lista de Permitidos* (reubicado de ignorados si existía).`;
    }
    return syntaxError('permitir', `No pude permitir *${t.targetId}*.`);
}

function runQuitar({ queryParam }) {
    if (!queryParam) return resolveTarget(null, 'quitar').error;

    if (queryParam === '*') {
        setNumberState('*', 'neutral');
        return `🔄 Comodín (\`*\`) removido de ambas listas. Transición a estado neutro.`;
    }

    const t = resolveTarget(queryParam, 'quitar');
    if (!t.ok) return t.error;
    const res = setNumberState(t.targetId, 'neutral');
    if (res.success) {
        return `🔄 ID/Número \`${res.target}\` removido de ambas listas. Regresado a *Estado 0 (Neutro)*.`;
    }
    return syntaxError('quitar', `No pude quitar *${t.targetId}* de las listas.`);
}

function runListas() {
    const dbListas = getContactsDB();

    const globalMode = getGlobalMode();
    let modeStr = "🌐 *Permitir a Todos por Defecto* (Atención Libre)";
    if (globalMode === 'ignored_all') modeStr = "🔒 *Ignorar a Todos por Defecto* (Modo Estricto / Whitelist)";

    const { ignored, allowed } = summarizeListCounts(dbListas);
    const listIgnored = Object.values(dbListas).filter(c => c.estado === 'ignorado');
    const listAllowed = Object.values(dbListas).filter(c => c.estado === 'permitido');

    const ignoredText = listIgnored.length ? listIgnored.map(c => {
        return `• \`${c.phone || c.lid}\`${c.savedName ? ` (${c.savedName})` : ''}`;
    }).join('\n') : "Ninguno";

    const allowedText = listAllowed.length ? listAllowed.map(c => {
        return `• \`${c.phone || c.lid}\`${c.savedName ? ` (${c.savedName})` : ''}`;
    }).join('\n') : "Ninguno";

    return `📋 *ESTADO DE LISTAS DE ATENCIÓN*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ **Modo Global:** ${modeStr}\n\n` +
        `🚫 **Lista de Ignorados (${ignored}):**\n${ignoredText}\n\n` +
        `✅ **Lista de Permitidos Explícitos (${allowed}):**\n${allowedText}\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *Usa \`/i <num|agenda|*>\`, \`/p <num|*>\` o \`/q <num|*>\`.*`;
}

module.exports = [
    { aliases: ['/ignorar', '/i', '/b', '/ignore'], run: runIgnorar },
    { aliases: ['/permitir', '/p', '/allow'], run: runPermitir },
    { aliases: ['/quitar', '/q', '/remove', '/rem'], run: runQuitar },
    { aliases: ['/listas', '/lista', '/l', '/list'], run: runListas }
];
