const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { state } = require('./config');
const { bulkUpsertContactsMetadata, isJunkJid, cleanContactsDB, contactStore } = require('./services/storageService');
const { getCountryFromPhone } = require('./services/metadataService');
const { handleIncomingMessage } = require('./handlers/messageHandler');

// Limpiar base de contactos al iniciar para remover data basura preexistente
cleanContactsDB();

// -------------------------------------------------------------
// CONEXIÓN PRINCIPAL CON BAILEYS (ENTRADA PRINCIPAL DEL GATEWAY)
// -------------------------------------------------------------

async function connectToWhatsApp () {
    const { state: authState, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: authState,
        logger: pino({ level: 'silent' }),
        syncFullHistory: true,
        markOnlineOnConnect: false
    });

    // Capturar eventos de sincronización de contactos de WhatsApp (Agenda del Teléfono)
    const handleContactSync = contacts => {
        if (!Array.isArray(contacts)) return;
        const batch = [];

        contacts.forEach(c => {
            if (c && c.id && !isJunkJid(c.id)) {
                // Guardar en el almacén de sesión local
                contactStore.set(c.id, c);

                const phone = c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null;
                const lid = c.lid ? c.lid.split('@')[0] : (c.id.endsWith('@lid') ? c.id.split('@')[0] : null);
                
                batch.push({
                    phoneNumber: phone,
                    lid: lid,
                    savedName: c.name || null,
                    pushName: c.notify || c.pushName || null,
                    verifiedName: c.verifiedName || null,
                    isContact: true,
                    country: getCountryFromPhone(phone)
                });
            }
        });

        if (batch.length > 0) {
            bulkUpsertContactsMetadata(batch);
        }
    };

    sock.ev.on('contacts.upsert', handleContactSync);
    sock.ev.on('contacts.update', handleContactSync);
    
    // Capturar sincronización de historial completo inicial de WhatsApp Web
    sock.ev.on('messaging-history.set', ({ contacts }) => {
        if (contacts) handleContactSync(contacts);
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Motivo:', lastDisconnect.error?.message, '| Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            if (sock.user) {
                state.ADMIN_PHONE = sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                state.ADMIN_LID = sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
            }
            console.log(`\n✅ ¡Conectado a WhatsApp con éxito!`);
            console.log(`👑 ADMIN DETECTADO -> Teléfono: ${state.ADMIN_PHONE} | LID: ${state.ADMIN_LID}`);
        }
    });

    sock.ev.on('messages.upsert', async m => {
        await handleIncomingMessage(m, sock);
    });
    
    // Guardar estado de autenticación (sesión)
    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
