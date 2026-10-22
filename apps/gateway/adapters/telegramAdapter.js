// @ts-check
/* global AbortController */
const ChannelAdapter = require('../core/ChannelAdapter');
const StandardMessage = require('../core/StandardMessage');
const https = require('https');
const { getSettingsDB } = require('../services/db');
const { updateTelegramMenu, classifyPollResponse } = require('../services/telegramService');
const { transcribeAudio } = require('../services/stt');
const { num } = require('../tuning');
const { cat, safeErrorLabel } = require('../services/logger');
const { requestText, requestJson, failure, parseTelegramJson } = require('../services/telegramHttp');
const { verifiedBotId, normalizeUpdates, createTelegramCapture, normalizeSentMessage, decimalId } = require('../services/conversations/telegramCapture');
const { setTimeout: delay, setImmediate: yieldLoop } = require('node:timers/promises');

const log = cat('TELEGRAM');
const logError = cat('ERROR');
const MAX_ATTACHMENT_DOWNLOAD_BYTES = 16 * 1024 * 1024;

function telegramMediaDescriptor(message) {
    let media, type;
    if (Array.isArray(message?.photo) && message.photo.length) {
        media = message.photo[message.photo.length - 1]; type = 'image';
    } else if (message?.voice) { media = message.voice; type = 'audio'; }
    else if (message?.audio) { media = message.audio; type = 'audio'; }
    else if (message?.video || message?.video_note || message?.animation) {
        media = message.video || message.video_note || message.animation; type = 'video';
    } else if (message?.document) { media = message.document; type = 'document'; }
    if (!media || typeof media.file_id !== 'string' || !media.file_id.length || media.file_id.length > 2048) return null;
    const extension = type === 'image' ? 'jpg' : type === 'audio' ? 'ogg' : type === 'video' ? 'mp4' : 'bin';
    const fileName = typeof media.file_name === 'string' && media.file_name.trim()
        ? media.file_name : `${type}-${message.message_id || 'message'}.${extension}`;
    const contentType = typeof media.mime_type === 'string' ? media.mime_type.split(';')[0].trim()
        : type === 'image' ? 'image/jpeg' : type === 'audio' ? 'audio/ogg' : 'application/octet-stream';
    return { type, media, fileId: media.file_id, fileName, contentType };
}

class TelegramAdapter extends ChannelAdapter {
    /** @param {{archive?:any, attachmentStore?:any, getMe?:(input:any)=>Promise<any>, getUpdates?:(input:any)=>Promise<any>, updateMenu?:(token:string)=>Promise<any>, transcribe?:(buffer:Buffer,name:string,options:any)=>Promise<any>, sendHttpRequest?:(options:any,callback:(response:any)=>void)=>any, pollTimeoutMs?:number, retryMs?:number, discoveryTimeoutMs?:number, sendTimeoutMs?:number, presenceTimeoutMs?:number}} [options] */
    constructor({ archive, attachmentStore, getMe = requestBotIdentity, getUpdates = requestUpdates, updateMenu = updateTelegramMenu, transcribe = transcribeAudio,
        sendHttpRequest = (...args) => https.request(...args), pollTimeoutMs = 35000, retryMs = 5000, discoveryTimeoutMs = 1500,
        sendTimeoutMs = num('TELEGRAM_SEND_TIMEOUT_MS', 10000), presenceTimeoutMs = num('TELEGRAM_PRESENCE_TIMEOUT_MS', 3000) } = {}) {
        super('telegram');
        this.pollerActive = false;
        this.lastUpdateId = null;
        this.token = null;
        this.accountId = null;
        this.adminChatId = null;
        // Generación del loop de polling: al reconectar (ej: token nuevo
        // guardado desde el panel) la generación cambia y el loop viejo
        // termina solo, sin dejar dos loops compitiendo por getUpdates.
        this.pollGeneration = 0;
        this.archive = archive || null;
        this.attachmentStore = attachmentStore || null;
        this.attachmentTasks = new Set();
        this.capture = archive ? createTelegramCapture(archive) : null;
        this.getMe = getMe;
        this.getUpdates = getUpdates;
        this.sendHttpRequest = sendHttpRequest;
        this.updateMenu = updateMenu;
        this.transcribe = transcribe;
        this.pollTimeoutMs = pollTimeoutMs;
        this.retryMs = retryMs;
        this.discoveryTimeoutMs = discoveryTimeoutMs;
        this.sendTimeoutMs = sendTimeoutMs;
        this.presenceTimeoutMs = presenceTimeoutMs;
        this.lifecycle = Promise.resolve();
        /** @type {Promise<any>} */
        this.pollRequest = Promise.resolve();
        /** @type {AbortController|null} */
        this.pollAbort = null;
        this.runningGeneration = -1;
        this.pollTask = Promise.resolve();
        this.pollTasks = new Set();
        this.archiveOperations = new Set();
        /** @type {{id:string, at:number}|null} */
        this.lastChat = null;
        this.chatWaiters = new Set();
    }

    connect() {
        const gen = this.invalidatePolling();
        const task = this.lifecycle.then(async () => {
            // The cancelled HTTP request must really close before its successor.
            await this.pollRequest.catch(() => {});
            await Promise.allSettled([...this.pollTasks]);
            if (!this.isGeneration(gen)) return;
            const settings = getSettingsDB();
            const token = typeof settings.telegramToken === 'string' ? settings.telegramToken.trim() || null : null;
            this.token = token;
            this.adminChatId = decimalId(settings.telegramChatId, { signed: true }) || '';
            if (!token) { this.setStatus('standby', 'sin_token'); return; }
            if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(token)) { this.setStatus('standby', 'token_invalido'); return; }
            this.pollAbort = new AbortController();
            let identity;
            try {
                const response = await this.getMe({ token, signal: this.pollAbort.signal, timeoutMs: 15000 });
                if (!this.isGeneration(gen, token)) return;
                const botId = verifiedBotId(response);
                if (!botId) {
                    const authError = classifyPollResponse(response) === 'auth' || response?.error_code >= 400 && response.error_code < 500;
                    this.setStatus('standby', authError ? 'token_invalido' : 'identidad_no_verificada');
                    return;
                }
                if (!this.capture) { this.setStatus('standby', 'archivo_no_disponible'); return; }
                identity = await this.trackArchive(this.capture.openBot(botId));
            } catch (error) {
                if (!this.isGeneration(gen, token)) return;
                const code = /** @type {any} */ (error)?.code || 'TG_ACCOUNT_SETUP_FAILED';
                log.error(`No se pudo verificar la cuenta o leer su cursor durable (${code}).`);
                this.setStatus('standby', 'error_archivo');
                return;
            }
            if (!this.isGeneration(gen, token)) return;
            this.accountId = identity.accountId;
            this.lastUpdateId = identity.lastUpdateId;
            this.pollerActive = true;
            this.setStatus('open');
            this.emit('ready', { adminLid: this.adminChatId });
            void this.updateMenu(token).catch(() => log.error('No se pudo actualizar el menú Telegram.'));
            const pollTask = this.poll(gen, token, this.pollAbort.signal).catch(() => logError.error('Falló el ciclo de Telegram.'));
            this.pollTask = pollTask;
            this.pollTasks.add(pollTask);
            void pollTask.finally(() => this.pollTasks.delete(pollTask));
        });
        this.lifecycle = task.catch(() => {});
        return task;
    }

    invalidatePolling() {
        this.pollerActive = false;
        this.pollAbort?.abort();
        this.pollAbort = null;
        this.accountId = null;
        this.lastUpdateId = null;
        this.lastChat = null;
        for (const waiter of this.chatWaiters) waiter.reject(failure('TG_CONNECTION_CHANGED', 'La conexión de Telegram cambió. Guarda el token y vuelve a probar.'));
        return ++this.pollGeneration;
    }

    disconnect() {
        const gen = this.invalidatePolling();
        const task = this.lifecycle.then(async () => {
            await this.pollRequest.catch(() => {});
            await Promise.allSettled([...this.pollTasks]);
            await Promise.allSettled([...this.archiveOperations]);
            if (gen !== this.pollGeneration) return;
            this.token = null;
            this.accountId = null;
            this.lastUpdateId = null;
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
        return this.pollerActive && this.isGeneration(gen, token);
    }

    isGeneration(gen, token = this.token) {
        return gen === this.pollGeneration && token === this.token && !this.pollAbort?.signal.aborted;
    }

    trackArchive(operation) {
        const tracked = Promise.resolve(operation);
        this.archiveOperations.add(tracked);
        return tracked.finally(() => this.archiveOperations.delete(tracked));
    }

    queueMediaCapture(message, messageId, session) {
        if (!this.attachmentStore || !this.archive) return null;
        const descriptor = telegramMediaDescriptor(message);
        if (!descriptor) {
            void this.trackArchive(this.archive.markAttachmentCaptureFailed({ messageId })).catch(() => {});
            return null;
        }
        if (this.attachmentTasks.size >= 4) {
            void this.trackArchive(this.archive.markAttachmentCaptureFailed({ messageId })).catch(() => {});
            log.error('Se alcanzó el límite de descargas de medios Telegram.');
            return null;
        }
        const task = Promise.resolve().then(async () => {
            if (!this.isCurrent(session.gen, session.token)) throw Object.assign(new Error('Telegram connection changed.'), { code: 'TG_CONNECTION_CHANGED' });
            const info = /** @type {any} */ (await fetchJson(`https://api.telegram.org/bot${session.token}/getFile?file_id=${encodeURIComponent(descriptor.fileId)}`, session.signal));
            const filePath = info?.ok === true ? info.result?.file_path : null;
            if (typeof filePath !== 'string' || filePath.length > 1024
                || filePath.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) {
                throw Object.assign(new Error('Telegram file metadata unavailable.'), { code: 'TG_MEDIA_FILE_UNAVAILABLE' });
            }
            const downloadPath = filePath.split('/').map(encodeURIComponent).join('/');
            const buffer = await downloadBytes(`https://api.telegram.org/file/bot${session.token}/${downloadPath}`,
                session.signal, MAX_ATTACHMENT_DOWNLOAD_BYTES);
            if (!buffer?.length) throw Object.assign(new Error('Telegram media unavailable or too large.'), { code: 'TG_MEDIA_UNAVAILABLE' });
            if (!this.isCurrent(session.gen, session.token)) throw Object.assign(new Error('Telegram connection changed.'), { code: 'TG_CONNECTION_CHANGED' });
            await this.attachmentStore.store({ messageId, source: buffer, fileName: descriptor.fileName,
                contentType: descriptor.contentType });
            return buffer;
        }).catch(async error => {
            await this.trackArchive(this.archive.markAttachmentCaptureFailed({ messageId })).catch(() => {});
            log.error(`No se pudo archivar un medio Telegram (${safeErrorLabel(error)}).`);
            return null;
        });
        this.attachmentTasks.add(task);
        this.archiveOperations.add(task);
        void task.finally(() => { this.attachmentTasks.delete(task); this.archiveOperations.delete(task); });
        return task;
    }

    async idleAttachments() { await Promise.allSettled([...this.attachmentTasks]); }

    async poll(gen = this.pollGeneration, token = this.token, signal = this.pollAbort?.signal) {
        if (!token || !signal || !this.isCurrent(gen, token) || this.runningGeneration === gen) return;
        this.runningGeneration = gen;
        try {
            while (this.isCurrent(gen, token)) {
                let updates;
                try {
                    const offset = this.lastUpdateId === null ? '0' : String(BigInt(this.lastUpdateId) + 1n);
                    this.pollRequest = this.getUpdates({ token, offset, signal, timeoutMs: this.pollTimeoutMs });
                    updates = await this.pollRequest;
                } catch {
                    if (!this.isCurrent(gen, token)) return;
                    log.error('No se pudo consultar Telegram; reintento tras la pausa de recuperación.');
                    await delay(this.retryMs, undefined, { signal }).catch(() => {});
                    continue;
                }
                if (!this.isCurrent(gen, token)) return;
                if (!updates?.ok || !Array.isArray(updates.result)) {
                    const errorCode = Number(updates?.error_code);
                    if (classifyPollResponse(updates) === 'auth' || errorCode >= 400 && errorCode < 500) {
                        this.pollerActive = false;
                        for (const waiter of this.chatWaiters) waiter.reject(failure('TG_NOT_CONNECTED', 'Telegram rechazó la conexión. Revisa el token y vuelve a guardar.'));
                        this.setStatus('standby', classifyPollResponse(updates) === 'auth' ? 'token_invalido' : 'error_polling');
                        return;
                    }
                    if (errorCode >= 500 || updates?.ok === false) {
                        log.error('Telegram devolvió un error temporal; se reintentará tras la pausa de recuperación.');
                        await delay(this.retryMs, undefined, { signal }).catch(() => {});
                        continue;
                    }
                    log.error('Telegram devolvió una respuesta inválida; no se confirmó ningún update.');
                    this.stopForCapture('respuesta_invalida');
                    return;
                }
                if (updates.result.length) {
                    let observations, committed;
                    const capture = this.capture;
                    const accountId = this.accountId;
                    if (!capture || !accountId) { this.stopForCapture('archivo_no_disponible'); return; }
                    try {
                        observations = normalizeUpdates(updates.result, accountId, this.adminChatId || '', {
                            includeAudio: num('AUDIO_STT_ENABLED', 0) === 1
                        });
                        for (const observation of observations) {
                            if (observation.legacy) this.observeChat({ chat: { id: observation.legacy.chatId } });
                        }
                        committed = await this.trackArchive(capture.commitBatch(accountId, observations));
                        if (committed.results.length !== observations.length) throw failure('TG_CAPTURE_RESULT_INVALID');
                    } catch (error) {
                        if (!this.isCurrent(gen, token)) return;
                        const code = /** @type {any} */ (error)?.code || 'TG_CAPTURE_FAILED';
                        log.error(`No se confirmó el lote Telegram (${code}); el cursor durable no avanzó.`);
                        this.stopForCapture('error_captura');
                        return;
                    }
                    if (!this.isCurrent(gen, token)) return;
                    this.lastUpdateId = committed.lastUpdateId;
                    if (observations.some((observation, index) => observation.adminInbox
                        && committed.results[index]?.status !== 'stale')) this.emit('admin_inbox_pending');
                    let transcriptionFailure = false;
                    for (let i = 0; i < observations.length; i++) {
                        if (!this.isCurrent(gen, token)) return;
                        const observation = observations[i], captured = committed.results[i];
                        if (observation.edit) {
                            if (captured.result?.replacedAttachmentId) {
                                await this.attachmentStore?.sweepExpired();
                            }
                            if (captured.result?.captureAttachment && captured.result.message) {
                                this.queueMediaCapture(updates.result[i].edited_message, captured.result.message.id,
                                    { token, gen, signal });
                            }
                            continue;
                        }
                        const stored = captured.result?.message;
                        if (observation.message && captured.status === 'created' && stored
                            && ['audio','image','video','document'].includes(stored.content.type)) {
                            this.queueMediaCapture(updates.result[i].message, stored.id, { token, gen, signal });
                        }
                        if (!observation.legacy) continue;
                        const legacy = observation.legacy;
                        // Text from the configured admin chat is replayed from the
                        // SQLite inbox after the cursor and payload commit together.
                        if (observation.adminInbox) continue;
                        if (legacy.isAdminChannel ? captured.status === 'stale' : captured.status !== 'created') continue;
                        if (!legacy.isAdminChannel && (!stored || stored.content.type === 'oversized')) continue;
                        if (legacy.audio && num('AUDIO_STT_ENABLED', 0) === 1) {
                            if (transcriptionFailure) continue;
                            try {
                                await this._maybeHandleAudio(updates.result[i], legacy.message, {
                                    token, gen, signal, accountId,
                                    messageId: legacy.isAdminChannel ? null : stored.id
                                });
                            } catch (error) {
                                transcriptionFailure = true;
                                const code = /** @type {any} */ (error)?.code || 'TG_TRANSCRIPTION_FAILED';
                                log.error(`No se pudo guardar el resultado de audio Telegram (${code}).`);
                            }
                            continue;
                        }
                        if (legacy.text) this.emitLegacyMessage(legacy.message, legacy.chatId, legacy.text,
                            legacy.isAdminChannel, legacy.isAdminChannel ? null : stored?.id ?? null);
                    }
                    if (transcriptionFailure) this.stopForCapture('error_captura');
                }
                await yieldLoop();
            }
        } finally { if (this.runningGeneration === gen) this.runningGeneration = -1; }
    }

    stopForCapture(reason) {
        this.pollerActive = false;
        this.pollAbort?.abort();
        for (const waiter of this.chatWaiters) waiter.reject(failure('TG_CAPTURE_FAILED', 'La captura Telegram se detuvo; revisa el estado antes de continuar.'));
        this.setStatus('standby', reason);
    }

    emitLegacyMessage(msg, chatId, text, isAdminChannel, archiveMessageId = null) {
        const pushName = msg.from?.first_name || 'Desconocido';
        const username = msg.from?.username;
        this.emit('message', new StandardMessage({
            channel: 'telegram', remoteId: `telegram:${chatId}`, rawId: chatId, text,
            metadata: { pushName: username ? `${pushName} (@${username})` : pushName,
                savedName: null, phoneNumber: null, lid: chatId, isBusiness: false,
                country: 'Desconocido', isFromMe: false, isAdminChannel }, raw: msg,
            archiveMessageId
        }));
    }

    async archiveAcceptedSend(accountId, chatId, message, adminChatId) {
        if (!this.archive || !accountId) return;
        const input = normalizeSentMessage(message, accountId, chatId, adminChatId);
        if (!input) return;
        try {
            const [stored] = await this.trackArchive(this.archive.ingestBatch([input]));
            if (stored?.status === 'quarantined') logError.error('Telegram: conflicto al reconciliar una salida aceptada con su eco.');
        } catch (error) {
            const code = /** @type {any} */ (error)?.code || 'TG_OUTBOUND_ARCHIVE_FAILED';
            logError.error(`Telegram: salida aceptada sin confirmación local (${code}).`);
        }
    }

    async sendMessageRaw(normalizedJid, text, options = {}) {
        const token = this.token;
        const accountId = this.accountId;
        const adminChatId = this.adminChatId;
        const generation = this.pollGeneration;
        if (!token) throw Object.assign(new Error('Telegram token no configurado'), { code: 'TG_TOKEN_MISSING', outboundOutcome: 'rejected' });
        if (options._outboundAccountId && options._outboundAccountId !== accountId) {
            throw Object.assign(failure('TG_CONNECTION_CHANGED', 'La cuenta de Telegram cambió antes del envío.'), { outboundOutcome: 'rejected' });
        }
        const tgChatId = normalizedJid.replace('telegram:', '');
        const send = async useMarkdown => {
            const payload = { chat_id: tgChatId, text: text };
            if (useMarkdown) payload.parse_mode = 'Markdown';
            try {
                const response = await requestText({ path: `/bot${token}/sendMessage`, method: 'POST', body: payload,
                    timeoutMs: this.sendTimeoutMs, requestImpl: this.sendHttpRequest });
                if (useMarkdown && response.statusCode === 400 && response.body.includes("can't parse entities")) {
                    const sameSession = this.isGeneration(generation, token) && this.accountId === accountId;
                    if (!sameSession) throw Object.assign(failure('TG_CONNECTION_CHANGED', 'La conexión de Telegram cambió antes del reintento.'), { outboundOutcome: 'rejected' });
                    // A retry is allowed only after Telegram explicitly rejected
                    // Markdown; transport timeouts never enter this path.
                    return await send(false);
                }
                let bodyJson;
                try { bodyJson = parseTelegramJson(response.body); }
                catch { throw failure('TG_SEND_RESPONSE_INVALID'); }
                if (response.statusCode === 200 && bodyJson?.ok === true) {
                    await this.archiveAcceptedSend(accountId, tgChatId, bodyJson.result, adminChatId);
                    return bodyJson;
                }
                const definite = response.statusCode >= 400 && response.statusCode < 500
                    || response.statusCode < 400 && bodyJson?.ok === false;
                throw Object.assign(failure(definite ? 'TG_SEND_REJECTED' : 'TG_SEND_HTTP_ERROR',
                    `Telegram rechazó el envío (${response.statusCode}).`), { outboundOutcome: definite ? 'rejected' : 'unknown' });
            } catch (error) {
                const caught = /** @type {any} */ (error);
                if (caught?.outboundOutcome) throw caught;
                const code = caught?.code === 'TG_REQUEST_TIMEOUT' ? 'TG_SEND_TIMEOUT'
                    : caught?.code || 'TG_SEND_REQUEST_FAILED';
                throw Object.assign(failure(code, 'No se confirmó el resultado del envío Telegram.'), { outboundOutcome: 'unknown' });
            }
        };

        return send(options.useMarkdown !== false);
    }

    async sendPresenceUpdate(status, normalizedJid) {
        // Telegram supports 'typing' action
        if (!normalizedJid || !this.token) return;
        if (status !== 'composing') return; // we only simulate composing
        
        const tgChatId = normalizedJid.replace('telegram:', '');
        await requestText({ path: `/bot${this.token}/sendChatAction`, method: 'POST',
            body: { chat_id: tgChatId, action: 'typing' }, timeoutMs: this.presenceTimeoutMs,
            requestImpl: this.sendHttpRequest });
    }

    async requestPairingCode() {
        throw new Error('Telegram no soporta requestPairingCode');
    }

    /**
     * 🎤 STT local (Telegram): descarga el audio (voice/audio) vía getFile,
     * lo transcribe y emite un StandardMessage con el texto normalizado.
     * @param {any} update - update completo de Telegram (tiene .message.chat.id)
     * @param {any} msg - update.message (con .voice o .audio y .from)
     * @param {{token:string, gen:number, signal:AbortSignal, accountId:string, messageId:string|null}} session
     */
    async _maybeHandleAudio(update, msg, session) {
        const current = () => this.isCurrent(session.gen, session.token) && !session.signal.aborted;
        if (!current()) return;
        const voiceOrAudio = msg.voice || msg.audio;
        if (!voiceOrAudio) return;

        let transcriptionPending = false;
        const updateTranscript = async input => {
            try { return await this.trackArchive(this.archive.updateTranscription(input)); }
            catch (error) { /** @type {any} */ (error).telegramArchiveFailure = true; throw error; }
        };
        const markFailed = async () => {
            if (!session.messageId || !transcriptionPending) return;
            await updateTranscript({ messageId: session.messageId, expectedStatus: 'pending', status: 'failed' });
            transcriptionPending = false;
        };
        if (session.messageId) {
            const pending = await updateTranscript({ messageId: session.messageId, expectedStatus: 'not_requested', status: 'pending' });
            if (pending.status !== 'updated') return;
            transcriptionPending = true;
        }

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
            await markFailed();
            if (!current()) return;
            await abortable(Promise.resolve().then(() => this.sendMessage(`telegram:${tgChatId}`,
                `🎤 Audio muy largo (${seconds}s). Máximo ${maxSeconds}s por ahora.`)), session.signal).catch(() => {});
            return;
        }

        let transcript;
        try {
            await abortable(Promise.resolve().then(() => this.sendPresenceUpdate('composing', `telegram:${tgChatId}`)), session.signal).catch(() => {});

            if (!current()) { await markFailed(); return; }
            // 1) getFile -> file_path
            const fileId = voiceOrAudio.file_id;
            const getFileUrl = `https://api.telegram.org/bot${session.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
            const info = /** @type {any} */ (await fetchJson(getFileUrl, session.signal));
            if (!current()) { await markFailed(); return; }
            if (!info || !info.ok || !info.result || !info.result.file_path) {
                log.warn('🎤 TG getFile falló.');
                await markFailed();
                return;
            }
            // 2) descargar el binario
            const dlUrl = `https://api.telegram.org/file/bot${session.token}/${info.result.file_path}`;
            const buffer = await downloadBytes(dlUrl, session.signal);
            if (!buffer || buffer.length === 0) {
                log.warn('🎤 TG no se pudo descargar el audio.');
                await markFailed();
                return;
            }

            const ext = (info.result.file_path.split('.').pop() || 'oga').toLowerCase();
            if (!current()) { await markFailed(); return; }
            const work = Promise.resolve().then(() => this.transcribe(buffer, `tg-audio.${ext}`, { language: 'es', signal: session.signal }));
            transcript = await abortable(work, session.signal);
        } catch (err) {
            const error = /** @type {any} */ (err);
            if (error?.telegramArchiveFailure) throw err;
            if (current()) logError.error(`🎤 Error en STT de Telegram (${safeErrorLabel(error)}).`);
            await markFailed();
            return;
        }
        if (!current()) { await markFailed(); return; }
        if (typeof transcript !== 'string' || !transcript.trim() || !/** @type {any} */ (transcript).isWellFormed()) {
            log.warn('🎤 STT TG no devolvió una transcripción válida.');
            await markFailed();
            return;
        }
        if (session.messageId) {
            const completed = await updateTranscript({ messageId: session.messageId, expectedStatus: 'pending', status: 'completed', transcript });
            transcriptionPending = false;
            if (completed.status !== 'updated') return;
            const conversation = await this.trackArchive(this.archive.conversation(completed.message.conversationId));
            if (conversation?.requires_review) return;
        }
        if (!current()) return;
        log.info('🎤 [AUDIO TG TRANSCRITO] Transcripción aceptada.');
        this.emit('message', new StandardMessage({
            channel: 'telegram', remoteId: `telegram:${tgChatId}`, rawId: tgChatId,
            text: transcript, transcript, isAudio: true,
            metadata: { pushName: fullName, savedName: null, phoneNumber: null, lid: tgChatId,
                isBusiness: false, country: 'Desconocido', isFromMe: false, isAdminChannel: isAdmin }, raw: msg,
            archiveMessageId: session.messageId
        }));
    }
}

module.exports = TelegramAdapter;

/** GET JSON con timeout explícito (ADR-004). */
async function fetchJson(url, signal) {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!res.ok) return null;
    return res.json();
}

async function abortable(operation, signal) {
    if (signal.aborted) throw signal.reason || failure('TG_REQUEST_CANCELLED');
    let listener;
    const aborted = new Promise((_, reject) => {
        listener = () => reject(signal.reason || failure('TG_REQUEST_CANCELLED'));
        signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', listener); }
}

/** Descarga bytes con timeout explícito (ADR-004). */
async function downloadBytes(url, signal, limit = num('STT_MAX_UPLOAD_BYTES', 5 * 1024 * 1024)) {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    if (!res.ok) return null;
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) { await res.body?.cancel?.().catch(() => {}); return null; }
    if (!res.body?.getReader) {
        const ab = await res.arrayBuffer();
        return ab.byteLength <= limit ? Buffer.from(ab) : null;
    }
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel().catch(() => {}); return null; }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
}

/** The only getUpdates path in the application. No discovery offset/reader. */
function requestUpdates({ token, offset, signal, timeoutMs }) {
    const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'edited_message']));
    return requestJson({ path: `/bot${token}/getUpdates?offset=${encodeURIComponent(offset)}&limit=100&timeout=30&allowed_updates=${allowedUpdates}`, signal, timeoutMs });
}

/** Verify the bot identity before connecting a token to its durable namespace. */
function requestBotIdentity({ token, signal, timeoutMs }) {
    return requestJson({ path: `/bot${token}/getMe`, signal, timeoutMs });
}
