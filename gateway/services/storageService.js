const fs = require('fs');
const fsPromises = require('fs/promises');
const { ALLOWED_FILE_PATH, IGNORED_FILE_PATH, CONTACTS_FILE_PATH } = require('../config');

// Almacén en memoria de contactos de la sesión
const contactStore = new Map();

// -------------------------------------------------------------
// CACHÉ EN MEMORIA Y GUARDADO DIFERIDO (DEBOUNCE)
// -------------------------------------------------------------
let cachedAllowedNumbers = null;
let cachedIgnoredNumbers = null;
let cachedContactsDB = null;

let saveContactsTimer = null;
let saveAllowedTimer = null;
let saveIgnoredTimer = null;

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
function loadDataOnStartup() {
    console.log("📂 Cargando bases de datos en memoria...");
    
    try {
        if (!fs.existsSync(ALLOWED_FILE_PATH)) {
            fs.writeFileSync(ALLOWED_FILE_PATH, JSON.stringify(["*"], null, 2));
            cachedAllowedNumbers = ["*"];
        } else {
            cachedAllowedNumbers = JSON.parse(fs.readFileSync(ALLOWED_FILE_PATH, 'utf8'));
        }
    } catch (e) {
        console.error("Error al leer allowed_numbers.json:", e.message);
        cachedAllowedNumbers = ["*"];
    }

    try {
        if (!fs.existsSync(IGNORED_FILE_PATH)) {
            fs.writeFileSync(IGNORED_FILE_PATH, JSON.stringify([], null, 2));
            cachedIgnoredNumbers = [];
        } else {
            cachedIgnoredNumbers = JSON.parse(fs.readFileSync(IGNORED_FILE_PATH, 'utf8'));
        }
    } catch (e) {
        console.error("Error al leer ignored_numbers.json:", e.message);
        cachedIgnoredNumbers = [];
    }

    try {
        if (!fs.existsSync(CONTACTS_FILE_PATH)) {
            fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify({}, null, 2));
            cachedContactsDB = {};
        } else {
            cachedContactsDB = JSON.parse(fs.readFileSync(CONTACTS_FILE_PATH, 'utf8'));
        }
    } catch (e) {
        console.error("Error al leer contacts_db.json:", e.message);
        cachedContactsDB = {};
    }
}

// -------------------------------------------------------------
// GETTERS (Retornan Caché)
// -------------------------------------------------------------
function getAllowedNumbers() {
    if (!cachedAllowedNumbers) loadDataOnStartup();
    return cachedAllowedNumbers;
}

function getIgnoredNumbers() {
    if (!cachedIgnoredNumbers) loadDataOnStartup();
    return cachedIgnoredNumbers;
}

function getContactsDB() {
    if (!cachedContactsDB) loadDataOnStartup();
    return cachedContactsDB;
}

// -------------------------------------------------------------
// SETTERS ASÍNCRONOS CON DEBOUNCE (Para no bloquear Event Loop)
// -------------------------------------------------------------
function saveAllowedNumbers(list) {
    cachedAllowedNumbers = list;
    if (saveAllowedTimer) clearTimeout(saveAllowedTimer);
    saveAllowedTimer = setTimeout(async () => {
        try {
            await fsPromises.writeFile(ALLOWED_FILE_PATH, JSON.stringify(cachedAllowedNumbers, null, 2));
        } catch (e) {
            console.error("Error al guardar allowed_numbers.json de forma asíncrona:", e.message);
        }
    }, SAVE_DELAY_MS);
    return true;
}

function saveIgnoredNumbers(list) {
    cachedIgnoredNumbers = list;
    if (saveIgnoredTimer) clearTimeout(saveIgnoredTimer);
    saveIgnoredTimer = setTimeout(async () => {
        try {
            await fsPromises.writeFile(IGNORED_FILE_PATH, JSON.stringify(cachedIgnoredNumbers, null, 2));
        } catch (e) {
            console.error("Error al guardar ignored_numbers.json de forma asíncrona:", e.message);
        }
    }, SAVE_DELAY_MS);
    return true;
}

function saveContactsDB(db) {
    cachedContactsDB = db;
    if (saveContactsTimer) clearTimeout(saveContactsTimer);
    saveContactsTimer = setTimeout(async () => {
        try {
            // Se puede implementar un atomic write aquí guardando a .tmp y renombrando si se quiere máxima seguridad.
            const tmpPath = `${CONTACTS_FILE_PATH}.tmp`;
            await fsPromises.writeFile(tmpPath, JSON.stringify(cachedContactsDB, null, 2));
            await fsPromises.rename(tmpPath, CONTACTS_FILE_PATH);
        } catch (e) {
            console.error("Error al guardar contacts_db.json de forma asíncrona:", e.message);
        }
    }, SAVE_DELAY_MS);
    return true;
}

// -------------------------------------------------------------
// FUNCIÓN DE CIERRE SEGURO (Graceful Shutdown)
// -------------------------------------------------------------
function flushToDisk() {
    console.log("💾 Guardando bases de datos a disco antes de cerrar...");
    try {
        if (cachedAllowedNumbers) fs.writeFileSync(ALLOWED_FILE_PATH, JSON.stringify(cachedAllowedNumbers, null, 2));
        if (cachedIgnoredNumbers) fs.writeFileSync(IGNORED_FILE_PATH, JSON.stringify(cachedIgnoredNumbers, null, 2));
        if (cachedContactsDB) fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify(cachedContactsDB, null, 2));
        console.log("✅ Datos guardados correctamente.");
    } catch (e) {
        console.error("⚠️ Error durante el volcado síncrono a disco:", e.message);
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
    });

    if (updated) {
        saveContactsDB(db);
    }
    return db;
}

function isContactHandoff(metadata) {
    const { phoneNumber, lid } = metadata;
    const db = getContactsDB();
    const existingKey = Object.keys(db).find(k => {
        const item = db[k];
        if (phoneNumber && item.phone === phoneNumber) return true;
        if (lid && item.lid === lid) return true;
        return false;
    });
    return existingKey ? Boolean(db[existingKey].handoff) : false;
}

function setContactHandoff(keyOrMetadata, handoffState = true) {
    const db = getContactsDB();
    let targetKey = typeof keyOrMetadata === 'string' ? keyOrMetadata : (keyOrMetadata.phoneNumber || keyOrMetadata.lid);

    const existingKey = Object.keys(db).find(k => {
        const item = db[k];
        if (targetKey && item.phone && item.phone.includes(targetKey)) return true;
        if (targetKey && item.lid && item.lid.includes(targetKey)) return true;
        return k === targetKey;
    });

    if (existingKey) {
        db[existingKey].handoff = Boolean(handoffState);
        saveContactsDB(db);
        return db[existingKey];
    }
    return null;
}

function upsertContactMetadata(metadata) {
    const { phoneNumber, lid, savedName, pushName, verifiedName, country, language, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

    if (phoneNumber && isJunkJid(phoneNumber)) return null;
    if (lid && isJunkJid(lid)) return null;
    if (!phoneNumber && !lid) return null;

    const hasAnyIdentity = phoneNumber || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
    if (!hasAnyIdentity) return null;

    const db = cleanContactsDB();

    let existingKey = Object.keys(db).find(k => {
        const item = db[k];
        if (phoneNumber && item.phone === phoneNumber) return true;
        if (lid && item.lid === lid) return true;
        return false;
    });

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
        handoff: false,
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
    if (bio) record.bio = bio;
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

        let existingKey = Object.keys(db).find(k => {
            const item = db[k];
            if (phoneNumber && item.phone === phoneNumber) return true;
            if (lid && item.lid === lid) return true;
            return false;
        });

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
            handoff: false,
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
        if (bio) record.bio = bio;
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

// Inicializar la carga explícita al arrancar
loadDataOnStartup();

module.exports = {
    contactStore,
    isJunkJid,
    getAllowedNumbers,
    saveAllowedNumbers,
    getIgnoredNumbers,
    saveIgnoredNumbers,
    getContactsDB,
    saveContactsDB,
    cleanContactsDB,
    isContactHandoff,
    setContactHandoff,
    upsertContactMetadata,
    bulkUpsertContactsMetadata,
    flushToDisk,
    loadDataOnStartup
};
