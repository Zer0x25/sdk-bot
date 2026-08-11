const { test } = require('node:test');
const assert = require('node:assert');
const { withTempQueuePath } = require('./helpers/tmpQueue');

const item = (over = {}) => ({
    jid: '56912345678@s.whatsapp.net',
    text: 'Hola, ¿estás?',
    metadata: { phoneNumber: '56912345678', savedName: 'Cliente Test' },
    ...over
});

// Cada test crea su propio tmpDir: la instancia cacheada apuntaría a un path viejo,
// así que se fuerza recarga del módulo tras setear la env (mismo proceso, distinto file).
function freshQueue() {
    delete require.cache[require.resolve('../services/messageQueue')];
    return require('../services/messageQueue');
}

test('enqueue persiste el mensaje en disco y se recarga al "reiniciar"', () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        assert.strictEqual(queue.enqueue(item()), true);
        assert.strictEqual(queue.getQueueStats().pending, 1);

        const head = queue.peek();
        assert.strictEqual(head.text, 'Hola, ¿estás?');
        assert.strictEqual(head.attempts, 0);
        assert.ok(head.id);

        // Simular reinicio del gateway: recargar el módulo desde cero
        const queue2 = freshQueue();
        assert.strictEqual(queue2.getQueueStats().pending, 1);
        assert.strictEqual(queue2.peek().jid, item().jid);
    } finally {
        t.restore();
    }
});

test('removeHead quita el mensaje procesado y persiste', () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        queue.enqueue(item({ text: 'uno' }));
        queue.enqueue(item({ text: 'dos' }));

        queue.removeHead();
        assert.strictEqual(queue.getQueueStats().pending, 1);
        assert.strictEqual(queue.peek().text, 'dos');
    } finally {
        t.restore();
    }
});

test('cola llena descarta el mensaje nuevo (límite)', () => {
    const t = withTempQueuePath();
    try {
        process.env.SDK_MESSAGE_QUEUE_MAX = '3';
        const queue = freshQueue();

        assert.strictEqual(queue.enqueue(item({ text: '1' })), true);
        assert.strictEqual(queue.enqueue(item({ text: '2' })), true);
        assert.strictEqual(queue.enqueue(item({ text: '3' })), true);
        assert.strictEqual(queue.enqueue(item({ text: '4' })), false); // descartado
        assert.strictEqual(queue.getQueueStats().pending, 3);
        delete process.env.SDK_MESSAGE_QUEUE_MAX;
    } finally {
        t.restore();
    }
});

test('saveHead persiste el contador de intentos', () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        queue.enqueue(item());
        queue.peek().attempts = 2;
        queue.saveHead();

        const queue2 = freshQueue();
        assert.strictEqual(queue2.peek().attempts, 2);
    } finally {
        t.restore();
    }
});

test('flush procesa la cola con el handler registrado', async () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        queue.setSock({ fake: true });
        queue.enqueue(item({ text: 'uno' }));
        queue.enqueue(item({ text: 'dos' }));

        const processed = [];
        queue.setFlushHandler(async () => {
            while (queue.peek()) {
                processed.push(queue.peek().text);
                queue.removeHead();
            }
        });
        queue.scheduleFlush();
        await new Promise(r => setTimeout(r, 5000)); // debounce 3s + margen

        assert.deepStrictEqual(processed, ['uno', 'dos']);
        assert.strictEqual(queue.getQueueStats().pending, 0);
    } finally {
        t.restore();
    }
});

test('flush no pierde el mensaje si el procesador falla', async () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        queue.setSock({ fake: true });
        queue.enqueue(item({ text: 'uno' }));

        queue.setFlushHandler(async () => {
            throw new Error('brain caído');
        });
        queue.scheduleFlush();
        await new Promise(r => setTimeout(r, 5000));

        assert.strictEqual(queue.getQueueStats().pending, 1);
    } finally {
        t.restore();
    }
});
