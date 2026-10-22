const path = require('path');
const fs = require('fs');
const { GATEWAY_STATE_DIR } = require('./lib/repoPaths');
const { state } = require('./config');
const { bulkUpsertContactsMetadata, cleanContactsDB, contactStore, contactIdentityFromRaw } = require('./services/contactsRepository');
const contactSyncQueue = require('./services/contactSyncQueue');
const { flushToDisk } = require('./services/db');
const { getCountryFromPhone } = require('./services/metadataService');
const { handleIncomingMessage, handlePresenceUpdate, drainConversation, drainAllConversations } = require('./handlers/messageHandler');
const messageQueue = require('./services/messageQueue');
const broadcastService = require('./services/broadcastService');
const { startStatusServer, channels } = require('./services/statusServer');
const chatStore = require('./store/chatStore');
const messageSyncQueue = require('./services/messageSyncQueue');
const { isWiping } = require('./services/factoryReset');
const { cat, safeErrorLabel } = require('./services/logger');
const internalBus = require('./services/internalBus');
const { setControlService } = require('./services/stateService');

const WhatsappAdapter = require('./adapters/whatsappAdapter');
const TelegramAdapter = require('./adapters/telegramAdapter');
const { createWhatsappPairingCallbacks } = require('./services/whatsappPairing');

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
    logError.error(`🛡️ [${kind}] #${faultStreak}: ${safeErrorLabel(err)}.`);
    if (kind === 'uncaughtException' && faultStreak >= 4) {
        logError.error('🛡️ Estado posiblemente corrupto: saliendo para reinicio limpio.');
        process.exit(1);
    }
}
process.on('unhandledRejection', (err) => noteFault('unhandledRejection', err));
process.on('uncaughtException', (err) => noteFault('uncaughtException', err));

const GATEWAY_LOCK_FILE = process.env.SDK_GATEWAY_LOCK_PATH || path.join(GATEWAY_STATE_DIR, '.gateway.lock');

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

    fs.mkdirSync(path.dirname(GATEWAY_LOCK_FILE), { recursive: true });
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

let conversationArchive;
let archiveRetention;
let legacyDispatchPump;
let telegramAdminInboxPump;
let conversationControl;
let attachmentStore;
async function startGateway() {
    conversationArchive = require('./services/conversations').createArchive();
    await conversationArchive.ready;
    attachmentStore = require('./services/conversations/attachments').createAttachmentStore({ archive: conversationArchive });
    await attachmentStore.init();
    conversationControl = require('./services/conversations/controlService').createControlService(conversationArchive, {
        drainConversation,
        onResumePending: () => legacyDispatchPump?.trigger(),
        validateProfile: async profileKey => {
            const profiles = await require('./services/brainService').getAvailableProfiles();
            return Array.isArray(profiles) && profiles.some(profile => profile.key === profileKey);
        },
        onPolicyChanged: policy => {
            state.GLOBAL_MODE = policy.globalMode;
            state.CURRENT_PROFILE = policy.globalProfileKey || 'default';
            return drainAllConversations();
        }
    });
    setControlService(conversationControl);
    const controlAuthority = await conversationArchive.controlAuthority();
    if (controlAuthority.mode === 'sqlite') {
        await conversationControl.refreshPolicy();
        const invalidatedQueue = messageQueue.invalidateLegacyReplay();
        if (invalidatedQueue.invalidated) {
            log.warn(`Control SQLite: ${invalidatedQueue.invalidated} trabajos JSONL heredados quedaron archivados sin replay.`);
        }
    }
    await conversationControl.recoverPendingOperations();
    await conversationControl.setServiceReady(true);
    archiveRetention = await require('./services/conversations/retention').startRetention(conversationArchive,
        () => log.error('Archivo: falló la purga diaria; revisar retención.'), attachmentStore);
    require('./services/factoryReset').setBeforeReset(async () => {
        for (const adapter of adapters.values()) await adapter.disconnect();
        await legacyDispatchPump?.close();
        await telegramAdminInboxPump?.close();
        await archiveRetention.close();
        await attachmentStore.close();
        await conversationArchive.close();
    });
    internalBus.startInternalBus({ archive: conversationArchive, attachmentStore, controlService: conversationControl,
        getAdapter: (channel, accountId) => {
            const adapter = adapters.get(channel);
            return adapter?.accountId === accountId ? adapter : null;
        },
        getChannelStatus: (channel, accountId) => {
            const adapter = adapters.get(channel);
            if (!adapter || adapter.accountId !== accountId) return 'disconnected';
            return { status: adapter.status, detail: adapter.statusDetail || null };
        } });
    log.info('Iniciando Hub de Canales del Gateway...');

    // 1. Iniciar WhatsApp
    const whatsapp = new WhatsappAdapter({ archive: conversationArchive, attachmentStore });
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
        log.info('👑 ADMIN WA DETECTADO.');
    });

    whatsapp.on('connection', ({ status, detail }) => {
        channels.whatsapp.connection = status;
        channels.whatsapp.reconnectAttempt = whatsapp.reconnectAttempt || 0;
        // 'sin_sesion' | 'logged_out' en standby; null al abrir/reconectar
        channels.whatsapp.lastDisconnectReason = detail || null;
        if (status === 'open') {
            channels.whatsapp.lastConnectAt = new Date().toISOString();
            void legacyDispatchPump.trigger();
        }
        internalBus.handleConnectionUpdate({ connection: status }, whatsapp);
    });

    whatsapp.on('message', stdMsg => {
        if (stdMsg.archiveMessageId) { void legacyDispatchPump.trigger(); return; }
        void handleIncomingMessage(stdMsg).catch(error => logError.error(`Mensaje WhatsApp no procesado (${safeErrorLabel(error)}).`));
    });

    whatsapp.on('capture_status', status => { channels.whatsapp.capture = status; });
    whatsapp.on('archived_message', ({ raw, source }) => {
        if (source === 'live') chatStore.upsertMessage(raw);
        else messageSyncQueue.push([raw]);
    });

    whatsapp.on('raw_message', async () => {
        // Temporarily handling raw Baileys messages if needed
    });

    whatsapp.on('contact_sync', ({ contacts, source }) => {
        log.info(`📇 [${source}] ${contacts.length} contactos encolados`);
        contactSyncQueue.push(contacts);
    });

    whatsapp.on('presence_update', ({ id, presences }) => {
        handlePresenceUpdate(id, presences);
    });

    // 2. Iniciar Telegram
    const telegram = new TelegramAdapter({ archive: conversationArchive, attachmentStore });
    adapters.set('telegram', telegram);
    internalBus.setTelegramChatIdResolver((token, options) => telegram.discoverChatId(token, options));

    legacyDispatchPump = require('./services/conversations/legacyDispatch').createLegacyDispatchPump({
        archive: conversationArchive,
        dispatch: (message, acknowledge) => handleIncomingMessage(message, { onDurableComplete: acknowledge }),
        isReady: channel => channels[channel]?.connection === 'open',
        onError: (error) => logError.error(`Replay durable falló (${safeErrorLabel(error)}); queda pendiente.`)
    });
    telegramAdminInboxPump = require('./services/conversations/telegramAdminInbox').createTelegramAdminInboxPump({
        archive: conversationArchive,
        dispatch: message => handleIncomingMessage(message),
        isReady: channel => channels[channel]?.connection === 'open',
        onError: error => logError.error(`Comando Telegram quedó con resultado incierto (${safeErrorLabel(error)}); no se repetirá automáticamente.`),
        onUncertain: count => logError.error(`Telegram conserva ${count} comando(s) administrativo(s) con resultado incierto; revisar antes de repetirlos.`)
    });

    telegram.on('ready', () => {
        log.info('👑 ADMIN TG DETECTADO.');
    });

    telegram.on('message', stdMsg => {
        // ÚNICO dueño de getUpdates. Los mensajes de clientes usan el replay
        // durable; el texto administrativo se procesa desde su inbox SQLite.
        if (stdMsg.archiveMessageId) { void legacyDispatchPump.trigger(); return; }
        void handleIncomingMessage(stdMsg).catch(error => logError.error(`Mensaje Telegram no procesado (${safeErrorLabel(error)}).`));
    });
    telegram.on('admin_inbox_pending', () => { void telegramAdminInboxPump.trigger(); });
    
    telegram.on('connection', ({ status, detail }) => {
        channels.telegram.connection = status;
        // 'token_invalido' en standby; null al conectar bien
        channels.telegram.lastDisconnectReason = detail || null;
        if (status === 'open') {
            channels.telegram.lastConnectAt = new Date().toISOString();
            void legacyDispatchPump.trigger();
            void telegramAdminInboxPump.trigger();
        }
    });

    // Arrancar conectores
    await whatsapp.connect();
    await telegram.connect();

    // Inyectar adaptadores y resolutores multi-canal
    messageQueue.setSock(whatsapp);
    messageQueue.setAdapterResolver(getAdapter);
    broadcastService.setSock(whatsapp);
    internalBus.setSock(whatsapp);
    
    const whatsappPairing = createWhatsappPairingCallbacks({
        whatsapp,
        isQrWindowOpen: internalBus.isQrWindowOpen,
        log: message => log.info(`🔌 [BUS] ${message}`)
    });
    internalBus.setQrRefresh(whatsappPairing.refreshQr);

    // Reset de pairing desde el panel: reconectar WhatsApp en caliente (nuevo
    // QR) sin matar el gateway. En dev no hay systemd que lo reviva, y el panel
    // es el producto final -> debe quedar usable sin consola.
    internalBus.setResetReconnect(() => {
        log.info('🔌 [BUS] Reset de pairing desde el panel: rehaciendo sesión de WhatsApp (QR nuevo)...');
        return whatsapp.connect({ freshQr: true });
    });
    
    internalBus.setPairingCodeRequester(whatsappPairing.requestCode);

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

ensureSingleInstance().then(startGateway).catch(() => {
    log.error('No se pudo iniciar el gateway/archivo; se cierra sin admitir canales.');
    void handleExit(1);
});

// Status server
startStatusServer();
require('./services/brainService').startBrainHealthWatch();

// Compatibilidad: Estas colas asumen WhatsApp por ahora
setInterval(() => messageQueue.scheduleFlush(), 30 * 1000).unref();
broadcastService.setIsConnected(() => channels.whatsapp.connection === 'open' || channels.telegram.connection === 'open');
setInterval(() => { broadcastService.tick(); }, 10 * 1000).unref();

let exiting = false;
async function handleExit(exitCode = 0) {
    if (exiting) return;
    exiting = true;
    log.info('\n🛑 Señal de apagado recibida. Cerrando de forma segura...');
    for (const [, adapter] of adapters.entries()) {
        await adapter.disconnect().catch(() => {});
    }
    if (!isWiping()) flushToDisk();
    try { await legacyDispatchPump?.close(); await telegramAdminInboxPump?.close(); await archiveRetention?.close(); await attachmentStore?.close(); await conversationArchive?.close(); } catch { /* exit after worker terminates */ }
    process.exit(exitCode);
}

process.on('SIGINT', () => { void handleExit(); });
process.on('SIGTERM', () => { void handleExit(); });
