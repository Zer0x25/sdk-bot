// @ts-check
const fs = require('fs');
const fsPromises = require('fs/promises');
const { SETTINGS_FILE_PATH, CONTACTS_FILE_PATH, state } = require('../config');
const { isWiping } = require('./factoryReset');
const { cat, safeErrorLabel } = require("./logger");
const { num } = require('../tuning');
const { createJsonSettingsRepository } = require('./repositories/jsonSettingsRepository');
const log = cat("STORAGE");
const logError = cat("ERROR");
const settingsRepository = createJsonSettingsRepository(SETTINGS_FILE_PATH);

/**
 * 🧾 Forma de settings_db.json (globalMode, perfil global, etc.)
 * @typedef {Object} SettingsDB
 * @property {string} [globalMode]
 * @property {string} [currentProfile]
 * @property {string} [telegramToken]
 * @property {string} [telegramChatId]
 */

/**
 * @typedef {Object<string, import('./contactsRepository.js').ContactRecord>} ContactsDB
 */

// -------------------------------------------------------------
// CACHÉ EN MEMORIA Y GUARDADO DIFERIDO (DEBOUNCE)
// -------------------------------------------------------------
/** @type {SettingsDB|null} */
let cachedSettingsDB = null;
/** @type {ContactsDB|null} */
let cachedContactsDB = null;

/** @type {NodeJS.Timeout|null} */
let saveContactsTimer = null;
/** @type {NodeJS.Timeout|null} */
let saveSettingsTimer = null;

const SAVE_DELAY_MS = num('GATEWAY_SAVE_DELAY_MS', 2000); // 2 segundos de debounce (tunable vía .env.tuning)

// Suscriptores del cambio de caché de contactos (los índices RAM del
// contactsRepository se reconstruyen cuando la caché se reemplaza)
/** @type {Array<(db: ContactsDB) => void>} */
let contactsCacheListeners = [];

function notifyContactsCache() {
    if (!cachedContactsDB) return;
    for (const listener of contactsCacheListeners) {
        listener(cachedContactsDB);
    }
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
        if (!settingsRepository.exists()) {
            // 🔒 Default seguro de deploy: nadie habla con el bot hasta que el admin lo permita
            const defaultSettings = { globalMode: 'ignored_all' };
            settingsRepository.saveSync(defaultSettings);
            cachedSettingsDB = defaultSettings;
        } else {
            cachedSettingsDB = settingsRepository.load();
        }
    } catch (e) {
        logError.error(`Error al leer settings_db.json (${safeErrorLabel(e)}).`);
        cachedSettingsDB = { globalMode: 'ignored_all' };
        state.GLOBAL_MODE = 'ignored_all';
    }

    // Sincronizar con el state global (cachedSettingsDB ya quedó cargado)
    const settingsLoaded = cachedSettingsDB ?? { globalMode: 'ignored_all' };
    if (settingsLoaded.globalMode) {
        state.GLOBAL_MODE = settingsLoaded.globalMode;
    }
    if (settingsLoaded.currentProfile) {
        state.CURRENT_PROFILE = settingsLoaded.currentProfile;
    }

    try {
        if (!fs.existsSync(CONTACTS_FILE_PATH)) {
            fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify({}, null, 2));
            cachedContactsDB = {};
        } else {
            cachedContactsDB = JSON.parse(stripBOM(fs.readFileSync(CONTACTS_FILE_PATH, 'utf8')));
        }
    } catch (e) {
        logError.error(`Error al leer contacts_db.json (${safeErrorLabel(e)}).`);
        cachedContactsDB = {};
    }
    notifyContactsCache();
}

// -------------------------------------------------------------
// GETTERS (Retornan Caché)
// -------------------------------------------------------------
/** @returns {SettingsDB} */
function getSettingsDB() {
    if (!cachedSettingsDB) loadDataOnStartup();
    return /** @type {SettingsDB} */ (cachedSettingsDB);
}

/** @returns {ContactsDB} */
function getContactsDB() {
    if (!cachedContactsDB) loadDataOnStartup();
    return /** @type {ContactsDB} */ (cachedContactsDB);
}

// -------------------------------------------------------------
// SETTERS ASÍNCRONOS CON DEBOUNCE (Para no bloquear Event Loop)
// -------------------------------------------------------------
/** @param {SettingsDB} settings */
function saveSettingsDB(settings) {
    cachedSettingsDB = settings;
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(async () => {
        // 🧹 Reset limpio en curso: no reescribir las DBs recién borradas
        if (isWiping()) return;
        try {
            await settingsRepository.save(cachedSettingsDB);
        } catch (e) {
            logError.error(`Error al guardar settings_db.json (${safeErrorLabel(e)}).`);
        }
    }, SAVE_DELAY_MS);
    saveSettingsTimer.unref?.();
    return true;
}

/** @param {ContactsDB} db */
function saveContactsDB(db) {
    // Los listeners (índices RAM) solo necesitan enterarse si la caché se
    // REEMPLAZA (objeto nuevo). Las mutaciones del mismo objeto las mantiene
    // el propio contactsRepository de forma incremental; notificar en cada
    // guardado hacía reconstruir índices O(N) por mensaje/lote (saturaba el
    // event loop durante la sync inicial de la agenda).
    const replaced = db !== cachedContactsDB;
    cachedContactsDB = db;
    if (replaced) notifyContactsCache();
    if (saveContactsTimer) clearTimeout(saveContactsTimer);
    saveContactsTimer = setTimeout(async () => {
        // 🧹 Reset limpio en curso: no reescribir las DBs recién borradas
        if (isWiping()) return;
        try {
            // Write atómico: .tmp + rename (máxima seguridad contra cortes)
            const tmpPath = `${CONTACTS_FILE_PATH}.tmp`;
            await fsPromises.writeFile(tmpPath, JSON.stringify(cachedContactsDB, null, 2));
            await fsPromises.rename(tmpPath, CONTACTS_FILE_PATH);
        } catch (e) {
            logError.error(`Error al guardar contacts_db.json (${safeErrorLabel(e)}).`);
        }
    }, SAVE_DELAY_MS);
    saveContactsTimer.unref?.();
    return true;
}

// -------------------------------------------------------------
// FUNCIÓN DE CIERRE SEGURO (Graceful Shutdown)
// -------------------------------------------------------------
function flushToDisk() {
    // 🧹 Reset limpio en curso: la caché RAM es justamente lo que se quiere
    // perder; volcarla a disco resistiría el wipe (recrearía las DBs borradas).
    if (isWiping()) {
        log.info("🧹 Reset limpio en curso: se omite el volcado de DBs a disco.");
        return;
    }
    log.info("💾 Guardando bases de datos a disco antes de cerrar...");
    try {
        if (cachedSettingsDB) settingsRepository.saveSync(cachedSettingsDB);
        if (cachedContactsDB) fs.writeFileSync(CONTACTS_FILE_PATH, JSON.stringify(cachedContactsDB, null, 2));
        log.info("✅ Datos guardados correctamente.");
    } catch (e) {
        logError.error(`⚠️ Error durante el volcado síncrono a disco (${safeErrorLabel(e)}).`);
    }
}

/** @param {(db: ContactsDB) => void} listener */
function onContactsCacheUpdate(listener) {
    contactsCacheListeners.push(listener);
}

// Inicializar la carga explícita al arrancar
loadDataOnStartup();

module.exports = {
    getSettingsDB,
    saveSettingsDB,
    getContactsDB,
    saveContactsDB,
    flushToDisk,
    loadDataOnStartup,
    onContactsCacheUpdate
};
