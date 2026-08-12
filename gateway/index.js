const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { state } = require('./config');
const { bulkUpsertContactsMetadata, isJunkJid, cleanContactsDB, contactStore, contactIdentityFromRaw } = require('./services/contactsRepository');
const contactSyncQueue = require('./services/contactSyncQueue');
const { flushToDisk } = require('./services/db');
const { getCountryFromPhone } = require('./services/metadataService');
const { handleIncomingMessage, handlePresenceUpdate } = require('./handlers/messageHandler');
const { decideReconnect } = require('./services/pipeline');
const messageQueue = require('./services/messageQueue');
const broadcastService = require('./services/broadcastService');
const { startStatusServer, runtime } = require('./services/statusServer');
const { isWiping } = require('./services/factoryReset');
const { cat } = require('./services/logger');

const log = cat('CORE');
const logInstancia = cat('INSTANCIA');
const logError = cat('ERROR');

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
            logInstancia.info(`♻️  Gateway anterior detectado (PID ${existing}). Cerrando y reiniciando...`);
            try { process.kill(existing, 'SIGTERM'); } catch (e) { /* ya muerto */ }
            await waitForExit(existing, 8000);
        } else {
            logInstancia.info(`\n🔒 El Gateway YA está corriendo (PID ${existing}).`);
            logInstancia.info(`   → Para reiniciarlo: \`npm start -- --restart\`\n`);
            process.exit(1);
        }
    } else if (existing) {
        logInstancia.info(`🧹 Lock huérfano detectado (PID ${existing} ya no existe). Limpiando...`);
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

let currentSocket = null;          // Socket activo (para cerrar el anterior antes de recrear)
let reconnectAttempt = 0;          // Intento actual de reconexión (reset en 'open')
let reconnectTimer = null;         // Timer de backoff pendiente

// 🖥️ F6-P4: referencia al panel web opcional (null si no está montado).
// El motor NO depende de él: solo usa `?.` para avisarle del socket y del QR.
let adminWeb = null;

// ⚠️ Backoff exponencial: 2s → 5s → 15s → 60s (tope) para no martillear a WhatsApp
const RECONNECT_BACKOFF_MS = [2000, 5000, 15000, 60000];

function getReconnectDelay() {
    const idx = Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    return RECONNECT_BACKOFF_MS[idx];
}

// ¿Hay una sesión guardada en disco? Sin creds.json, WhatsApp espera un QR
// nuevo y NO hay nada que reconectar: un loop de reconexión solo martillea
// a WhatsApp (riesgo de baneo). En ese estado, esperar acción del admin
// (escanear QR, pairing o reset desde el panel/terminal).
function hasSavedSession() {
    return fs.existsSync(path.join(__dirname, 'auth_info_baileys', 'creds.json'));
}

function scheduleReconnect() {
    reconnectAttempt += 1;
    const delay = getReconnectDelay();
    log.warn(`↻ Esperando ${(delay / 1000).toFixed(0)}s antes de reconectar (intento ${reconnectAttempt})...`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToWhatsApp();
    }, delay);
}

async function connectToWhatsApp () {
    // 🔌 Cerrar limpiamente un socket anterior que aún esté vivo (evita doble conexión)
    if (currentSocket) {
        const old = currentSocket;
        currentSocket = null;
        try { old.end(new Error('Reconnect por nueva conexión')); } catch (e) { /* ya cerrado */ }
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: authState,
        logger: pino({ level: 'silent' }),
        syncFullHistory: true,
        markOnlineOnConnect: true
    });
    currentSocket = sock;
    messageQueue.setSock(sock);
    broadcastService.setSock(sock);
    adminWeb?.setSock(sock); // F6-P4: el panel se entera del socket nuevo (QR fresco)

    // Capturar eventos de sincronización de contactos de WhatsApp (Agenda del Teléfono).
    // La sync completa ocurre SOLO al vincular el dispositivo por primera vez
    // (no se puede repetir después): si se corta a mitad, la agenda queda
    // parcial. Por eso el procesamiento va a una COLA POR CHUNKS que cede el
    // event loop entre lote y lote (300 contactos por tick): procesar miles
    // de contactos en un solo tick saturaba el proceso, el socket no
    // respondía los pings y WhatsApp cortaba la conexión.
    let agendaProcessed = 0; // total de contactos procesados por esta conexión

    contactSyncQueue.setProcessor(chunk => {
        const batch = [];

        chunk.forEach(c => {
            if (!c || !c.id) return;
            // Guardar en el almacén de sesión local
            contactStore.set(c.id, c);

            const { phone, lid } = contactIdentityFromRaw(c);

            batch.push({
                phoneNumber: phone,
                lid: lid,
                savedName: c.name || null,
                pushName: c.notify || c.pushName || null,
                verifiedName: c.verifiedName || null,
                isContact: true,
                country: getCountryFromPhone(phone)
            });
        });

        if (batch.length > 0) {
            const accepted = bulkUpsertContactsMetadata(batch);
            agendaProcessed += batch.length;
            log.info(`✅ Cola de agenda: ${batch.length} procesados (${accepted} guardados)`);
        }
        if (contactSyncQueue.pendingCount() === 0) {
            log.info(`✅ Cola de agenda drenada: ${agendaProcessed} contactos procesados en esta conexión`);
        }
    });

    const handleContactSync = (contacts, source) => {
        if (!Array.isArray(contacts) || contacts.length === 0) return;
        log.info(`📇 [${source}] ${contacts.length} contactos encolados`);
        contactSyncQueue.push(contacts.filter(c => c && c.id && !isJunkJid(c.id)));
    };

    sock.ev.on('contacts.upsert', c => handleContactSync(c, 'contacts.upsert'));
    sock.ev.on('contacts.update', c => handleContactSync(c, 'contacts.update'));

    // Capturar sincronización de historial completo inicial de WhatsApp Web
    sock.ev.on('messaging-history.set', ({ contacts, chats, messages, progress, syncType }) => {
        if (contacts) handleContactSync(contacts, 'history');
        log.info(`📜 History sync: type=${syncType} progreso=${progress}% chats=${chats?.length ?? 0} contactos=${contacts?.length ?? 0} msgs=${messages?.length ?? 0}`);
    });

    // Progreso de la sync de historial (INITIAL_BOOTSTRAP / RECENT): si al
    // vincular la agenda se corta, este log dice en qué fase quedó.
    sock.ev.on('messaging-history.status', ({ syncType, status }) => {
        log.info(`🔄 Sync de historial: ${syncType} → ${status}`);
    });

    // Capturar eventos de presencia (detección de escritura "composing" para reiniciar el timer de inactividad de 8s)
    sock.ev.on('presence.update', ({ id, presences }) => {
        handlePresenceUpdate(id, presences);
    });

    sock.ev.on('connection.update', (update) => {
        // Ignorar eventos de sockets reemplazados o cerrados por una reconexión nueva
        if (currentSocket !== sock) return;

        adminWeb?.handleConnectionUpdate(update); // F6-P4: el panel captura el QR (si lo hay)

        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            log.info('\n--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            currentSocket = null;
            runtime.connection = 'close';
            runtime.lastDisconnectReason = lastDisconnect.error?.message || null;
            const loggedOut = (lastDisconnect.error)?.output?.statusCode === DisconnectReason.loggedOut;
            const { reconnect, reason } = decideReconnect({ hasSession: hasSavedSession(), loggedOut });
            log.warn('Conexión cerrada. Motivo:', lastDisconnect.error?.message, '| Reconectando:', reconnect);
            if (reconnect) {
                runtime.connection = 'reconnecting';
                runtime.reconnectAttempt = reconnectAttempt;
                scheduleReconnect();
            } else if (reason === 'sin_sesion') {
                // Sin sesión: nada que reconectar. El QR/pairing lo resuelve
                // el admin (terminal o panel web); no reintentar en loop.
                log.warn('ℹ️ Sin sesión guardada: no se reintenta reconectar automáticamente. Escanea el QR o usa el panel web (pairing/reset) para obtener un QR nuevo.');
            }
        } else if (connection === 'open') {
            runtime.connection = 'open';
            runtime.lastConnectAt = new Date().toISOString();
            reconnectAttempt = 0;
            runtime.reconnectAttempt = 0;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            if (sock.user) {
                state.ADMIN_PHONE = sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                state.ADMIN_LID = sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
            }
            log.info(`\n✅ ¡Conectado a WhatsApp con éxito!`);
            log.info(`👑 ADMIN DETECTADO -> Teléfono: ${state.ADMIN_PHONE} | LID: ${state.ADMIN_LID}`);
            
            // 📡 Anunciar al servidor que el bot está en línea para poder recibir eventos de "composing" de otros.
            sock.sendPresenceUpdate('available').catch(e => logError.error('⚠️ Error enviando estado de presencia:', e));
        }
    });

    sock.ev.on('messages.upsert', async m => {
        await handleIncomingMessage(m, sock);
    });
    
    // Guardar estado de autenticación (sesión)
    sock.ev.on('creds.update', saveCreds);
}

ensureSingleInstance().then(connectToWhatsApp);

// 📊 F4-P3: servidor de métricas local (GET /status y /health en 127.0.0.1)
startStatusServer();

// 🖥️ F6-P1: panel de administración web OPCIONAL — solo con SDK_ADMIN_WEB_ENABLED=1.
// Módulo consumidor: no altera el motor (sin el env, el bot es idéntico).
if (process.env.SDK_ADMIN_WEB_ENABLED === '1') {
    adminWeb = require('./services/adminWebServer');
    adminWeb.startAdminWebServer();
}

// 📥 F4-P4: red de seguridad — si el brain vuelve sin una llamada IA exitosa que
// dispare el flush, intentar vaciar la cola cada 30s (no mantiene el proceso vivo).
setInterval(() => messageQueue.scheduleFlush(), 30 * 1000).unref();

// 📢 F4-P5: worker de broadcasts — 1 mensaje por tick (pacing anti-ban) y solo
// con la conexión abierta. No mantiene el proceso vivo.
broadcastService.setIsConnected(() => runtime.connection === 'open');
setInterval(() => { broadcastService.tick(); }, 10 * 1000).unref();

// -------------------------------------------------------------
// CIERRE SEGURO (GRACEFUL SHUTDOWN)
// -------------------------------------------------------------
function handleExit() {
    log.info('\n🛑 Señal de apagado recibida. Cerrando de forma segura...');
    // 🧹 Reset limpio en curso (F7): el wipe ya borró las DBs; no volcarlas.
    if (!isWiping()) flushToDisk();
    process.exit(0);
}

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);
