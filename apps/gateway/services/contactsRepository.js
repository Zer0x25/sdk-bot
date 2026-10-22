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
 * @property {string|null} [handoffAt]
 * @property {string|null} [perfil]
 */

const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * ⏳ ¿El handoff está activo o ya expiró (> 24h)?
 * @param {ContactRecord} [record]
 * @param {number} [nowMs]
 * @param {number} [ttlMs]
 * @returns {boolean}
 */
function isHandoffActive(record, nowMs = Date.now(), ttlMs = (Number(process.env.SDK_HANDOFF_TTL_MS) || DEFAULT_HANDOFF_TTL_MS)) {
    if (!record || record.estado !== 'handoff') return false;
    if (!record.handoffAt) return true; // sin fecha registrada, activo por compatibilidad
    const at = Date.parse(record.handoffAt);
    if (isNaN(at)) return true;
    return (nowMs - at) < ttlMs;
}

// Almacén en memoria de contactos de la sesión (RAM de Baileys)
const contactStore = new Map();

// -------------------------------------------------------------
// ÍNDICES RAM (R1): eliminan los Object.keys().find() del hot path
// -------------------------------------------------------------
let phoneIndex = new Map();   // phone -> clave del registro
let lidIndex = new Map();     // lid   -> clave del registro
let digitsIndex = new Map();  // dígitos puros exactos -> todas las claves coincidentes
let phonesByKey = new Map();  // aliases phone por fila, para retirar valores reemplazados
let lidsByKey = new Map();    // aliases lid por fila, para retirar valores reemplazados
let digitsByKey = new Map();  // identidades indexadas por fila, para retirar aliases reemplazados

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
    phonesByKey = new Map();
    lidsByKey = new Map();
    digitsByKey = new Map();
    if (!db || typeof db !== 'object') return;
    for (const [k, item] of Object.entries(db)) {
        if (!item || typeof item !== 'object') continue;
        indexAdd(k, item);
    }
}

function identityValues(key, record) {
    const values = [record?.phone, record?.lid].filter(value => typeof value === 'string' && value.length);
    if (values.length) return values;
    const rawKey = String(key).replace(/^whatsapp:/i, '');
    return /^(?:\+?\d+|\d+(?::\d+)?@(?:s\.whatsapp\.net|lid))$/i.test(rawKey) ? [rawKey] : [];
}

function addDigitsIndex(value, key) {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    if (!digits) return;
    let keys = digitsIndex.get(digits);
    if (!keys) { keys = new Set(); digitsIndex.set(digits, keys); }
    keys.add(key);
}

function removeDigitsIndex(value, key) {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    if (!digits) return;
    const keys = digitsIndex.get(digits);
    if (!keys) return;
    keys.delete(key);
    if (!keys.size) digitsIndex.delete(digits);
}

function removeAliases(index, aliasesByKey, key) {
    for (const alias of aliasesByKey.get(key) || []) {
        if (index.get(alias) === key) index.delete(alias);
    }
    aliasesByKey.delete(key);
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
    removeAliases(phoneIndex, phonesByKey, key);
    removeAliases(lidIndex, lidsByKey, key);
    if (record.phone) {
        phoneIndex.set(record.phone, key);
        phonesByKey.set(key, [record.phone]);
    }
    if (record.lid) {
        lidIndex.set(record.lid, key);
        lidsByKey.set(key, [record.lid]);
    }
    for (const digits of digitsByKey.get(key) || []) removeDigitsIndex(digits, key);
    const values = [...new Set(identityValues(key, record)
        .map(value => String(value).replace(/[^0-9]/g, ''))
        .filter(Boolean))];
    for (const digits of values) addDigitsIndex(digits, key);
    digitsByKey.set(key, values);
}

function indexRemove(key, record) {
    if (!key || !record || typeof record !== 'object') return;
    removeAliases(phoneIndex, phonesByKey, key);
    removeAliases(lidIndex, lidsByKey, key);
    const values = digitsByKey.get(key) || identityValues(key, record)
        .map(value => String(value).replace(/[^0-9]/g, ''))
        .filter(Boolean);
    for (const digits of values) removeDigitsIndex(digits, key);
    digitsByKey.delete(key);
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

// Resolución legacy conservadora. Un target debe coincidir con la identidad
// completa; un substring solo informa que el input era parcial y nunca elige
// un contacto. Si varias filas comparten los mismos dígitos, se devuelve ambigüedad.
function resolveContactKeyByDigits(cleanTarget) {
    if (typeof cleanTarget !== 'string' || !/^\d+$/.test(cleanTarget)) return { status: 'missing', keys: [] };
    ensureIndexes();
    const exact = [...(digitsIndex.get(cleanTarget) || [])].sort();
    if (exact.length === 1) return { status: 'found', key: exact[0], keys: exact };
    if (exact.length > 1) return { status: 'ambiguous', keys: exact };

    const db = getContactsDB();
    const partial = new Set();
    for (const [key, item] of Object.entries(db)) {
        const values = identityValues(key, item)
            .map(value => String(value || '').replace(/[^0-9]/g, ''))
            .filter(Boolean);
        if (values.some(value => value !== cleanTarget && value.includes(cleanTarget))) partial.add(key);
    }
    const keys = [...partial].sort();
    if (keys.length === 1) return { status: 'partial', keys };
    if (keys.length > 1) return { status: 'ambiguous', keys };
    return { status: 'missing', keys: [] };
}

function findKeyByDigits(cleanTarget) {
    const result = resolveContactKeyByDigits(cleanTarget);
    return result.status === 'found' ? result.key : null;
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

        // E) Handoff expirado (>24h): resetear a estado neutro automáticamente
        if (item.estado === 'handoff' && !isHandoffActive(item)) {
            item.estado = 'neutro';
            item.handoffAt = null;
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
 * @param {string} [remoteId] - ID compuesto (ej: whatsapp:123, telegram:456)
 * @returns {ContactRecord|null}
 */
/**
 * 🏗️ Construye o actualiza un ContactRecord a partir de metadata normalizada.
 * Fuente única de verdad compartida por upsertContactMetadata y
 * bulkUpsertContactsMetadata (evita el duplicado de ~70 líneas).
 * NO guarda la DB ni maneja índices: eso lo hace el llamador.
 * @param {object} db - contacts DB en memoria
 * @param {ContactMetadataInput} metadata
 * @param {object} opts
 * @param {string} [opts.remoteId] - ID compuesto (ej: whatsapp:123, telegram:456)
 * @param {boolean} [opts.forceWhatsappKey] - bulkUpsert fuerza clave `whatsapp:<num>`
 * @param {boolean} [opts.incrementMessages] - upsert individual incrementa totalMessages
 * @returns {{ targetKey: string, record: ContactRecord } | null}
 */
function buildOrUpdateContactRecord(db, metadata, opts = {}) {
    const { phoneNumber, lid, savedName, pushName, verifiedName, country, language, isContact, bio, profilePicUrl, isBusiness, lastEnrichedAt } = metadata;

    if (phoneNumber && isJunkJid(phoneNumber)) return null;
    if (lid && isJunkJid(lid)) return null;
    if (!phoneNumber && !lid) return null;

    const hasAnyIdentity = phoneNumber || lid || (savedName && savedName.trim()) || (pushName && pushName !== 'Desconocido' && pushName.trim()) || verifiedName || profilePicUrl;
    if (!hasAnyIdentity) return null;

    let existingKey = findExistingKey(phoneNumber, lid);

    let targetKey = opts.remoteId || phoneNumber || (existingKey && db[existingKey].phone ? db[existingKey].phone : lid);
    if (opts.forceWhatsappKey) {
        if (phoneNumber) targetKey = `whatsapp:${phoneNumber}`;
        else if (lid) targetKey = `whatsapp:${lid}`;
    }
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
    if (opts.incrementMessages) record.totalMessages = (record.totalMessages || 0) + 1;

    return { targetKey, record };
}

function upsertContactMetadata(metadata, remoteId = undefined) {
    if (!metadata) return null;
    const db = getContactsDB();
    const built = buildOrUpdateContactRecord(db, metadata, { remoteId, incrementMessages: true });
    if (!built) return null;

    db[built.targetKey] = built.record;
    indexAdd(built.targetKey, built.record);
    saveContactsDB(db);

    return built.record;
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

    contactsList.forEach(metadata => {
        const built = buildOrUpdateContactRecord(db, metadata, { forceWhatsappKey: true });
        if (!built) return;

        db[built.targetKey] = built.record;
        indexAdd(built.targetKey, built.record);
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
    resolveContactKeyByDigits,
    findKeyByDigits,
    cleanContactsDB,
    isHandoffActive,
    upsertContactMetadata,
    bulkUpsertContactsMetadata
};
