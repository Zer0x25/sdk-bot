'use strict';

const fs = require('node:fs');

/**
 * JSON storage adapter for durable broadcast state.
 * @param {string} filePath
 */
function createJsonBroadcastRepository(filePath) {
    return {
        exists() {
            return fs.existsSync(filePath);
        },

        load() {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        },

        save(snapshot) {
            const tempPath = `${filePath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
            fs.renameSync(tempPath, filePath);
        }
    };
}

module.exports = { createJsonBroadcastRepository };
