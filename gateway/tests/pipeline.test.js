const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const tmp = withTempDbPaths();
before(() => {}); // (las rutas ya quedaron parcheadas al importar los módulos)

after(() => tmp.restore());

const { decideMessageFlow, getAdaptiveDebounceMs, checkHumanRequest, extractTextMessage } = require('../services/pipeline');
const { state } = require('../config');

// Estado base de un mensaje de cliente normal
const metaCliente = { savedName: 'Cliente A', pushName: 'a', phoneNumber: '56911112222', lid: null };
const ctx = (over) => ({
    textMessage: 'hola',
    metadata: metaCliente,
    contactRecord: { estado: 'neutro' },
    isSelf: false,
    isFromMe: false,
    ...over
});

test('pipeline: self-chat -> comando admin o asistente IA', () => {
    assert.deepStrictEqual(
        decideMessageFlow(ctx({ isSelf: true, textMessage: '/p 56911112222' })),
        { type: 'admin_command', text: '/p 56911112222' }
    );
    assert.deepStrictEqual(
        decideMessageFlow(ctx({ isSelf: true, textMessage: 'hola' })),
        { type: 'self_chat_ai', text: 'hola' }
    );
});

test('pipeline: mensajes propios en chat de cliente se ignoran', () => {
    assert.deepStrictEqual(decideMessageFlow(ctx({ isFromMe: true })), { type: 'ignore', reason: 'from_me' });
});

test('pipeline: clientes no pueden ejecutar comandos /', () => {
    assert.deepStrictEqual(decideMessageFlow(ctx({ textMessage: '/admin x' })), { type: 'ignore', reason: 'client_command' });
});

test('pipeline: bot pausado globalmente ignora clientes', () => {
    state.IS_BOT_PAUSED = true;
    assert.deepStrictEqual(decideMessageFlow(ctx()), { type: 'ignore', reason: 'paused' });
    state.IS_BOT_PAUSED = false;
});

test('pipeline: estado del contacto (ignorado/permitido/handoff)', () => {
    assert.deepStrictEqual(decideMessageFlow(ctx({ contactRecord: { estado: 'ignorado' } })), { type: 'ignore', reason: 'estado_ignorado' });
    assert.strictEqual(decideMessageFlow(ctx({ contactRecord: { estado: 'permitido' } })).type, 'respond');
    assert.deepStrictEqual(decideMessageFlow(ctx({ contactRecord: { estado: 'handoff' } })), { type: 'ignore', reason: 'handoff_activo' });
});

test('pipeline: modo global estricto solo deja pasar permitidos', () => {
    state.GLOBAL_MODE = 'ignored_all';
    assert.deepStrictEqual(decideMessageFlow(ctx()), { type: 'ignore', reason: 'modo_global_estricto' });
    assert.strictEqual(decideMessageFlow(ctx({ contactRecord: { estado: 'permitido' } })).type, 'respond');
    state.GLOBAL_MODE = 'allowed_all';
    assert.strictEqual(decideMessageFlow(ctx()).type, 'respond');
});

test('pipeline: handoff por palabras clave', () => {
    const ho = decideMessageFlow(ctx({ textMessage: 'quiero hablar con una persona por favor' }));
    assert.strictEqual(ho.type, 'handoff');
    assert.strictEqual(ho.targetId, '56911112222');
    assert.ok(ho.adminNotify.includes('SOLICITUD DE ATENCIÓN HUMANA'));
    assert.ok(ho.adminNotify.includes('/auto 56911112222'));
});

test('checkHumanRequest: solo keywords reales', () => {
    assert.strictEqual(checkHumanRequest('hablar con una persona'), true);
    assert.strictEqual(checkHumanRequest('atencion humana'), true);
    assert.strictEqual(checkHumanRequest('necesito un ejecutivo'), true);
    assert.strictEqual(checkHumanRequest('hola, ¿cuánto cuesta?'), false);
    assert.strictEqual(checkHumanRequest(null), false);
    assert.strictEqual(checkHumanRequest(''), false);
});

test('getAdaptiveDebounceMs: rangos con rng inyectable', () => {
    // roll < 0.05 -> AFK 180-240s
    const afk = getAdaptiveDebounceMs([], () => 0.01);
    assert.ok(afk >= 180000 && afk <= 240000, `AFK fuera de rango: ${afk}`);
    // 0.05 <= roll < 0.17 -> ocupado 60-120s
    const busy = getAdaptiveDebounceMs([], () => 0.10);
    assert.ok(busy >= 60000 && busy <= 120000, `busy fuera de rango: ${busy}`);
    // roll >= 0.17: 1 msg corto -> 5-7s; largo/múltiple -> 7.5-12s
    const corto = getAdaptiveDebounceMs(['hola'], () => 0.5);
    assert.ok(corto >= 5000 && corto <= 7000, `corto fuera de rango: ${corto}`);
    const largo = getAdaptiveDebounceMs(['mensaje largo de prueba para exceder el umbral de caracteres'], () => 0.5);
    assert.ok(largo >= 7500 && largo <= 12000, `largo fuera de rango: ${largo}`);
    const multi = getAdaptiveDebounceMs(['a', 'b', 'c'], () => 0.5);
    assert.ok(multi >= 7500 && multi <= 12000, `multi fuera de rango: ${multi}`);
});

test('extractTextMessage: extrae texto de todos los tipos de mensaje', () => {
    assert.strictEqual(extractTextMessage({ message: { conversation: 'hola' } }), 'hola');
    assert.strictEqual(extractTextMessage({ message: { extendedTextMessage: { text: 'ext' } } }), 'ext');
    assert.strictEqual(extractTextMessage({ message: { imageMessage: { caption: 'foto' } } }), 'foto');
    assert.strictEqual(extractTextMessage({ message: { documentMessage: { caption: 'doc' } } }), 'doc');
    assert.strictEqual(extractTextMessage({ message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'doc2' } } } } }), 'doc2');
    assert.strictEqual(extractTextMessage({ message: { audioMessage: {} } }), '');
    assert.strictEqual(extractTextMessage({}), '');
});
