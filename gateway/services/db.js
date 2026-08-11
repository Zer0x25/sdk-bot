// @ts-check
const fs = require('fs');
const fsPromises = require('fs/promises');
const { SETTINGS_FILE_PATH, CONTACTS_FILE_PATH, state } = require('../config');
const { cat, errMsg } = require("./logger");
const log = cat("STORAGE");
const logError = cat("ERROR");

/**
 * 🧾 Forma de settings_db.json (globalMode, perfil global, etc.)
 * @typedef {Object} SettingsDB
 * @property {string} [globalMode]
 * @property {string} [currentProfile]
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

const SAVE_DELAY_MS = 2000; // 2 segundos de debounce

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
        if (!fs.existsSync(SETTINGS_FILE_PATH)) {
            // 🔒 Default seguro de deploy: nadie habla con el bot hasta que el admin lo permita
            const defaultSettings = { globalMode: 'ignored_all' };
            fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(defaultSettings, null, 2));
            cachedSettingsDB = defaultSettings;
        } else {
            cachedSettingsDB = JSON.parse(stripBOM(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8')));
        }
    } catch (e) {
        logError.error("Error al leer settings_db.json: " + errMsg(e));
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
        logError.error("Error al leer contacts_db.json: " + errMsg(e));
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
        try {
            await fsPromises.writeFile(SETTINGS_FILE_PATH, JSON.stringify(cachedSettingsDB, null, 2));
        } catch (e) {
            logError.error("Error al guardar settings_db.json de forma asíncrona: " + errMsg(e));
        }
    }, SAVE_DELAY_MS);
    return true;
}

/** @param {ContactsDB} db */
function saveContactsDB(db) {
    cachedContactsDB = db;
    notifyContactsCache();
    if (saveContactsTimer) clearTimeout(saveContactsTimer);
    saveContactsTimer = setTimeout(async () => {
        try {
            // Write atómico: .tmp + rename (máxima seguridad contra cortes)
            const tmpPath = `${CONTACTS_FILE_PATH}.tmp`;
            await fsPromises.writeFile(tmpPath, JSON.stringify(cachedContactsDB, null, 2));
            await fsPromises.rename(tmpPath, CONTACTS_FILE_PATH);
        } catch (e) {
            logError.error("Error al guardar contacts_db.json de forma asíncrona: " + errMsg(e));
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
        logError.error("⚠️ Error durante el volcado síncrono a disco: " + errMsg(e));
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
