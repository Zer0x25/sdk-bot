const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { state } = require('./config');
const { bulkUpsertContactsMetadata, isJunkJid, cleanContactsDB, contactStore, flushToDisk } = require('./services/storageService');
const { getCountryFromPhone } = require('./services/metadataService');
const { handleIncomingMessage, handlePresenceUpdate } = require('./handlers/messageHandler');

// -------------------------------------------------------------
// 🔒 INSTANCIA ÚNICA DEL GATEWAY
// Dos gateways compartiendo auth_info_baileys pelean por creds.json
// y pueden CORROMPER la sesión de WhatsApp. Por eso se bloquea.
// Uso: `node index.js --restart` (o `npm start -- --restart`) cierra
// el anterior y arranca uno nuevo.
// -------------------------------------------------------------
const GATEWAY_LOCK_FILE = path.join(__dirname, '.gateway.lock');

function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function readLock() {
    try {
        return parseInt(fs.readFileSync(GATEWAY_LOCK_FILE, 'utf8').trim(), 10);
    } catch (e) {
        return null;
    }
}

function removeLock() {
    try {
        if (readLock() === process.pid) fs.unlinkSync(GATEWAY_LOCK_FILE);
    } catch (e) { /* ignorar */ }
}

function waitForExit(pid, timeoutMs) {
    const start = Date.now();
    return new Promise(resolve => {
        const check = () => {
            if (!isProcessAlive(pid) || Date.now() - start > timeoutMs) return resolve();
            setTimeout(check, 250);
        };
        check();
    });
}

async function ensureSingleInstance() {
    const allowRestart = process.argv.includes('--restart');
    const existing = readLock();

    if (existing && isProcessAlive(existing)) {
        if (allowRestart) {
            console.log(`♻️  Gateway anterior detectado (PID ${existing}). Cerrando y reiniciando...`);
            try { process.kill(existing, 'SIGTERM'); } catch (e) { /* ya muerto */ }
            await waitForExit(existing, 8000);
        } else {
            console.log(`\n🔒 El Gateway YA está corriendo (PID ${existing}).`);
            console.log(`   → Para reiniciarlo: \`npm start -- --restart\`\n`);
            process.exit(1);
        }
    } else if (existing) {
        console.log(`🧹 Lock huérfano detectado (PID ${existing} ya no existe). Limpiando...`);
        try { fs.unlinkSync(GATEWAY_LOCK_FILE); } catch (e) { /* ignorar */ }
    }

    fs.writeFileSync(GATEWAY_LOCK_FILE, String(process.pid));
    process.on('exit', removeLock);
}

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
        markOnlineOnConnect: true
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

    // Capturar eventos de presencia (detección de escritura "composing" para reiniciar el timer de inactividad de 8s)
    sock.ev.on('presence.update', ({ id, presences }) => {
        handlePresenceUpdate(id, presences);
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
            
            // 📡 Anunciar al servidor que el bot está en línea para poder recibir eventos de "composing" de otros.
            sock.sendPresenceUpdate('available').catch(e => console.error('⚠️ Error enviando estado de presencia:', e));
        }
    });

    sock.ev.on('messages.upsert', async m => {
        await handleIncomingMessage(m, sock);
    });
    
    // Guardar estado de autenticación (sesión)
    sock.ev.on('creds.update', saveCreds);
}

ensureSingleInstance().then(connectToWhatsApp);

// -------------------------------------------------------------
// CIERRE SEGURO (GRACEFUL SHUTDOWN)
// -------------------------------------------------------------
function handleExit() {
    console.log('\n🛑 Señal de apagado recibida. Cerrando de forma segura...');
    flushToDisk();
    process.exit(0);
}

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);
