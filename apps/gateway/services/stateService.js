// @ts-check
const { state } = require('../config');
const { getSettingsDB, saveSettingsDB, getContactsDB, saveContactsDB } = require('./db');
const { resolveContactKeyByDigits } = require('./contactsRepository');
const { getGlobalMode, summarizeListCounts } = require('../handlers/commandHelpers');

/** @param {unknown} accessState @returns {'ignored'|'allowed'|'neutral'|null} */
function normalizeAccessState(accessState) {
    if (accessState === 'ignored' || accessState === 'ignorado') return 'ignored';
    if (accessState === 'allowed' || accessState === 'permitido') return 'allowed';
    if (accessState === 'neutral' || accessState === 'neutro') return 'neutral';
    return null;
}

/** @param {unknown} accessState @param {string|undefined} [globalMode]
 * @param {any|null} [control] @param {any|null} [policy] @returns {string|null} */
function automationBlockReason(accessState, globalMode = getGlobalMode(), control = null, policy = null) {
    if (state.IS_BOT_PAUSED) return 'global_paused';
    if (policy?.requiresReview || control?.requiresReview) return 'control_review_required';
    if (control?.lifecycle && control.lifecycle !== 'open') return 'conversation_not_open';
    if (control?.automationMode && control.automationMode !== 'ai') return 'automation_not_ai';
    const normalizedState = normalizeAccessState(accessState);
    if (!normalizedState) return 'control_state_unknown';
    if (normalizedState === 'ignored') return 'contact_ignored';
    if (normalizedState === 'neutral' && globalMode === 'ignored_all') return 'global_ignored_all';
    return null;
}

/** @type {any} */
let controlService = null;
function setControlService(service) { controlService = service; }
function getControlService() { return controlService; }
function controlError(error) {
    const messages = {
        IDENTITY_AMBIGUOUS: 'La identidad tiene varias coincidencias; indica una cuenta exacta.',
        CONTROL_TARGET_NOT_FOUND: 'No se encontró una identidad exacta para ese contacto.',
        CONTROL_AUTHORITY_NOT_ACTIVE: 'El control SQLite aún no está activo.',
        CONTROL_VERSION_CONFLICT: 'El control cambió mientras se aplicaba la operación.',
        CONTROL_OWNER_CONFLICT: 'La conversación pertenece a otro operador.'
    };
    return messages[/** @type {any} */ (error)?.code] || 'No se pudo guardar el cambio de control.';
}

/**
 * 🔄 GESTIÓN DE ESTADOS EN CONTACTS_DB (ignorado ↔ permitido ↔ handoff ↔ neutro)
 * @param {string} targetId - Teléfono, LID o "*"
 * @param {'allowed' | 'ignored' | 'handoff' | 'neutral'} stateType
 */
async function setNumberState(targetId, stateType, context = {}) {
    if (controlService && await controlService.isActive()) {
        try {
            if (targetId === '*') {
                const globalMode = stateType === 'ignored' ? 'ignored_all' : 'allowed_all';
                const result = await controlService.setGlobalPolicy({ globalMode });
                state.GLOBAL_MODE = globalMode;
                return { success: true, mode: globalMode,
                    message: globalMode === 'ignored_all' ? "Modo 'Ignorar a Todos por Defecto' (Estricto)" : "Modo 'Permitir a Todos por Defecto'",
                    policyVersion: result.policy.policyVersion };
            }
            const result = await controlService.projectStateForLegacyTarget(targetId, stateType, {
                channel: context.channel || 'whatsapp', accountId: context.accountId || null,
                reason: context.reason || 'operator'
            });
            const accessPolicy = result.control?.accessPolicy || result.target?.control?.accessPolicy || null;
            return { success: true, target: String(targetId), state: stateType,
                accessPolicy, accessState: accessPolicy, pending: result.status === 'pending',
                conversationId: result.target?.conversationId };
        } catch (error) {
            return { success: false, code: /** @type {any} */ (error)?.code, message: controlError(error) };
        }
    }
    if (targetId === '*') {
        const settings = getSettingsDB();
        if (stateType === 'allowed' || stateType === 'neutral') {
            settings.globalMode = 'allowed_all';
            state.GLOBAL_MODE = 'allowed_all';
            saveSettingsDB(settings);
            return { success: true, mode: 'allowed_all', message: "Modo 'Permitir a Todos por Defecto'" };
        } else if (stateType === 'ignored') {
            settings.globalMode = 'ignored_all';
            state.GLOBAL_MODE = 'ignored_all';
            saveSettingsDB(settings);
            return { success: true, mode: 'ignored_all', message: "Modo 'Ignorar a Todos por Defecto' (Estricto)" };
        }
    }

    const cleanTarget = String(targetId).replace(/[^0-9]/g, '');
    if (!cleanTarget) return { success: false, message: "ID no válido" };

    if ((context.channel || 'whatsapp') !== 'whatsapp') {
        return { success: false, code: 'LEGACY_CHANNEL_UNSUPPORTED',
            message: 'El control Telegram requiere la autoridad SQLite activa.' };
    }

    const db = getContactsDB();
    const resolution = resolveContactKeyByDigits(cleanTarget);
    if (resolution.status === 'partial' || resolution.status === 'ambiguous') {
        return { success: false, code: 'IDENTITY_AMBIGUOUS',
            message: 'Indica el número o LID completo; el sufijo coincide con varias identidades o no es exacto.' };
    }
    const existingKey = resolution.status === 'found' ? resolution.key : null;

    if (existingKey) {
        // Mapeo del stateType al campo "estado" string
        /** @type {Record<string, import('./contactsRepository.js').ContactRecord['estado']>} */
        const stateMap = {
            'allowed': 'permitido',
            'ignored': 'ignorado',
            'handoff': 'handoff',
            'neutral': 'neutro'
        };
        const nuevoEstado = stateMap[stateType] || 'neutro';
        const record = db[existingKey];
        if (nuevoEstado === 'handoff') {
            const previousState = record.handoffPreviousState;
            if (record.estado !== 'handoff' || (previousState !== 'neutro' && previousState !== 'permitido' && previousState !== 'ignorado')) {
                record.handoffPreviousState = record.estado === 'permitido' ? 'permitido'
                    : record.estado === 'ignorado' ? 'ignorado' : 'neutro';
            }
        } else {
            delete record.handoffPreviousState;
        }
        record.estado = nuevoEstado;
        record.handoffAt = nuevoEstado === 'handoff' ? new Date().toISOString() : null;
        saveContactsDB(db);
        const accessState = nuevoEstado === 'handoff' ? record.handoffPreviousState : nuevoEstado;
        return { success: true, target: record.phone || existingKey, state: record.estado, accessState };
    }

    // Si el contacto no existe, creamos uno básico para guardar el estado
    const newKey = cleanTarget;
    const nuevoEstado = stateType === 'allowed' ? 'permitido' : (stateType === 'ignored' ? 'ignorado' : (stateType === 'handoff' ? 'handoff' : 'neutro'));
    db[newKey] = {
        phone: newKey,
        lid: null,
        estado: nuevoEstado,
        ...(nuevoEstado === 'handoff' ? { handoffPreviousState: 'neutro' } : {}),
        handoffAt: nuevoEstado === 'handoff' ? new Date().toISOString() : null,
        isContact: false,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };
    saveContactsDB(db);
    return { success: true, target: newKey, state: db[newKey].estado,
        accessState: nuevoEstado === 'handoff' ? 'neutro' : nuevoEstado };
}

async function releaseControl(targetId, context = {}) {
    if (controlService && await controlService.isActive()) {
        try {
            const result = await controlService.setLegacyControl({ targetId,
                channel: context.channel || 'whatsapp', accountId: context.accountId || null,
                action: 'release', actorId: context.actorId || controlService.legacyAdminActor });
            /** @type {any} */ let policy = null;
            try { policy = await controlService.getPolicy?.(); } catch { /* No cambiar un release confirmado por fallo de lectura auxiliar. */ }
            const control = result.control || result.target?.control || null;
            const accessState = control?.accessPolicy || null;
            const globalMode = policy?.globalMode || getGlobalMode();
            return { success: true, target: String(targetId), state: 'ai', accessState, accessPolicy: accessState,
                globalMode, blockReason: automationBlockReason(accessState, globalMode, control, policy),
                conversationId: result.target?.conversationId };
        } catch (error) { return { success: false, code: /** @type {any} */ (error)?.code, message: controlError(error) }; }
    }

    const cleanTarget = String(targetId).replace(/[^0-9]/g, '');
    if (!cleanTarget || (context.channel || 'whatsapp') !== 'whatsapp') return setNumberState(targetId, 'neutral', context);
    const db = getContactsDB();
    const resolution = resolveContactKeyByDigits(cleanTarget);
    if (resolution.status === 'partial' || resolution.status === 'ambiguous') return setNumberState(targetId, 'neutral', context);
    const existingKey = resolution.status === 'found' ? resolution.key : null;
    if (!existingKey) {
        const created = await setNumberState(targetId, 'neutral', context);
        if (!created.success) return created;
        const accessState = 'neutro', globalMode = getGlobalMode();
        return { ...created, state: 'ai', accessState, globalMode, blockReason: automationBlockReason(accessState, globalMode) };
    }

    const record = db[existingKey];
    const previousState = record.handoffPreviousState;
    const restoredState = record.estado === 'handoff'
        ? (previousState === 'permitido' || previousState === 'ignorado' ? previousState : 'neutro')
        : (record.estado === 'permitido' || record.estado === 'ignorado' || record.estado === 'neutro'
            ? record.estado : 'neutro');
    if (record.estado === 'handoff') {
        record.estado = restoredState;
        record.handoffAt = null;
        delete record.handoffPreviousState;
        saveContactsDB(db);
    }
    const globalMode = getGlobalMode();
    return { success: true, target: record.phone || existingKey, state: 'ai', accessState: restoredState,
        globalMode, blockReason: automationBlockReason(restoredState, globalMode) };
}

/**
 * 🎭 CAMBIAR PERFIL GLOBAL DEL BOT (persistido en settings_db.json)
 * @param {string} profileKey - Clave del perfil SOUL (default, lucia, mateo, ...)
 */
async function setCurrentProfile(profileKey) {
    if (!profileKey) return { success: false, message: "Perfil no válido" };
    if (controlService && await controlService.isActive()) {
        try {
            const result = await controlService.setGlobalPolicy({ globalProfileKey: profileKey });
            state.CURRENT_PROFILE = profileKey;
            return { success: true, profile: profileKey, policyVersion: result.policy.policyVersion };
        } catch (error) { return { success: false, code: /** @type {any} */ (error)?.code, message: controlError(error) }; }
    }
    state.CURRENT_PROFILE = profileKey;
    const settings = getSettingsDB();
    settings.currentProfile = profileKey;
    saveSettingsDB(settings);
    return { success: true, profile: profileKey };
}

/**
 * 🎭 ASIGNAR PERFIL INDIVIDUAL A UN CONTACTO (contacts_db.json)
 * @param {string} targetId - Teléfono o LID del contacto
 * @param {string} profileKey - Clave del perfil SOUL
 */
async function setContactProfile(targetId, profileKey, context = {}) {
    if (controlService && await controlService.isActive()) {
        try {
            const cleanProfile = (profileKey === 'default' || profileKey === 'none' || !profileKey) ? null : profileKey;
            const result = await controlService.setProfileForLegacyTarget({ targetId,
                channel: context.channel || 'whatsapp', accountId: context.accountId || null,
                profileKey: cleanProfile });
            return { success: true, target: String(targetId), profile: cleanProfile,
                conversationId: result.target?.conversationId };
        } catch (error) { return { success: false, code: /** @type {any} */ (error)?.code, message: controlError(error) }; }
    }
    const cleanTarget = String(targetId).replace(/[^0-9]/g, '');
    if (!cleanTarget) return { success: false, message: "ID no válido" };

    if ((context.channel || 'whatsapp') !== 'whatsapp') {
        return { success: false, code: 'LEGACY_CHANNEL_UNSUPPORTED',
            message: 'La asignación de perfil Telegram requiere la autoridad SQLite activa.' };
    }

    const db = getContactsDB();
    const resolution = resolveContactKeyByDigits(cleanTarget);
    if (resolution.status === 'partial' || resolution.status === 'ambiguous') {
        return { success: false, code: 'IDENTITY_AMBIGUOUS',
            message: 'Indica el número o LID completo; el sufijo coincide con varias identidades o no es exacto.' };
    }
    const existingKey = resolution.status === 'found' ? resolution.key : null;

    const cleanProfile = (profileKey === 'default' || profileKey === 'none' || !profileKey) ? null : profileKey;

    if (existingKey) {
        db[existingKey].perfil = cleanProfile;
        saveContactsDB(db);
        return { success: true, target: db[existingKey].phone || existingKey, profile: cleanProfile };
    }

    // Si el contacto no existe, creamos uno básico con el perfil asignado
    db[cleanTarget] = {
        phone: cleanTarget,
        lid: null,
        perfil: cleanProfile,
        isContact: false,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };
    saveContactsDB(db);
    return { success: true, target: cleanTarget, profile: cleanProfile };
}

/**
 * 📇 IGNORAR MASIVAMENTE A TODOS LOS CONTACTOS CON NOMBRE EN AGENDA
 */
async function ignoreAllAgendaContacts(context = {}) {
    if (controlService && await controlService.isActive()) {
        const db = getContactsDB();
        const contacts = Object.values(db).filter(contact => contact && (contact.isContact || (contact.savedName && contact.savedName.trim())));
        let addedCount = 0;
        let ambiguous = 0;
        for (const contact of contacts) {
            const target = contact.lid || contact.phone;
            if (!target) continue;
            const result = await setNumberState(target, 'ignored', { channel: context.channel || 'whatsapp',
                accountId: context.accountId || null });
            if (result.success && result.state === 'ignored') addedCount += 1;
            else if (result.code === 'IDENTITY_AMBIGUOUS') ambiguous += 1;
        }
        return { addedCount, totalIgnored: addedCount, ambiguous };
    }
    const db = getContactsDB();
    let addedCount = 0;

    Object.keys(db).forEach(k => {
        const contact = db[k];
        if (contact.isContact || (contact.savedName && contact.savedName.trim())) {
            if (contact.estado !== 'ignorado') {
                contact.estado = 'ignorado';
                addedCount++;
            }
        }
    });

    if (addedCount > 0) {
        saveContactsDB(db);
    }

    const totalIgnored = summarizeListCounts(db).ignored;
    return { addedCount, totalIgnored };
}

module.exports = {
    setControlService,
    getControlService,
    setNumberState,
    releaseControl,
    setCurrentProfile,
    setContactProfile,
    ignoreAllAgendaContacts
};
