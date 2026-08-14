// @ts-check
/**
 * 🎛️ TUNING CENTRALIZADO DEL GATEWAY (Opción A, sin nuevas dependencias).
 *
 * Lee el archivo .env.tuning de la RAÍZ del repo (hermano de gateway/).
 * Esa es la única fuente de constantes tunables; NO contiene secretos.
 *
 * Reglas:
 *  - Formato: CLAVE=valor (sin comillas, sin espacios alrededor del =).
 *  - Líneas que empiezan con # o vacías se ignoran.
 *  - Si una var YA está en process.env, process.env gana (override del sistema).
 *  - Si .env.tuning no existe, todas las constantes usan su default hardcodeado
 *    en cada módulo (comportamiento legacy idéntico).
 *
 * helpers: num() / str() para leer con default tipado desde cualquier módulo.
 */
const fs = require('fs');
const path = require('path');

const TUNING_PATH = path.join(__dirname, '..', '.env.tuning');

/** @type {Record<string, string>} */
const _cache = {};

try {
    if (fs.existsSync(TUNING_PATH)) {
        const raw = fs.readFileSync(TUNING_PATH, 'utf-8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            if (key) _cache[key] = value;
        }
    }
} catch (e) {
    // Si falla la lectura, simplemente no hay tuning y cada módulo usa su default.
}

/**
 * Lee una clave de tuning. process.env tiene prioridad sobre .env.tuning.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function str(key, fallback) {
    if (process.env[key] !== undefined) return process.env[key];
    return _cache[key] !== undefined ? _cache[key] : fallback;
}

/**
 * Igual que str() pero convierte a número. Si no es número válido, usa fallback.
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function num(key, fallback) {
    const v = str(key, String(fallback));
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

module.exports = { str, num, TUNING_PATH };
