/**
 * 🤖 CATEGORÍA 1: CONTROL DE CHAT E IA POR CLIENTE (/ia /humano /limpiar)
 */
const { getContactsDB } = require('../../services/db');
const { clearAIMemory } = require('../../services/brainService');
const { setNumberState } = require('../../services/stateService');
const { resolveTarget, getGlobalMode, syntaxError } = require('../commandHelpers');

function runIa({ queryParam }) {
    const t = resolveTarget(queryParam, 'ia');
    if (!t.ok) return t.error;
    const res = setNumberState(t.targetId, 'neutral');
    if (res.success) {
        return `🤖 *IA Reactivada para el cliente:*\n\`${res.target}\`. (Pasó a estado: ${res.state})`;
    }
    return syntaxError('ia', `No pude reactivar la IA para *${t.targetId}*.`);
}

function runHumano({ queryParam }) {
    const t = resolveTarget(queryParam, 'humano');
    if (!t.ok) return t.error;
    // Coherencia con el pipeline: en Modo Global estricto (ignored_all) el bot
    // no atiende clientes salvo whitelist, así que /humano tampoco aplica.
    if (getGlobalMode() === 'ignored_all') {
        return syntaxError('humano', 'El bot está en *Modo Global Estricto* (Ignorar a Todos). Reactívalo con `/permitir *` antes de pausar la IA por cliente.');
    }
    const res = setNumberState(t.targetId, 'handoff');
    if (res.success) {
        return `🤝 *Atención Humana activada para:*\n\`${res.target}\`.\nLa IA permanecerá en silencio durante 24 horas (volverá a estado neutro automáticamente, o reactiva antes con \`/ia ${res.target}\`).`;
    }
    return syntaxError('humano', `No pude activar atención humana para *${t.targetId}*.`);
}

async function runLimpiar({ queryParam }) {
    const t = resolveTarget(queryParam, 'limpiar');
    if (!t.ok) return t.error;
    const targetId = t.targetId;
    const db = getContactsDB();
    const record = Object.values(db).find(c => (c.phone && c.phone.includes(targetId)) || (c.lid && c.lid.includes(targetId)));

    const targetJid = record ? (record.phone ? `${record.phone}@s.whatsapp.net` : `${record.lid}@lid`) : (targetId.length < 15 ? `${targetId}@s.whatsapp.net` : `${targetId}@lid`);
    const success = await clearAIMemory(targetJid);

    if (success) {
        return `🧹 *Memoria de IA borrada con éxito para:*\n${record ? (record.savedName || record.pushName || targetId) : targetId}. El historial conversacional ha sido reiniciado.`;
    }
    return syntaxError('limpiar', `No pude limpiar la memoria para *${targetId}* (¿existe el contacto?).`);
}

module.exports = [
    { aliases: ['/ia', '/a', '/auto', '/unpause'], run: runIa },
    { aliases: ['/humano', '/h', '/handoff'], run: runHumano },
    { aliases: ['/limpiar', '/c', '/reset'], run: runLimpiar }
];
