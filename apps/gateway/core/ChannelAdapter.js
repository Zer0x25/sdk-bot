const EventEmitter = require('events');

/**
 * Clase base para un Canal de comunicación del Gateway (WhatsApp, Telegram, etc).
 * Emite eventos: 'message', 'presence', 'connection', 'qr', 'contact_sync'
 */
class ChannelAdapter extends EventEmitter {
    constructor(channelName) {
        super();
        this.channelName = channelName; // ej. 'whatsapp', 'telegram'
        this.archive = null;
        this.status = 'disconnected';
        this.statusDetail = null;
    }

    /**
     * Inicia la conexión del canal.
     */
    async connect(_options = {}) {
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
     * @param {string} _normalizedJid - ID estandarizado (ej 'whatsapp:123', 'telegram:456')
     * @param {string} _text
     * @returns {Promise<any>} Objeto resultado de envío para registrar
     */
    async sendMessage(normalizedJid, text, options = {}) {
        return require('../services/outbound/sendMessage').sendMessage(this, normalizedJid, text, options);
    }

    /** Envío del proveedor, invocado por el SendMessage común tras guardar el intent. */
    async sendMessageRaw(_normalizedJid, _text, _options = {}) {
        throw new Error('Not implemented');
    }

    /**
     * Actualiza el estado de presencia ('composing', 'paused', 'available').
     * @param {string} _status 
     * @param {string} [_normalizedJid]
     */
    async sendPresenceUpdate(_status, _normalizedJid) {
        throw new Error('Not implemented');
    }

    /**
     * Solicita código de emparejamiento manual (principalmente para WhatsApp)
     */
    async requestPairingCode(_number) {
        throw new Error('Not supported by this channel');
    }

    /**
     * Setter estandarizado del estado interno.
     * @param {string} status
     * @param {string} [detail] motivo opcional (ej: 'sin_sesion', 'logged_out', 'token_invalido')
     */
    setStatus(status, detail) {
        this.status = status;
        this.statusDetail = detail || null;
        this.emit('connection', { status, channel: this.channelName, detail: detail || null });
    }
}

module.exports = ChannelAdapter;
