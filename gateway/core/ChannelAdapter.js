const EventEmitter = require('events');

/**
 * Clase base para un Canal de comunicación del Gateway (WhatsApp, Telegram, etc).
 * Emite eventos: 'message', 'presence', 'connection', 'qr', 'contact_sync'
 */
class ChannelAdapter extends EventEmitter {
    constructor(channelName) {
        super();
        this.channelName = channelName; // ej. 'whatsapp', 'telegram'
        this.status = 'disconnected';
    }

    /**
     * Inicia la conexión del canal.
     */
    async connect(options = {}) {
        throw new Error('Not implemented');
    }

    /**
     * Desconecta el canal de forma segura.
     */
    async disconnect() {
        throw new Error('Not implemented');
    }

    /**
     * Envia un mensaje de texto.
     * @param {string} normalizedJid - ID estandarizado (ej 'whatsapp:123', 'telegram:456')
     * @param {string} text
     * @returns {Promise<any>} Objeto resultado de envío para registrar
     */
    async sendMessage(normalizedJid, text) {
        throw new Error('Not implemented');
    }

    /**
     * Actualiza el estado de presencia ('composing', 'paused', 'available').
     * @param {string} status 
     * @param {string} [normalizedJid]
     */
    async sendPresenceUpdate(status, normalizedJid) {
        throw new Error('Not implemented');
    }

    /**
     * Solicita código de emparejamiento manual (principalmente para WhatsApp)
     */
    async requestPairingCode(number) {
        throw new Error('Not supported by this channel');
    }

    /**
     * Setter estandarizado del estado interno.
     */
    setStatus(status) {
        this.status = status;
        this.emit('connection', { status, channel: this.channelName });
    }
}

module.exports = ChannelAdapter;
