const fs = require('fs');
const { ALLOWED_FILE_PATH, IGNORED_FILE_PATH, CONTACTS_FILE_PATH } = require('../config');

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

function upsertContactMetadata(metadata) {
    const db = getContactsDB();
    const { phoneNumber, lid, savedName, pushName, verifiedName, country, isContact, bio, profilePicUrl, isBusiness } = metadata;

    if (!phoneNumber && !lid) return null;

    let key = phoneNumber || lid;
    let existingKey = Object.keys(db).find(k => {
        const item = db[k];
        if (phoneNumber && item.phone === phoneNumber) return true;
        if (lid && item.lid === lid) return true;
        return false;
    });

    if (existingKey) {
        key = existingKey;
    }

    const now = new Date().toISOString();
    const record = db[key] || {
        phone: phoneNumber || null,
        lid: lid || null,
        savedName: savedName || null,
        pushName: (pushName && pushName !== 'Desconocido') ? pushName : null,
        verifiedName: verifiedName || null,
        country: country || "Desconocido",
        profilePicUrl: profilePicUrl || null,
        bio: bio || null,
        isBusiness: isBusiness || false,
        isContact: isContact || false,
        firstSeen: now,
        lastSeen: now,
        totalMessages: 0
    };

    if (phoneNumber && !record.phone) record.phone = phoneNumber;
    if (lid && !record.lid) record.lid = lid;
    if (savedName && savedName !== record.savedName) record.savedName = savedName;
    if (pushName && pushName !== 'Desconocido' && pushName !== record.pushName) record.pushName = pushName;
    if (verifiedName && verifiedName !== record.verifiedName) record.verifiedName = verifiedName;
    if (country && country !== 'Desconocido') record.country = country;
    if (profilePicUrl) record.profilePicUrl = profilePicUrl;
    if (bio) record.bio = bio;
    if (isBusiness !== undefined) record.isBusiness = isBusiness;
    if (isContact) record.isContact = true;

    record.lastSeen = now;
    record.totalMessages = (record.totalMessages || 0) + 1;

    db[key] = record;
    saveContactsDB(db);

    return record;
}

module.exports = {
    getAllowedNumbers,
    saveAllowedNumbers,
    getIgnoredNumbers,
    saveIgnoredNumbers,
    getContactsDB,
    saveContactsDB,
    upsertContactMetadata
};
