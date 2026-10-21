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

test('la autoridad SQLite archiva e invalida jobs JSONL heredados sin replay tras reiniciar', () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        queue.enqueue(item({ text: 'antiguo 1' }));
        queue.enqueue(item({ text: 'antiguo 2' }));
        const result = queue.invalidateLegacyReplay();
        assert.equal(result.invalidated, 2);
        assert.ok(result.archivedPath);
        assert.equal(require('node:fs').readFileSync(result.archivedPath, 'utf8').includes('antiguo 1'), true);
        assert.equal(queue.getQueueStats().pending, 0);
        assert.equal(require('node:fs').readFileSync(t.queuePath, 'utf8'), '');

        const reopened = freshQueue();
        assert.equal(reopened.getQueueStats().pending, 0);
    } finally {
        t.restore();
    }
});

test('F5.7 preserves versioned queue entries with their durable source IDs across restart', () => {
    const t = withTempQueuePath();
    try {
        const queue = freshQueue();
        const versioned = item({ text: 'mensaje versionado', controlSnapshot: {
            conversationId: '11111111-1111-4111-8111-111111111111', controlVersion: '3', contextVersion: '2', policyVersion: '4'
        }, sourceMessageIds: ['22222222-2222-4222-8222-222222222222'] });
        queue.enqueue(item({ text: 'mensaje viejo' }));
        queue.enqueue(versioned);
        const result = queue.invalidateLegacyReplay();
        assert.equal(result.invalidated, 1);
        assert.ok(result.archivedPath);
        assert.equal(require('node:fs').readFileSync(result.archivedPath, 'utf8').includes('mensaje viejo'), true);
        assert.equal(require('node:fs').readFileSync(result.archivedPath, 'utf8').includes('mensaje versionado'), false);
        assert.equal(queue.peek().text, 'mensaje versionado');
        assert.deepEqual(queue.peek().sourceMessageIds, versioned.sourceMessageIds);

        const reopened = freshQueue();
        assert.equal(reopened.peek().id, queue.peek().id);
        assert.deepEqual(reopened.peek().controlSnapshot, versioned.controlSnapshot);
        assert.deepEqual(reopened.peek().sourceMessageIds, versioned.sourceMessageIds);
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
