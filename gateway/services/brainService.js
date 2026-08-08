const { BRAIN_API_URL, state, registerSentMessage } = require('../config');

/**
 * 🧩 Dividir respuestas largas de la IA en globos de chat naturales (Multi-Bubble)
 */
function splitIntoHumanBubbles(text) {
    if (!text || typeof text !== 'string') return [text];
    const trimmed = text.trim();
    if (trimmed.length <= 180) return [trimmed];

    const rawParagraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    let bubbles = [];

    for (const p of rawParagraphs) {
        if (p.length > 300 && p.includes('\n')) {
            const lines = p.split(/\n+/).map(l => l.trim()).filter(Boolean);
            bubbles.push(...lines);
        } else {
            bubbles.push(p);
        }
    }

    const merged = [];
    let current = '';

    for (const b of bubbles) {
        if (!current) {
            current = b;
        } else if ((current.length + b.length) < 180) {
            current += '\n\n' + b;
        } else {
            merged.push(current);
            current = b;
        }
    }
    if (current) merged.push(current);

    return merged.length > 0 ? merged : [trimmed];
}

/**
 * 🧠 Calcular tiempo de lectura/pensamiento inicial antes de empezar a teclear
 */
function calculateReadDelay(incomingText) {
    const len = (incomingText || '').length;
    const baseReadMs = Math.min(Math.max(len * 15, 1000), 3000);
    const readJitter = (Math.random() - 0.5) * 600; // ±300ms de varianza
    return Math.max(Math.round(baseReadMs + readJitter), 800);
}

/**
 * ⌨️ Calcular tiempo de tecleo ultra-realista con ruido estocástico (Jitter)
 * Basado en velocidad rápida de teclado móvil: ~7 a 10 caracteres por segundo (100ms a 135ms por carácter)
 */
function calculateTypingDelay(bubbleText) {
    const len = (bubbleText || '').length;
    const msPerChar = 100 + Math.random() * 35; // 100ms a 135ms por carácter (7 - 10 char/s)
    const baseTypingMs = len * msPerChar;
    const typingJitter = (Math.random() - 0.5) * 1000; // ±500ms de ruido estocástico
    return Math.min(Math.max(Math.round(baseTypingMs + typingJitter), 1500), 16000);
}

/**
 * 🚨 Notificar al Administrador en Self-Chat en caso de error técnico o fallo de IA
 */
async function notifyAdminError(sock, metadata, textMessage, errorDetails) {
    if (!state.ADMIN_PHONE && !state.ADMIN_LID) {
        console.error("⚠️ [ERROR ADMIN] No se detectó ADMIN_PHONE ni ADMIN_LID para enviar alerta de error.");
        return;
    }

    const adminJid = state.ADMIN_PHONE ? `${state.ADMIN_PHONE}@s.whatsapp.net` : `${state.ADMIN_LID}@lid`;
    const displayName = metadata.savedName || metadata.pushName || 'Desconocido';
    const phone = metadata.phoneNumber || 'N/A';
    const lid = metadata.lid || 'N/A';
    const country = metadata.country || 'Desconocido';
    const targetKey = metadata.phoneNumber || metadata.lid || 'N/A';

    const adminAlert = 
        `⚠️ **ALERTA DE ERROR EN CEREBRO IA**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 **Cliente:** ${displayName}\n` +
        `📱 **Teléfono:** ${phone} | LID: ${lid}\n` +
        `🌎 **País:** ${country}\n` +
        `💬 **Mensaje del Cliente:** "${textMessage}"\n` +
        `❌ **Error Técnico:** ${errorDetails}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *El bot NO respondió al cliente.* Puedes responderle manualmente o pausar la IA en este chat con:\n` +
        `\`/handoff ${targetKey}\``;

    try {
        const sentAlert = await sock.sendMessage(adminJid, { text: adminAlert });
        registerSentMessage(sentAlert);
    } catch (err) {
        console.error("Error al enviar alerta a Self-Chat del Admin:", err.message);
    }
}

async function processAIChat(textMessage, remoteJid, metadata, sock) {
    const displayName = metadata.savedName || metadata.pushName || 'Usuario';
    const langLog = metadata.language ? ` | Idioma: ${metadata.language}` : '';
    console.log(`\n[ENVIANDO A IA] De: ${displayName} (${remoteJid}) | País: ${metadata.country}${langLog}`);
    
    try {
        const response = await fetch(BRAIN_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
                user_id: remoteJid,
                message: textMessage,
                bot_profile: state.CURRENT_PROFILE,
                saved_name: metadata.savedName,
                push_name: metadata.pushName,
                user_name: displayName,
                phone_number: metadata.phoneNumber,
                lid: metadata.lid,
                country: metadata.country,
                language: metadata.language,
                bio: metadata.bio,
                is_business: metadata.isBusiness
            })
        });
        
        const data = await response.json();
        
        if (data.response) {
            console.log(`[BOT RESPONDE A ${displayName}]: ${data.response}`);
            
            // 🧠 1. Simulación de Lectura / Pensamiento Humano (antes de teclear)
            const readDelay = calculateReadDelay(textMessage);
            console.log(`[SIMULACIÓN HUMANA] 📖 Leyendo/pensando durante ${(readDelay / 1000).toFixed(2)}s...`);
            await new Promise(r => setTimeout(r, readDelay));

            // 🧩 2. Divisón inteligente en globos (Multi-Bubble)
            const bubbles = splitIntoHumanBubbles(data.response);

            // ⌨️ 3. Secuencia de Escritura + Envío por Globo
            for (let i = 0; i < bubbles.length; i++) {
                const bubble = bubbles[i];
                const typingDelay = calculateTypingDelay(bubble);

                console.log(`[SIMULACIÓN HUMANA] ⌨️ Tecleando globo ${i + 1}/${bubbles.length} (${bubble.length} chars) durante ${(typingDelay / 1000).toFixed(2)}s...`);
                
                await sock.sendPresenceUpdate('composing', remoteJid);
                await new Promise(r => setTimeout(r, typingDelay));

                const sentMsg = await sock.sendMessage(remoteJid, { text: bubble });
                registerSentMessage(sentMsg);

                // ☕ Pausa humana entre globos consecutivos
                if (i < bubbles.length - 1) {
                    await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
                    const pauseBetweenBubbles = 1000 + Math.floor(Math.random() * 1200); // 1.0s a 2.2s
                    console.log(`[SIMULACIÓN HUMANA] ☕ Pausa entre globos de ${(pauseBetweenBubbles / 1000).toFixed(2)}s...`);
                    await new Promise(r => setTimeout(r, pauseBetweenBubbles));
                }
            }
        } else {
            console.error("Error del cerebro:", data.error);
            await notifyAdminError(sock, metadata, textMessage, data.error || "Respuesta vacía del cerebro IA");
        }
    } catch (error) {
        console.error("Error al conectar con el cerebro:", error.message);
        await notifyAdminError(sock, metadata, textMessage, error.message);
    } finally {
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }
}

module.exports = {
    processAIChat
};
