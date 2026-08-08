const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { state } = require('./config');
const { upsertContactMetadata, isJunkJid, cleanContactsDB } = require('./services/storageService');
const { getCountryFromPhone } = require('./services/metadataService');
const { handleIncomingMessage } = require('./handlers/messageHandler');

// Limpiar base de contactos al iniciar para remover data basura preexistente
cleanContactsDB();

// -------------------------------------------------------------
// ALMACÉN EN MEMORIA PERSISTENTE DE BAILEYS (STORE DE CONTACTOS Y CHATS)
// -------------------------------------------------------------
const STORE_PATH = path.join(__dirname, 'auth_info_baileys', 'baileys_store.json');
const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

try {
    if (fs.existsSync(STORE_PATH)) {
        store.readFromFile(STORE_PATH);
    }
} catch (e) {
    console.error("No se pudo leer baileys_store.json (se creará uno nuevo):", e.message);
}

setInterval(() => {
    try {
        const storeDir = path.dirname(STORE_PATH);
        if (!fs.existsSync(storeDir)) {
            fs.mkdirSync(storeDir, { recursive: true });
        }
        store.writeToFile(STORE_PATH);
    } catch (e) {
        // Ignorar errores menores al escribir el store
    }
}, 10000);

// -------------------------------------------------------------
// CONEXIÓN PRINCIPAL CON BAILEYS (ENTRADA PRINCIPAL DEL GATEWAY)
// -------------------------------------------------------------

async function connectToWhatsApp () {
    const { state: authState, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: authState,
        logger: pino({ level: 'silent' })
    });

    // Enlazar eventos del socket con el almacén en memoria (Contacts & Chats Store)
    store.bind(sock.ev);

    // Capturar eventos de sincronización de contactos de WhatsApp (Agenda del Teléfono)
    const handleContactSync = contacts => {
        contacts.forEach(c => {
            if (c.id && !isJunkJid(c.id)) {
                const phone = c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null;
                const lid = c.lid ? c.lid.split('@')[0] : (c.id.endsWith('@lid') ? c.id.split('@')[0] : null);
                
                upsertContactMetadata({
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
    };

    sock.ev.on('contacts.upsert', handleContactSync);
    sock.ev.on('contacts.update', handleContactSync);
    
    // Capturar sincronización de historial inicial de WhatsApp Web
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
        await handleIncomingMessage(m, sock, store);
    });
    
    // Guardar estado de autenticación (sesión)
    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
