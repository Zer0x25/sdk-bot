const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-log-privacy-'));
const logPath = path.join(tempDir, 'gateway.log');
process.env.SDK_BOT_TEST = '1';
process.env.SDK_TEST_LOG_PATH = logPath;
process.env.SDK_MESSAGE_QUEUE_PATH = path.join(tempDir, 'pending.jsonl');

const { logger, safeErrorLabel } = require('../services/logger');
const messageQueue = require('../services/messageQueue');

async function waitForLog(filePath, predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath)) {
            const contents = fs.readFileSync(filePath, 'utf8');
            if (predicate(contents)) return contents;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

test('la cola conserva el mensaje y omite identidad/contenido de los logs', async () => {
    const privateId = 'whatsapp:569876543210@s.whatsapp.net';
    const privateText = 'private-customer-message-75b4';
    const privateName = 'private-customer-name-0c21';
    assert.equal(messageQueue.enqueue({
        jid: privateId,
        text: privateText,
        metadata: { phoneNumber: '569876543210', savedName: privateName }
    }), true);
    assert.equal(messageQueue.peek().text, privateText);

    logger.flush();
    const logs = await waitForLog(logPath, contents => contents.includes('Mensaje encolado'));
    assert.match(logs, /Mensaje encolado/);
    assert.equal(logs.includes(privateId), false);
    assert.equal(logs.includes(privateText), false);
    assert.equal(logs.includes(privateName), false);
});

test('safeErrorLabel omite el mensaje privado y acota identificadores numéricos', () => {
    const error = Object.assign(new Error('private-customer-message-75b4'), {
        code: 'PRIVATE_CUSTOMER_569876543210'
    });
    assert.equal(safeErrorLabel(error), 'PRIVATE_CUSTOMER_[id]');
});

after(async () => {
    messageQueue.clearQueueForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
});
