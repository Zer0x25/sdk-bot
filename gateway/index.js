const path = require('path');
const fs = require('fs');
const { state } = require('./config');
const { bulkUpsertContactsMetadata, cleanContactsDB, contactStore, contactIdentityFromRaw } = require('./services/contactsRepository');
const contactSyncQueue = require('./services/contactSyncQueue');
const { flushToDisk } = require('./services/db');
const { getCountryFromPhone } = require('./services/metadataService');
const { handleIncomingMessage, handlePresenceUpdate } = require('./handlers/messageHandler');
const messageQueue = require('./services/messageQueue');
const broadcastService = require('./services/broadcastService');
const { startStatusServer, channels } = require('./services/statusServer');
const chatStore = require('./store/chatStore');
const messageSyncQueue = require('./services/messageSyncQueue');
const { isWiping } = require('./services/factoryReset');
const { cat } = require('./services/logger');
const internalBus = require('./services/internalBus');

const WhatsappAdapter = require('./adapters/whatsappAdapter');
const TelegramAdapter = require('./adapters/telegramAdapter');

chatStore.configure({
    maxPerChat: Number(process.env.GATEWAY_PRELOAD_MAX_PER_CHAT) || 200,
    chatTtlMs: Number(process.env.GATEWAY_PRELOAD_CHAT_TTL_MS) || 30 * 60 * 1000,
});
chatStore.startCleanup(Number(process.env.GATEWAY_PRELOAD_CLEANUP_MS) || 10 * 60 * 1000);

const log = cat('CORE');
const logError = cat('ERROR');
const logInstancia = cat('INSTANCIA');

// 🛡️ GUARDAS DE PROCESO (ADR-004): un rechazo no manejado en un poller,
// cola o handler NO debe tumbar todos los canales de golpe. Se registra y
// se sigue vivo. Solo si el proceso queda visiblemente corrupto (≥4 fallos
// en <60s) se sale con código 1 para que el supervisor (systemd/Docker)
// levante un proceso sano desde el inicio.
let faultStreak = 0;
let lastFaultAt = 0;
/** @param {string} kind @param {any} err */
function noteFault(kind, err) {
    const now = Date.now();
    faultStreak = (now - lastFaultAt < 60000) ? faultStreak + 1 : 1;
    lastFaultAt = now;
    logError.error(`🛡️ [${kind}] #${faultStreak}: ${err && (err.stack || err.message || err)}`);
    if (kind === 'uncaughtException' && faultStreak >= 4) {
        logError.error('🛡️ Estado posiblemente corrupto: saliendo para reinicio limpio.');
        process.exit(1);
    }
}
process.on('unhandledRejection', (err) => noteFault('unhandledRejection', err));
process.on('uncaughtException', (err) => noteFault('uncaughtException', err));

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

cleanContactsDB();

// Registry of active adapters
const adapters = new Map();

/**
 * Helper to get a registered adapter by channel name (e.g. 'whatsapp', 'telegram')
 */
function getAdapter(channel) {
    return adapters.get(channel) || null;
}
module.exports.getAdapter = getAdapter; // Expose for pipeline

async function startGateway() {
    log.info('Iniciando Hub de Canales del Gateway...');

    // 1. Iniciar WhatsApp
    const whatsapp = new WhatsappAdapter();
    adapters.set('whatsapp', whatsapp);

    // Conectar eventos del adaptador de WhatsApp
    whatsapp.on('qr', ({ qr }) => {
        internalBus.handleConnectionUpdate({ qr }, whatsapp); // Simulate for old internalBus
        log.info('\n--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---');
        require('qrcode-terminal').generate(qr, { small: true });
    });

    whatsapp.on('ready', ({ adminPhone, adminLid }) => {
        if (adminPhone) state.ADMIN_PHONE = adminPhone;
        if (adminLid) state.ADMIN_LID = adminLid;
        log.info(`👑 ADMIN WA DETECTADO -> Teléfono: ${state.ADMIN_PHONE} | LID: ${state.ADMIN_LID}`);
    });

    whatsapp.on('connection', ({ status, detail }) => {
        channels.whatsapp.connection = status;
        channels.whatsapp.reconnectAttempt = whatsapp.reconnectAttempt || 0;
        // 'sin_sesion' | 'logged_out' en standby; null al abrir/reconectar
        channels.whatsapp.lastDisconnectReason = detail || null;
        if (status === 'open') {
            channels.whatsapp.lastConnectAt = new Date().toISOString();
        }
        internalBus.handleConnectionUpdate({ connection: status }, whatsapp);
    });

    whatsapp.on('message', async stdMsg => {
        await handleIncomingMessage(stdMsg);
    });

    whatsapp.on('raw_message', async () => {
        // Temporarily handling raw Baileys messages if needed
    });

    whatsapp.on('contact_sync', ({ contacts, source }) => {
        log.info(`📇 [${source}] ${contacts.length} contactos encolados`);
        contactSyncQueue.push(contacts);
    });

    whatsapp.on('history_sync', ({ messages }) => {
        if (messages && messages.length) messageSyncQueue.push(messages);
    });

    whatsapp.on('presence_update', ({ id, presences }) => {
        handlePresenceUpdate(id, presences);
    });

    // 2. Iniciar Telegram
    const telegram = new TelegramAdapter();
    adapters.set('telegram', telegram);

    telegram.on('ready', ({ adminLid }) => {
        log.info(`👑 ADMIN TG DETECTADO -> Chat ID: ${adminLid}`);
    });

    telegram.on('message', async stdMsg => {
        // ÚNICO dueño de getUpdates: este adaptador. Todo (comandos del admin
        // y conversaciones) entra al pipeline; messageHandler trata el chat
        // del admin de Telegram como self-chat (mismas reglas que WhatsApp).
        await handleIncomingMessage(stdMsg);
    });
    
    telegram.on('connection', ({ status, detail }) => {
        channels.telegram.connection = status;
        // 'token_invalido' en standby; null al conectar bien
        channels.telegram.lastDisconnectReason = detail || null;
        if (status === 'open') {
            channels.telegram.lastConnectAt = new Date().toISOString();
        }
    });

    // Arrancar conectores
    await whatsapp.connect();
    await telegram.connect();

    // Compatibilidad Inyectar socket a colas para compatibilidad temporal
    messageQueue.setSock(whatsapp); // Needs refactor to use adapter
    broadcastService.setSock(whatsapp); // Needs refactor
    internalBus.setSock(whatsapp); // Needs refactor
    
    internalBus.setQrRefresh(() => {
        // No recrear el socket si ya hay un QR vigente o un pairing en curso:
        // connect({freshQr:true}) destruye el socket actual y eso cortaba el
        // stream justo cuando WhatsApp iba a abrir la sesion -> 515 "restart required".
        // El bus ya bloquea esto en /qr/refresh, pero el adapter tambien debe
        // protegerse si se llama por otra via.
        if (internalBus.isQrWindowOpen && internalBus.isQrWindowOpen()) {
            log.info('🔌 [BUS] Refresh ignorado: ya hay una ventana QR vigente (pairing en curso).');
            return Promise.resolve();
        }
        log.info('🔌 [BUS] Refresco de QR pedido desde el panel: recreando socket de pairing…');
        whatsapp.connect({ freshQr: true });
    });
    
    internalBus.setPairingCodeRequester(async (number) => {
        if (whatsapp.isSessionRegistered()) {
            throw new Error('La sesión ya está registrada; resetea antes de pedir otro código.');
        }
        if (whatsapp.readyState === 3) {
            log.info('🔌 [BUS] Socket cerrado: recreando para pedir código de pairing…');
            whatsapp.connect();
        }
        return await whatsapp.requestPairingCode(number);
    });

    // Guardar/cambiar el token de Telegram desde el panel reconecta el
    // adaptador en caliente, sin reiniciar el gateway.
    internalBus.setTelegramReloader(async () => {
        log.info('🔌 [BUS] Config de Telegram cambiada: reconectando adaptador…');
        await telegram.disconnect();
        await telegram.connect();
    });

    // Colas WA Sync
    let agendaProcessed = 0;
    contactSyncQueue.setProcessor(chunk => {
        const batch = [];
        chunk.forEach(c => {
            if (!c || !c.id) return;
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

    messageSyncQueue.setProcessor(chunk => {
        if (chunk && chunk.length) chatStore.seedMessages(chunk);
    });
}

ensureSingleInstance().then(startGateway);

// Status server
startStatusServer();
require('./services/brainService').startBrainHealthWatch();
internalBus.startInternalBus();

// Compatibilidad: Estas colas asumen WhatsApp por ahora
setInterval(() => messageQueue.scheduleFlush(), 30 * 1000).unref();
broadcastService.setIsConnected(() => channels.whatsapp.connection === 'open' || channels.telegram.connection === 'open');
setInterval(() => { broadcastService.tick(); }, 10 * 1000).unref();

function handleExit() {
    log.info('\n🛑 Señal de apagado recibida. Cerrando de forma segura...');
    for (const [, adapter] of adapters.entries()) {
        adapter.disconnect().catch(() => {});
    }
    if (!isWiping()) flushToDisk();
    process.exit(0);
}

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);
