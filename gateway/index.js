const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const path = require('path')

// URL de la API del Cerebro (FastAPI)
const BRAIN_API_URL = 'http://127.0.0.1:8000/chat'

// Ruta del archivo de números permitidos
const ALLOWED_FILE_PATH = path.join(__dirname, 'allowed_numbers.json')

// Estado Global del Bot
let IS_BOT_PAUSED = false;
let CURRENT_PROFILE = "default";

// Identificadores automáticos del Administrador (se capturan al conectar)
let ADMIN_PHONE = "";
let ADMIN_LID = "";

// 🛑 Registro de IDs de mensajes enviados por el bot para PREVENIR BUCLE INFINITO
const botSentMessageIds = new Set();

function registerSentMessage(sentMsg) {
    if (sentMsg && sentMsg.key && sentMsg.key.id) {
        botSentMessageIds.add(sentMsg.key.id);
        setTimeout(() => botSentMessageIds.delete(sentMsg.key.id), 60000);
    }
}

function getAllowedNumbers() {
    try {
        if (!fs.existsSync(ALLOWED_FILE_PATH)) {
            fs.writeFileSync(ALLOWED_FILE_PATH, JSON.stringify(["*"], null, 2))
            return ["*"]
        }
        const fileData = fs.readFileSync(ALLOWED_FILE_PATH, 'utf8')
        return JSON.parse(fileData)
    } catch (e) {
        console.error("Error al leer allowed_numbers.json:", e.message)
        return ["*"]
    }
}

function saveAllowedNumbers(list) {
    try {
        fs.writeFileSync(ALLOWED_FILE_PATH, JSON.stringify(list, null, 2))
        return true
    } catch (e) {
        console.error("Error al guardar allowed_numbers.json:", e.message)
        return false
    }
}

// 🔒 Comprueba si un chat es EXCLUSIVAMENTE el "Self-Chat" (Chat con uno mismo)
function isSelfChat(remoteJid, isFromMe) {
    // REGLA 1: Si el mensaje NO proviene de tu cuenta (isFromMe=false), JAMÁS es Self-Chat
    if (!isFromMe) return false;
    if (!remoteJid) return false;
    
    // Limpiar el JID para quitar sufijos como @s.whatsapp.net, @lid, o :12 (device index)
    const cleanTarget = remoteJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const cleanAdminPhone = ADMIN_PHONE ? ADMIN_PHONE.split(':')[0].replace(/[^0-9]/g, '') : '';
    const cleanAdminLid = ADMIN_LID ? ADMIN_LID.split(':')[0].replace(/[^0-9]/g, '') : '';

    // Solo es Self-Chat si el chat destino coincide EXACTAMENTE con el Teléfono o LID del Administrador
    if (cleanAdminLid && cleanTarget === cleanAdminLid) return true;
    if (cleanAdminPhone && cleanTarget === cleanAdminPhone) return true;

    return false;
}

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        logger: pino({ level: 'silent' })
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            console.log('\n--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---')
            qrcode.generate(qr, { small: true })
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexión cerrada. Motivo:', lastDisconnect.error?.message, '| Reconectando:', shouldReconnect)
            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === 'open') {
            if (sock.user) {
                ADMIN_PHONE = sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                ADMIN_LID = sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
            }
            console.log(`\n✅ ¡Conectado a WhatsApp con éxito!`)
            console.log(`👑 ADMIN DETECTADO -> Teléfono: ${ADMIN_PHONE} | LID: ${ADMIN_LID}`)
        }
    })

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0]
        if (!msg || !msg.message) return;

        // 🛑 ANTI-BUCLE: Ignorar mensajes generados por el propio bot
        if (msg.key.id && botSentMessageIds.has(msg.key.id)) {
            return;
        }

        const remoteJid = msg.key.remoteJid || ''
        const participant = msg.key.participant || ''
        const remoteJidAlt = msg.key.remoteJidAlt || ''
        const sender = msg.pushName || 'Desconocido'
        const isFromMe = msg.key.fromMe

        // Extraer texto
        const textMessage = msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            msg.message?.imageMessage?.caption || 
                            "";
            
        if (!textMessage) return; // Ignorar si no hay texto

        const targetNumber = remoteJid.split('@')[0];
        const isSelf = isSelfChat(remoteJid, isFromMe);

        console.log(`\n🔍 [DEBUG CHAT] JID: ${remoteJid} | FromMe: ${isFromMe} | isSelfChat: ${isSelf} | Texto: "${textMessage}"`)

        // -------------------------------------------------------------
        // SCENARIO 1: MENSAJES EN TU CHAT PROPIO (Self-Chat / Mensaje a ti mismo)
        // -------------------------------------------------------------
        if (isSelf) {
            // A) Si empieza con / -> Ejecutar Comando Admin
            if (textMessage.trim().startsWith('/')) {
                await handleAdminCommand(textMessage.trim(), remoteJid, sock);
                return;
            }

            // B) Si NO empieza con / -> Asistente Personal IA en tu chat propio
            console.log(`\n🤖 [ASISTENTE PERSONAL EN SELF-CHAT]: "${textMessage}"`)
            await processAIChat(textMessage, remoteJid, "Tú (Admin)", sock);
            return;
        }

        // -------------------------------------------------------------
        // SCENARIO 2: MENSAJES ENVIADOS POR TI EN CHATS DE CLIENTES
        // -------------------------------------------------------------
        if (isFromMe) {
            // Si tú escribes en el chat de un cliente desde tu teléfono, el bot TE IGNORA AL 100%
            console.log(`\n🙈 [IGNORADO FORZADO] Escribiste en chat de cliente (${remoteJid}). Bot en silencio.`);
            return;
        }

        // -------------------------------------------------------------
        // SCENARIO 3: MENSAJES RECIBIDOS DE CLIENTES / TERCEROS
        // -------------------------------------------------------------

        // 🛡️ SEGURIDAD: Bloquear intentos de comandos / desde clientes
        if (textMessage.trim().startsWith('/')) {
            console.log(`\n🚫 [SEGURIDAD] Cliente (${sender} - ${remoteJid}) intentó ejecutar comando admin: ${textMessage}`);
            return;
        }

        // 🛑 Si el bot está pausado globalmente, no responder a clientes
        if (IS_BOT_PAUSED) {
            console.log(`\n⏸️ [MENSAJE IGNORADO] Bot pausado. Mensaje de: ${sender}`);
            return;
        }

        // 🔒 Cargar lista de permitidos en tiempo real para USUARIOS
        const allowedNumbers = getAllowedNumbers();
        const candidateIds = [
            targetNumber,
            participant ? participant.split('@')[0] : '',
            remoteJidAlt ? remoteJidAlt.split('@')[0] : ''
        ].filter(Boolean);

        const isAllowed = allowedNumbers.includes("*") || allowedNumbers.some(num => {
            const cleanNum = String(num).replace(/[^0-9]/g, '');
            return candidateIds.some(cid => cid.includes(cleanNum));
        });

        if (!isAllowed) {
            console.log(`\n🚫 [MENSAJE IGNORADO] De: ${sender} | ID recibido: ${candidateIds.join(' / ')} - No está en allowed_numbers.json`);
            return;
        }

        // Procesar respuesta IA para el cliente
        await processAIChat(textMessage, remoteJid, sender, sock);
    })
    
    // Guardar estado de autenticación (sesión)
    sock.ev.on('creds.update', saveCreds)
}

// Función auxiliar para enviar mensaje al Cerebro IA
async function processAIChat(textMessage, remoteJid, sender, sock) {
    console.log(`\n[ENVIANDO A IA] De: ${sender} (${remoteJid})`)
    
    await sock.sendPresenceUpdate('composing', remoteJid)
    
    try {
        const response = await fetch(BRAIN_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: remoteJid,
                message: textMessage,
                bot_profile: CURRENT_PROFILE
            })
        })
        
        const data = await response.json()
        await new Promise(r => setTimeout(r, 1000))
        
        if (data.response) {
            console.log(`[BOT RESPONDE A ${sender}]: ${data.response}`)
            const sentMsg = await sock.sendMessage(remoteJid, { text: data.response })
            registerSentMessage(sentMsg);
        } else {
            console.error("Error del cerebro:", data.error)
            const sentMsg = await sock.sendMessage(remoteJid, { text: "⚠️ Cerebro IA respondió con error. Revisa la consola de Python." })
            registerSentMessage(sentMsg);
        }
    } catch (error) {
        console.error("Error al conectar con el cerebro:", error.message)
        const sentMsg = await sock.sendMessage(remoteJid, { text: "⚠️ Error de conexión con el Cerebro IA (¿Está encendido?)" })
        registerSentMessage(sentMsg);
    } finally {
        await sock.sendPresenceUpdate('paused', remoteJid)
    }
}

// Función auxiliar para procesar comandos de Administrador
async function handleAdminCommand(textMessage, remoteJid, sock) {
    const args = textMessage.trim().split(' ');
    const command = args[0].toLowerCase();
    const targetParam = args[1];

    console.log(`\n👑 [COMANDO ADMIN EN SELF-CHAT]: ${command} ${targetParam || ''}`)

    let adminResponse = "";

    switch (command) {
        case '/pause':
            IS_BOT_PAUSED = true;
            adminResponse = "⏸️ **Bot Pausado.** El auto-respondedor de IA ha sido desactivado.";
            break;

        case '/resume':
        case '/start':
            IS_BOT_PAUSED = false;
            adminResponse = "▶️ **Bot Reanudado.** El auto-respondedor de IA está activo.";
            break;

        case '/allow':
            if (!targetParam) {
                adminResponse = "⚠️ Uso: `/allow <numero_o_lid>`\nEjemplo: `/allow 56912345678` o `/allow *`";
            } else {
                const list = getAllowedNumbers();
                const cleanTarget = targetParam.trim();
                if (!list.includes(cleanTarget)) {
                    list.push(cleanTarget);
                    saveAllowedNumbers(list);
                    adminResponse = `✅ ID/Número **${cleanTarget}** agregado a la lista de permitidos.`;
                } else {
                    adminResponse = `ℹ️ El ID/Número **${cleanTarget}** ya estaba en la lista.`;
                }
            }
            break;

        case '/revoke':
        case '/remove':
            if (!targetParam) {
                adminResponse = "⚠️ Uso: `/remove <numero_o_lid>`";
            } else {
                let list = getAllowedNumbers();
                const cleanTarget = targetParam.trim();
                if (list.includes(cleanTarget)) {
                    list = list.filter(item => item !== cleanTarget);
                    saveAllowedNumbers(list);
                    adminResponse = `🗑️ ID/Número **${cleanTarget}** removido de la lista.`;
                } else {
                    adminResponse = `ℹ️ El ID/Número **${cleanTarget}** no se encontró en la lista.`;
                }
            }
            break;

        case '/list':
            const currentList = getAllowedNumbers();
            adminResponse = `📋 **Lista de Permitidos:**\n\n${currentList.map(n => `- ${n}`).join('\n')}`;
            break;

        case '/profile':
            if (!targetParam) {
                adminResponse = `⚠️ Uso: \`/profile <default|lucia|mateo>\`\nPerfil actual: *${CURRENT_PROFILE}*`;
            } else {
                CURRENT_PROFILE = targetParam.toLowerCase();
                adminResponse = `🎭 Perfil de bot cambiado a: **${CURRENT_PROFILE}**`;
            }
            break;

        case '/status':
        case '/help':
            adminResponse = `🤖 **Estado del SDK-Bot:**\n` +
                `- **Estado:** ${IS_BOT_PAUSED ? '⏸️ Pausado' : '▶️ Activo'}\n` +
                `- **Perfil IA:** ${CURRENT_PROFILE}\n` +
                `- **Permitidos:** ${getAllowedNumbers().length} registrado(s)\n\n` +
                `📌 **Comandos Admin:**\n` +
                `• \`/pause\` - Pausar IA\n` +
                `• \`/resume\` - Activar IA\n` +
                `• \`/allow <num/lid/*>\` - Permitir usuario\n` +
                `• \`/remove <num/lid>\` - Remover usuario\n` +
                `• \`/list\` - Ver permitidos\n` +
                `• \`/profile <default|lucia|mateo>\` - Cambiar personalidad\n` +
                `• \`/status\` - Ver este menú`;
            break;

        default:
            adminResponse = `⚠️ Comando no reconocido: ${command}. Usa \`/help\` para ver la lista.`;
            break;
    }

    const sentMsg = await sock.sendMessage(remoteJid, { text: adminResponse })
    registerSentMessage(sentMsg);
}

connectToWhatsApp()
