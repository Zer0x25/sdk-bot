const ChannelAdapter = require('../core/ChannelAdapter');
const StandardMessage = require('../core/StandardMessage');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { cat } = require('../services/logger');
const { isJunkJid } = require('../services/contactsRepository');
const { extractUserMetadata } = require('../services/metadataService');
const { extractTextMessage, decideReconnect } = require('../services/pipeline');
const { isBotSentMessage } = require('../config');
const internalBus = require('../services/internalBus');
const { getSettingsDB, saveSettingsDB } = require('../services/db');

const log = cat('WHATSAPP');
const logError = cat('ERROR');

const AUTH_DIR = process.env.SDK_AUTH_DIR || path.join(__dirname, '..', 'auth_info_baileys');

class WhatsappAdapter extends ChannelAdapter {
    constructor() {
        super('whatsapp');
        this.sock = null;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.RECONNECT_BACKOFF_MS = [2000, 5000, 15000, 60000];
    }

    /** Lee el ultimo numero admin conocido desde settings DB (sobrevive reinicios). */
    getKnownAdminPhone() {
        try { return getSettingsDB().lastKnownAdminPhone || ''; } catch (e) { return ''; }
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
        const idx = Math.min(this.reconnectAttempt, this.RECONNECT_BACKOFF_MS.length - 1);
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
            this.connect();
        }, delay);
    }

    async connect(options = {}) {
        const freshQr = options.freshQr === true;

        // No destruir el socket si ya hay un QR vigente o pairing en curso:
        // connect({freshQr:true}) hace old.end() y eso cortaba el stream justo
        // cuando WhatsApp iba a abrir la sesion -> 515 "restart required".
        // El bus ya bloquea el refresh si hay ventana abierta, pero el adapter
        // tambien se protege (el refresh puede venir por otras vias).
        const pairingInFlight = this.sock && internalBus.isQrWindowOpen && internalBus.isQrWindowOpen();
        if (this.sock && !pairingInFlight) {
            const old = this.sock;
            this.sock = null;
            try { old.end(new Error('Reconnect por nueva conexión')); } catch (e) { /* ya cerrado */ }
        }

        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

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

        this.sock = makeWASocket({
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
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            if (this.sock !== sock) return; // Ignora eventos de un socket reemplazado
            
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.emit('qr', { qr });
            }
            
            if (connection === 'close') {
                this.sock = null;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const closeDetail = (lastDisconnect?.error)?.message || 'sin detalle';
                const loggedOut = statusCode === DisconnectReason.loggedOut;
                // Loguea la razon real del cierre (el logger de Baileys esta en silent,
                // asi que sin esto el pairing fallido queda ciego: statusCode 401/403/409/500
                // o "Stream Errored" indican el motivo de fondo).
                log.warn(`🔌 [WHATSAPP] connection.close statusCode=${statusCode ?? 'n/a'} loggedOut=${loggedOut} err=${closeDetail}`);

                // [main] Logout real de WhatsApp (el cliente revoco la sesion desde
                // su movil: Dispositivos vinculados). NO borramos las creds: si
                // revincula el MISMO numero solo genera un QR nuevo y sigue igual.
                // Avisar al admin y resetear el numero conocido para detectar cambios
                // de numero (Opcion B) en el futuro.
                if (loggedOut) {
                    const msg = '🚪 El cliente DESVINCULÓ el bot desde su móvil (WhatsApp > Dispositivos vinculados). El bot quedó en standby (no se borró nada). Si revincula el mismo número, solo genera un QR nuevo y sigue igual; si usa otro número, se reinicia el pairing desde cero.';
                    log.warn(msg);
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
                    log.warn(`↻ WhatsApp cerró la conexión (statusCode=${statusCode}, ${closeDetail}). Reconectando en breve…`);
                    this.scheduleReconnect();
                } else {
                    // Sin sesión ni identidad a medias, o revocada desde el
                    // teléfono: no reconectar en bucle (evita baneos); el
                    // admin debe volver a vincular.
                    this.setStatus('standby', decision.reason);
                    log.warn(`ℹ️ Gateway WhatsApp en STANDBY. Razón: ${decision.reason} (statusCode=${statusCode}, ${closeDetail}). Vincula de nuevo desde el panel (QR o código).`);
                }
            } else if (connection === 'open') {
                this.reconnectAttempt = 0;
                if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
                this.setStatus('open');
                
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
                    log.warn(msg);
                    if (internalBus && internalBus.notifyAdmin) internalBus.notifyAdmin(msg);
                    this.setKnownAdminPhone(adminPhone);
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        log.info('🔌 [WHATSAPP] auth_info_baileys borrado por cambio de número.');
                    } catch (e) {
                        logError.error(`🔌 [WHATSAPP] No se pudo borrar auth_info_baileys: ${e.message}`);
                    }
                    // Reconnect limpio: el socket actual se cierra y el nuevo
                    // lee creds vacíos -> emite QR nuevo para re-pairing.
                    this.connect();
                    return;
                }
                if (adminPhone) this.setKnownAdminPhone(adminPhone);

                log.info(`✅ ¡Conectado a WhatsApp con éxito!`);
                this.emit('ready', { adminPhone, adminLid });
                
                this.sendPresenceUpdate('available').catch(e => logError.error('⚠️ Error enviando estado de presencia WA:', e));
            }
        });

        this.sock.ev.on('messages.upsert', async m => {
            if (!m.messages || m.messages.length === 0) return;
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            // 🛑 ANTI-BUCLE: Ignorar mensajes generados por el propio bot
            if (msg.key.id && isBotSentMessage(msg.key.id)) return;

            const text = extractTextMessage(msg);
            if (!text) return; // Ignore non-text for now

            const metadata = extractUserMetadata(msg);
            const remoteJid = metadata.remoteJid;

            const stdMsg = new StandardMessage({
                channel: 'whatsapp',
                remoteId: `whatsapp:${remoteJid}`,
                rawId: remoteJid,
                text: text,
                metadata: {
                    ...metadata,
                    isFromMe: msg.key.fromMe
                },
                raw: msg
            });

            this.emit('message', stdMsg);
        });

        const handleContactSync = (contacts, source) => {
            if (!Array.isArray(contacts) || contacts.length === 0) return;
            const valid = contacts.filter(c => c && c.id && !isJunkJid(c.id));
            if (valid.length > 0) {
                this.emit('contact_sync', { contacts: valid, source });
            }
        };

        this.sock.ev.on('contacts.upsert', c => handleContactSync(c, 'contacts.upsert'));
        this.sock.ev.on('contacts.update', c => handleContactSync(c, 'contacts.update'));

        this.sock.ev.on('messaging-history.set', ({ contacts, chats, messages, progress, syncType }) => {
            if (contacts) handleContactSync(contacts, 'history');
            this.emit('history_sync', { messages });
            log.info(`📜 WA History sync: type=${syncType} progreso=${progress}% chats=${chats?.length ?? 0} msgs=${messages?.length ?? 0}`);
        });

        this.sock.ev.on('presence.update', ({ id, presences }) => {
            this.emit('presence_update', { id, presences });
        });
    }

    async disconnect() {
        if (this.sock) {
            this.sock.end(new Error('Manual disconnect'));
            this.sock = null;
        }
        this.setStatus('disconnected');
    }

    async sendMessage(normalizedJid, text, options = {}) {
        if (!this.sock) throw new Error('WhatsApp no conectado');
        const waJid = normalizedJid.replace('whatsapp:', '');
        return await this.sock.sendMessage(waJid, { text, ...options });
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
