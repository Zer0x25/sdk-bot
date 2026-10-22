const path = require('node:path');
const { GATEWAY_STATE_DIR } = require('../../lib/repoPaths');

function databasePath() {
    return path.resolve(process.env.SDK_CONVERSATIONS_DB_PATH || path.join(GATEWAY_STATE_DIR, 'data', 'conversations.db'));
}
function statePaths() {
    const db = databasePath();
    return [db, `${db}-wal`, `${db}-shm`];
}
module.exports = { databasePath, statePaths };
