/**
 * ⚙️ CATEGORÍA 4: CONTROL GLOBAL DEL SISTEMA (/pausar /reanudar /info /estado /init)
 */
const { state } = require('../../config');
const { getContactsDB } = require('../../services/db');
const { getCountryFromPhone } = require('../../services/metadataService');

function runPausar() {
    state.IS_BOT_PAUSED = true;
    return "⏸️ *Bot Pausado Globalmente.* El auto-respondedor de IA ha sido desactivado para todos los chats.";
}

function runReanudar() {
    state.IS_BOT_PAUSED = false;
    return "▶️ *Bot Reanudado Globalmente.* El auto-respondedor de IA está activo.";
}

function runInfo({ remoteJid }) {
    return `📱 *Información de Conexión Admin:*\n` +
        `• *Teléfono Admin:* \`${state.ADMIN_PHONE || 'No detectado'}\`\n` +
        `• *LID Admin:* \`${state.ADMIN_LID || 'No detectado'}\`\n` +
        `• *País:* ${getCountryFromPhone(state.ADMIN_PHONE)}\n` +
        `• *JID Actual:* \`${remoteJid}\`\n\n` +
        `💡 *Consejo:* Usa \`/buscar <nombre>\` para buscar cualquier contacto en tu libreta.`;
}

function runEstado() {
    const stateDb = getContactsDB();
    return `🤖 *Estado del SDK-Bot:*\n` +
        `• *Estado Bot Global:* ${state.IS_BOT_PAUSED ? '⏸️ Pausado' : '▶️ Activo'}\n` +
        `• *Perfil IA:* ${state.CURRENT_PROFILE}\n` +
        `• *Permitidos (Allowed):* ${Object.values(stateDb).filter(c => c.estado === 'permitido').length} usuario(s)\n` +
        `• *Lista Negra (Ignorados):* ${Object.values(stateDb).filter(c => c.estado === 'ignorado').length} usuario(s)\n` +
        `• *Base de Contactos:* ${Object.keys(stateDb).length} registrado(s)\n\n` +
        `📌 *MENÚ DE COMANDOS:*\n\n` +
        `🤖 *Control Individual (Chat):*\n` +
        `• \`/a <num>\` -> Activar IA\n` +
        `• \`/h <num>\` -> Atención Humana (Pausar IA)\n` +
        `• \`/c <num>\` -> Limpiar Memoria de IA\n\n` +
        `🛡️ *Modos y Reglas (Listas):*\n` +
        `• \`/i <num|agenda|*>\` -> Ignorar (Lista Negra)\n` +
        `• \`/p <num|*>\` -> Permitir (Lista Blanca)\n` +
        `• \`/q <num|*>\` -> Quitar de listas (Neutro)\n` +
        `• \`/l\` -> Ver listas de reglas actuales\n\n` +
        `📇 *Contactos y Agenda:*\n` +
        `• \`/s <texto>\` -> Buscar contacto\n` +
        `• \`/n <num> <nombre>\` -> Guardar nombre\n` +
        `• \`/lc\` -> Resumen de libreta\n` +
        `• \`/sync\` -> Sincronizar memoria RAM\n` +
        `• \`/export\` -> Exportar toda la libreta\n\n` +
        `⚙️ *Sistema y Config:*\n` +
        `• \`/pg\` / \`/ag\` -> Pausar/Arrancar bot globalmente\n` +
        `• \`/pf <perfil>\` -> Cambiar prompt IA\n` +
        `• \`/pf exportar <perfil>\` -> Enviar .md del perfil a editar\n` +
        `• \`/pf eliminar <perfil>\` -> Borrar un perfil (default protegido)\n` +
        `• \`/update\` (citando un .md) -> Importar perfil editado\n` +
        `• \`/info\` -> Datos de depuración\n` +
        `• \`/init\` -> 📚 Leer guía rápida de inicio`;
}

function runInit() {
    return `🚀 *GUÍA RÁPIDA DE INICIO - SDK BOT*\n\n` +
        `¡Hola Admin! Tu bot está listo. Aquí tienes cómo funciona la lógica principal:\n\n` +
        `*1️⃣ MODO GLOBAL (Quién habla con el bot)*\n` +
        `Por defecto, el bot responde a **todos**. Si quieres que solo hable con ciertos clientes, envíame \`/i *\` (Ignorar a todos). El bot se volverá estricto y solo responderá a la "Lista Blanca".\n\n` +
        `*2️⃣ PERMITIR E IGNORAR INDIVIDUALMENTE*\n` +
        `Para saltar el Modo Global, puedes usar reglas individuales:\n` +
        `• \`/p +56912345678\` -> El bot SIEMPRE le responderá.\n` +
        `• \`/i +56912345678\` -> El bot NUNCA le responderá.\n` +
        `• \`/q +56912345678\` -> Quita la regla y vuelve al comportamiento por defecto.\n\n` +
        `*3️⃣ ATENCIÓN HUMANA (HANDOFF)*\n` +
        `Si un cliente quiere hablar contigo, el bot te avisará aquí. Si respondes a esa alerta con \`/a\` (o envías \`/a <num>\`), la IA vuelve a tomar el control. Si envías \`/h <num>\`, silencias a la IA y hablas tú.\n\n` +
        `*4️⃣ ATAJOS (CITAS)*\n` +
        `¡No necesitas escribir el número de teléfono todo el tiempo! Solo **responde (cita)** el mensaje del cliente en este chat y escribe \`/a\`, \`/h\` o \`/c\`.\n\n` +
        `*5️⃣ EL BOTÓN DE PÁNICO*\n` +
        `Si necesitas apagar el bot por completo, usa \`/pg\` (Pause Global). Para prenderlo, \`/ag\` (Arranque Global).\n\n` +
        `Para ver todos los comandos de nuevo, envía \`/e\`.`;
}

module.exports = [
    { aliases: ['/pausar', '/pg', '/pause', '/stop'], run: runPausar },
    { aliases: ['/reanudar', '/ag', '/resume', '/start', '/run'], run: runReanudar },
    { aliases: ['/info', '/whoami'], run: runInfo },
    { aliases: ['/estado', '/e', '/menu', '/status', '/help', '/admin'], run: runEstado },
    { aliases: ['/init', '/startguide', '/guia'], run: runInit }
];
