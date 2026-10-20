// @ts-check
/* global FormData, Blob */
/**
 * 🎤 CLIENTE STT LOCAL (speech-to-text).
 *
 * El gateway descarga el audio del canal (WhatsApp/Telegram) y lo manda al
 * servicio faster-whisper del repo (stt/server.py), que expone un endpoint
 * OpenAI-compatible: POST /v1/audio/transcriptions -> {"text": "..."}.
 *
 * Contrato de resiliencia (ADR-004):
 *   - Todo fetch lleva AbortSignal.timeout(STT_TIMEOUT_MS) explícito.
 *   - 4xx (413 audio gigante, 422 codec corrupto, 400 vacío) = bug/validación
 *     -> NO se reintenta, se informa tal cual.
 *   - red/timeout/5xx = transitorio -> 1 reintento con backoff corto.
 *   - Si el STT está caído, se devuelve null (el audio se descarta con aviso
 *     en el adapter) y NO se tumba el canal.
 *
 * El gateway es quien "normaliza audio -> texto" (filosofía de StandardMessage
 * y ADR-003: dueño único del transporte por canal). El brain nunca ve audio.
 */
const { STT_API_URL, STT_TIMEOUT_MS } = require('../config');
const { num } = require('../tuning');
const { cat, errMsg } = require('./logger');

const log = cat('STT');

// Tope de tamaño de audio aceptado por el servidor (debe coincidir con
// STT_MAX_UPLOAD_BYTES del server). Por debajo de esto no vale la pena
// transcribir en CPU; el cliente lo rechaza antes de subir.
const MAX_AUDIO_BYTES = num('STT_MAX_UPLOAD_BYTES', 5 * 1024 * 1024);
// Tope de duración en segundos (aprox por tamaño). > esto -> rechazo con aviso.
const MAX_AUDIO_SECONDS = num('STT_MAX_SECONDS', 120); // 2 min
// Backoff del 1 reintento transitorio.
const RETRY_BACKOFF_MS = 1500;

/**
 * Transcribe un buffer de audio.
 * @param {Buffer} audioBuffer - bytes del audio (ogg/opus/mp3/wav/m4a)
 * @param {string} filename - nombre con extensión para sugerir el codec
 * @param {object} [opts]
 * @param {string} [opts.language] - forzar idioma (ej. "es")
 * @param {AbortSignal} [opts.signal] - cancela trabajo de un socket reemplazado
 * @returns {Promise<string|null>} texto transcrito, o null si no se pudo
 */
async function transcribeAudio(audioBuffer, filename, opts = {}) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        log.warn('⚠️ STT: audio vacío, se ignora.');
        return null;
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
        log.warn(`⚠️ STT: audio demasiado grande (${audioBuffer.length} > ${MAX_AUDIO_BYTES}). Se rechaza.`);
        return null;
    }

    const form = new FormData();
    // Node 20+ tiene FormData global; el blob necesita el tipo mime aproximado.
    const ext = (filename.split('.').pop() || 'ogg').toLowerCase();
    const mime = ({
        ogg: 'audio/ogg', opus: 'audio/ogg', oga: 'audio/ogg',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm'
    })[ext] || 'audio/ogg';
    form.append('file', new Blob([new Uint8Array(audioBuffer)], { type: mime }), filename);
    form.append('model', 'whisper-1'); // ignorado por el server, compat OpenAI
    if (opts.language) form.append('language', opts.language);

    return postWithRetry(form, opts.signal);
}

/**
 * POST al servicio STT con política ADR-004.
 * @param {FormData} form
 * @param {AbortSignal} [signal]
 * @returns {Promise<string|null>}
 */
async function postWithRetry(form, signal) {
    /** @type {Error & {status?: number} | null} */
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) return null;
        try {
            const res = await fetch(`${STT_API_URL}/v1/audio/transcriptions`, {
                method: 'POST',
                body: form,
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(STT_TIMEOUT_MS)]) : AbortSignal.timeout(STT_TIMEOUT_MS)
            });
            if (!res.ok) {
                // 4xx = validación/bug -> NO reintentar.
                const detail = await res.text().catch(() => `HTTP ${res.status}`);
                if (res.status < 500) {
                    log.warn(`⚠️ STT rechazó (${res.status}): ${detail}`);
                    return null;
                }
                // 5xx = transitorio -> reintentar (si es el intento 0).
                lastErr = Object.assign(new Error(`STT 5xx: ${detail}`), { status: res.status });
                if (attempt === 0) { await backoff(signal); continue; }
                return null;
            }
            const data = await res.json();
            /** @type {any} */
            const parsed = data;
            const text = (parsed && typeof parsed.text === 'string') ? parsed.text.trim() : '';
            return text || null;
        } catch (err) {
            lastErr = /** @type {Error & {status?: number}} */ (err);
            const transient = isTransient(err);
            if (signal?.aborted) return null;
            if (transient && attempt === 0) {
                log.warn(`↻ STT transitorio (${errMsg(err)}). Reintentando (1/1)...`);
                await backoff(signal);
                continue;
            }
            log.error(`❌ STT falló (no transitorio o agotado): ${errMsg(err)}`);
            return null;
        }
    }
    log.error(`❌ STT agotó reintentos: ${errMsg(lastErr)}`);
    return null;
}

/** Red/timeout/abort = transitorio; errores de parseo NO. */
function isTransient(err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    const msg = String(err && err.message || '').toLowerCase();
    return msg.includes('fetch failed') || msg.includes('econnrefused') ||
           msg.includes('timeout') || msg.includes('aborted') ||
           msg.includes('network');
}

function backoff(signal) {
    const { setTimeout: delay } = require('node:timers/promises');
    return delay(RETRY_BACKOFF_MS, undefined, { signal }).catch(() => {});
}

module.exports = { transcribeAudio, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS };
