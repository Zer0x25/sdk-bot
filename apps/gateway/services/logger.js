// @ts-check
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GATEWAY_STATE_DIR } = require('../lib/repoPaths');
const SAFE_ERROR_NAMES = new Set([
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
    'EvalError', 'AggregateError', 'DOMException', 'AbortError', 'TimeoutError', 'FetchError'
]);

const LOG_DIR = process.env.SDK_ADMIN_WEB_LOG_GATEWAY || path.join(GATEWAY_STATE_DIR, 'logs');
const TEST_MODE = process.env.SDK_BOT_TEST === '1' || process.execArgv.includes('--test');
const TEST_LOG_FILE = process.env.SDK_TEST_LOG_PATH || path.join(os.tmpdir(), `sdk-bot-test-${process.pid}.log`);
const LOG_FILE = TEST_MODE ? TEST_LOG_FILE : path.join(LOG_DIR, 'gateway.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

/** @type {any[]} */
const targets = TEST_MODE
    ? [{ target: 'pino/file', options: { destination: LOG_FILE } }]
    : [
        {
            target: 'pino-roll',
            options: {
                file: LOG_FILE,
                size: '5m',
                limit: { count: 3 },
                mkdir: true
            }
        },
        {
            target: 'pino/file',
            options: { destination: 1 }
        }
    ];

const transport = pino.transport({ targets });

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: undefined
}, transport);

function cat(category) {
    return logger.child({ cat: category });
}

/**
 * 🧰 Mensaje de error a string (los catch de JS moderno tipan `unknown`)
 */
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}

/** Return a bounded error category for logs without serializing request data. */
function safeErrorLabel(error) {
    if (!error || typeof error !== 'object') return 'UNCLASSIFIED';
    const code = error.code;
    if (typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(code)) return code.replace(/[0-9]{4,}/g, '[id]');
    const status = Number(error.status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return `HTTP_${status}`;
    const name = error.name;
    if (typeof name === 'string' && SAFE_ERROR_NAMES.has(name)) return name.toUpperCase();
    return 'UNCLASSIFIED';
}

module.exports = { logger, cat, errMsg, safeErrorLabel };
