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

    await new Promise(resolve => logger.flush(resolve));
    const logs = fs.readFileSync(logPath, 'utf8');
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
    await new Promise(resolve => logger.flush(resolve));
    messageQueue.clearQueueForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
});
