/* global AbortController */
const ChannelAdapter = require('../core/ChannelAdapter');
const StandardMessage = require('../core/StandardMessage');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, WAMessageStubType, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { cat, safeErrorLabel } = require('../services/logger');
const { isJunkJid } = require('../services/contactsRepository');
const { extractUserMetadata } = require('../services/metadataService');
const { extractTextMessage, decideReconnect } = require('../services/pipeline');
const { createWhatsappCapture, socketIdentity, individualJid, unwrap, acceptedOutbound,
    normalizeProviderEdit, normalizeProviderDelete } = require('../services/conversations/whatsappCapture');
const { createWhatsappTranscription } = require('../services/conversations/whatsappTranscription');
const internalBus = require('../services/internalBus');
const { getSettingsDB, saveSettingsDB } = require('../services/db');
const { transcribeAudio, MAX_AUDIO_BYTES } = require('../services/stt');
const { num } = require('../tuning');
const { GATEWAY_STATE_DIR } = require('../lib/repoPaths');

const log = cat('WHATSAPP');
const logError = cat('ERROR');

const AUTH_DIR = process.env.SDK_AUTH_DIR || path.join(GATEWAY_STATE_DIR, 'auth_info_baileys');

class WhatsappAdapter extends ChannelAdapter {
    constructor({ archive, attachmentStore, makeSocket = makeWASocket, loadAuth = useMultiFileAuthState,
        download = downloadMediaMessage, transcribe = transcribeAudio } = {}) {
        super('whatsapp');
        this.sock = null;
        this.accountId = null;
        this.makeSocket = makeSocket;
        this.loadAuth = loadAuth;
        this.download = download;
        this.transcribe = transcribe;
        this.attachmentStore = attachmentStore || null;
        this.attachmentTasks = new Set();
        this.mediaTasks = new Set();
        this.attachmentControllers = new Set();
        this.capture = archive ? createWhatsappCapture(archive, {
            buildLegacyDispatch: (msg, observation) => this.buildLegacyDispatch(msg, observation)
        }) : null;
        this.archive = archive;
        this.transcriptions = archive ? createWhatsappTranscription(archive, code => this.captureFailure(code)) : null;
        this.connectRevision = 0;
        this.sentIds = new Map();
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.RECONNECT_BACKOFF_MS = [1000, 5000, 15000, 60000];
    }

    /** Lee el ultimo numero admin conocido desde settings DB (sobrevive reinicios). */
    getKnownAdminPhone() {
        try { return getSettingsDB().lastKnownAdminPhone || ''; } catch (e) { return ''; }
    }

    async ensureOutboundAccountId() {
        const sock = this.sock;
        if (!sock?.user || !this.archive) throw Object.assign(new Error('WhatsApp no conectado.'), { code: 'WA_NOT_CONNECTED' });
        const session = socketIdentity(sock.user);
        const account = await this.archive.registerAccount({ channel: 'whatsapp', providerKey: session.providerKey });
        if (this.sock !== sock) throw Object.assign(new Error('Socket WhatsApp reemplazado.'), { code: 'WA_SOCKET_REPLACED' });
        this.accountId = account.id;
        return account.id;
    }
    /** Persiste el numero admin conocido en settings DB. */
    setKnownAdminPhone(phone) {
        try {
            const s = getSettingsDB();
            s.lastKnownAdminPhone = phone;
            saveSettingsDB(s);
        } catch (e) { /* settings no disponible */ }
    }

    getReconnectDelay() {
        // reconnectAttempt ya fue incrementado en scheduleReconnect (queda en 1
        // en el primer reconnect), así que el delay del primer intento usa el
        // índice 0 del array. Sin el -1 el índice 0 quedaría muerto.
        const idx = Math.max(0, Math.min(this.reconnectAttempt - 1, this.RECONNECT_BACKOFF_MS.length - 1));
        return this.RECONNECT_BACKOFF_MS[idx];
    }

    isSessionRegistered() {
        try {
            const credsPath = path.join(AUTH_DIR, 'creds.json');
            if (!fs.existsSync(credsPath)) return false;
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            return Boolean(creds && creds.registered);
        } catch (e) {
            return false;
        }
    }

    /**
     * ¿Hay una identidad de emparejamiento a medias? Baileys persiste `me`
     * cuando el teléfono aceptó el QR/código, pero `registered` recién se
     * consolida tras la reconexión que WhatsApp exige (restartRequired/515).
     * Ver ADR-003/004: ese cierre es transitorio, no terminal.
     */
    hasPairedIdentity() {
        try {
            const credsPath = path.join(AUTH_DIR, 'creds.json');
            if (!fs.existsSync(credsPath)) return false;
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            return Boolean(creds && creds.me && creds.me.id);
        } catch (e) {
            return false;
        }
    }

    scheduleReconnect() {
        this.reconnectAttempt += 1;
        const delay = this.getReconnectDelay();
        log.warn(`↻ Esperando ${(delay / 1000).toFixed(0)}s antes de reconectar a WhatsApp (intento ${this.reconnectAttempt})...`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(() => this.captureFailure('WA_CONNECT_FAILED'));
        }, delay);
    }

    async connect(options = {}) {
        const freshQr = options.freshQr === true;
        const revision = ++this.connectRevision;

        // No destruir el socket si ya hay un QR vigente o pairing en curso:
        // connect({freshQr:true}) hace old.end() y eso cortaba el stream justo
        // cuando WhatsApp iba a abrir la sesion -> 515 "restart required".
        // El bus ya bloquea el refresh si hay ventana abierta, pero el adapter
        // tambien se protege (el refresh puede venir por otras vias).
        const pairingInFlight = this.sock && internalBus.isQrWindowOpen && internalBus.isQrWindowOpen();
        if (pairingInFlight) return;
        this.accountId = null;
        if (this.sock) {
            const old = this.sock;
            this.sock = null;
            this.transcriptions?.cancel();
            this.cancelAttachmentTasks();
            try { old.end(new Error('Reconnect por nueva conexión')); } catch (e) { /* ya cerrado */ }
            if (this.attachmentTasks.size) await Promise.allSettled([...this.attachmentTasks]);
        }

        const { state: authState, saveCreds } = await this.loadAuth(AUTH_DIR);
        if (revision !== this.connectRevision) return;

        // Limpiar sesion a medias SOLO cuando el panel pide QR fresco
        // (freshQr). En un reconnect normal NO se borra 'me': Baileys necesita
        // esa identidad parcial para completar el pairing en el segundo intento
        // (el primero siempre cae con 515/401 transitorio de WhatsApp).
        if (freshQr && !authState.creds.registered && (authState.creds.me || authState.creds.pairingCode)) {
            delete authState.creds.me;
            delete authState.creds.pairingCode;
            await saveCreds();
            log.info('🔌 [WHATSAPP] Pairing fresco: sesion a medias descartada (registered=false).');
        }

        if (revision !== this.connectRevision) return;
        this.sock = this.makeSocket({
            printQRInTerminal: false,
            auth: authState,
            logger: pino({ level: 'silent' }),
            // syncFullHistory:true restaurado: WhatsApp envia el historial por
            // chunks y el stream se estabiliza. El 515 no era por esto.
            syncFullHistory: true,
            markOnlineOnConnect: true,
            browser: ['SDK-Bot', 'Chrome', '124.0.0.0']
            // NOTA: no pasar 'version' con un array inventado. Baileys rc14 no
            // exporta DEFAULT_VERSION y una version invalida hace que el handshake
            // HTTP con WhatsApp Web sea rechazado con 405 (Connection Failure) y el
            // gateway cae a standby sin emitir QR. Baileys resuelve su version por
            // defecto internamente si no se especifica.
        });

        // Captura local del socket de ESTA conexión: los eventos de un socket
        // viejo (tras reconnect o freshQr) deben ignorarse.
        const sock = this.sock;
        // Eventos Baileys
        sock.ev.on('creds.update', () => {
            if (this.sock !== sock) return;
            void Promise.resolve().then(() => { if (this.sock === sock) return saveCreds(); })
                .catch(() => { if (this.sock === sock) this.captureFailure('WA_CREDENTIAL_SAVE_FAILED'); });
        });

        sock.ev.on('connection.update', (update) => {
            if (this.sock !== sock) return; // Ignora eventos de un socket reemplazado
            
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.emit('qr', { qr });
            }
            
            if (connection === 'close') {
                this.sock = null;
                this.transcriptions?.cancel();
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;
                // Loguea la razon real del cierre (el logger de Baileys esta en silent,
                // asi que sin esto el pairing fallido queda ciego: statusCode 401/403/409/500
                // o "Stream Errored" indican el motivo de fondo).
                log.warn(`🔌 [WHATSAPP] connection.close statusCode=${statusCode ?? 'n/a'} loggedOut=${loggedOut}.`);

                // [main] Logout real de WhatsApp (el cliente revoco la sesion desde
                // su movil: Dispositivos vinculados). NO borramos las creds: si
                // revincula el MISMO numero solo genera un QR nuevo y sigue igual.
                // Avisar al admin y resetear el numero conocido para detectar cambios
                // de numero (Opcion B) en el futuro.
                if (loggedOut) {
                    const msg = '🚪 El cliente DESVINCULÓ el bot desde su móvil (WhatsApp > Dispositivos vinculados). El bot quedó en standby (no se borró nada). Si revincula el mismo número, solo genera un QR nuevo y sigue igual; si usa otro número, se reinicia el pairing desde cero.';
                    log.warn('🚪 WhatsApp desvinculó la sesión; el gateway queda en standby.');
                    if (internalBus && internalBus.notifyAdmin) internalBus.notifyAdmin(msg);
                    this.setKnownAdminPhone('');
                }

                // Decisión PURA centralizada en pipeline.decideReconnect
                // (idéntica regla para el adapter y para los tests).
                const decision = decideReconnect({
                    hasSession: this.isSessionRegistered(),
                    hasPairedIdentity: this.hasPairedIdentity(),
                    loggedOut
                });

                if (decision.reconnect) {
                    this.setStatus('reconnecting');
                    log.warn(`↻ WhatsApp cerró la conexión (statusCode=${statusCode ?? 'n/a'}). Reconectando en breve…`);
                    this.scheduleReconnect();
                } else {
                    // Sin sesión ni identidad a medias, o revocada desde el
                    // teléfono: no reconectar en bucle (evita baneos); el
                    // admin debe volver a vincular.
                    this.setStatus('standby', decision.reason);
                    log.warn(`ℹ️ Gateway WhatsApp en STANDBY. Razón: ${decision.reason} (statusCode=${statusCode ?? 'n/a'}). Vincula de nuevo desde el panel (QR o código).`);
                }
            } else if (connection === 'open') {
                this.reconnectAttempt = 0;
                if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
                this.setStatus('open');

                if (this.archive && sock.user) {
                    try {
                        const session = socketIdentity(sock.user);
                        void this.archive.registerAccount({ channel: 'whatsapp', providerKey: session.providerKey })
                            .then(account => {
                                if (this.sock === sock && revision === this.connectRevision) this.accountId = account.id;
                            })
                            .catch(() => { if (this.sock === sock) this.captureFailure('WA_ACCOUNT_ARCHIVE_FAILED'); });
                    } catch (error) {
                        this.captureFailure(error?.code || 'WA_ACCOUNT_IDENTITY_INVALID');
                    }
                }
                
                let adminPhone = '';
                let adminLid = '';
                if (sock.user) {
                    adminPhone = sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                    adminLid = sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
                }

                // Anti-cambio de numero (Opción B: permitir y empezar de cero):
                // el numero conocido se persiste en settings DB para sobrevivir
                // reinicios. Si el numero vinculado cambia respecto al conocido,
                // se avisa al admin, se borra auth_info_baileys y se reconecta
                // para re-pair limpio (el panel mostrara un QR nuevo). Si coincide
                // o es el primero, solo se persiste para futuras comparaciones.
                const knownPhone = this.getKnownAdminPhone();
                if (adminPhone && knownPhone && adminPhone !== knownPhone) {
                    const msg = `⚠️ Número de WhatsApp del bot CAMBIÓ: antes '${knownPhone}', ahora '${adminPhone}'. Se borra la sesión y se reinicia el pairing desde cero.`;
                        log.warn('⚠️ La identidad de WhatsApp vinculada cambió; se reiniciará el pairing.');
                    if (internalBus && internalBus.notifyAdmin) internalBus.notifyAdmin(msg);
                    this.setKnownAdminPhone(adminPhone);
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        log.info('🔌 [WHATSAPP] auth_info_baileys borrado por cambio de número.');
                    } catch (e) {
                        logError.error(`🔌 [WHATSAPP] No se pudo borrar auth_info_baileys (${safeErrorLabel(e)}).`);
                    }
                    // Reconnect limpio: el socket actual se cierra y el nuevo
                    // lee creds vacíos -> emite QR nuevo para re-pairing.
                    this.connect().catch(() => this.captureFailure('WA_CONNECT_FAILED'));
                    return;
                }
                if (adminPhone) this.setKnownAdminPhone(adminPhone);

                log.info(`✅ ¡Conectado a WhatsApp con éxito!`);
                this.emit('ready', { adminPhone, adminLid });
                
                this.sendPresenceUpdate('available').catch(e => logError.error(`⚠️ Error enviando estado de presencia WA (${safeErrorLabel(e)}).`));
            }
        });

        sock.ev.on('messages.upsert', m => {
            if (this.sock !== sock) return;
            // append is offline/backfill traffic; only notify may reach automation.
            this.captureBatch(sock, m.messages, m.type === 'notify' ? 'live' : 'history');
        });

        sock.ev.on('messages.update', updates => {
            if (this.sock !== sock || !Array.isArray(updates)) return;
            let session;
            try { session = socketIdentity(sock.user); } catch (error) { this.captureFailure(error.code); return; }
            for (const item of updates) {
                if (item?.update?.message?.editedMessage) {
                    let edit;
                    try { edit = normalizeProviderEdit(item.key, item.update, session); }
                    catch (error) { this.captureFailure(error.code || 'WA_EDIT_INVALID'); continue; }
                    if (edit) this.applyProviderEdit(sock, item, edit, session);
                } else if (item?.update?.messageStubType === WAMessageStubType.REVOKE) {
                    let removal;
                    try { removal = normalizeProviderDelete(item.key, session); }
                    catch (error) { this.captureFailure(error.code || 'WA_DELETE_INVALID'); continue; }
                    if (removal) this.applyProviderDelete(sock, removal, session);
                }
                // Receipt/status updates are deliberately not inferred as edits or delivery evidence.
            }
        });

        sock.ev.on('messages.delete', deletion => {
            if (this.sock !== sock || !Array.isArray(deletion?.keys)) return;
            let session;
            try { session = socketIdentity(sock.user); } catch (error) { this.captureFailure(error.code); return; }
            for (const key of deletion.keys) {
                let removal;
                try { removal = normalizeProviderDelete(key, session); }
                catch (error) { this.captureFailure(error.code || 'WA_DELETE_INVALID'); continue; }
                if (removal) this.applyProviderDelete(sock, removal, session);
            }
            // Baileys' chat-wide { jid, all: true } clear has no per-message provenance; ignore it.
        });

        const handleContactSync = (contacts, source) => {
            if (this.sock !== sock) return;
            if (!Array.isArray(contacts) || contacts.length === 0) return;
            const valid = contacts.filter(c => c && c.id && !isJunkJid(c.id));
            if (valid.length > 0) {
                this.emit('contact_sync', { contacts: valid, source });
            }
        };

        sock.ev.on('contacts.upsert', c => handleContactSync(c, 'contacts.upsert'));
        sock.ev.on('contacts.update', c => handleContactSync(c, 'contacts.update'));

        sock.ev.on('messaging-history.set', ({ contacts, chats, messages, progress, syncType }) => {
            if (this.sock !== sock) return;
            this.captureBatch(sock, messages, 'history');
            if (contacts) handleContactSync(contacts, 'history');
            // Legacy RAM cache is fed only after durable capture below.
            log.info(`📜 WA History sync: type=${syncType} progreso=${progress}% chats=${chats?.length ?? 0} msgs=${messages?.length ?? 0}`);
        });

        sock.ev.on('presence.update', ({ id, presences }) => {
            if (this.sock !== sock) return;
            this.emit('presence_update', { id, presences });
        });
    }

    captureFailure(code) {
        const safeCode = safeErrorLabel({ code });
        const status = { status: 'degraded', code: safeCode, at: new Date().toISOString() };
        this.emit('capture_status', status);
        logError.error(`Archivo WhatsApp: ${safeCode}. Captura no confirmada; revisar intervalo afectado.`);
    }

    deferUnknownSelfHandoff(observation) {
        const conversationId = observation?.result?.message?.conversationId;
        if (!conversationId || !this.archive) return;
        const target = observation.remote;
        const providerMessageId = observation.providerMessageId;
        const timer = setTimeout(async () => {
            try {
                const intents = await this.archive.outboundIntents({ conversationId, limit: 500 });
                if (providerMessageId && intents.some(intent => intent.providerMessageId === providerMessageId
                    && intent.state === 'accepted')) return;
                const { setNumberState } = require('../services/stateService');
                const result = await setNumberState(target, 'handoff', { channel: 'whatsapp',
                    accountId: this.accountId, reason: 'external_self' });
                if (!result.success) {
                    logError.error('No se pudo pausar IA tras una salida propia no correlacionada.');
                } else {
                    log.warn('Salida propia no correlacionada archivada; IA pausada hasta liberación humana.');
                }
            } catch (error) {
                logError.error(`No se pudo revisar la salida propia (${safeErrorLabel(error)}).`);
            }
        }, 500);
        timer.unref?.();
    }

    captureBatch(sock, messages, source) {
        if (!Array.isArray(messages) || this.sock !== sock) return;
        let session;
        try { session = socketIdentity(sock.user); }
        catch (error) { this.captureFailure(error.code); return; }
        if (!this.capture) { this.captureFailure('WA_CAPTURE_UNCONFIGURED'); return; }
        // Each record is admitted synchronously. Overflow is visible and never
        // reaches legacy automation. No extra unbounded promise-chain queue.
        const reported = new Set();
        for (const msg of messages) {
            this.capture.enqueue(msg, session, source).then(observation => {
                if (this.sock !== sock) return;
                if (observation.scope === 'administration') {
                    if (source === 'live') return this.processLive(sock, msg, session);
                    return;
                }
                if (observation.scope !== 'individual') return;
                if (observation.result.status !== 'quarantined') this.emit('archived_message', { raw: msg, source, observation });
                if (source === 'live' && observation.result.status === 'created'
                    && ['audio','image','video','document'].includes(observation.result.message.content.type)) {
                    this.queueMediaCapture(sock, msg, observation.result.message.id);
                }
                if (source === 'live' && msg.key?.fromMe && observation.result.status === 'created') {
                    this.deferUnknownSelfHandoff(observation);
                }
                if (source !== 'live' || observation.result.status !== 'created' || observation.requiresReview
                    || observation.result.message.content.type === 'oversized') return;
                // The archive records fromMe independently of the legacy echo guard.
                if (msg.key.fromMe) return;
                return this.processLive(sock, msg, session, observation);
            }).catch(error => {
                const code = error.code || 'WA_CAPTURE_FAILED';
                if (!reported.has(code)) { reported.add(code); this.captureFailure(code); }
            });
        }
    }

    queueMediaCapture(sock, message, messageId) {
        if (!this.attachmentStore || !this.archive) return;
        if (this.mediaTasks.size >= 4) {
            this.trackAttachmentTask(this.archive.markAttachmentCaptureFailed({ messageId }).catch(() => {}));
            this.captureFailure('WA_MEDIA_CAPTURE_SATURATED');
            return;
        }
        const controller = new AbortController();
        this.attachmentControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(new Error('WA media deadline')), 30000);
        timeout.unref?.();
        const task = Promise.resolve().then(async () => {
            if (this.sock !== sock) throw Object.assign(new Error('Socket WhatsApp reemplazado.'), { code: 'WA_SOCKET_REPLACED' });
            const body = unwrap(message?.message);
            const type = ['audio','image','video','document'].find(name => body[`${name}Message`]);
            const media = type && body[`${type}Message`];
            if (!media) throw Object.assign(new Error('Media unavailable.'), { code: 'WA_MEDIA_UNAVAILABLE' });
            const downloaded = await this.download(message, 'stream', { options: { signal: controller.signal } }, {
                logger: log, reuploadRequest: async m => m
            });
            controller.signal.throwIfAborted();
            if (downloaded && !Buffer.isBuffer(downloaded) && typeof downloaded.destroy === 'function') {
                const abort = () => downloaded.destroy(controller.signal.reason);
                controller.signal.addEventListener('abort', abort, { once: true });
                try {
                    const extension = path.extname(media.fileName || '') || `.${({ audio: 'ogg', image: 'jpg', video: 'mp4', document: 'bin' })[type]}`;
                    await this.attachmentStore.store({ messageId, source: downloaded,
                        fileName: media.fileName || `${type}-${messageId}${extension}`,
                        contentType: typeof media.mimetype === 'string' ? media.mimetype.split(';')[0].trim() : 'application/octet-stream' });
                } finally { controller.signal.removeEventListener('abort', abort); downloaded.destroy?.(); }
            } else {
                const extension = path.extname(media.fileName || '') || `.${({ audio: 'ogg', image: 'jpg', video: 'mp4', document: 'bin' })[type]}`;
                await this.attachmentStore.store({ messageId, source: downloaded,
                    fileName: media.fileName || `${type}-${messageId}${extension}`,
                    contentType: typeof media.mimetype === 'string' ? media.mimetype.split(';')[0].trim() : 'application/octet-stream' });
            }
        }).catch(async error => {
            await this.archive.markAttachmentCaptureFailed({ messageId }).catch(() => {});
            this.captureFailure(error.code || 'WA_MEDIA_CAPTURE_FAILED');
        }).finally(() => {
            clearTimeout(timeout); this.attachmentControllers.delete(controller); this.attachmentTasks.delete(task);
            this.mediaTasks.delete(task);
        });
        this.attachmentTasks.add(task);
        this.mediaTasks.add(task);
    }

    applyProviderEdit(sock, item, edit, session) {
        const task = Promise.resolve(this.capture?.edit(edit, session)).then(async result => {
            if (this.sock !== sock || result?.status !== 'updated') return;
            if (result.replacedAttachmentId) await this.attachmentStore?.sweepExpired();
            if (result.captureAttachment) {
                const edited = { ...item, message: item.update.message.editedMessage.message };
                this.queueMediaCapture(sock, edited, result.message.id);
            }
        }).catch(error => this.captureFailure(error?.code || 'WA_EDIT_ARCHIVE_FAILED'));
        this.trackAttachmentTask(task);
    }

    applyProviderDelete(sock, removal, session) {
        const task = Promise.resolve(this.capture?.remove(removal, session)).then(async result => {
            if (this.sock === sock && result?.attachmentId) await this.attachmentStore?.sweepExpired();
        }).catch(error => this.captureFailure(error?.code || 'WA_DELETE_ARCHIVE_FAILED'));
        this.trackAttachmentTask(task);
    }

    trackAttachmentTask(task) {
        this.attachmentTasks.add(task);
        void task.finally(() => this.attachmentTasks.delete(task));
        return task;
    }

    cancelAttachmentTasks() {
        for (const controller of this.attachmentControllers) controller.abort(new Error('Socket WhatsApp reemplazado'));
    }

    buildLegacyDispatch(msg, observation) {
        if (observation.source !== 'live' || observation.direction !== 'inbound' || observation.authorKind !== 'customer') return null;
        const content = observation.content;
        const text = content.type === 'text' ? content.text : content.caption || '';
        if (Buffer.byteLength(text) > 65536) return null;
        const waitForTranscription = content.type === 'audio' && !text && num('AUDIO_STT_ENABLED', 0) === 1;
        if (!text && !waitForTranscription) return null;
        const metadata = extractUserMetadata(msg);
        return { waitForTranscription, message: {
            channel: 'whatsapp', remoteId: `whatsapp:${observation.remote}`, rawId: observation.remote,
            text, transcript: '', isAudio: waitForTranscription,
            metadata: { pushName: metadata.pushName, savedName: metadata.savedName,
                phoneNumber: metadata.phoneNumber, lid: metadata.lid, isBusiness: metadata.isBusiness,
                country: metadata.country, isFromMe: false, isAdminChannel: false }
        } };
    }

    isOwnEcho(msg, session) {
        const remote = individualJid(msg.key?.remoteJid);
        const k = `${session.providerKey}|${remote}|${msg.key?.id}`;
        return msg.key?.fromMe && (this.sentIds.get(k) || 0) > Date.now();
    }

    async archiveAcceptedSend(session, targetJid, sentContent, result) {
        if (!this.archive) return;
        const outbound = acceptedOutbound(result, session, targetJid, sentContent);
        if (!outbound) return;
        try {
            const account = await this.archive.registerAccount({ channel: 'whatsapp', providerKey: session.providerKey });
            outbound.identity = { accountId: account.id, channel: 'whatsapp',
                kind: outbound.remote.endsWith('@lid') ? 'whatsapp_lid' : 'whatsapp_jid', exactValue: outbound.remote };
            delete outbound.remote;
            const [stored] = await this.archive.ingestBatch([outbound]);
            if (stored?.status === 'quarantined') this.captureFailure('WA_OUTBOUND_RECONCILIATION_CONFLICT');
        } catch (error) {
            this.captureFailure(error.code || 'WA_OUTBOUND_ARCHIVE_FAILED');
        }
    }

    async processLive(sock, msg, session, observation) {
        if (this.sock !== sock || this.isOwnEcho(msg, session)) return;
        const content = observation?.result.message.content;
        const text = content ? (content.type === 'text' ? content.text : content.caption || '') : extractTextMessage(msg);
        const metadata = extractUserMetadata(msg);
        if (!text) return this._maybeHandleAudio(msg, metadata, sock, observation);
        this.emit('message', new StandardMessage({
            channel: 'whatsapp', remoteId: `whatsapp:${metadata.remoteJid}`,
            rawId: metadata.remoteJid, text,
            metadata: { ...metadata, isFromMe: msg.key.fromMe }, raw: msg,
            archiveMessageId: observation?.result?.message?.id ?? null
        }));
    }

    async disconnect() {
        this.connectRevision++;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        const sock = this.sock;
        this.sock = null;
        this.accountId = null;
        this.transcriptions?.cancel();
        this.cancelAttachmentTasks();
        try { if (sock) sock.end(new Error('Manual disconnect')); }
        finally {
            await this.capture?.close();
            await this.transcriptions?.close();
            await Promise.allSettled([...this.attachmentTasks]);
            this.setStatus('disconnected');
        }
    }

    /** Audio is enriched only after its original ID has committed. */
    async _maybeHandleAudio(msg, metadata, sock, observation) {
        const audio = unwrap(msg?.message).audioMessage;
        const messageId = observation?.result.message.id;
        if (!audio || !this.transcriptions || this.sock !== sock) return;
        if (num('AUDIO_STT_ENABLED', 0) !== 1) return;
        if ((Number(audio.seconds) || 0) > num('STT_MAX_SECONDS', 120)) {
            await this.transcriptions.skip(messageId);
            if (this.sock === sock) await this.sendMessage(`whatsapp:${metadata.remoteJid}`,
                `🎤 Audio muy largo (${Number(audio.seconds)}s). Máximo ${num('STT_MAX_SECONDS', 120)}s por ahora.`).catch(() => {});
            return;
        }
        const remoteJid = metadata.remoteJid;
        await this.transcriptions.run(messageId, async signal => {
            try {
                await sock.sendPresenceUpdate('recording', remoteJid).catch(() => {});
                signal.throwIfAborted();
                const media = await this.download(msg, 'stream', { options: { signal } }, {
                    logger: log, reuploadRequest: async m => m
                });
                let buffer;
                try {
                    signal.throwIfAborted();
                    if (Buffer.isBuffer(media)) buffer = media; // injected transports
                    else {
                        const chunks = []; let bytes = 0;
                        for await (const chunk of media) {
                            signal.throwIfAborted();
                            bytes += chunk.length;
                            if (bytes > MAX_AUDIO_BYTES) throw new Error('Audio exceeds limit');
                            chunks.push(chunk);
                        }
                        buffer = Buffer.concat(chunks);
                    }
                    if (!buffer?.length || buffer.length > MAX_AUDIO_BYTES) throw new Error('Invalid audio size');
                } finally { if (!Buffer.isBuffer(media)) media?.destroy(); }
                const ext = (audio.mimetype || '').includes('mp4') ? 'm4a' : 'ogg';
                return await this.transcribe(buffer, `wa-audio.${ext}`, { language: 'es', signal });
            } finally {
                if (this.sock === sock && !signal.aborted) void sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
            }
        }, () => this.sock === sock, transcript => {
            this.emit('message', new StandardMessage({
                channel: 'whatsapp', remoteId: `whatsapp:${remoteJid}`, rawId: remoteJid,
                text: transcript, transcript, isAudio: true,
                metadata: { ...metadata, isFromMe: msg.key.fromMe }, raw: msg,
                archiveMessageId: messageId
            }));
        });
    }

    async sendMessageRaw(normalizedJid, text, options = {}) {
        if (!this.sock) throw Object.assign(new Error('WhatsApp no conectado'), { code: 'WA_NOT_CONNECTED', outboundOutcome: 'rejected' });
        const sock = this.sock;
        const waJid = normalizedJid.replace('whatsapp:', '');
        const session = socketIdentity(sock.user);
        if (options._outboundAccountId && options._outboundAccountId !== this.accountId) {
            throw Object.assign(new Error('La cuenta WhatsApp cambió antes del envío.'), { code: 'OUTBOUND_ACCOUNT_CHANGED', outboundOutcome: 'rejected' });
        }
        const remote = individualJid(waJid);
        try {
            if (this.archive && remote && !session.self.includes(remote)) {
                const identity = await this.archive.resolve({ accountId: (await this.archive.registerAccount({
                    channel: 'whatsapp', providerKey: session.providerKey })).id, channel: 'whatsapp',
                kind: remote.endsWith('@lid') ? 'whatsapp_lid' : 'whatsapp_jid', exactValue: remote });
                if ((await this.archive.conversation(identity.conversation_id)).requires_review) {
                    throw Object.assign(new Error('Identidad pendiente de revisión.'), { code: 'WA_IDENTITY_REVIEW_REQUIRED' });
                }
            }
        } catch (error) {
            error.outboundOutcome = 'rejected';
            throw error;
        }
        if (this.sock !== sock) throw Object.assign(new Error('Socket WhatsApp reemplazado'), { code: 'WA_SOCKET_REPLACED', outboundOutcome: 'rejected' });
        const providerOptions = require('../services/outbound/sendMessage').withoutOutboundOptions(options);
        const content = (text && typeof text === 'object') ? { ...text, ...providerOptions } : { text, ...providerOptions };
        const result = await sock.sendMessage(waJid, content);
        if (result?.key?.id) {
            const now = Date.now();
            for (const [id, expiry] of this.sentIds) if (expiry <= now) this.sentIds.delete(id);
            if (this.sentIds.size >= 10000) this.sentIds.delete(this.sentIds.keys().next().value);
            this.sentIds.set(`${session.providerKey}|${individualJid(waJid)}|${result.key.id}`, now + 60000);
        }
        await this.archiveAcceptedSend(session, waJid, content, result);
        return result;
    }

    async sendPresenceUpdate(status, normalizedJid) {
        if (!this.sock) return;
        if (normalizedJid) {
            const waJid = normalizedJid.replace('whatsapp:', '');
            return await this.sock.sendPresenceUpdate(status, waJid);
        } else {
            return await this.sock.sendPresenceUpdate(status);
        }
    }

    async requestPairingCode(number) {
        if (!this.sock) throw new Error('Socket no instanciado');
        return await this.sock.requestPairingCode(number);
    }
    
    get readyState() {
        if (!this.sock) return 3; // CLOSED
        return this.sock.ws ? this.sock.ws.readyState : 3;
    }
}

module.exports = WhatsappAdapter;
