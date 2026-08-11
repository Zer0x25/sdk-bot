const path = require('path');
const os = require('os');
const fs = require('fs');

// Aisla la cola persistente (messageQueue.js) en un archivo temporal.
// DEBE llamarse ANTES de require('../services/messageQueue') (lee la env al cargar).
function withTempQueuePath() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-queue-'));
    const queuePath = path.join(tmpDir, 'pending_messages.jsonl');
    process.env.SDK_MESSAGE_QUEUE_PATH = queuePath;

    return {
        tmpDir,
        queuePath,
        restore() {
            delete process.env.SDK_MESSAGE_QUEUE_PATH;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    };
}

module.exports = { withTempQueuePath };
