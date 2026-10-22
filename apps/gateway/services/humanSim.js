// @ts-check
/**
 * 🎭 SIMULACIÓN HUMANA (funciones puras, sin I/O).
 *
 * Separadas de brainService para que las reglas de realismo (tamaño de
 * globos, tiempos de lectura/tecleo) sean testeables y reutilizables por
 * cualquier canal. Nada aquí toca red, reloj del sistema ni estado global:
 * entra texto, sale texto/tiempo determinista salvo el jitter aleatorio.
 *
 * Todos los parámetros son TUNABLES vía .env.tuning (ver gateway/tuning.js):
 *   GATEWAY_BUBBLE_MAX_CHARS, GATEWAY_READ_DELAY_MIN_MS/_MAX_MS,
 *   GATEWAY_TYPING_MS_PER_CHAR_MIN/_MAX, GATEWAY_TYPING_MIN_MS/_MAX_MS,
 *   GATEWAY_PAUSE_BETWEEN_BUBBLES_MIN_MS/_MAX_MS.
 */

const { num } = require('../tuning');

/** Tamaño objetivo máximo por globo (chars) */
const BUBBLE_MAX_CHARS = num('GATEWAY_BUBBLE_MAX_CHARS', 220);

/** Tiempo de lectura/pensamiento antes de teclear (ms). */
const READ_DELAY_MIN_MS = num('GATEWAY_READ_DELAY_MIN_MS', 1000);
const READ_DELAY_MAX_MS = num('GATEWAY_READ_DELAY_MAX_MS', 3000);
const READ_DELAY_JITTER_MS = num('GATEWAY_READ_DELAY_JITTER_MS', 600); // ±300ms

/** Velocidad de tecleo: ms por carácter (rango). */
const TYPING_MS_PER_CHAR_MIN = num('GATEWAY_TYPING_MS_PER_CHAR_MIN', 100);
const TYPING_MS_PER_CHAR_MAX = num('GATEWAY_TYPING_MS_PER_CHAR_MAX', 135);
const TYPING_MIN_MS = num('GATEWAY_TYPING_MIN_MS', 1500);
const TYPING_MAX_MS = num('GATEWAY_TYPING_MAX_MS', 16000);
const TYPING_JITTER_MS = num('GATEWAY_TYPING_JITTER_MS', 1000); // ±500ms

/** Pausa humana entre globos consecutivos (ms). */
const PAUSE_BETWEEN_BUBBLES_MIN_MS = num('GATEWAY_PAUSE_BETWEEN_BUBBLES_MIN_MS', 1000);
const PAUSE_BETWEEN_BUBBLES_MAX_MS = num('GATEWAY_PAUSE_BETWEEN_BUBBLES_MAX_MS', 2200);

/**
 * 🧩 Dividir respuestas largas de la IA en globos de chat naturales (Multi-Bubble)
 * Divide párrafos largos por oraciones (. ! ?) si superan los ~220 caracteres.
 * Acepta cualquier entrada y la devuelve envuelta si no es texto utilizable.
 * @param {any} text
 * @returns {string[]}
 */
function splitIntoHumanBubbles(text) {
    if (!text || typeof text !== 'string') return [text];
    const trimmed = text.trim();
    if (trimmed.length <= BUBBLE_MAX_CHARS) return [trimmed];

    // 1. Separar por párrafos / saltos de línea
    const rawBlocks = trimmed.split(/\n+/).map(b => b.trim()).filter(Boolean);
    let chunks = [];

    for (const block of rawBlocks) {
        if (block.length <= 250) {
            chunks.push(block);
        } else {
            // Si el bloque es muy largo (>250 chars) sin saltos de línea, dividir por oraciones (. ! ?)
            const sentences = block.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
            let currentChunk = '';

            for (const s of sentences) {
                if (!currentChunk) {
                    currentChunk = s;
                } else if ((currentChunk.length + s.length + 1) <= BUBBLE_MAX_CHARS) {
                    currentChunk += ' ' + s;
                } else {
                    chunks.push(currentChunk);
                    currentChunk = s;
                }
            }
            if (currentChunk) chunks.push(currentChunk);
        }
    }

    // 2. Reagrupar fragmentos manteniendo un tamaño cómodo por globo (~220 chars máx)
    const finalBubbles = [];
    let currentBubble = '';

    for (const chunk of chunks) {
        if (!currentBubble) {
            currentBubble = chunk;
        } else if ((currentBubble.length + chunk.length + 1) <= BUBBLE_MAX_CHARS) {
            currentBubble += ' ' + chunk;
        } else {
            finalBubbles.push(currentBubble);
            currentBubble = chunk;
        }
    }
    if (currentBubble) finalBubbles.push(currentBubble);

    return finalBubbles.length > 0 ? finalBubbles : [trimmed];
}

/**
 * 🧠 Calcular tiempo de lectura/pensamiento inicial antes de empezar a teclear.
 * @param {string} incomingText
 * @returns {number} ms (800..~3300)
 */
function calculateReadDelay(incomingText) {
    const len = (incomingText || '').length;
    const baseReadMs = Math.min(Math.max(len * 15, READ_DELAY_MIN_MS), READ_DELAY_MAX_MS);
    const readJitter = (Math.random() - 0.5) * READ_DELAY_JITTER_MS; // ±(JITTER/2) de varianza
    return Math.max(Math.round(baseReadMs + readJitter), READ_DELAY_MIN_MS);
}

/**
 * ⌨️ Calcular tiempo de tecleo ultra-realista con ruido estocástico (Jitter)
 * Basado en velocidad rápida de teclado móvil: ~7 a 10 caracteres por segundo (100ms a 135ms por carácter)
 * @param {string} bubbleText
 * @returns {number} ms (TYPING_MIN_MS..TYPING_MAX_MS)
 */
function calculateTypingDelay(bubbleText) {
    const len = (bubbleText || '').length;
    const msPerChar = TYPING_MS_PER_CHAR_MIN + Math.random() * (TYPING_MS_PER_CHAR_MAX - TYPING_MS_PER_CHAR_MIN);
    const baseTypingMs = len * msPerChar;
    const typingJitter = (Math.random() - 0.5) * TYPING_JITTER_MS; // ±(JITTER/2) de ruido estocástico
    return Math.min(Math.max(Math.round(baseTypingMs + typingJitter), TYPING_MIN_MS), TYPING_MAX_MS);
}

/**
 * ☕ Pausa humana entre globos consecutivos.
 * @returns {number} ms
 */
function calculatePauseBetweenBubbles() {
    return PAUSE_BETWEEN_BUBBLES_MIN_MS + Math.floor(Math.random() * (PAUSE_BETWEEN_BUBBLES_MAX_MS - PAUSE_BETWEEN_BUBBLES_MIN_MS));
}

module.exports = {
    BUBBLE_MAX_CHARS,
    splitIntoHumanBubbles,
    calculateReadDelay,
    calculateTypingDelay,
    calculatePauseBetweenBubbles
};
