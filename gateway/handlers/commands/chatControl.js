/**
 * 🤖 CATEGORÍA 1: CONTROL DE CHAT E IA POR CLIENTE (/ia /humano /limpiar)
 */
const { getContactsDB } = require('../../services/db');
const { clearAIMemory } = require('../../services/brainService');
const { setNumberState } = require('../../services/stateService');
const { parsePhoneOrLid, isValidTargetId, usageOf, syntaxError, sanitizeMarkdown } = require('../commandHelpers');

function runIa({ queryParam }) {
    if (!queryParam) return usageOf('ia');
    const targetId = parsePhoneOrLid(queryParam);
    if (!isValidTargetId(targetId)) {
        return syntaxError('ia', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
    }
    const res = setNumberState(targetId, 'neutral');
    if (res.success) {
        return `🤖 *IA Reactivada para el cliente:*\n\`${res.target}\`. (Pasó a estado: ${res.state})`;
    }
    return syntaxError('ia', `No pude reactivar la IA para *${sanitizeMarkdown(queryParam)}*.`);
}

function runHumano({ queryParam }) {
    if (!queryParam) return usageOf('humano');
    const targetId = parsePhoneOrLid(queryParam);
    if (!isValidTargetId(targetId)) {
        return syntaxError('humano', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
    }
    const res = setNumberState(targetId, 'handoff');
    if (res.success) {
        return `🤝 *Atención Humana activada para:*\n\`${res.target}\`.\nLa IA permanecerá en silencio durante 24 horas (volverá a estado neutro automáticamente, o reactiva antes con \`/ia ${res.target}\`).`;
    }
    return syntaxError('humano', `No pude activar atención humana para *${sanitizeMarkdown(queryParam)}*.`);
}

async function runLimpiar({ queryParam }) {
    if (!queryParam) return usageOf('limpiar');
    const targetId = parsePhoneOrLid(queryParam);
    if (!isValidTargetId(targetId)) {
        return syntaxError('limpiar', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
    }
    const db = getContactsDB();
    const record = Object.values(db).find(c => (c.phone && c.phone.includes(targetId)) || (c.lid && c.lid.includes(targetId)));
    
    const targetJid = record ? (record.phone ? `${record.phone}@s.whatsapp.net` : `${record.lid}@lid`) : (targetId.length < 15 ? `${targetId}@s.whatsapp.net` : `${targetId}@lid`);
    const success = await clearAIMemory(targetJid);
    
    if (success) {
        return `🧹 *Memoria de IA borrada con éxito para:*\n${record ? (record.savedName || record.pushName || targetId) : targetId}. El historial conversacional ha sido reiniciado.`;
    }
    return syntaxError('limpiar', `No pude limpiar la memoria para *${sanitizeMarkdown(queryParam)}* (¿existe el contacto?).`);
}

module.exports = [
    { aliases: ['/ia', '/a', '/auto', '/unpause'], run: runIa },
    { aliases: ['/humano', '/h', '/handoff'], run: runHumano },
    { aliases: ['/limpiar', '/c', '/reset'], run: runLimpiar }
];
