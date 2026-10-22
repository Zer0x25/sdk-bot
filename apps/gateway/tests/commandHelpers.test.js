const { test } = require('node:test');
const assert = require('node:assert');
const {
    sanitizeMarkdown,
    parsePhoneOrLid,
    isValidTargetId,
    whatsappTargetContext,
    usageOf,
    syntaxError,
    chunkAdminText,
    extractPhoneFromQuoted
} = require('../handlers/commandHelpers');

test('parsePhoneOrLid: teléfono formateado nativo -> dígitos puros', () => {
    assert.strictEqual(parsePhoneOrLid('+56 9 4252 3669'), '56942523669');
    assert.strictEqual(parsePhoneOrLid('+56-9-4252-3669'), '56942523669');
    assert.strictEqual(parsePhoneOrLid('(56) 9 4252 3669'), '56942523669');
    assert.strictEqual(parsePhoneOrLid('56942523669'), '56942523669');
});

test('Telegram admin commands resolve customer targets through the WhatsApp account', () => {
    assert.deepStrictEqual(whatsappTargetContext({ channelName: 'whatsapp', accountId: 'wa-account' }),
        { channel: 'whatsapp', accountId: 'wa-account' });
    assert.deepStrictEqual(whatsappTargetContext({ channelName: 'telegram', accountId: 'tg-account' }),
        { channel: 'whatsapp', accountId: null });
    assert.deepStrictEqual(whatsappTargetContext(null), { channel: 'whatsapp', accountId: null });
});

test('parsePhoneOrLid: comodín y casos límite', () => {
    assert.strictEqual(parsePhoneOrLid('*'), '*');
    assert.strictEqual(parsePhoneOrLid(''), '');
    assert.strictEqual(parsePhoneOrLid(null), '');
    // Menos de 7 dígitos: se devuelve tal cual (no es un target válido)
    assert.strictEqual(parsePhoneOrLid('12345'), '12345');
    assert.strictEqual(parsePhoneOrLid('abc'), 'abc');
});

test('parsePhoneOrLid: LID de 15+ dígitos', () => {
    assert.strictEqual(parsePhoneOrLid('272048244940855'), '272048244940855');
});

test('isValidTargetId: * o 7+ dígitos', () => {
    assert.strictEqual(isValidTargetId('*'), true);
    assert.strictEqual(isValidTargetId('56942523669'), true);
    assert.strictEqual(isValidTargetId('1234567'), true);
    assert.strictEqual(isValidTargetId('123456'), false);
    assert.strictEqual(isValidTargetId('holamundo'), false);
    assert.strictEqual(isValidTargetId('*'), true);
});

test('sanitizeMarkdown: neutraliza formato y saltos de línea', () => {
    assert.strictEqual(sanitizeMarkdown('*hola* _mundo_ `cod` ~tach~'), 'hola mundo cod tach');
    assert.strictEqual(sanitizeMarkdown('linea1\nlinea2'), 'linea1 linea2');
    assert.strictEqual(sanitizeMarkdown(null), '');
    assert.strictEqual(sanitizeMarkdown(''), '');
});

test('usageOf / syntaxError: help por comando + error con detalle', () => {
    assert.strictEqual(usageOf('permitir').startsWith('⚠️ *Uso:* /permitir'), true);
    assert.strictEqual(usageOf('noexiste'), '⚠️ *Uso:* revisa el menú con `/e`');
    const err = syntaxError('permitir', 'ID no válido: *"x"*.');
    assert.ok(err.startsWith('⚠️ ID no válido: *"x"*.'));
    assert.ok(err.includes(usageOf('permitir')));
});

test('chunkAdminText: respeta saltos de línea y divide >2800 chars', () => {
    const corto = 'respuesta corta';
    assert.deepStrictEqual(chunkAdminText(corto), [corto]);
    assert.deepStrictEqual(chunkAdminText(''), []);
    assert.deepStrictEqual(chunkAdminText(null), []);

    // Líneas largas se cortan por el límite
    const larga = 'x'.repeat(3000);
    const chunks = chunkAdminText(larga);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(c => c.length <= 2800));
    assert.strictEqual(chunks.join(''), larga);

    // Los saltos de línea no se pierden (no corta a mitad de un item de lista)
    const listText = Array.from({ length: 100 }, (_, i) => `• item ${i}`).join('\n');
    const listChunks = chunkAdminText(listText);
    assert.ok(listChunks.every(c => c.split('\n').every(l => l.startsWith('• item '))));
    assert.strictEqual(listChunks.join('\n'), listText);
});

test('extractPhoneFromQuoted: extrae teléfono del texto citado', () => {
    const rawMsg = {
        message: {
            extendedTextMessage: {
                contextInfo: {
                    quotedMessage: { conversation: '🚨 Alert: +56 9 1234 5678 necesita humano' }
                }
            }
        }
    };
    assert.strictEqual(extractPhoneFromQuoted(rawMsg), '56912345678');

    const rawMsgText = {
        message: {
            extendedTextMessage: {
                contextInfo: {
                    quotedMessage: { extendedTextMessage: { text: 'Cliente: 56942523669' } }
                }
            }
        }
    };
    assert.strictEqual(extractPhoneFromQuoted(rawMsgText), '56942523669');
});

test('extractPhoneFromQuoted: sin teléfono -> vacío', () => {
    const rawMsg = {
        message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: 'hola mundo' } } } }
    };
    assert.strictEqual(extractPhoneFromQuoted(rawMsg), '');
    assert.strictEqual(extractPhoneFromQuoted(null), '');
    assert.strictEqual(extractPhoneFromQuoted({}), '');
});
