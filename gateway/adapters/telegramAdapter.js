// @ts-check
/* global AbortController */
const ChannelAdapter = require('../core/ChannelAdapter');
const StandardMessage = require('../core/StandardMessage');
const https = require('https');
const { getSettingsDB } = require('../services/db');
const { updateTelegramMenu, classifyPollResponse } = require('../services/telegramService');
const { registerSentMessage, isBotSentMessage } = require('../config');
const { transcribeAudio } = require('../services/stt');
const { num } = require('../tuning');
const { cat } = require('../services/logger');
const { requestJson, failure } = require('../services/telegramHttp');
const { setTimeout: delay, setImmediate: yieldLoop } = require('node:timers/promises');

const log = cat('TELEGRAM');
const logError = cat('ERROR');

class TelegramAdapter extends ChannelAdapter {
    constructor({ getUpdates = requestUpdates, updateMenu = updateTelegramMenu, transcribe = transcribeAudio,
        pollTimeoutMs = 35000, retryMs = 5000, discoveryTimeoutMs = 1500 } = {}) {
        super('telegram');
        this.pollerActive = false;
        this.lastUpdateId = 0;
        this.token = null;
        this.adminChatId = null;
        // Generación del loop de polling: al reconectar (ej: token nuevo
        // guardado desde el panel) la generación cambia y el loop viejo
        // termina solo, sin dejar dos loops compitiendo por getUpdates.
        this.pollGeneration = 0;
        this.getUpdates = getUpdates;
        this.updateMenu = updateMenu;
        this.transcribe = transcribe;
        this.pollTimeoutMs = pollTimeoutMs;
        this.retryMs = retryMs;
        this.discoveryTimeoutMs = discoveryTimeoutMs;
        this.lifecycle = Promise.resolve();
        /** @type {Promise<any>} */
        this.pollRequest = Promise.resolve();
        /** @type {AbortController|null} */
        this.pollAbort = null;
        this.runningGeneration = -1;
        this.offsetToken = null;
        /** @type {{id:string, at:number}|null} */
        this.lastChat = null;
        this.chatWaiters = new Set();
    }

    connect() {
        const gen = this.invalidatePolling();
        const task = this.lifecycle.then(async () => {
            // The cancelled HTTP request must really close before its successor.
            await this.pollRequest.catch(() => {});
            if (gen !== this.pollGeneration) return;
            const settings = getSettingsDB();
            const token = typeof settings.telegramToken === 'string' ? settings.telegramToken.trim() || null : null;
            if (token !== this.offsetToken) this.lastUpdateId = 0;
            this.offsetToken = token;
            this.token = token;
            this.adminChatId = String(settings.telegramChatId || '');
            if (!token) { this.setStatus('standby', 'sin_token'); return; }
            if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(token)) { this.setStatus('standby', 'token_invalido'); return; }
            this.pollAbort = new AbortController();
            this.pollerActive = true;
            this.setStatus('open');
            this.emit('ready', { adminLid: this.adminChatId });
            void this.updateMenu(token).catch(() => log.error('No se pudo actualizar el menú Telegram.'));
            void this.poll(gen, token, this.pollAbort.signal).catch(() => logError.error('Falló el ciclo de Telegram.'));
        });
        this.lifecycle = task.catch(() => {});
        return task;
    }

    invalidatePolling() {
        this.pollerActive = false;
        this.pollAbort?.abort();
        this.lastChat = null;
        for (const waiter of this.chatWaiters) waiter.reject(failure('TG_CONNECTION_CHANGED', 'La conexión de Telegram cambió. Guarda el token y vuelve a probar.'));
        return ++this.pollGeneration;
    }

    disconnect() {
        const gen = this.invalidatePolling();
        const task = this.lifecycle.then(async () => {
            await this.pollRequest.catch(() => {});
            if (gen !== this.pollGeneration) return;
            this.token = null;
            this.setStatus('disconnected');
        });
        this.lifecycle = task.catch(() => {});
        return task;
    }

    /** Discovery observes the configured owner; it never reads/acks the source.
     * @param {string} token
     * @param {{signal?:AbortSignal}} [options]
     * @returns {Promise<string>}
     */
    async discoverChatId(token, { signal } = {}) {
        if (!token || token !== this.token) throw failure('TG_SAVE_TOKEN_FIRST', 'Guarda primero este token, envía /start al bot en Telegram y vuelve a probar.');
        if (!this.pollerActive) throw failure('TG_NOT_CONNECTED', 'Telegram no está conectado. Guarda un token válido y vuelve a probar.');
        if (signal?.aborted) throw failure('TG_REQUEST_CANCELLED');
        if (this.lastChat && Date.now() - this.lastChat.at <= 5 * 60000) return this.lastChat.id;
        if (this.chatWaiters.size >= 64) throw failure('TG_DISCOVERY_BUSY', 'Hay demasiadas pruebas pendientes. Reintenta.');
        return new Promise((resolve, reject) => {
            const finish = (error, id) => {
                clearTimeout(timer); signal?.removeEventListener('abort', cancelled);
                this.chatWaiters.delete(waiter);
                if (error) reject(error); else resolve(id);
            };
            const cancelled = () => finish(failure('TG_REQUEST_CANCELLED'), null);
            const timer = setTimeout(() => finish(failure('TG_CHAT_NOT_OBSERVED', 'No se observó un chat reciente. Envía /start al bot y vuelve a probar.'), null), this.discoveryTimeoutMs);
            const waiter = { resolve: id => finish(null, id), reject: error => finish(error, null) };
            this.chatWaiters.add(waiter);
            signal?.addEventListener('abort', cancelled, { once: true });
        });
    }

    observeChat(msg) {
        const raw = msg?.chat?.id;
        const id = typeof raw === 'string' ? raw : Number.isSafeInteger(raw) ? String(raw) : '';
        if (!/^-?[1-9]\d*$/.test(id)) return;
        this.lastChat = { id, at: Date.now() };
        for (const waiter of this.chatWaiters) waiter.resolve(id);
    }

    isCurrent(gen, token) {
        return this.pollerActive && gen === this.pollGeneration && token === this.token;
    }

    async poll(gen = this.pollGeneration, token = this.token, signal = this.pollAbort?.signal) {
        if (!token || !signal || !this.isCurrent(gen, token) || this.runningGeneration === gen) return;
        this.runningGeneration = gen;
        try {
            while (this.isCurrent(gen, token)) {
                try {
                    this.pollRequest = this.getUpdates({ token, offset: this.lastUpdateId + 1, signal, timeoutMs: this.pollTimeoutMs });
                    const updates = await this.pollRequest;
                    if (!this.isCurrent(gen, token)) return;
                    if (updates?.ok && Array.isArray(updates.result)) {
                        for (const u of updates.result) {
                            if (!this.isCurrent(gen, token)) return;
                            // Legacy RAM cursor only. Durable admission/ACK is F2C.2.
                            this.lastUpdateId = Math.max(this.lastUpdateId, u.update_id);
                            const msg = u.message;
                            if (!msg) continue;
                            this.observeChat(msg);
                            if (msg.message_id && isBotSentMessage(msg.message_id)) continue;
                            if ((msg.voice || msg.audio) && num('AUDIO_STT_ENABLED', 0) === 1) {
                                await this._maybeHandleAudio(u, msg, { token, gen, signal });
                                continue;
                            }
                            if (msg.text) {
                                const tgChatId = String(msg.chat.id);
                                const pushName = msg.from?.first_name || 'Desconocido';
                                const username = msg.from?.username;
                                this.emit('message', new StandardMessage({
                                    channel: 'telegram', remoteId: `telegram:${tgChatId}`, rawId: tgChatId, text: msg.text,
                                    metadata: { pushName: username ? `${pushName} (@${username})` : pushName,
                                        savedName: null, phoneNumber: null, lid: tgChatId, isBusiness: false,
                                        country: 'Desconocido', isFromMe: false, isAdminChannel: tgChatId === this.adminChatId }, raw: msg
                                }));
                            }
                        }
                    } else {
                        if (classifyPollResponse(updates) === 'auth' || updates?.error_code >= 400 && updates.error_code < 500) {
                            this.pollerActive = false;
                            for (const waiter of this.chatWaiters) waiter.reject(failure('TG_NOT_CONNECTED', 'Telegram rechazó la conexión. Revisa el token y vuelve a guardar.'));
                            this.setStatus('standby', classifyPollResponse(updates) === 'auth' ? 'token_invalido' : 'error_polling');
                            return;
                        }
                        throw failure('TG_POLL_FAILED');
                    }
                } catch {
                    if (!this.isCurrent(gen, token)) return;
                    log.error('No se pudo consultar Telegram; reintento tras la pausa de recuperación.');
                    await delay(this.retryMs, undefined, { signal }).catch(() => {});
                }
                await yieldLoop();
            }
        } finally { if (this.runningGeneration === gen) this.runningGeneration = -1; }
    }

    async sendMessage(normalizedJid, text, options = {}) {
        if (!this.token) throw new Error('Telegram token no configurado');
        const tgChatId = normalizedJid.replace('telegram:', '');
        const useMarkdown = options.useMarkdown !== false;

        return new Promise((resolve, reject) => {
            const payload = { chat_id: tgChatId, text: text };
            if (useMarkdown) payload.parse_mode = 'Markdown';

            const data = JSON.stringify(payload);
            const req = https.request({
                hostname: 'api.telegram.org',
                family: 4,
                port: 443,
                path: `/bot${this.token}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        const bodyJson = JSON.parse(body);
                        // 🛑 Registrar el message_id para el anti-bucle del poller
                        if (bodyJson && bodyJson.result && bodyJson.result.message_id) {
                            registerSentMessage({ message_id: bodyJson.result.message_id });
                        }
                        resolve(bodyJson);
                    } else if (useMarkdown && res.statusCode === 400 && body.includes("can't parse entities")) {
                        // Retry without markdown
                        this.sendMessage(normalizedJid, text, { ...options, useMarkdown: false })
                            .then(resolve)
                            .catch(reject);
                    } else {
                        reject(new Error(`Telegram error ${res.statusCode}: ${body}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    async sendPresenceUpdate(status, normalizedJid) {
        // Telegram supports 'typing' action
        if (!normalizedJid || !this.token) return;
        if (status !== 'composing') return; // we only simulate composing
        
        const tgChatId = normalizedJid.replace('telegram:', '');
        const data = JSON.stringify({ chat_id: tgChatId, action: 'typing' });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.telegram.org',
                family: 4,
                port: 443,
                path: `/bot${this.token}/sendChatAction`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    async requestPairingCode() {
        throw new Error('Telegram no soporta requestPairingCode');
    }

    /**
     * 🎤 STT local (Telegram): descarga el audio (voice/audio) vía getFile,
     * lo transcribe y emite un StandardMessage con el texto normalizado.
     * @param {any} update - update completo de Telegram (tiene .message.chat.id)
     * @param {any} msg - update.message (con .voice o .audio y .from)
     * @param {{token:string, gen:number, signal:AbortSignal}} session
     */
    async _maybeHandleAudio(update, msg, session) {
        const current = () => this.isCurrent(session.gen, session.token) && !session.signal.aborted;
        if (!current()) return;
        const voiceOrAudio = msg.voice || msg.audio;
        if (!voiceOrAudio) return;

        const tgChatId = String(msg.chat.id);
        const isAdmin = (tgChatId === this.adminChatId);
        const pushName = msg.from?.first_name || 'Desconocido';
        const username = msg.from?.username;
        const fullName = username ? `${pushName} (@${username})` : pushName;

        // Tope de duración (Telegram da `duration` en segundos).
        const seconds = Number(voiceOrAudio.duration) || 0;
        const maxSeconds = num('STT_MAX_SECONDS', 120);
        if (seconds > maxSeconds) {
            log.warn(`🎤 Audio TG de ${seconds}s excede tope (${maxSeconds}s). Ignorado.`);
            await this.sendMessage(`telegram:${tgChatId}`,
                `🎤 Audio muy largo (${seconds}s). Máximo ${maxSeconds}s por ahora.`).catch(() => {});
            return;
        }

        try {
            await this.sendPresenceUpdate('composing', `telegram:${tgChatId}`).catch(() => {});

            if (!current()) return;
            // 1) getFile -> file_path
            const fileId = voiceOrAudio.file_id;
            const getFileUrl = `https://api.telegram.org/bot${session.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
            const info = /** @type {any} */ (await fetchJson(getFileUrl, session.signal));
            if (!current()) return;
            if (!info || !info.ok || !info.result || !info.result.file_path) {
                log.warn('🎤 TG getFile falló: ' + JSON.stringify(info));
                return;
            }
            // 2) descargar el binario
            const dlUrl = `https://api.telegram.org/file/bot${session.token}/${info.result.file_path}`;
            const buffer = await downloadBytes(dlUrl, session.signal);
            if (!buffer || buffer.length === 0) {
                log.warn('🎤 TG no se pudo descargar el audio.');
                return;
            }

            const ext = (info.result.file_path.split('.').pop() || 'oga').toLowerCase();
            if (!current()) return;
            const transcript = await this.transcribe(buffer, `tg-audio.${ext}`, { language: 'es', signal: session.signal });
            if (!current()) return;
            if (!transcript) {
                log.warn('🎤 STT TG no devolvió transcripción.');
                return;
            }

            log.info(`🎤 [AUDIO TG TRANSCRITO] ${tgChatId}: "${transcript}"`);
            const stdMsg = new StandardMessage({
                channel: 'telegram',
                remoteId: `telegram:${tgChatId}`,
                rawId: tgChatId,
                text: transcript,
                transcript: transcript,
                isAudio: true,
                metadata: {
                    pushName: fullName,
                    savedName: null,
                    phoneNumber: null,
                    lid: tgChatId,
                    isBusiness: false,
                    country: 'Desconocido',
                    isFromMe: false,
                    isAdminChannel: isAdmin
                },
                raw: msg
            });
            this.emit('message', stdMsg);
        } catch (err) {
            if (!current()) return;
            const e = /** @type {any} */ (err);
            logError.error('🎤 Error en STT de Telegram: ' + (e && e.message));
        }
    }
}

module.exports = TelegramAdapter;

/** GET JSON con timeout explícito (ADR-004). */
async function fetchJson(url, signal) {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!res.ok) return null;
    return res.json();
}

/** Descarga bytes con timeout explícito (ADR-004). */
async function downloadBytes(url, signal) {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}

/** The only getUpdates path in the application. No discovery offset/reader. */
function requestUpdates({ token, offset, signal, timeoutMs }) {
    return requestJson({ path: `/bot${token}/getUpdates?offset=${offset}&timeout=30`, signal, timeoutMs });
}
