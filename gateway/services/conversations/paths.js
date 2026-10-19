const path = require('node:path');

function databasePath() {
    return path.resolve(process.env.SDK_CONVERSATIONS_DB_PATH || path.join(__dirname, '../../data/conversations.db'));
}
function statePaths() {
    const db = databasePath();
    return [db, `${db}-wal`, `${db}-shm`];
}
module.exports = { databasePath, statePaths };
