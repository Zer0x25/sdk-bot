/**
 * 🧹 Helpers compartidos de comandos admin: sanitización, parseo de targets,
 * ayuda contextual (COMMAND_USAGE / usageOf / syntaxError) y particionado
 * de respuestas largas. Sin dependencias circulares.
 */

/**
 * 🧹 Sanitizar texto de usuario antes de interpolar en respuestas con formato
 * markdown de WhatsApp (Fase 2, S3): neutraliza caracteres de formato
 * (* _ ` ~) y saltos de línea para evitar inyección de markdown.
 */
function sanitizeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/[*_`~]/g, '')
        .replace(/[\r\n]+/g, ' ');
}

/**
 * 🧹 Normalizar cualquier formato de teléfono (+56 9 4252 3669 -> 56942523669) o LID
 */
function parsePhoneOrLid(input) {
    if (!input) return "";
    const str = String(input).trim();
    if (str === "*") return "*";
    
    // Extraer solo dígitos
    const digits = str.replace(/[^0-9]/g, '');
    
    // Si tiene 7 o más dígitos, es un teléfono o LID válido
    if (digits.length >= 7) {
        return digits;
    }
    return str;
}

/**
 * 🎯 Validar target para comandos de listas (/p /i /q): "*" o 7+ dígitos puros
 * (número de WhatsApp o LID). Evita crear registros "undefined"/basura.
 */
function isValidTargetId(targetId) {
    return targetId === '*' || /^\d{7,}$/.test(targetId);
}

/**
 * 📖 Help por comando canónico: sintaxis + ejemplos. Un solo lugar para mantener.
 * En cualquier error de sintaxis, el bot responde con el Uso del comando.
 */
const COMMAND_USAGE = {
    ia:      '/ia <numero_o_lid> — o responde (cita) un mensaje del cliente.\n\n*Ejemplo copiable:*\n```/a +56 9 4252 3669```',
    humano:  '/humano <numero_o_lid> — o responde (cita) un mensaje del cliente.\n\n*Ejemplo copiable:*\n```/h +56 9 4252 3669```',
    limpiar: '/limpiar <numero_o_lid> — o responde (cita) un mensaje del cliente.\n\n*Ejemplo copiable:*\n```/c +56 9 4252 3669```',
    ignorar: '/ignorar <num|agenda|*> —\n\n*Ejemplos copiables:*\n```/i +56 9 4252 3669```\n```/i agenda```\n```/i *```',
    permitir: '/permitir <numero_o_lid|*> —\n\n*Ejemplos copiables:*\n```/p +56 9 4252 3669```\n```/p *```',
    quitar:  '/quitar <numero_o_lid|*> —\n\n*Ejemplo copiable:*\n```/q +56 9 4252 3669```',
    buscar:  '/buscar <nombre_tel_o_lid> —\n\n*Ejemplos copiables:*\n```/s Pedro```\n```/s +56 9 4252 3669```',
    nombre:  '/nombre <numero_o_lid> <nombre_agenda> —\n\n*Ejemplo copiable:*\n```/n +56 9 4252 3669 Pedro Pizzería```',
    update:  'cita un archivo `.md` y escribe `/update` (o envíalo con caption `/update`).\n\n*Exportar un perfil para editar:* `/perfil exportar <key>`'
};

/**
 * 📖 Formatea el help de un comando ("⚠️ *Uso:* ...").
 */
function usageOf(cmd) {
    return `⚠️ *Uso:* ${COMMAND_USAGE[cmd] || 'revisa el menú con `/e`'}`;
}

/**
 * 📖 Respuesta de error de sintaxis: detalle + help del comando en cuestión.
 */
function syntaxError(cmd, detail) {
    return `⚠️ ${detail}\n\n${usageOf(cmd)}`;
}

// 📏 WhatsApp limita los mensajes de texto (~4096 chars); nos quedamos por debajo con margen
const ADMIN_MSG_MAX_CHARS = 2800;

/**
 * ✂️ Divide una respuesta larga del admin en varios mensajes de WhatsApp.
 * Respeta los saltos de línea para no cortar elementos de listas.
 */
function chunkAdminText(text) {
    if (!text) return [];
    if (text.length <= ADMIN_MSG_MAX_CHARS) return [text];

    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (line.length > ADMIN_MSG_MAX_CHARS) {
            if (current) { chunks.push(current); current = ''; }
            // Línea única monstruosa (sin saltos donde apoyarse): cortar por caracteres
            for (let i = 0; i < line.length; i += ADMIN_MSG_MAX_CHARS) {
                chunks.push(line.slice(i, i + ADMIN_MSG_MAX_CHARS));
            }
            continue;
        }
        if (current && (current.length + line.length + 1) > ADMIN_MSG_MAX_CHARS) {
            chunks.push(current);
            current = line;
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

/**
 * 💡 Extraer un teléfono o LID del mensaje citado por el admin
 * (respuesta/cita a un mensaje de alerta o contacto). Devuelve "" si no hay match.
 */
function extractPhoneFromQuoted(rawMsg) {
    const quotedText = rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                       rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ||
                       "";
    // Buscar un número de teléfono (con espacios, guiones o llano) o LID en el texto citado
    const phoneMatch = quotedText.match(/(?:\+?\d[\d\s\-]{6,20}\d|\b\d{7,16}\b)/);
    return phoneMatch ? parsePhoneOrLid(phoneMatch[0]) : "";
}

module.exports = {
    sanitizeMarkdown,
    parsePhoneOrLid,
    isValidTargetId,
    COMMAND_USAGE,
    usageOf,
    syntaxError,
    chunkAdminText,
    extractPhoneFromQuoted,
    ADMIN_MSG_MAX_CHARS
};
