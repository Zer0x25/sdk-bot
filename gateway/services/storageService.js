const fs = require('fs');
const fsPromises = require('fs/promises');
const { SETTINGS_FILE_PATH, CONTACTS_FILE_PATH, state } = require('../config');
const { cat } = require("../services/logger");
const log = cat("STORAGE");
const logError = cat("ERROR");

// Almacén en memoria de contactos de la sesión
const contactStore = new Map();

// -------------------------------------------------------------
// ÍNDICES RAM (R1): eliminan los Object.keys().find() del hot path
// -------------------------------------------------------------
let phoneIndex = new Map();   // phone -> clave del registro
let lidIndex = new Map();     // lid   -> clave del registro
let digitsIndex = new Map();  // clave/phone/lid en dígitos puros -> clave (para comandos admin)

function rebuildIndexes() {
    const db = cachedContactsDB || {};
    phoneIndex = new Map();
    lidIndex = new Map();
    digitsIndex = new Map();
    for (const [k, item] of Object.entries(db)) {
        if (!item || typeof item !== 'object') continue;
        if (item.phone) phoneIndex.set(item.phone, k);
        if (item.lid) lidIndex.set(item.lid, k);
        const d = String(k).replace(/[^0-9]/g, '');
        if (d) digitsIndex.set(d, k);
    }
}

// Búsqueda exacta por phone/lid (hot path: upsert, bulk, extractUserMetadata)
function findExistingKey(phoneNumber, lid) {
    if (phoneNumber && phoneIndex.has(phoneNumber)) return phoneIndex.get(phoneNumber);
    if (lid && lidIndex.has(lid)) return lidIndex.get(lid);
    return null;
}

// -------------------------------------------------------------
// CACHÉ EN MEMORIA Y GUARDADO DIFERIDO (DEBOUNCE)
// -------------------------------------------------------------
let cachedSettingsDB = null;
let cachedContactsDB = null;

let saveContactsTimer = null;
let saveSettingsTimer = null;

const SAVE_DELAY_MS = 2000; // 2 segundos de debounce

function isJunkJid(jid) {
    if (!jid) return true;
    const str = String(jid).toLowerCase();
    if (str.endsWith('@g.us')) return true;
    if (str.endsWith('@newsletter')) return true;
    if (str.endsWith('@broadcast')) return true;
    if (str.startsWith('status@')) return true;
    if (str.startsWith('0@')) return true;
    return false;
}

// -------------------------------------------------------------
// INICIALIZACIÓN SÍNCRONA AL ARRANCAR EL SERVIDOR
// -------------------------------------------------------------
function stripBOM(str) {
    if (str && str.charCodeAt(0) === 0xFEFF) return str.slice(1);
    return str;
}

function loadDataOnStartup() {
    log.info("📂 Cargando bases de datos en memoria...");
    
    try {
        if (!fs.existsSync(SETTINGS_FILE_PATH)) {
            const defaultSettings = { globalMode: 'allowed_all' };
            fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(defaultSettings, null, 2));
            cachedSettingsDB = defaultSettings;
        } else {
            cachedSettingsDB = JSON.parse(stripBOM(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8')));
        }
        // Sincronizar con el state global
        if (cachedSettingsDB.globalMode) {
            state.GLOBAL_MODE = cachedSettingsDB.globalMode;
        }
        if (cachedSettingsDB.currentProfile) {
            state.CURRENT_PROFILE = cachedSettingsDB.currentProfile;
        }
    } catch (e) {
        logError.error("Error al leer settings_db.json:", e.message);
        cachedSettingsDB = { globalMode: 'allowed_all' };
        state.GLOBAL_MODE = 'allowed_all';
    }

    try {
        if (!fs.existsSync(CONTACTS_FILE_PATH)) {
            fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify({}, null, 2));
            cachedContactsDB = {};
        } else {
            cachedContactsDB = JSON.parse(stripBOM(fs.readFileSync(CONTACTS_FILE_PATH, 'utf8')));
        }
    } catch (e) {
        logError.error("Error al leer contacts_db.json:", e.message);
        cachedContactsDB = {};
    }
    rebuildIndexes();
}

// -------------------------------------------------------------
// GETTERS (Retornan Caché)
// -------------------------------------------------------------
function getSettingsDB() {
    if (!cachedSettingsDB) loadDataOnStartup();
    return cachedSettingsDB;
}

function getContactsDB() {
    if (!cachedContactsDB) loadDataOnStartup();
    return cachedContactsDB;
}

// -------------------------------------------------------------
// SETTERS ASÍNCRONOS CON DEBOUNCE (Para no bloquear Event Loop)
// -------------------------------------------------------------
function saveSettingsDB(settings) {
    cachedSettingsDB = settings;
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(async () => {
        try {
            await fsPromises.writeFile(SETTINGS_FILE_PATH, JSON.stringify(cachedSettingsDB, null, 2));
        } catch (e) {
            logError.error("Error al guardar settings_db.json de forma asíncrona:", e.message);
        }
    }, SAVE_DELAY_MS);
    return true;
}

function saveContactsDB(db) {
    cachedContactsDB = db;
    rebuildIndexes(); // los índices RAM siempre espejan la caché actual
    if (saveContactsTimer) clearTimeout(saveContactsTimer);
    saveContactsTimer = setTimeout(async () => {
        try {
            // Se puede implementar un atomic write aquí guardando a .tmp y renombrando si se quiere máxima seguridad.
            const tmpPath = `${CONTACTS_FILE_PATH}.tmp`;
            await fsPromises.writeFile(tmpPath, JSON.stringify(cachedContactsDB, null, 2));
            await fsPromises.rename(tmpPath, CONTACTS_FILE_PATH);
        } catch (e) {
            logError.error("Error al guardar contacts_db.json de forma asíncrona:", e.message);
        }
    }, SAVE_DELAY_MS);
    return true;
}

// -------------------------------------------------------------
// FUNCIÓN DE CIERRE SEGURO (Graceful Shutdown)
// -------------------------------------------------------------
function flushToDisk() {
    log.info("💾 Guardando bases de datos a disco antes de cerrar...");
    try {
        if (cachedSettingsDB) fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(cachedSettingsDB, null, 2));
        if (cachedContactsDB) fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify(cachedContactsDB, null, 2));
        log.info("✅ Datos guardados correctamente.");
    } catch (e) {
        logError.error("⚠️ Error durante el volcado síncrono a disco:", e.message);
    }
}

function cleanContactsDB() {
    const db = getContactsDB();
    let updated = false;

    Object.keys(db).forEach(k => {
        const item = db[k];
        
        // A) Eliminar grupos, broadcast, canales o IDs inválidos
        if (isJunkJid(k) || (item.phone && isJunkJid(item.phone)) || (item.lid && isJunkJid(item.lid))) {
            delete db[k];
            updated = true;
            return;
        }

        // B) Eliminar entradas fantasma (sin teléfono Y sin nombres Y sin foto)
        if (!item.phone && !item.savedName && !item.pushName && !item.verifiedName && !item.profilePicUrl) {
            delete db[k];
            updated = true;
            return;
        }

        // C) Si la clave es un LID pero existe otra entrada con el mismo LID que ya posee Teléfono, fusionar y eliminar la clave LID
        if (!item.phone && item.lid) {
            const matchingPhoneKey = Object.keys(db).find(otherKey => otherKey !== k && db[otherKey].lid === item.lid && db[otherKey].phone);
            if (matchingPhoneKey) {
                const target = db[matchingPhoneKey];
                if (item.savedName && !target.savedName) target.savedName = item.savedName;
                if (item.pushName && !target.pushName) target.pushName = item.pushName;
                if (item.profilePicUrl && !target.profilePicUrl) target.profilePicUrl = item.profilePicUrl;
                if (item.bio && !target.bio) target.bio = item.bio;
                if (item.handoff !== undefined) target.handoff = item.handoff;
                delete db[k];
                updated = true;
            }
        }

        // D) Sanitizar bio: registros legados pueden tener el OBJETO {status,setAt} en vez
        //    de string (rompe la API del brain con 422 de validación)
        if (item.bio && typeof item.bio !== 'string') {
            item.bio = null;
            updated = true;
        }
    });

    if (updated) {
        saveContactsDB(db);
    }
    return db;
}

    // -----------------------------------------------------------------
    // NOTA: isContactHandoff y setContactHandoff han sido reemplazados 
    // por la nueva arquitectura de 'estado' en contacts_db.json, 
    // que se maneja a través de setNumberState().
    // -----------------------------------------------------------------

function upsertContactMetadata(metadata) {
    const { phoneNumber, lid, savedName, pushName, verifiedName, country, language, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

    if (phoneNumber && isJunkJid(phoneNumber)) return null;
    if (lid && isJunkJid(lid)) return null;
    if (!phoneNumber && !lid) return null;

    const hasAnyIdentity = phoneNumber || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
    if (!hasAnyIdentity) return null;

    const db = cleanContactsDB();

    // ⚡ Índice RAM: O(1) en vez de Object.keys().find()
    let existingKey = findExistingKey(phoneNumber, lid);

    let targetKey = phoneNumber || (existingKey && db[existingKey].phone ? db[existingKey].phone : lid);

    if (existingKey && existingKey !== targetKey) {
        const oldData = db[existingKey];
        delete db[existingKey];
        db[targetKey] = oldData;
    }

    const now = new Date().toISOString();
    const record = db[targetKey] || {
        phone: phoneNumber || null,
        lid: lid || null,
        savedName: (savedName && savedName.trim()) ? savedName.trim() : null,
        pushName: (pushName && pushName !== 'Desconocido' && pushName.trim()) ? pushName.trim() : null,
        verifiedName: (verifiedName && verifiedName.trim()) ? verifiedName.trim() : null,
        country: country || "Desconocido",
        language: language || null,
        profilePicUrl: profilePicUrl || null,
        bio: bio || null,
        isBusiness: isBusiness || false,
        isContact: isContact || false,
        estado: "neutro", // Estado por defecto: "neutro", "handoff", "ignorado", "permitido"
        lastEnrichedAt: lastEnrichedAt || null,
        firstSeen: now,
        lastSeen: now,
        totalMessages: 0
    };

    if (phoneNumber) record.phone = phoneNumber;
    if (lid) record.lid = lid;
    if (savedName && savedName.trim()) record.savedName = savedName.trim();
    if (pushName && pushName !== 'Desconocido' && pushName.trim()) record.pushName = pushName.trim();
    if (verifiedName && verifiedName.trim()) record.verifiedName = verifiedName.trim();
    if (country && country !== 'Desconocido') record.country = country;
    if (language) record.language = language;
    if (profilePicUrl) record.profilePicUrl = profilePicUrl;
    if (bio && typeof bio === 'string') record.bio = bio;
    if (isBusiness !== undefined) record.isBusiness = isBusiness;
    if (isContact) record.isContact = true;
    if (lastEnrichedAt) record.lastEnrichedAt = lastEnrichedAt;

    record.lastSeen = now;
    record.totalMessages = (record.totalMessages || 0) + 1;

    db[targetKey] = record;
    saveContactsDB(db);

    return record;
}

function bulkUpsertContactsMetadata(contactsList) {
    if (!Array.isArray(contactsList) || contactsList.length === 0) return 0;
    
    const db = cleanContactsDB();
    let count = 0;
    const now = new Date().toISOString();

    contactsList.forEach(metadata => {
        const { phoneNumber, lid, savedName, pushName, verifiedName, country, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

        if (phoneNumber && isJunkJid(phoneNumber)) return;
        if (lid && isJunkJid(lid)) return;
        if (!phoneNumber && !lid) return;

        const hasAnyIdentity = phoneNumber || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
        if (!hasAnyIdentity) return;

        // ⚡ Índice RAM: O(1) en vez de Object.keys().find()
        let existingKey = findExistingKey(phoneNumber, lid);

        let targetKey = phoneNumber || (existingKey && db[existingKey].phone ? db[existingKey].phone : lid);

        if (existingKey && existingKey !== targetKey) {
            const oldData = db[existingKey];
            delete db[existingKey];
            db[targetKey] = oldData;
        }

        const record = db[targetKey] || {
            phone: phoneNumber || null,
            lid: lid || null,
            savedName: (savedName && savedName.trim()) ? savedName.trim() : null,
            pushName: (pushName && pushName !== 'Desconocido' && pushName.trim()) ? pushName.trim() : null,
            verifiedName: (verifiedName && verifiedName.trim()) ? verifiedName.trim() : null,
            country: country || "Desconocido",
            profilePicUrl: profilePicUrl || null,
            bio: bio || null,
            isBusiness: isBusiness || false,
            isContact: isContact || false,
            estado: "neutro", // Estado por defecto
            lastEnrichedAt: lastEnrichedAt || null,
            firstSeen: now,
            lastSeen: now,
            totalMessages: 0
        };

        if (phoneNumber) record.phone = phoneNumber;
        if (lid) record.lid = lid;
        if (savedName && savedName.trim()) record.savedName = savedName.trim();
        if (pushName && pushName !== 'Desconocido' && pushName.trim()) record.pushName = pushName.trim();
        if (verifiedName && verifiedName.trim()) record.verifiedName = verifiedName.trim();
        if (country && country !== 'Desconocido') record.country = country;
        if (profilePicUrl) record.profilePicUrl = profilePicUrl;
        if (bio && typeof bio === 'string') record.bio = bio;
        if (isBusiness !== undefined) record.isBusiness = isBusiness;
        if (isContact) record.isContact = true;
        if (lastEnrichedAt) record.lastEnrichedAt = lastEnrichedAt;

        record.lastSeen = now;

        db[targetKey] = record;
        count++;
    });

    saveContactsDB(db);
    return count;
}

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
    // ⚡ Índice RAM de dígitos puros; scan completo solo si no hubo match exacto
    let existingKey = digitsIndex.has(cleanTarget) ? digitsIndex.get(cleanTarget) : null;
    if (!existingKey) {
        existingKey = Object.keys(db).find(k => {
            const item = db[k];
            const cleanPhone = item.phone ? item.phone.replace(/[^0-9]/g, '') : '';
            const cleanLid = item.lid ? item.lid.replace(/[^0-9]/g, '') : '';
            return cleanPhone.includes(cleanTarget) || cleanLid.includes(cleanTarget) || k === cleanTarget;
        });
    }

    if (existingKey) {
        // Mapeo del stateType al campo "estado" string
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
    // ⚡ Índice RAM de dígitos puros; scan completo solo si no hubo match exacto
    let existingKey = digitsIndex.has(cleanTarget) ? digitsIndex.get(cleanTarget) : null;
    if (!existingKey) {
        existingKey = Object.keys(db).find(k => {
            const item = db[k];
            const cleanPhone = item.phone ? item.phone.replace(/[^0-9]/g, '') : '';
            const cleanLid = item.lid ? item.lid.replace(/[^0-9]/g, '') : '';
            return cleanPhone.includes(cleanTarget) || cleanLid.includes(cleanTarget) || k === cleanTarget;
        });
    }

    if (existingKey) {
        db[existingKey].perfil = profileKey;
        saveContactsDB(db);
        return { success: true, target: db[existingKey].phone || existingKey, profile: profileKey };
    }

    // Si el contacto no existe, creamos uno básico con el perfil asignado
    db[cleanTarget] = {
        phone: cleanTarget,
        lid: null,
        perfil: profileKey,
        isContact: false,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };
    saveContactsDB(db);
    return { success: true, target: cleanTarget, profile: profileKey };
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

// Inicializar la carga explícita al arrancar
loadDataOnStartup();

module.exports = {
    contactStore,
    isJunkJid,
    getSettingsDB,
    saveSettingsDB,
    getContactsDB,
    saveContactsDB,
    cleanContactsDB,
    setNumberState,
    setCurrentProfile,
    setContactProfile,
    ignoreAllAgendaContacts,
    upsertContactMetadata,
    bulkUpsertContactsMetadata,
    findExistingKey,
    flushToDisk,
    loadDataOnStartup
};
