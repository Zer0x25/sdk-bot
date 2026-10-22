function createWhatsappPairingCallbacks({ whatsapp, isQrWindowOpen, log = () => {} }) {
    if (!whatsapp || typeof whatsapp.connect !== 'function'
        || typeof whatsapp.requestPairingCode !== 'function'
        || typeof whatsapp.isSessionRegistered !== 'function'
        || typeof isQrWindowOpen !== 'function') {
        throw new TypeError('INVALID_WHATSAPP_PAIRING_DEPENDENCIES');
    }

    return {
        async refreshQr() {
            // Recreating the socket during an active QR/pairing can close the
            // transport just as WhatsApp is completing the link.
            if (isQrWindowOpen()) {
                log('QR refresh ignored: pairing window is active.');
                return;
            }
            log('QR refresh requested: recreating pairing socket.');
            return await whatsapp.connect({ freshQr: true });
        },

        async requestCode(number) {
            if (whatsapp.isSessionRegistered()) {
                throw new Error('La sesión ya está registrada; resetea antes de pedir otro código.');
            }
            if (whatsapp.readyState === 3) {
                log('Pairing socket is closed: reconnecting before requesting a code.');
                await whatsapp.connect();
            }
            return await whatsapp.requestPairingCode(number);
        }
    };
}

module.exports = { createWhatsappPairingCallbacks };
