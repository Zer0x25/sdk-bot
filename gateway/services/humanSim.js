// @ts-check
/**
 * 🎭 SIMULACIÓN HUMANA (funciones puras, sin I/O).
 *
 * Separadas de brainService para que las reglas de realismo (tamaño de
 * globos, tiempos de lectura/tecleo) sean testeables y reutilizables por
 * cualquier canal. Nada aquí toca red, reloj del sistema ni estado global:
 * entra texto, sale texto/tiempo determinista salvo el jitter aleatorio.
 */

/** Tamaño objetivo máximo por globo (chars) */
const BUBBLE_MAX_CHARS = 220;

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
    const baseReadMs = Math.min(Math.max(len * 15, 1000), 3000);
    const readJitter = (Math.random() - 0.5) * 600; // ±300ms de varianza
    return Math.max(Math.round(baseReadMs + readJitter), 800);
}

/**
 * ⌨️ Calcular tiempo de tecleo ultra-realista con ruido estocástico (Jitter)
 * Basado en velocidad rápida de teclado móvil: ~7 a 10 caracteres por segundo (100ms a 135ms por carácter)
 * @param {string} bubbleText
 * @returns {number} ms (1500..16000)
 */
function calculateTypingDelay(bubbleText) {
    const len = (bubbleText || '').length;
    const msPerChar = 100 + Math.random() * 35; // 100ms a 135ms por carácter (7 - 10 char/s)
    const baseTypingMs = len * msPerChar;
    const typingJitter = (Math.random() - 0.5) * 1000; // ±500ms de ruido estocástico
    return Math.min(Math.max(Math.round(baseTypingMs + typingJitter), 1500), 16000);
}

/**
 * ☕ Pausa humana entre globos consecutivos (1.0s–2.2s).
 * @returns {number} ms
 */
function calculatePauseBetweenBubbles() {
    return 1000 + Math.floor(Math.random() * 1200);
}

module.exports = {
    BUBBLE_MAX_CHARS,
    splitIntoHumanBubbles,
    calculateReadDelay,
    calculateTypingDelay,
    calculatePauseBetweenBubbles
};
