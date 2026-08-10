const { test } = require('node:test');
const assert = require('node:assert');
const { splitIntoHumanBubbles, calculateReadDelay, calculateTypingDelay } = require('../services/brainService');

test('splitIntoHumanBubbles: texto corto queda en un solo globo', () => {
    assert.deepStrictEqual(splitIntoHumanBubbles('Hola'), ['Hola']);
    assert.deepStrictEqual(splitIntoHumanBubbles(null), [null]);
    assert.deepStrictEqual(splitIntoHumanBubbles(undefined), [undefined]);
});

test('splitIntoHumanBubbles: texto largo se divide y conserva contenido', () => {
    const texto = 'Esta es la primera oración muy larga para superar el límite de caracteres por globo de la conversación. ' +
        'Esta es la segunda oración igual de larga que la anterior para seguir sumando contenido. ' +
        'Esta es la tercera oración y también es bastante extensa para asegurar varios globos.';
    const bubbles = splitIntoHumanBubbles(texto);
    assert.ok(bubbles.length >= 2, `esperaba >=2 globos, recibí ${bubbles.length}`);
    assert.ok(bubbles.every(b => b.length <= 230), 'ningún globo debe exceder ~230 chars');
    // El contenido se conserva (quitando espacios)
    assert.strictEqual(bubbles.join('').replace(/\s+/g, ''), texto.replace(/\s+/g, ''));
});

test('splitIntoHumanBubbles: párrafos cortos se reagrupan en un globo cómodo', () => {
    const texto = 'Párrafo uno corto.\n\nPárrafo dos corto.\n\nPárrafo tres corto.';
    const bubbles = splitIntoHumanBubbles(texto);
    // Paso 2 del split: los fragmentos cortos se fusionan si caben en ~220 chars
    assert.strictEqual(bubbles.length, 1);
    assert.ok(bubbles[0].includes('Párrafo uno corto.'));
    assert.ok(bubbles[0].includes('Párrafo tres corto.'));
});

test('splitIntoHumanBubbles: no corta oraciones por la mitad', () => {
    const oracionLarga = 'Primera parte de la oración con contenido extenso y descriptivo. ' + 'Segunda parte de la oración con más contenido para superar el límite. '.repeat(2);
    const bubbles = splitIntoHumanBubbles(oracionLarga);
    for (const b of bubbles) {
        if (!b.endsWith('.') && b !== bubbles[bubbles.length - 1]) {
            assert.ok(false, `globo cortado a mitad de oración: "${b}"`);
        }
    }
    assert.ok(true);
});

test('calculateReadDelay: acotado entre 800ms y ~3300ms', () => {
    for (const len of [0, 5, 50, 200, 1000]) {
        const d = calculateReadDelay('x'.repeat(len));
        assert.ok(d >= 800 && d <= 3400, `readDelay fuera de rango para len=${len}: ${d}`);
    }
});

test('calculateTypingDelay: acotado entre 1500ms y 16000ms', () => {
    for (const len of [0, 10, 100, 500, 5000]) {
        const d = calculateTypingDelay('x'.repeat(len));
        assert.ok(d >= 1500 && d <= 16000, `typingDelay fuera de rango para len=${len}: ${d}`);
    }
});
