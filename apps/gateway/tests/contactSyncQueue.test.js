const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { setProcessor, push, pendingCount, resetForTests, CHUNK_SIZE } = require('../services/contactSyncQueue');

afterEach(() => resetForTests());

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

// Cada chunk consume un setImmediate; drena hasta que la cola esté vacía
async function drainQueue() {
    for (let i = 0; i < 100 && pendingCount() > 0; i++) {
        await flushMicrotasks();
    }
}

test('push procesa todos los contactos en chunks de máx 300 y preserva el orden', async () => {
    const chunks = [];
    setProcessor(chunk => chunks.push(chunk));

    const total = 1000;
    push(Array.from({ length: total }, (_, i) => i));
    await drainQueue();

    const processed = chunks.flat();
    assert.strictEqual(processed.length, total, 'todos los contactos procesados');
    assert.deepStrictEqual(processed, Array.from({ length: total }, (_, i) => i), 'orden FIFO');
    assert.ok(chunks.every(c => c.length <= CHUNK_SIZE), `ningún chunk supera ${CHUNK_SIZE}`);
    assert.ok(chunks.length >= 4, `varios chunks (${chunks.length})`);
    assert.strictEqual(pendingCount(), 0, 'cola vacía al terminar');
});

test('push acumula lotes entrantes mientras procesa (ráfaga de eventos)', async () => {
    const chunks = [];
    setProcessor(chunk => chunks.push(chunk));

    push([1, 2, 3]);
    push([4, 5]);
    push([6]);
    await drainQueue();

    assert.deepStrictEqual(chunks.flat(), [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(pendingCount(), 0);
});

test('pendingCount refleja el trabajo en cola', async () => {
    const chunks = [];
    setProcessor(chunk => chunks.push(chunk));

    push(Array.from({ length: 700 }, (_, i) => i));
    assert.strictEqual(pendingCount(), 700, 'todo en cola antes de arrancar');
    await flushMicrotasks();
    assert.ok(pendingCount() < 700, 'la cola se drena de a chunks');
    await drainQueue();
    assert.strictEqual(pendingCount(), 0);
    assert.strictEqual(chunks.flat().length, 700);
});

test('sin procesador registrado, push drena sin romper', async () => {
    push([1, 2, 3]);
    await drainQueue();
    assert.strictEqual(pendingCount(), 0);
});

test('un error del procesador no detiene la cola', async () => {
    const chunks = [];
    let fail = true;
    setProcessor(chunk => {
        chunks.push(chunk);
        if (fail) throw new Error('boom');
        fail = false;
    });

    push(Array.from({ length: CHUNK_SIZE + 1 }, (_, i) => i)); // 2 chunks: el 1º falla, el 2º no
    await drainQueue();

    assert.strictEqual(chunks.length, 2, 'ambos chunks se procesaron pese al error');
    assert.strictEqual(pendingCount(), 0);
});

test('push ignora entradas vacías/no-arrays', () => {
    push(null);
    push([]);
    push(undefined);
    assert.strictEqual(pendingCount(), 0);
});
