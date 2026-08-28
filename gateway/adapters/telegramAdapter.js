const ChannelAdapter = require('../core/ChannelAdapter');
const StandardMessage = require('../core/StandardMessage');
const https = require('https');
const { getSettingsDB } = require('../services/db');
const { updateTelegramMenu, classifyPollResponse } = require('../services/telegramService');
const { registerSentMessage, isBotSentMessage } = require('../config');
const { cat } = require('../services/logger');

const log = cat('TELEGRAM');

class TelegramAdapter extends ChannelAdapter {
    constructor() {
        super('telegram');
        this.pollerActive = false;
        this.lastUpdateId = 0;
        this.token = null;
        this.adminChatId = null;
        // Generación del loop de polling: al reconectar (ej: token nuevo
        // guardado desde el panel) la generación cambia y el loop viejo
        // termina solo, sin dejar dos loops compitiendo por getUpdates.
        this.pollGeneration = 0;
    }

    async connect() {
        // Detener cualquier loop previo antes de releer la configuración.
        this.pollerActive = false;
        const gen = ++this.pollGeneration;

        const settings = getSettingsDB();
        this.token = settings.telegramToken;
        this.adminChatId = String(settings.telegramChatId || '');

        if (!this.token) {
            log.warn('⚠️ No hay token de Telegram configurado. Adaptador en standby (configúralo en el panel).');
            this.setStatus('standby', 'sin_token');
            return;
        }

        this.setStatus('open');
        this.pollerActive = true;
        this.emit('ready', { adminLid: this.adminChatId });

        updateTelegramMenu(this.token).catch(e => log.error('Error actualizando menú: ' + e.message));
        
        log.info('✅ Conectado a Telegram (Polling activo)');
        this.poll(gen);
    }

    async disconnect() {
        this.pollerActive = false;
        this.setStatus('disconnected');
    }

    async poll(gen = this.pollGeneration) {
        if (!this.pollerActive || gen !== this.pollGeneration) return;

        try {
            const updates = await new Promise((resolve, reject) => {
                const req = https.get({hostname: 'api.telegram.org', path: `/bot${this.token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`, family: 4}, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.setTimeout(35000, () => { req.destroy(); resolve({ ok: true, result: [] }); });
            });

            if (!this.pollerActive || gen !== this.pollGeneration) return;

            if (updates.ok && updates.result) {
                for (const u of updates.result) {
                    this.lastUpdateId = Math.max(this.lastUpdateId, u.update_id);
                    if (u.message && u.message.text) {
                        // 🛑 ANTI-BUCLE (simétrico a WhatsApp): ignorar los
                        // mensajes que el propio bot envió (evita reprocesar
                        // respuestas del bot como si fueran del admin/cliente).
                        if (u.message.message_id && isBotSentMessage(u.message.message_id)) continue;

                        const tgChatId = String(u.message.chat.id);
                        
                        // Determinar si es el administrador principal de Telegram
                        const isAdmin = (tgChatId === this.adminChatId);
                        
                        // Parse name
                        const pushName = u.message.from?.first_name || 'Desconocido';
                        const username = u.message.from?.username;
                        const fullName = username ? `${pushName} (@${username})` : pushName;

                        const stdMsg = new StandardMessage({
                            channel: 'telegram',
                            remoteId: `telegram:${tgChatId}`,
                            rawId: tgChatId,
                            text: u.message.text,
                            metadata: {
                                pushName: fullName,
                                savedName: null,
                                phoneNumber: null,
                                lid: tgChatId, // Usamos tgChatId como su identificador
                                isBusiness: false,
                                country: 'Desconocido',
                                isFromMe: false,
                                isAdminChannel: isAdmin
                            },
                            raw: u.message
                        });

                        this.emit('message', stdMsg);
                    }
                }
            } else if (classifyPollResponse(updates) === 'auth') {
                // Token inválido o revocado: parar el loop y dejarlo visible en
                // el panel (standby + motivo). Se reactiva al guardar token nuevo.
                log.error('🚫 Token de Telegram inválido o revocado. Genera uno nuevo con @BotFather y guárdalo en el panel.');
                this.pollerActive = false;
                this.setStatus('standby', 'token_invalido');
                return;
            }
        } catch (e) {
            if (e.message !== 'socket hang up') {
                log.error('Error en poller de telegram: ' + e.message);
            }
            await new Promise(r => setTimeout(r, 5000));
        }

        if (this.pollerActive && gen === this.pollGeneration) {
            setImmediate(() => this.poll(gen));
        }
    }

    async sendMessage(normalizedJid, text, options = {}) {
        if (!this.token) throw new Error('Telegram token no configurado');
        const tgChatId = normalizedJid.replace('telegram:', '');
        const useMarkdown = options.useMarkdown !== false;

        return new Promise((resolve, reject) => {
            const payload = { chat_id: tgChatId, text: text };
            if (useMarkdown) payload.parse_mode = 'Markdown';

            const data = JSON.stringify(payload);
            const req = https.request({
                hostname: 'api.telegram.org',
                family: 4,
                port: 443,
                path: `/bot${this.token}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        const bodyJson = JSON.parse(body);
                        // 🛑 Registrar el message_id para el anti-bucle del poller
                        if (bodyJson && bodyJson.result && bodyJson.result.message_id) {
                            registerSentMessage({ message_id: bodyJson.result.message_id });
                        }
                        resolve(bodyJson);
                    } else if (useMarkdown && res.statusCode === 400 && body.includes("can't parse entities")) {
                        // Retry without markdown
                        this.sendMessage(normalizedJid, text, { ...options, useMarkdown: false })
                            .then(resolve)
                            .catch(reject);
                    } else {
                        reject(new Error(`Telegram error ${res.statusCode}: ${body}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    async sendPresenceUpdate(status, normalizedJid) {
        // Telegram supports 'typing' action
        if (!normalizedJid || !this.token) return;
        if (status !== 'composing') return; // we only simulate composing
        
        const tgChatId = normalizedJid.replace('telegram:', '');
        const data = JSON.stringify({ chat_id: tgChatId, action: 'typing' });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.telegram.org',
                family: 4,
                port: 443,
                path: `/bot${this.token}/sendChatAction`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    async requestPairingCode() {
        throw new Error('Telegram no soporta requestPairingCode');
    }
}

module.exports = TelegramAdapter;
