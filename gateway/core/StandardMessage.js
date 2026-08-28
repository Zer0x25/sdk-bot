/**
 * Estandarización de mensajes recibidos de cualquier canal.
 */
class StandardMessage {
    /**
     * @param {Object} params
     * @param {string} params.channel - 'whatsapp', 'telegram', etc.
     * @param {string} params.remoteId - ID unificado (ej. 'whatsapp:569xxxxxxx', 'telegram:12345')
     * @param {string} params.rawId - ID original del canal subyacente (ej. '569xxxxxxx@s.whatsapp.net')
     * @param {string} params.text - Contenido de texto del mensaje
     * @param {string} [params.transcript] - Texto resultante de transcribir audio (STT local).
     *        Si viene de audio, `text` se rellena con esto para que el pipeline común
     *        (debounce/presencia/brain/humanSim) lo trate como texto normal.
     * @param {boolean} [params.isAudio] - true si el mensaje original fue audio/voice.
     * @param {Object} [params.metadata] - Metadatos adicionales opcionales
     * @param {string} [params.metadata.pushName] - Nombre público
     * @param {string} [params.metadata.savedName] - Nombre en agenda
     * @param {string} [params.metadata.phoneNumber] - Número de teléfono limpio
     * @param {string} [params.metadata.lid] - ID de plataforma secundario
     * @param {boolean} [params.metadata.isGroup] - Si viene de un grupo
     * @param {any} params.raw - Objeto crudo del canal (solo para casos de escape / media no estandarizada)
     */
    constructor({ channel, remoteId, rawId, text, transcript, isAudio, metadata = {}, raw }) {
        this.channel = channel;
        this.remoteId = remoteId;
        this.rawId = rawId;
        // Si venía de audio, text se rellena con la transcripción (ver adapters).
        this.text = text || '';
        this.transcript = transcript || '';
        this.isAudio = Boolean(isAudio);
        this.metadata = metadata;
        this.raw = raw;
    }
}

module.exports = StandardMessage;
