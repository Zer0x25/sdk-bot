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
const chatStore = require('./store/chatStore'); // Opción C: store RAM de mensajes de Baileys (precarga web-like)
const messageSyncQueue = require('./services/messageSyncQueue'); // sync de historial por chunks (evita congelar el event loop)
const { isWiping } = require('./services/factoryReset');
const { cat } = require('./services/logger');

const AUTH_DIR = process.env.SDK_AUTH_DIR || path.join(__dirname, 'auth_info_baileys');

// Opción C: store RAM de mensajes de Baileys (precarga web-like desde el hilo real).
chatStore.configure({
    maxPerChat: Number(process.env.GATEWAY_PRELOAD_MAX_PER_CHAT) || 200,
    chatTtlMs: Number(process.env.GATEWAY_PRELOAD_CHAT_TTL_MS) || 30 * 60 * 1000,
});
chatStore.startCleanup(Number(process.env.GATEWAY_PRELOAD_CLEANUP_MS) || 10 * 60 * 1000);

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
        if (existing === process.pid) {
            // El lock apunta a ESTE mismo proceso. Ocurre en contenedores donde el
            // servicio corre siempre como PID 1 y, al reiniciar el contenedor
            // (restart: unless-stopped), el lock persiste en su capa escribible.
            // No es otra instancia: limpiamos y continuamos (evita el crash-loop).
            logInstancia.info(`ℹ️  Lock apunta a este mismo proceso (PID ${existing}). Ignorando y continuando...`);
            try { fs.unlinkSync(GATEWAY_LOCK_FILE); } catch (e) { /* ignorar */ }
        } else if (allowRestart) {
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
const internalBus = require('./services/internalBus'); // 🔌 bus interno (panel = 3er proceso)
const { wsReadyState } = internalBus;

// ⚠️ Backoff exponencial: 2s → 5s → 15s → 60s (tope) para no martillear a WhatsApp
const RECONNECT_BACKOFF_MS = [2000, 5000, 15000, 60000];

function getReconnectDelay() {
    const idx = Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    return RECONNECT_BACKOFF_MS[idx];
}

// ¿Hay una sesión REGISTRADA (realmente vinculada a WhatsApp)? Sin creds.json,
// o con un pairing incompleto (creds.me / pairingCode pero sin `registered`),
// WhatsApp espera un QR/pairing nuevo y NO hay nada que reconectar: un loop de
// reconexión solo martillea a WhatsApp (riesgo de baneo). En ese estado el
// gateway entra en STANDBY y espera acción del admin (escanear QR, pairing o
// reset desde el panel/terminal). Usar `registered` (no solo existencia de
// archivo) evita el falso positivo: Baileys crea creds.json al iniciar pairing
// aunque no se haya completado, lo que disparaba un bucle de QRs.
function isSessionRegistered() {
    try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        return Boolean(creds && creds.registered);
    } catch (e) {
        return false;
    }
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

/**
 * @param {{freshQr?: boolean}} [options]
 */
async function connectToWhatsApp (options = {}) {
    const freshQr = options.freshQr === true;
    // 🔌 Cerrar limpiamente un socket anterior que aún esté vivo (evita doble conexión)
    if (currentSocket) {
        const old = currentSocket;
        currentSocket = null;
        try { old.end(new Error('Reconnect por nueva conexión')); } catch (e) { /* ya cerrado */ }
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // requestPairingCode() escribe `creds.me` antes de que el usuario confirme
    // el código. Si ese pairing quedó incompleto, Baileys intenta hacer login
    // con ese número y ya no emite QR. Para un QR explícitamente fresco,
    // quitar solo esos marcadores; una sesión registrada se conserva intacta.
    if (freshQr && !authState.creds.registered && (authState.creds.me || authState.creds.pairingCode)) {
        delete authState.creds.me;
        delete authState.creds.pairingCode;
        await saveCreds();
        log.info('🔌 [BUS] Pairing incompleto descartado antes de generar QR fresco.');
    }

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
    adminWeb?.setSock(sock); // compat tests
    internalBus.setSock(sock); // 🔌 bus interno: el panel (proceso aparte) se entera del socket
    // 🔌 F6-P4: callback de "refrescar QR" desde el panel web. Cierra el
    // socket de pairing actual y Baileys re-emite update.qr en una tanda
    // fresca. También descarta un pairing por código incompleto.
    internalBus.setQrRefresh(() => {
        log.info('🔌 [BUS] Refresco de QR pedido desde el panel: recreando socket de pairing…');
        connectToWhatsApp({ freshQr: true });
    });
    // 🔌 F6-P4: pairing por código de 8 caracteres desde el panel web. Si el
    // socket actual está cerrado (tras agotar intentos de QR), lo recrea y
    // espera a que esté listo para pedir el código a WhatsApp. Así el método
    // "Pair con número" funciona aunque no haya QR vigente.
    internalBus.setPairingCodeRequester(async (number) => {
        // La guía de Baileys exige pedir código solo para una cuenta no
        // registrada. Una sesión ya vinculada debe pasar por reset explícito.
        if (authState.creds.registered) {
            throw new Error('La sesión ya está registrada; resetea antes de pedir otro código.');
        }
        if (!currentSocket || wsReadyState(currentSocket) === 3) {
            log.info('🔌 [BUS] Socket cerrado: recreando para pedir código de pairing…');
            connectToWhatsApp();
        }
        // Esperar a que el socket esté abierto (ws.readyState === 1) para
        // poder llamar requestPairingCode sin error.
        const waitReady = (tries = 40) => new Promise((resolve, reject) => {
            const tick = (n) => {
                const s = currentSocket;
                if (s && wsReadyState(s) === 1) return resolve(s);
                if (n <= 0) return reject(new Error('timeout esperando socket listo para pairing'));
                setTimeout(() => tick(n - 1), 250);
            };
            tick(tries);
        });
        const sock = await waitReady();
        return await sock.requestPairingCode(number);
    });

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

    // Opción C: procesar el historial de mensajes de messaging-history.set por
    // chunks (igual que la agenda) para NO saturar el event loop. Si se procesara
    // de golpe, el socket no responde pings y WhatsApp corta la sync a mitad.
    messageSyncQueue.setProcessor(chunk => {
        if (chunk && chunk.length) chatStore.seedMessages(chunk);
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
        // Opción C: sembrar el store RAM con el historial real de los chats
        // (lo que el web de WhatsApp muestra al abrir un chat). Antes se descartaba.
        if (messages && messages.length) messageSyncQueue.push(messages); // Opción C: sembrar el store RAM por chunks (no satura el event loop)
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

        adminWeb?.handleConnectionUpdate(update); // compat tests
        internalBus.handleConnectionUpdate(update, sock); // 🔌 bus interno: el panel (3er proceso) captura el QR

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
            const { reconnect, reason } = decideReconnect({ hasSession: isSessionRegistered(), loggedOut });
            log.warn('Conexión cerrada. Motivo:', lastDisconnect.error?.message, '| Reconectando:', reconnect);
            if (reconnect) {
                runtime.connection = 'reconnecting';
                runtime.reconnectAttempt = reconnectAttempt;
                scheduleReconnect();
            } else if (reason === 'sin_sesion') {
                // Sin sesión REGISTRADA: STANDBY. El gateway NO reintenta en bucle.
                // Queda vivo (brain + panel arriba) esperando que el admin dispare
                // el pairing manual: el bus interno recrea el socket vía
                // /qr/refresh (panel) o "Pair con número". Es el bot "esperando a
                // su cliente": no martillea a WhatsApp ni queda en bucle de QR.
                runtime.connection = 'standby';
                runtime.reconnectAttempt = 0;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                log.warn('ℹ️ Sin sesión registrada: gateway en STANDBY. No se reintenta reconectar automáticamente. El admin debe escanear el QR o usar el panel web (pairing/reset) para vincular la cuenta.');
            } else if (reason === 'logged_out') {
                // Sesión revocada en el teléfono: tampoco reconectar en loop; el
                // admin debe escanear un QR nuevo a propósito.
                runtime.connection = 'standby';
                runtime.reconnectAttempt = 0;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                log.warn('ℹ️ Sesión cerrada/revocada (logged out): gateway en STANDBY. El admin debe escanear un QR nuevo a propósito (panel web o terminal).');
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
        // Opción C: también alimentar el store RAM con mensajes en vivo.
        if (m?.messages) chatStore.upsertMessage(m.messages[0]);
        await handleIncomingMessage(m, sock);
    });
    
    // Guardar estado de autenticación (sesión)
    sock.ev.on('creds.update', saveCreds);
}

ensureSingleInstance().then(connectToWhatsApp);

// 📊 F4-P3: servidor de métricas local (GET /status y /health en 127.0.0.1)
startStatusServer();

// 💓 Healthcheck activo del brain para el dashboard (Running/Stopped/Idle)
require('./services/brainService').startBrainHealthWatch();

// 🔌 Bus interno SIEMPRE arriba: el panel web (3er proceso, gateway/panel/)
// lo consume por HTTP local (127.0.0.1:5400) para QR/logs/estado/comandos.
// Desacopla el panel del bot: al detener el gateway el panel sigue vivo
// (ap untado a su propio proceso) y se reconecta cuando el gateway vuelve.
internalBus.startInternalBus();

// 🖥️ Panel web: YA NO se arranca aquí. Es un proceso independiente
// (gateway/panel/index.js) que se comunica con el bus interno por HTTP.

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
