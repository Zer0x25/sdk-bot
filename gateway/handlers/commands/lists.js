/**
 * 🛡️ CATEGORÍA 2: SEGURIDAD Y LISTAS — PERMITIDOS Y BLOQUEADOS (/ignorar /permitir /quitar /listas)
 */
const { state } = require('../../config');
const { getSettingsDB, getContactsDB } = require('../../services/db');
const { setNumberState, ignoreAllAgendaContacts } = require('../../services/stateService');
const { parsePhoneOrLid, isValidTargetId, usageOf, syntaxError, sanitizeMarkdown } = require('../commandHelpers');

function runIgnorar({ queryParam }) {
    if (!queryParam) return usageOf('ignorar');

    if (queryParam.toLowerCase() === 'agenda') {
        const res = ignoreAllAgendaContacts();
        return `🚫 *Ignorado Masivo de Agenda Ejecutado:*\nSe agregaron *${res.addedCount}* contactos de tu libreta a la Lista de Ignorados.\nTotal ignorados en lista: *${res.totalIgnored}*.`;
    }

    if (queryParam === '*' || queryParam.toLowerCase() === 'all') {
        const res = setNumberState('*', 'ignored');
        return `🔒 *Modo Global Cambiado:* ${res.message}.\nLa IA estará en *Modo Estricto (Whitelist)*. Solo responderá a los números explícitamente permitidos.`;
    }

    const targetId = parsePhoneOrLid(queryParam);
    if (!isValidTargetId(targetId)) {
        return syntaxError('ignorar', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
    }
    const res = setNumberState(targetId, 'ignored');
    if (res.success) {
        return `🚫 ID/Número \`${res.target}\` asignado a la *Lista de Ignorados* (reubicado de permitidos si existía).`;
    }
    return syntaxError('ignorar', `No pude ignorar *${sanitizeMarkdown(queryParam)}*.`);
}

function runPermitir({ queryParam }) {
    if (!queryParam) return usageOf('permitir');

    if (queryParam === '*' || queryParam.toLowerCase() === 'all') {
        const res = setNumberState('*', 'allowed');
        return `🌐 *Modo Global Cambiado:* ${res.message}.\nLa IA responderá a todos los clientes por defecto (excepto los que estén en la Lista de Ignorados).`;
    }

    const targetId = parsePhoneOrLid(queryParam);
    if (!isValidTargetId(targetId)) {
        return syntaxError('permitir', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
    }
    const res = setNumberState(targetId, 'allowed');
    if (res.success) {
        return `✅ ID/Número \`${res.target}\` asignado a la *Lista de Permitidos* (reubicado de ignorados si existía).`;
    }
    return syntaxError('permitir', `No pude permitir *${sanitizeMarkdown(queryParam)}*.`);
}

function runQuitar({ queryParam }) {
    if (!queryParam) return usageOf('quitar');

    if (queryParam === '*') {
        setNumberState('*', 'neutral');
        return `🔄 Comodín (\`*\`) removido de ambas listas. Transición a estado neutro.`;
    }

    const targetId = parsePhoneOrLid(queryParam);
    if (!isValidTargetId(targetId)) {
        return syntaxError('quitar', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
    }
    const res = setNumberState(targetId, 'neutral');
    if (res.success) {
        return `🔄 ID/Número \`${res.target}\` removido de ambas listas. Regresado a *Estado 0 (Neutro)*.`;
    }
    return syntaxError('quitar', `No pude quitar *${sanitizeMarkdown(queryParam)}* de las listas.`);
}

function runListas() {
    const dbListas = getContactsDB();
    const settings = getSettingsDB();

    const globalMode = state.GLOBAL_MODE || settings.globalMode || 'allowed_all';
    let modeStr = "🌐 *Permitir a Todos por Defecto* (Atención Libre)";
    if (globalMode === 'ignored_all') modeStr = "🔒 *Ignorar a Todos por Defecto* (Modo Estricto / Whitelist)";

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
        `🚫 **Lista de Ignorados (${listIgnored.length}):**\n${ignoredText}\n\n` +
        `✅ **Lista de Permitidos Explícitos (${listAllowed.length}):**\n${allowedText}\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *Usa \`/i <num|agenda|*>\`, \`/p <num|*>\` o \`/q <num|*>\`.*`;
}

module.exports = [
    { aliases: ['/ignorar', '/i', '/b', '/ignore'], run: runIgnorar },
    { aliases: ['/permitir', '/p', '/allow'], run: runPermitir },
    { aliases: ['/quitar', '/q', '/remove', '/rem'], run: runQuitar },
    { aliases: ['/listas', '/lista', '/l', '/list'], run: runListas }
];
