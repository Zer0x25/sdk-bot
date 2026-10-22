'use strict';

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');

/** @param {string} raw */
function stripBOM(raw) {
    return raw && raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

/**
 * JSON storage adapter for legacy settings that remain outside SQLite control.
 * @param {string} filePath
 */
function createJsonSettingsRepository(filePath) {
    return {
        exists() {
            return fs.existsSync(filePath);
        },

        load() {
            return JSON.parse(stripBOM(fs.readFileSync(filePath, 'utf8')));
        },

        async save(settings) {
            await fsPromises.writeFile(filePath, JSON.stringify(settings, null, 2));
        },

        saveSync(settings) {
            fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
        }
    };
}

module.exports = { createJsonSettingsRepository };
