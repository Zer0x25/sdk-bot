const { state, registerSentMessage } = require('../config');
const { cat } = require("../services/logger");
const log = cat("COMANDO");
const logError = cat("ERROR");
const { createRateLimiter } = require('../services/rateLimit');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getCountryFromPhone } = require('../services/metadataService');
const { clearAIMemory, getAvailableProfiles, getProfileDetail, exportProfileFile, importProfileFile, deleteProfileFile } = require('../services/brainService');

// ⏱️ S2 — Límite de comandos admin: máx 20/min por admin (ventana deslizante)
const ADMIN_CMD_MAX_PER_MIN = 20;
const adminCommandLimiter = createRateLimiter(ADMIN_CMD_MAX_PER_MIN, 60 * 1000);
const { 
    getSettingsDB,
    getContactsDB,
    saveContactsDB,
    cleanContactsDB,
    upsertContactMetadata,
    bulkUpsertContactsMetadata,
    isJunkJid,
    contactStore,
    setNumberState,
    setCurrentProfile,
    setContactProfile,
    ignoreAllAgendaContacts
} = require('../services/storageService');

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
 * 📥 SUBIR UN PERFIL .MD DESDE UN DOCUMENTO DE WHATSAPP
 * Descarga el documento (adjunto o citado), valida el nombre y lo envía al brain.
 * @param {object} sock - Socket de Baileys
 * @param {string} remoteJid - JID del self-chat
 * @param {object} docMessage - message.documentMessage (o contenido de quotedMessage)
 * @param {object} [msgKey] - key del mensaje original para downloadMediaMessage
 */
async function handleProfileUpload(sock, remoteJid, docMessage, msgKey) {
    try {
        const fileName = docMessage?.fileName || 'perfil.md';
        const match = fileName.match(/^([a-z0-9_\-]+)\.(md|txt)$/i);
        if (!match) {
            await sock.sendMessage(remoteJid, { text: `⚠️ *Archivo no válido:* \`${fileName}\`. Debe llamarse \`perfil.md\` o \`<key>.md\` (ej: \`lucia.md\`).` });
            return false;
        }
        const profileKey = match[1].toLowerCase();

        // 📥 Descarga en Baileys 7.0.0-rc14: downloadMediaMessage(msg, type, options, ctx).
        // ctx.logger debe ser un logger real y ctx.reuploadRequest una FUNCIÓN
        // (Baileys la llama solo si el media da 404/410 = expirado; aquí no hay
        // re-fetch posible sin store, así que se reintenta con el mismo mensaje
        // y el error real llega al admin).
        const buffer = await downloadMediaMessage(msgKey, 'buffer', {}, {
            logger: log,
            reuploadRequest: async (msg) => msg
        });
        if (!buffer) {
            await sock.sendMessage(remoteJid, { text: `⚠️ No pude descargar el archivo \`${fileName}\`. Intenta reenviarlo citándolo con \`/update\`.` });
            return false;
        }

        const content = buffer.toString('utf8');
        const result = await importProfileFile(profileKey, content);

        if (result && result.success) {
            const sent = await sock.sendMessage(remoteJid, {
                text: `✅ *Perfil \`${profileKey}\` actualizado:*\n` +
                    `• *Nombre:* ${result.nombre}\n` +
                    `• *Reglas:* ${result.reglas} | *Ejemplos:* ${result.ejemplos}\n\n` +
                    `Comprueba el prompt: \`/perfil ver ${profileKey}\``
            });
            registerSentMessage(sent);
            return true;
        }

        const sent = await sock.sendMessage(remoteJid, {
            text: `⚠️ *Rechazado* (${fileName}): ${result?.message || 'Brain apagado o error de importación'}. El perfil no fue modificado.`
        });
        registerSentMessage(sent);
        return false;
    } catch (e) {
        logError.error("⚠️ Error al importar perfil desde documento:", e.message);
        await sock.sendMessage(remoteJid, { text: `⚠️ Error al importar el perfil: ${e.message}` }).catch(() => {});
        return false;
    }
}

/**
 * 🔤 Parsear comando /nombre tolerando teléfonos formateados nativos (ej: /nombre +56 9 4252 3669 Pedro)
 */function parseNameArgs(queryParam) {
    if (!queryParam) return { targetId: null, customName: null };
    const str = queryParam.trim();
    
    // Matchear teléfono o LID al inicio incluso con espacios o símbolos (ej: "+56 9 4252 3669 Pedro Pizzería")
    const phoneMatch = str.match(/^(\+?[\d\s\-\(\)]{7,25})\s+(.+)$/);
    if (phoneMatch) {
        const rawPhone = phoneMatch[1].trim();
        const customName = phoneMatch[2].trim();
        return { targetId: parsePhoneOrLid(rawPhone), customName };
    }

    // Fallback: separación por primer espacio
    const firstSpaceIndex = str.indexOf(' ');
    if (firstSpaceIndex !== -1) {
        const rawTarget = str.substring(0, firstSpaceIndex).trim();
        const customName = str.substring(firstSpaceIndex + 1).trim();
        return { targetId: parsePhoneOrLid(rawTarget), customName };
    }

    return { targetId: null, customName: null };
}

async function handleAdminCommand(textMessage, remoteJid, sock, metadata, rawMsg = null) {
    // ⏱️ S2 — Rate limit de comandos admin (protege de spam accidental de comandos)
    if (adminCommandLimiter(remoteJid)) {
        log.warn(`⏱️ [RATE LIMIT ADMIN] ${remoteJid} excedió ${ADMIN_CMD_MAX_PER_MIN} comandos/min. Ignorado: ${textMessage.slice(0, 60)}`);
        await sock.sendMessage(remoteJid, { text: "⏱️ *Demasiados comandos por minuto.* Espera unos segundos e inténtalo de nuevo." });
        return;
    }

    const args = textMessage.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    let queryParam = args.slice(1).join(' ').trim();

    // 💡 EXTRACCIÓN AUTOMÁTICA DE ID SI EL ADMIN RESPONDE (CITA) A UN MENSAJE DE ALERTA O CONTACTO
    if (!queryParam && rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const context = rawMsg.message.extendedTextMessage.contextInfo;
        const quotedText = context.quotedMessage?.conversation || 
                           context.quotedMessage?.extendedTextMessage?.text || 
                           "";
        
        // Buscar un número de teléfono (con espacios, guiones o llano) o LID en el texto citado
        const phoneMatch = quotedText.match(/(?:\+?\d[\d\s\-]{6,20}\d|\b\d{7,16}\b)/);
        if (phoneMatch) {
            queryParam = parsePhoneOrLid(phoneMatch[0]);
            log.info(`📌 [CITA DETECTADA] Extraído objetivo automáticamente del mensaje citado: ${queryParam}`);
        }
    }

    log.info(`\n👑 [COMANDO ADMIN EN SELF-CHAT]: ${command} ${queryParam || ''}`);

    let adminResponse = "";

    switch (command) {
        // -------------------------------------------------------------
        // 🌐 CATEGORÍA 1: CONTROL DE CHAT E IA POR CLIENTE
        // -------------------------------------------------------------

        case '/ia':
        case '/a':
        case '/auto':
        case '/unpause':
            if (!queryParam) {
                adminResponse = usageOf('ia');
            } else {
                const targetId = parsePhoneOrLid(queryParam);
                if (!isValidTargetId(targetId)) {
                    adminResponse = syntaxError('ia', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
                } else {
                    const res = setNumberState(targetId, 'neutral');
                    if (res.success) {
                        adminResponse = `🤖 *IA Reactivada para el cliente:*\n\`${res.target}\`. (Pasó a estado: ${res.state})`;
                    } else {
                        adminResponse = syntaxError('ia', `No pude reactivar la IA para *${sanitizeMarkdown(queryParam)}*.`);
                    }
                }
            }
            break;

        case '/humano':
        case '/h':
        case '/handoff':
            if (!queryParam) {
                adminResponse = usageOf('humano');
            } else {
                const targetId = parsePhoneOrLid(queryParam);
                if (!isValidTargetId(targetId)) {
                    adminResponse = syntaxError('humano', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
                } else {
                    const res = setNumberState(targetId, 'handoff');
                    if (res.success) {
                        adminResponse = `🤝 *Atención Humana activada para:*\n\`${res.target}\`.\nLa IA permanecerá en silencio para este chat.`;
                    } else {
                        adminResponse = syntaxError('humano', `No pude activar atención humana para *${sanitizeMarkdown(queryParam)}*.`);
                    }
                }
            }
            break;

        case '/limpiar':
        case '/c':
        case '/reset':
            if (!queryParam) {
                adminResponse = usageOf('limpiar');
            } else {
                const targetId = parsePhoneOrLid(queryParam);
                if (!isValidTargetId(targetId)) {
                    adminResponse = syntaxError('limpiar', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
                    break;
                }
                const db = getContactsDB();
                const record = Object.values(db).find(c => (c.phone && c.phone.includes(targetId)) || (c.lid && c.lid.includes(targetId)));
                
                const targetJid = record ? (record.phone ? `${record.phone}@s.whatsapp.net` : `${record.lid}@lid`) : (targetId.length < 15 ? `${targetId}@s.whatsapp.net` : `${targetId}@lid`);
                const success = await clearAIMemory(targetJid);
                
                if (success) {
                    adminResponse = `🧹 *Memoria de IA borrada con éxito para:*\n${record ? (record.savedName || record.pushName || targetId) : targetId}. El historial conversacional ha sido reiniciado.`;
                } else {
                    adminResponse = syntaxError('limpiar', `No pude limpiar la memoria para *${sanitizeMarkdown(queryParam)}* (¿existe el contacto?).`);
                }
            }
            break;

        // -------------------------------------------------------------
        // 🛡️ CATEGORÍA 2: SEGURIDAD Y LISTAS (PERMITIDOS Y BLOQUEADOS)
        // -------------------------------------------------------------

        case '/ignorar':
        case '/i':
        case '/b':
        case '/ignore':
            if (!queryParam) {
                adminResponse = usageOf('ignorar');
            } else if (queryParam.toLowerCase() === 'agenda') {
                const res = ignoreAllAgendaContacts();
                adminResponse = `🚫 *Ignorado Masivo de Agenda Ejecutado:*\nSe agregaron *${res.addedCount}* contactos de tu libreta a la Lista de Ignorados.\nTotal ignorados en lista: *${res.totalIgnored}*.`;
            } else if (queryParam === '*' || queryParam.toLowerCase() === 'all') {
                const res = setNumberState('*', 'ignored');
                adminResponse = `🔒 *Modo Global Cambiado:* ${res.message}.\nLa IA estará en *Modo Estricto (Whitelist)*. Solo responderá a los números explícitamente permitidos.`;
            } else {
                const targetId = parsePhoneOrLid(queryParam);
                if (!isValidTargetId(targetId)) {
                    adminResponse = syntaxError('ignorar', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
                } else {
                    const res = setNumberState(targetId, 'ignored');
                    if (res.success) {
                        adminResponse = `🚫 ID/Número \`${res.target}\` asignado a la *Lista de Ignorados* (reubicado de permitidos si existía).`;
                    } else {
                        adminResponse = syntaxError('ignorar', `No pude ignorar *${sanitizeMarkdown(queryParam)}*.`);
                    }
                }
            }
            break;

        case '/permitir':
        case '/p':
        case '/allow':
            if (!queryParam) {
                adminResponse = usageOf('permitir');
            } else if (queryParam === '*' || queryParam.toLowerCase() === 'all') {
                const res = setNumberState('*', 'allowed');
                adminResponse = `🌐 *Modo Global Cambiado:* ${res.message}.\nLa IA responderá a todos los clientes por defecto (excepto los que estén en la Lista de Ignorados).`;
            } else {
                const targetId = parsePhoneOrLid(queryParam);
                if (!isValidTargetId(targetId)) {
                    adminResponse = syntaxError('permitir', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
                } else {
                    const res = setNumberState(targetId, 'allowed');
                    if (res.success) {
                        adminResponse = `✅ ID/Número \`${res.target}\` asignado a la *Lista de Permitidos* (reubicado de ignorados si existía).`;
                    } else {
                        adminResponse = syntaxError('permitir', `No pude permitir *${sanitizeMarkdown(queryParam)}*.`);
                    }
                }
            }
            break;

        case '/quitar':
        case '/q':
        case '/remove':
        case '/rem':
            if (!queryParam) {
                adminResponse = usageOf('quitar');
            } else if (queryParam === '*') {
                const res = setNumberState('*', 'neutral');
                adminResponse = `🔄 Comodín (\`*\`) removido de ambas listas. Transición a estado neutro.`;
            } else {
                const targetId = parsePhoneOrLid(queryParam);
                if (!isValidTargetId(targetId)) {
                    adminResponse = syntaxError('quitar', `ID/Número no válido: *"${sanitizeMarkdown(queryParam)}"*.`);
                } else {
                    const res = setNumberState(targetId, 'neutral');
                    if (res.success) {
                        adminResponse = `🔄 ID/Número \`${res.target}\` removido de ambas listas. Regresado a *Estado 0 (Neutro)*.`;
                    } else {
                        adminResponse = syntaxError('quitar', `No pude quitar *${sanitizeMarkdown(queryParam)}* de las listas.`);
                    }
                }
            }
            break;

        case '/listas':
        case '/lista':
        case '/l':
        case '/list':
            const dbListas = getContactsDB();
            const settings = getSettingsDB();

            const globalMode = state.GLOBAL_MODE || settings.globalMode || 'allowed_all';
            let modeStr = "🌐 *Permitir a Todos por Defecto* (Atención Libre)";
            if (globalMode === 'ignored_all') modeStr = "🔒 *Ignorar a Todos por Defecto* (Modo Estricto / Whitelist)";

            const listIgnored = Object.values(dbListas).filter(c => c.estado === 'ignorado');
            const listAllowed = Object.values(dbListas).filter(c => c.estado === 'permitido');

            const ignoredText = listIgnored.length ? listIgnored.map(c => {
                return `• \`${c.phone || c.lid}\`${c.savedName ? ` (${c.savedName})` : ''}`;
            }).join('\n') : "Ninguno";

            const allowedText = listAllowed.length ? listAllowed.map(c => {
                return `• \`${c.phone || c.lid}\`${c.savedName ? ` (${c.savedName})` : ''}`;
            }).join('\n') : "Ninguno";

            adminResponse = `📋 *ESTADO DE LISTAS DE ATENCIÓN*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `⚙️ **Modo Global:** ${modeStr}\n\n` +
                `🚫 **Lista de Ignorados (${listIgnored.length}):**\n${ignoredText}\n\n` +
                `✅ **Lista de Permitidos Explícitos (${listAllowed.length}):**\n${allowedText}\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💡 *Usa \`/i <num|agenda|*>\`, \`/p <num|*>\` o \`/q <num|*>\`.*`;
            break;

        // -------------------------------------------------------------
        // 🔍 CATEGORÍA 3: LIBRETA Y AGENDA DE CONTACTOS
        // -------------------------------------------------------------

        case '/buscar':
        case '/s':
        case '/search':
            if (!queryParam) {
                adminResponse = usageOf('buscar');
            } else {
                const db = getContactsDB();
                const cleanQuery = queryParam.toLowerCase().replace(/[^a-z0-9]/g, '');
                
                const matches = Object.values(db).filter(item => {
                    const savedMatch = item.savedName && item.savedName.toLowerCase().includes(queryParam.toLowerCase());
                    const pushMatch = item.pushName && item.pushName.toLowerCase().includes(queryParam.toLowerCase());
                    const phoneMatch = item.phone && item.phone.includes(cleanQuery);
                    const lidMatch = item.lid && item.lid.includes(cleanQuery);
                    return savedMatch || pushMatch || phoneMatch || lidMatch;
                });

                if (matches.length === 0) {
                    adminResponse = `🔍 No se encontraron contactos coincidiendo con "${sanitizeMarkdown(queryParam)}".`;
                } else {
                    const resultsText = matches.slice(0, 10).map(c => {
                        const targetNum = c.phone || c.lid;
                        return `👤 *${sanitizeMarkdown(c.savedName ? `${c.savedName} (Agenda)` : (c.pushName || 'Sin Nombre'))}*\n` +
                        `  • Teléfono: \`${c.phone || 'N/A'}\` | LID: \`${c.lid || 'N/A'}\`\n` +
                        `  • Estado Actual: \`${c.estado}\` ${c.estado === 'handoff' ? '🚨' : '🤖'}\n` +
                        `  • Reanudar IA: \`\`\`/a ${targetNum}\`\`\`\n` +
                        `  • Atención Humana: \`\`\`/h ${targetNum}\`\`\`\n` +
                        `  • Limpiar IA: \`\`\`/c ${targetNum}\`\`\``;
                    }).join('\n\n');
                    
                    adminResponse = `🔍 *Coincidencias Encontradas (${matches.length}):*\n\n${resultsText}`;
                }
            }
            break;

        case '/nombre':
        case '/n':
        case '/name':
        case '/alias':
            const { targetId: nameTarget, customName } = parseNameArgs(queryParam);
            if (!nameTarget || !customName) {
                adminResponse = usageOf('nombre');
            } else {
                const db = getContactsDB();
                
                const existingKey = Object.keys(db).find(k => {
                    const item = db[k];
                    const cleanPhone = item.phone ? item.phone.replace(/[^0-9]/g, '') : '';
                    const cleanLid = item.lid ? item.lid.replace(/[^0-9]/g, '') : '';
                    if (cleanPhone && cleanPhone.includes(nameTarget)) return true;
                    if (cleanLid && cleanLid.includes(nameTarget)) return true;
                    return k === nameTarget;
                });

                if (!isValidTargetId(nameTarget) || nameTarget === '*') {
                    adminResponse = syntaxError('nombre', `ID/Número no válido: *"${sanitizeMarkdown(nameTarget)}"*.`);
                    break;
                }

                if (existingKey) {
                    db[existingKey].savedName = customName;
                    saveContactsDB(db);
                    adminResponse = `✅ Contacto \`${db[existingKey].phone || existingKey}\` asignado con el nombre de agenda: *"${customName}"*.`;
                } else {
                    const newRecord = upsertContactMetadata({
                        phoneNumber: nameTarget.length < 15 ? nameTarget : null,
                        lid: nameTarget.length >= 15 ? nameTarget : null,
                        savedName: customName,
                        isContact: true
                    });
                    adminResponse = `✅ Nuevo contacto registrado en agenda: *"${customName}"* (\`${nameTarget}\`).`;
                }
            }
            break;

        case '/contactos':
        case '/lc':
        case '/contacts':
            const contactsDB = getContactsDB();
            const totalContacts = Object.keys(contactsDB).length;
            const inAgenda = Object.values(contactsDB).filter(c => c.isContact || c.savedName).length;
            const inHandoff = Object.values(contactsDB).filter(c => c.estado === 'handoff').length;
            const recent = Object.values(contactsDB).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)).slice(0, 5);
            
            adminResponse = `📇 *Base de Contactos Registrados:*\n` +
                `• *Total registrados:* ${totalContacts}\n` +
                `• *En tu agenda:* ${inAgenda}\n` +
                `• *En atención humana (Handoff):* ${inHandoff}\n\n` +
                `📌 *Últimos activos:*\n` +
                (recent.length ? recent.map(c => `• ${c.savedName ? `${c.savedName} (Agenda)` : (c.pushName || 'Anónimo')} (\`${c.phone || c.lid || 'Sin ID'}\`) ${c.estado === 'handoff' ? '[🚨 Humano]' : ''}`).join('\n') : 'Sin registros');
            break;

        // -------------------------------------------------------------
        // ⚙️ CATEGORÍA 4: CONTROL GLOBAL DEL SISTEMA
        // -------------------------------------------------------------

        case '/pausar':
        case '/pg':
        case '/pause':
        case '/stop':
            state.IS_BOT_PAUSED = true;
            adminResponse = "⏸️ *Bot Pausado Globalmente.* El auto-respondedor de IA ha sido desactivado para todos los chats.";
            break;

        case '/reanudar':
        case '/ag':
        case '/resume':
        case '/start':
        case '/run':
            state.IS_BOT_PAUSED = false;
            adminResponse = "▶️ *Bot Reanudado Globalmente.* El auto-respondedor de IA está activo.";
            break;

        case '/perfil':
        case '/pf':
        case '/profile':
            const profiles = await getAvailableProfiles();
            const profileList = profiles.map(p => `• \`${p.key}\` - *${p.nombre}*: ${p.descripcion}`).join('\n');

            if (!queryParam) {
                adminResponse = `⚠️ *Uso:* \`/perfil <perfil>\` (global) | \`/perfil <perfil> <num>\` (contacto) | \`/perfil ver <perfil>\` | \`/perfil exportar <perfil>\` | \`/perfil eliminar <perfil>\`\nPerfil actual: *${state.CURRENT_PROFILE}*\n\n*Perfiles disponibles:*\n${profileList || "No se pudieron cargar (¿brain encendido?)"}`;
                break;
            }

            // 📄 /perfil ver <key> → muestra el system prompt compilado
            if (queryParam.toLowerCase().startsWith('ver ')) {
                const keyToShow = queryParam.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
                if (!keyToShow) {
                    adminResponse = `⚠️ Uso: \`/perfil ver <perfil>\`. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no cargados'}.`;
                    break;
                }
                const detail = await getProfileDetail(keyToShow);
                if (detail && detail.prompt) {
                    adminResponse = `📄 *Perfil ${detail.nombre} (\`${detail.key}\`)*\n━━━━━━━━━━━━━━━━━━━━━━\n${detail.prompt}`;
                } else {
                    adminResponse = `⚠️ Perfil *"${keyToShow}"* no encontrado o brain apagado. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ')}.`;
                }
                break;
            }

            // 🗑️ /perfil eliminar <key> → borra el .md del perfil en el brain
            if (['eliminar', 'borrar', 'delete', 'del', 'rm'].includes(queryParam.toLowerCase().split(/\s+/)[0])) {
                const keyToDelete = queryParam.toLowerCase().split(/\s+/).slice(1).join(' ').trim();
                if (!keyToDelete) {
                    adminResponse = `⚠️ Uso: \`/perfil eliminar <perfil>\`. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no cargados'}.`;
                    break;
                }
                const delResult = await deleteProfileFile(keyToDelete);
                if (delResult && delResult.success) {
                    adminResponse = `🗑️ *Perfil \`${keyToDelete}\` eliminado.*\n\nRecuerda: si un contacto tenía ese perfil asignado, el brain caerá a \`default\`.`;
                } else {
                    adminResponse = `⚠️ No pude borrar *"${keyToDelete}"*: ${(delResult && delResult.detail) || 'no encontrado o brain apagado'}.`;
                }
                break;
            }

            // 📤 /perfil exportar <key> → envía el .md al self-chat para editar
            if (queryParam.toLowerCase().startsWith('exportar ') || queryParam.toLowerCase() === 'exportar') {
                const keyToExport = queryParam.toLowerCase().startsWith('exportar ')
                    ? queryParam.split(/\s+/).slice(1).join(' ').trim().toLowerCase()
                    : '';
                if (!keyToExport) {
                    adminResponse = `⚠️ Uso: \`/perfil exportar <perfil>\`. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no cargados'}.`;
                    break;
                }
                const exported = await exportProfileFile(keyToExport);
                if (!exported) {
                    adminResponse = `⚠️ Perfil *"${keyToExport}"* no encontrado o brain apagado.`;
                    break;
                }
                try {
                    await sock.sendMessage(remoteJid, {
                        document: Buffer.from(exported.content, 'utf8'),
                        mimetype: 'text/markdown',
                        fileName: exported.filename,
                        caption: `📤 Perfil *${keyToExport}*. Edítalo y envíalo citando este archivo con \`/update\`.`
                    });
                    adminResponse = null; // La respuesta es el propio documento
                } catch (e) {
                    logError.error("⚠️ Error al enviar documento de perfil:", e.message);
                    adminResponse = `⚠️ Error al enviar el archivo de perfil: ${e.message}`;
                }
                break;
            }

            const argsParts = queryParam.split(/\s+/);
            const profileKey = argsParts[0].toLowerCase();
            const valid = profiles.find(p => p.key === profileKey);

            if (!valid) {
                adminResponse = `⚠️ Perfil *"${profileKey}"* no encontrado. Disponibles: ${profiles.map(p => `\`${p.key}\``).join(', ') || 'no hay perfiles cargados'}.`;
                break;
            }

            // 🎯 Asignación por contacto: /perfil <key> <num/lid> o cita con número
            let contactTarget = argsParts.slice(1).join(' ').trim();

            // Si no hay target explícito pero el admin cita un mensaje con teléfono → per-contacto
            if (!contactTarget && rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
                const context = rawMsg.message.extendedTextMessage.contextInfo;
                const quotedText = context.quotedMessage?.conversation ||
                                   context.quotedMessage?.extendedTextMessage?.text ||
                                   "";
                const phoneMatch = quotedText.match(/(?:\+?\d[\d\s\-]{6,20}\d|\b\d{7,16}\b)/);
                if (phoneMatch) contactTarget = parsePhoneOrLid(phoneMatch[0]);
            }

            if (contactTarget) {
                const res = setContactProfile(contactTarget, profileKey);
                if (res.success) {
                    adminResponse = `🎭 Perfil *${valid.nombre}* (\`${profileKey}\`) asignado al contacto:\n\`${res.target}\``;
                } else {
                    adminResponse = `⚠️ Error al asignar perfil: ${res.message}`;
                }
                break;
            }

            // 🌐 Perfil global
            const globalRes = setCurrentProfile(profileKey);
            if (globalRes.success) {
                adminResponse = `🎭 Perfil global de bot cambiado a: *${valid.nombre}* (\`${profileKey}\`)`;
            } else {
                adminResponse = `⚠️ ${globalRes.message}`;
            }
            break;

        case '/update':
        case '/upd':
        case '/import':
            // El admin cita un documento .md con /update, o envía el documento con caption /update
            const quotedDoc = rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage ||
                              rawMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentWithCaptionMessage?.message?.documentMessage;
            const ownDoc = rawMsg?.message?.documentMessage || rawMsg?.message?.documentWithCaptionMessage?.message?.documentMessage;
            const docMsg = quotedDoc || ownDoc;
            const docKey = quotedDoc ? {
                key: {
                    remoteJid,
                    id: rawMsg.message.extendedTextMessage.contextInfo.stanzaId,
                    participant: rawMsg.message.extendedTextMessage.contextInfo.participant || undefined
                },
                message: rawMsg.message.extendedTextMessage.contextInfo.quotedMessage
            } : rawMsg;

            if (!docMsg) {
                adminResponse = usageOf('update');
                break;
            }

            await handleProfileUpload(sock, remoteJid, docMsg, docKey);
            adminResponse = null; // handleProfileUpload ya respondió
            break;

        case '/sincronizar':
        case '/sync':
        case '/resync':
            const contactsList = Array.from(contactStore.values());
            const batch = [];

            contactsList.forEach(c => {
                if (c && c.id && !isJunkJid(c.id)) {
                    const phone = c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null;
                    const lid = c.lid ? c.lid.split('@')[0] : (c.id.endsWith('@lid') ? c.id.split('@')[0] : null);
                    
                    batch.push({
                        phoneNumber: phone,
                        lid: lid,
                        savedName: c.name || null,
                        pushName: c.notify || c.pushName || null,
                        verifiedName: c.verifiedName || null,
                        isContact: true,
                        country: getCountryFromPhone(phone)
                    });
                }
            });

            const syncedCount = bulkUpsertContactsMetadata(batch);
            const cleanDb = cleanContactsDB();
            const totalCount = Object.keys(cleanDb).length;
            
            adminResponse = `🔄 *Sincronización Incremental Ejecutada:*\n` +
                `• Contactos procesados de la sesión: *${syncedCount}*\n` +
                `• Total contactos activos en base de datos: *${totalCount}*\n` +
                `• Caché persistente actualizada en \`contacts_db.json\`.`;
            break;

        case '/exportar':
        case '/export':
            const dbExport = getContactsDB();
            const exportList = Object.values(dbExport).map(c => 
                `• ${sanitizeMarkdown(c.savedName ? `[Agenda] ${c.savedName}` : (c.pushName || 'Desconocido'))} -> Tel: \`${c.phone || 'N/A'}\` | LID: \`${c.lid || 'N/A'}\` [${c.estado.toUpperCase()}]`
            );
            adminResponse = `📤 *Exportación de Libreta (${exportList.length}):*\n\n` + exportList.join('\n');
            break;

        case '/info':
        case '/whoami':
            adminResponse = `📱 *Información de Conexión Admin:*\n` +
                `• *Teléfono Admin:* \`${state.ADMIN_PHONE || 'No detectado'}\`\n` +
                `• *LID Admin:* \`${state.ADMIN_LID || 'No detectado'}\`\n` +
                `• *País:* ${getCountryFromPhone(state.ADMIN_PHONE)}\n` +
                `• *JID Actual:* \`${remoteJid}\`\n\n` +
                `💡 *Consejo:* Usa \`/buscar <nombre>\` para buscar cualquier contacto en tu libreta.`;
            break;

        case '/estado':
        case '/e':
        case '/menu':
        case '/status':
        case '/help':
        case '/admin':
            const stateDb = getContactsDB();
            adminResponse = `🤖 *Estado del SDK-Bot:*\n` +
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
            break;

        case '/init':
        case '/startguide':
        case '/guia':
            adminResponse = `🚀 *GUÍA RÁPIDA DE INICIO - SDK BOT*\n\n` +
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
            break;

        default:
            adminResponse = `⚠️ Comando no reconocido: *${command}*. Usa \`/e\` o \`/estado\` para ver el menú.`;
            break;
    }

    // ✂️ Enviar por partes si la respuesta es demasiado larga (WhatsApp rechaza >~4096 chars)
    try {
        const chunks = chunkAdminText(adminResponse);
        for (let i = 0; i < chunks.length; i++) {
            const suffix = chunks.length > 1 ? `\n_(Mensaje ${i + 1}/${chunks.length})_` : '';
            const sentMsg = await sock.sendMessage(remoteJid, { text: chunks[i] + suffix });
            registerSentMessage(sentMsg);
        }
    } catch (e) {
        logError.error("⚠️ No se pudo enviar confirmación admin por reconexión temporal de WhatsApp:", e.message);
    }
}

module.exports = {
    handleAdminCommand,
    handleProfileUpload
};
