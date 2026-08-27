const ChannelAdapter = require('../core/ChannelAdapter');
const StandardMessage = require('../core/StandardMessage');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { cat } = require('../services/logger');
const { isJunkJid } = require('../services/contactsRepository');
const { extractUserMetadata } = require('../services/metadataService');
const { extractTextMessage } = require('../services/pipeline'); // Actually we might need to extract this WA logic somewhere else, but for now we import it.
const { isBotSentMessage } = require('../config');

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

        if (this.sock) {
            const old = this.sock;
            this.sock = null;
            try { old.end(new Error('Reconnect por nueva conexión')); } catch (e) { /* ya cerrado */ }
        }

        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        if (freshQr && !authState.creds.registered && (authState.creds.me || authState.creds.pairingCode)) {
            delete authState.creds.me;
            delete authState.creds.pairingCode;
            await saveCreds();
            log.info('🔌 [WHATSAPP] Pairing incompleto descartado antes de generar QR fresco.');
        }

        this.sock = makeWASocket({
            printQRInTerminal: false,
            auth: authState,
            logger: pino({ level: 'silent' }),
            // syncFullHistory:true saturaba el handshake con numeros con historia
            // y WhatsApp cerraba el stream con 515 "restart required" antes de open.
            syncFullHistory: false,
            markOnlineOnConnect: true,
            browser: ['SDK-Bot', 'Chrome', '124.0.0.0']
            // NOTA: no pasar 'version' con un array inventado. Baileys rc14 no
            // exporta DEFAULT_VERSION y una version invalida hace que el handshake
            // HTTP con WhatsApp Web sea rechazado con 405 (Connection Failure) y el
            // gateway cae a standby sin emitir QR. Baileys resuelve su version por
            // defecto internamente si no se especifica.
        });

        // Eventos Baileys
        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', (update) => {
            if (this.sock !== this.sock) return; // Ignore old socket events
            
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.emit('qr', { qr });
            }
            
            if (connection === 'close') {
                this.sock = null;
                const dc = /** @type {any} */ (lastDisconnect);
                const dcErr = dc?.error;
                const dcStatus = dcErr?.output?.statusCode;
                const loggedOut = dcStatus === DisconnectReason.loggedOut;
                // Loguea la razon real del cierre (el logger de Baileys esta en silent,
                // asi que sin esto el pairing fallido queda ciego: statusCode 401/403/409/500
                // o "Stream Errored" indican el motivo de fondo).
                log.warn(`🔌 [WHATSAPP] connection.close statusCode=${dcStatus ?? 'n/a'} loggedOut=${loggedOut} err=${dcErr?.message || (dcErr ? String(dcErr) : 'n/a')}`);

                let shouldReconnect = true;
                let reason = '';
                if (!this.isSessionRegistered()) {
                    shouldReconnect = false;
                    reason = 'sin_sesion';
                } else if (loggedOut) {
                    shouldReconnect = false;
                    reason = 'logged_out';
                }

                if (shouldReconnect) {
                    this.setStatus('reconnecting');
                    this.scheduleReconnect();
                } else {
                    this.setStatus('standby');
                    log.warn(`ℹ️ Gateway WhatsApp en STANDBY. Razón: ${reason}`);
                }
            } else if (connection === 'open') {
                this.reconnectAttempt = 0;
                if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
                this.setStatus('open');
                
                let adminPhone = '';
                let adminLid = '';
                if (this.sock.user) {
                    adminPhone = this.sock.user.id ? this.sock.user.id.split(':')[0].split('@')[0] : '';
                    adminLid = this.sock.user.lid ? this.sock.user.lid.split(':')[0].split('@')[0] : '';
                }
                
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
