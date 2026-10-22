/**
 * 🤖 CATEGORÍA 1: CONTROL DE CHAT E IA POR CLIENTE (/ia /humano /limpiar)
 */
const { getContactsDB } = require('../../services/db');
const { resolveContactKeyByDigits } = require('../../services/contactsRepository');
const { clearAIMemory } = require('../../services/brainService');
const { setNumberState, releaseControl, getControlService } = require('../../services/stateService');
const { resolveTarget, syntaxError, whatsappTargetContext } = require('../commandHelpers');

async function runIa({ queryParam, targetAdapter }) {
    const t = resolveTarget(queryParam, 'ia');
    if (!t.ok) return t.error;
    const res = await releaseControl(t.targetId, whatsappTargetContext(targetAdapter));
    if (res.success) {
        return `🤖 *IA Reactivada para el cliente:*\n\`${res.target}\`. (Pasó a estado: ${res.state})`;
    }
    return syntaxError('ia', `No pude reactivar la IA para *${t.targetId}*: ${res.message || 'conflicto de control'}.`);
}

async function runHumano({ queryParam, targetAdapter }) {
    const t = resolveTarget(queryParam, 'humano');
    if (!t.ok) return t.error;
    const res = await setNumberState(t.targetId, 'handoff', whatsappTargetContext(targetAdapter));
    if (!res.success) return syntaxError('humano', `No pude activar atención humana para *${t.targetId}*: ${res.message || 'conflicto de control'}.`);
    if (res.pending) {
        return `🤝 *Toma de control pendiente para:* \`${res.target}\`. La salida que ya comenzó está terminando; consulta la operación en el panel.`;
    }
    return `🤝 *Atención Humana activada para:*\n\`${res.target}\`. La IA seguirá en silencio hasta que uses \`/ia ${res.target}\`.`;
}

async function runLimpiar({ queryParam, targetAdapter }) {
    const t = resolveTarget(queryParam, 'limpiar');
    if (!t.ok) return t.error;
    const targetId = t.targetId;
    const db = getContactsDB();
    const resolution = resolveContactKeyByDigits(targetId);
    if (resolution.status === 'partial' || resolution.status === 'ambiguous') {
        return syntaxError('limpiar', `Indica el número o LID completo; *${targetId}* no identifica un contacto único.`);
    }
    const record = resolution.status === 'found' ? db[resolution.key] : null;

    const targetJid = record ? (record.phone ? `${record.phone}@s.whatsapp.net` : `${record.lid}@lid`) : (targetId.length < 15 ? `${targetId}@s.whatsapp.net` : `${targetId}@lid`);
    const controlService = getControlService();
    const context = whatsappTargetContext(targetAdapter);
    if (controlService && await controlService.isActive()) {
        try {
            await controlService.clearContextForLegacyTarget({ targetId,
                channel: context.channel, accountId: context.accountId });
            return `🧹 *Contexto de IA reiniciado para:*\n${record ? (record.savedName || record.pushName || targetId) : targetId}. El archivo conversacional se conserva; la IA usará solo los mensajes posteriores a este punto.`;
        } catch (error) {
            return syntaxError('limpiar', `No pude invalidar el contexto para *${targetId}*: ${error?.code || error?.message || 'conflicto de control'}.`);
        }
    }
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
