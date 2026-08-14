// @ts-check
const { state } = require('../config');
const { getSettingsDB, saveSettingsDB, getContactsDB, saveContactsDB } = require('./db');
const { findKeyByDigits } = require('./contactsRepository');

/**
 * 🔄 GESTIÓN DE ESTADOS EN CONTACTS_DB (ignorado ↔ permitido ↔ handoff ↔ neutro)
 * @param {string} targetId - Teléfono, LID o "*"
 * @param {'allowed' | 'ignored' | 'handoff' | 'neutral'} stateType
 */
function setNumberState(targetId, stateType) {
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

    const db = getContactsDB();
    const existingKey = findKeyByDigits(cleanTarget);

    if (existingKey) {
        // Mapeo del stateType al campo "estado" string
        /** @type {Record<string, import('./contactsRepository.js').ContactRecord['estado']>} */
        const stateMap = {
            'allowed': 'permitido',
            'ignored': 'ignorado',
            'handoff': 'handoff',
            'neutral': 'neutro'
        };
        db[existingKey].estado = stateMap[stateType] || 'neutro';
        saveContactsDB(db);
        return { success: true, target: db[existingKey].phone || existingKey, state: db[existingKey].estado };
    }

    // Si el contacto no existe, creamos uno básico para guardar el estado
    const newKey = cleanTarget;
    db[newKey] = {
        phone: newKey,
        lid: null,
        estado: stateType === 'allowed' ? 'permitido' : (stateType === 'ignored' ? 'ignorado' : (stateType === 'handoff' ? 'handoff' : 'neutro')),
        isContact: false,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };
    saveContactsDB(db);
    return { success: true, target: newKey, state: db[newKey].estado };
}

/**
 * 🎭 CAMBIAR PERFIL GLOBAL DEL BOT (persistido en settings_db.json)
 * @param {string} profileKey - Clave del perfil SOUL (default, lucia, mateo, ...)
 */
function setCurrentProfile(profileKey) {
    if (!profileKey) return { success: false, message: "Perfil no válido" };
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
function setContactProfile(targetId, profileKey) {
    const cleanTarget = String(targetId).replace(/[^0-9]/g, '');
    if (!cleanTarget) return { success: false, message: "ID no válido" };

    const db = getContactsDB();
    const existingKey = findKeyByDigits(cleanTarget);

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
function ignoreAllAgendaContacts() {
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

    const totalIgnored = Object.values(db).filter(c => c.estado === 'ignorado').length;
    return { addedCount, totalIgnored };
}

module.exports = {
    setNumberState,
    setCurrentProfile,
    setContactProfile,
    ignoreAllAgendaContacts
};
