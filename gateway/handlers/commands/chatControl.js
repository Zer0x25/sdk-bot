/**
 * 🤖 CATEGORÍA 1: CONTROL DE CHAT E IA POR CLIENTE (/ia /humano /limpiar)
 */
const { getContactsDB } = require('../../services/db');
const { clearAIMemory } = require('../../services/brainService');
const { setNumberState, releaseControl } = require('../../services/stateService');
const { resolveTarget, syntaxError } = require('../commandHelpers');

async function runIa({ queryParam, adapter }) {
    const t = resolveTarget(queryParam, 'ia');
    if (!t.ok) return t.error;
    const res = await releaseControl(t.targetId, { channel: adapter?.channel || 'whatsapp', accountId: adapter?.accountId || null });
    if (res.success) {
        return `🤖 *IA Reactivada para el cliente:*\n\`${res.target}\`. (Pasó a estado: ${res.state})`;
    }
    return syntaxError('ia', `No pude reactivar la IA para *${t.targetId}*: ${res.message || 'conflicto de control'}.`);
}

async function runHumano({ queryParam, adapter }) {
    const t = resolveTarget(queryParam, 'humano');
    if (!t.ok) return t.error;
    const res = await setNumberState(t.targetId, 'handoff', { channel: adapter?.channel || 'whatsapp', accountId: adapter?.accountId || null });
    if (!res.success) return syntaxError('humano', `No pude activar atención humana para *${t.targetId}*: ${res.message || 'conflicto de control'}.`);
    if (res.pending) {
        return `🤝 *Toma de control pendiente para:* \`${res.target}\`. La salida que ya comenzó está terminando; consulta la operación en el panel.`;
    }
    return `🤝 *Atención Humana activada para:*\n\`${res.target}\`. La IA seguirá en silencio hasta que uses \`/ia ${res.target}\`.`;
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
