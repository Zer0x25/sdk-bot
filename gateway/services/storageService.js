const fs = require('fs');
const { ALLOWED_FILE_PATH, IGNORED_FILE_PATH, CONTACTS_FILE_PATH } = require('../config');

// Almacén en memoria de contactos de la sesión
const contactStore = new Map();

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

function getAllowedNumbers() {
    try {
        if (!fs.existsSync(ALLOWED_FILE_PATH)) {
            fs.writeFileSync(ALLOWED_FILE_PATH, JSON.stringify(["*"], null, 2));
            return ["*"];
        }
        const fileData = fs.readFileSync(ALLOWED_FILE_PATH, 'utf8');
        return JSON.parse(fileData);
    } catch (e) {
        console.error("Error al leer allowed_numbers.json:", e.message);
        return ["*"];
    }
}

function saveAllowedNumbers(list) {
    try {
        fs.writeFileSync(ALLOWED_FILE_PATH, JSON.stringify(list, null, 2));
        return true;
    } catch (e) {
        console.error("Error al guardar allowed_numbers.json:", e.message);
        return false;
    }
}

function getIgnoredNumbers() {
    try {
        if (!fs.existsSync(IGNORED_FILE_PATH)) {
            fs.writeFileSync(IGNORED_FILE_PATH, JSON.stringify([], null, 2));
            return [];
        }
        const fileData = fs.readFileSync(IGNORED_FILE_PATH, 'utf8');
        return JSON.parse(fileData);
    } catch (e) {
        console.error("Error al leer ignored_numbers.json:", e.message);
        return [];
    }
}

function saveIgnoredNumbers(list) {
    try {
        fs.writeFileSync(IGNORED_FILE_PATH, JSON.stringify(list, null, 2));
        return true;
    } catch (e) {
        console.error("Error al guardar ignored_numbers.json:", e.message);
        return false;
    }
}

function getContactsDB() {
    try {
        if (!fs.existsSync(CONTACTS_FILE_PATH)) {
            fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify({}, null, 2));
            return {};
        }
        const fileData = fs.readFileSync(CONTACTS_FILE_PATH, 'utf8');
        return JSON.parse(fileData);
    } catch (e) {
        console.error("Error al leer contacts_db.json:", e.message);
        return {};
    }
}

function saveContactsDB(db) {
    try {
        fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify(db, null, 2));
        return true;
    } catch (e) {
        console.error("Error al guardar contacts_db.json:", e.message);
        return false;
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
    const { phoneNumber, lid, savedName, pushName, verifiedName, country, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

    // Filtro de data basura (grupos, canales, broadcast)
    if (phoneNumber && isJunkJid(phoneNumber)) return null;
    if (lid && isJunkJid(lid)) return null;
    if (!phoneNumber && !lid) return null;

    // No crear registros fantasma sin teléfono ni ningún nombre/foto
    const hasAnyIdentity = phoneNumber || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
    if (!hasAnyIdentity) return null;

    const db = cleanContactsDB();

    // Buscar si ya existe por teléfono o LID
    let existingKey = Object.keys(db).find(k => {
        const item = db[k];
        if (phoneNumber && item.phone === phoneNumber) return true;
        if (lid && item.lid === lid) return true;
        return false;
    });

    // Clave de destino preferida: Número de Teléfono
    let targetKey = phoneNumber || (existingKey && db[existingKey].phone ? db[existingKey].phone : lid);

    // Si cambió la clave (ej. de LID a Teléfono), migrar datos y borrar la clave LID anterior
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
    bulkUpsertContactsMetadata
};
