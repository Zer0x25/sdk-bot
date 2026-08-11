// @ts-check
const { getContactsDB, saveContactsDB, onContactsCacheUpdate } = require('./db');

/**
 * 🧾 Forma de un registro de contacto en contacts_db.json
 * (typedef compartido: db.js, stateService.js y pipeline.js lo usan vía import()).
 * @typedef {Object} ContactRecord
 * @property {string|null} phone
 * @property {string|null} lid
 * @property {string|null} [savedName]
 * @property {string|null} [pushName]
 * @property {string|null} [verifiedName]
 * @property {string} [country]
 * @property {string|null} [language]
 * @property {string|null} [profilePicUrl]
 * @property {string|null} [bio]
 * @property {boolean} [isBusiness]
 * @property {boolean} [isContact]
 * @property {('neutro'|'permitido'|'ignorado'|'handoff')} [estado]
 * @property {string|null} [lastEnrichedAt]
 * @property {string} [firstSeen]
 * @property {string} [lastSeen]
 * @property {number} [totalMessages]
 * @property {boolean} [handoff]
 * @property {string} [perfil]
 */

// Almacén en memoria de contactos de la sesión (RAM de Baileys)
const contactStore = new Map();

// -------------------------------------------------------------
// ÍNDICES RAM (R1): eliminan los Object.keys().find() del hot path
// -------------------------------------------------------------
let phoneIndex = new Map();   // phone -> clave del registro
let lidIndex = new Map();     // lid   -> clave del registro
let digitsIndex = new Map();  // clave/phone/lid en dígitos puros -> clave (para comandos admin)

// Mantenimiento INCREMENTAL: los índices se actualizan O(1) en cada
// upsert/bulk (indexAdd/indexRemove) y solo se reconstruyen por completo
// (O(N), raro) cuando la caché se REEMPLAZA o la DB se limpia. Antes se
// reconstruían en CADA saveContactsDB (por mensaje/lote): con miles de
// contactos entrando en la sync inicial, ese O(N) repetido saturaba el
// event loop y WhatsApp cortaba la conexión a mitad de la agenda.
let indexesDirty = true;

function rebuildIndexes(db) {
    phoneIndex = new Map();
    lidIndex = new Map();
    digitsIndex = new Map();
    if (!db || typeof db !== 'object') return;
    for (const [k, item] of Object.entries(db)) {
        if (!item || typeof item !== 'object') continue;
        if (item.phone) phoneIndex.set(item.phone, k);
        if (item.lid) lidIndex.set(item.lid, k);
        const d = String(k).replace(/[^0-9]/g, '');
        if (d) digitsIndex.set(d, k);
    }
}

function ensureIndexes() {
    if (!indexesDirty) return;
    rebuildIndexes(getContactsDB());
    indexesDirty = false;
}

function markIndexesDirty() {
    indexesDirty = true;
}

// Mantenimiento incremental O(1) tras mutar un registro (upsert/bulk)
function indexAdd(key, record) {
    if (!key || !record || typeof record !== 'object') return;
    if (record.phone) phoneIndex.set(record.phone, key);
    if (record.lid) lidIndex.set(record.lid, key);
    const d = String(key).replace(/[^0-9]/g, '');
    if (d) digitsIndex.set(d, key);
}

function indexRemove(key, record) {
    if (!key || !record || typeof record !== 'object') return;
    if (record.phone && phoneIndex.get(record.phone) === key) phoneIndex.delete(record.phone);
    if (record.lid && lidIndex.get(record.lid) === key) lidIndex.delete(record.lid);
    const d = String(key).replace(/[^0-9]/g, '');
    if (d && digitsIndex.get(d) === key) digitsIndex.delete(d);
}

// Los índices RAM siempre espejan la caché actual (se reconstruyen si la
// caché se REEMPLAZA; las mutaciones las mantienen los propios upserts)
onContactsCacheUpdate(markIndexesDirty);

// Búsqueda exacta por phone/lid (hot path: upsert, bulk, extractUserMetadata)
function findExistingKey(phoneNumber, lid) {
    ensureIndexes();
    if (phoneNumber && phoneIndex.has(phoneNumber)) return phoneIndex.get(phoneNumber);
    if (lid && lidIndex.has(lid)) return lidIndex.get(lid);
    return null;
}

// Búsqueda por dígitos puros (comandos admin: /p /i /q /n, estados, perfiles).
// Índice RAM de dígitos puros; scan completo solo si no hubo match exacto.
function findKeyByDigits(cleanTarget) {
    if (!cleanTarget) return null;
    ensureIndexes();
    if (digitsIndex.has(cleanTarget)) return digitsIndex.get(cleanTarget);
    const db = getContactsDB();
    return Object.keys(db).find(k => {
        const item = db[k];
        const cleanPhone = item.phone ? item.phone.replace(/[^0-9]/g, '') : '';
        const cleanLid = item.lid ? item.lid.replace(/[^0-9]/g, '') : '';
        return cleanPhone.includes(cleanTarget) || cleanLid.includes(cleanTarget) || k === cleanTarget;
    }) ?? null;
}

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

// Extrae phone/lid de un contacto CRUDO de Baileys rc14 (history sync).
// rc14 entrega `{id, name, username, lid, phoneNumber}`: `id` es el JID del
// chat (ahora mayoritariamente LID: `...@lid`), `phoneNumber` es el PN JID
// (`...@s.whatsapp.net` o `...@hosted`) y `lid` el LID JID. Los PUSH_NAME
// llegan como `{id, notify}`. Sin estos campos, la agenda LID-únicamente se
// rechazaba en el upsert (identidad vacía) y la libreta no crecía.
function contactIdentityFromRaw(c) {
    const id = (c && c.id) ? String(c.id) : '';
    const phoneJid = (c && (c.phoneNumber || id)) || '';
    const lidJid = (c && (c.lid || id)) || '';
    const phone = /@s\.whatsapp\.net$/.test(phoneJid) || phoneJid.endsWith('@hosted')
        ? phoneJid.split('@')[0]
        : null;
    const lid = /@lid$/.test(lidJid) || lidJid.endsWith('@hosted.lid')
        ? lidJid.split('@')[0]
        : null;
    return { phone, lid };
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
        markIndexesDirty(); // mutó claves: los índices RAM se reconstruyen en la próxima búsqueda
        saveContactsDB(db);
    }
    return db;
}

/**
 * 📝 Datos enriquecidos de un contacto para upsert (entrada normalizada)
 * @typedef {Object} ContactMetadataInput
 * @property {string|null} phoneNumber
 * @property {string|null} lid
 * @property {string|null} [savedName]
 * @property {string|null} [pushName]
 * @property {string|null} [verifiedName]
 * @property {string} [country]
 * @property {string|null} [language]
 * @property {string|null} [profilePicUrl]
 * @property {string|null} [bio]
 * @property {boolean} [isBusiness]
 * @property {boolean} [isContact]
 * @property {string|null} [lastEnrichedAt]
 */

/**
 * @param {ContactMetadataInput} metadata
 * @returns {ContactRecord|null}
 */
function upsertContactMetadata(metadata) {
    const { phoneNumber, lid, savedName, pushName, verifiedName, country, language, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

    if (phoneNumber && isJunkJid(phoneNumber)) return null;
    if (lid && isJunkJid(lid)) return null;
    if (!phoneNumber && !lid) return null;

    const hasAnyIdentity = phoneNumber || lid || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
    if (!hasAnyIdentity) return null;

    const db = getContactsDB();

    // ⚡ Índice RAM: O(1) en vez de Object.keys().find() (y SIN el
    // cleanContactsDB() por llamada: mantenimiento aparte, solo arranque)
    let existingKey = findExistingKey(phoneNumber, lid);

    let targetKey = phoneNumber || (existingKey && db[existingKey].phone ? db[existingKey].phone : lid);

    if (!targetKey) return null;

    if (existingKey && existingKey !== targetKey) {
        const oldData = db[existingKey];
        delete db[existingKey];
        indexRemove(existingKey, oldData);
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
    indexAdd(targetKey, record);
    saveContactsDB(db);

    return record;
}

/**
 * @param {ContactMetadataInput[]} contactsList
 * @returns {number}
 */
function bulkUpsertContactsMetadata(contactsList) {
    if (!Array.isArray(contactsList) || contactsList.length === 0) return 0;

    // Sin cleanContactsDB() por lote (O(N) + merge LID O(N²) + guardado):
    // la sync inicial entra en ráfagas de miles de contactos y ese costo
    // repetido saturaba el event loop → el socket perdía pings y WhatsApp
    // cortaba la conexión a mitad de la agenda. La limpieza se hace en el
    // arranque y bajo demanda (cleanContactsDB()), los upserts mantienen
    // los índices RAM de forma incremental (O(1)).
    const db = getContactsDB();
    let count = 0;
    const now = new Date().toISOString();

    contactsList.forEach(metadata => {
        const { phoneNumber, lid, savedName, pushName, verifiedName, country, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

        if (phoneNumber && isJunkJid(phoneNumber)) return;
        if (lid && isJunkJid(lid)) return;
        if (!phoneNumber && !lid) return;

        const hasAnyIdentity = phoneNumber || lid || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
        if (!hasAnyIdentity) return;

        // ⚡ Índice RAM: O(1) en vez de Object.keys().find()
        let existingKey = findExistingKey(phoneNumber, lid);

        let targetKey = phoneNumber || (existingKey && db[existingKey].phone ? db[existingKey].phone : lid);

        if (!targetKey) return;

        if (existingKey && existingKey !== targetKey) {
            const oldData = db[existingKey];
            delete db[existingKey];
            indexRemove(existingKey, oldData);
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
        indexAdd(targetKey, record);
        count++;
    });

    saveContactsDB(db);
    return count;
}

module.exports = {
    contactStore,
    isJunkJid,
    contactIdentityFromRaw,
    findExistingKey,
    findKeyByDigits,
    cleanContactsDB,
    upsertContactMetadata,
    bulkUpsertContactsMetadata
};
