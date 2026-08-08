const { BRAIN_API_URL, state, registerSentMessage } = require('../config');

async function processAIChat(textMessage, remoteJid, metadata, sock) {
    const displayName = metadata.savedName || metadata.pushName || 'Usuario';
    console.log(`\n[ENVIANDO A IA] De: ${displayName} (${remoteJid}) | País: ${metadata.country}`);
    
    try {
        const response = await fetch(BRAIN_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
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
                bio: metadata.bio,
                is_business: metadata.isBusiness
            })
        });
        
        const data = await response.json();
        
        if (data.response) {
            console.log(`[BOT RESPONDE A ${displayName}]: ${data.response}`);
            
            // 🧠 SIMULACIÓN HUMANA (Anti-Ban Rate Limiter):
            // Calcular retardo proporcional al tamaño del mensaje (ej: 1.5s - 4.5s) simulando escritura humana
            const textLen = data.response.length;
            const typingDelay = Math.min(Math.max(textLen * 35, 1500), 4500);
            
            await sock.sendPresenceUpdate('composing', remoteJid);
            await new Promise(r => setTimeout(r, typingDelay));

            const sentMsg = await sock.sendMessage(remoteJid, { text: data.response });
            registerSentMessage(sentMsg);
        } else {
            console.error("Error del cerebro:", data.error);
            const sentMsg = await sock.sendMessage(remoteJid, { text: "⚠️ Cerebro IA respondió con error. Revisa la consola de Python." });
            registerSentMessage(sentMsg);
        }
    } catch (error) {
        console.error("Error al conectar con el cerebro:", error.message);
        const sentMsg = await sock.sendMessage(remoteJid, { text: "⚠️ Error de conexión con el Cerebro IA (¿Está encendido?)" });
        registerSentMessage(sentMsg);
    } finally {
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }
}

module.exports = {
    processAIChat
};
