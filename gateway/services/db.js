const fs = require('fs');
const fsPromises = require('fs/promises');
const { SETTINGS_FILE_PATH, CONTACTS_FILE_PATH, state } = require('../config');
const { cat } = require("./logger");
const log = cat("STORAGE");
const logError = cat("ERROR");

// -------------------------------------------------------------
// CACHÉ EN MEMORIA Y GUARDADO DIFERIDO (DEBOUNCE)
// -------------------------------------------------------------
let cachedSettingsDB = null;
let cachedContactsDB = null;

let saveContactsTimer = null;
let saveSettingsTimer = null;

const SAVE_DELAY_MS = 2000; // 2 segundos de debounce

// Suscriptores del cambio de caché de contactos (los índices RAM del
// contactsRepository se reconstruyen cuando la caché se reemplaza)
let contactsCacheListeners = [];

function notifyContactsCache() {
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
    notifyContactsCache();
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
    notifyContactsCache();
    if (saveContactsTimer) clearTimeout(saveContactsTimer);
    saveContactsTimer = setTimeout(async () => {
        try {
            // Write atómico: .tmp + rename (máxima seguridad contra cortes)
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
