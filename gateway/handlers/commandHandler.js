const { state, registerSentMessage } = require('../config');
const { getCountryFromPhone } = require('../services/metadataService');
const { 
    getAllowedNumbers, 
    saveAllowedNumbers, 
    getIgnoredNumbers, 
    saveIgnoredNumbers, 
    getContactsDB,
    saveContactsDB,
    cleanContactsDB,
    upsertContactMetadata,
    isJunkJid,
    contactStore
} = require('../services/storageService');

async function handleAdminCommand(textMessage, remoteJid, sock, metadata) {
    const args = textMessage.trim().split(' ');
    const command = args[0].toLowerCase();
    const queryParam = args.slice(1).join(' ').trim();

    console.log(`\n👑 [COMANDO ADMIN EN SELF-CHAT]: ${command} ${queryParam || ''}`);

    let adminResponse = "";

    switch (command) {
        case '/pause':
            state.IS_BOT_PAUSED = true;
            adminResponse = "⏸️ **Bot Pausado.** El auto-respondedor de IA ha sido desactivado.";
            break;

        case '/resume':
        case '/start':
            state.IS_BOT_PAUSED = false;
            adminResponse = "▶️ **Bot Reanudado.** El auto-respondedor de IA está activo.";
            break;

        case '/allow':
            if (!queryParam) {
                adminResponse = "⚠️ Uso: `/allow <numero_o_lid>`\nEjemplo: `/allow 56912345678` o `/allow *`";
            } else {
                const list = getAllowedNumbers();
                if (!list.includes(queryParam)) {
                    list.push(queryParam);
                    saveAllowedNumbers(list);
                    adminResponse = `✅ ID/Número **${queryParam}** agregado a la lista de permitidos.`;
                } else {
                    adminResponse = `ℹ️ El ID/Número **${queryParam}** ya estaba en la lista de permitidos.`;
                }
            }
            break;

        case '/revoke':
        case '/remove':
            if (!queryParam) {
                adminResponse = "⚠️ Uso: `/remove <numero_o_lid>`";
            } else {
                let list = getAllowedNumbers();
                if (list.includes(queryParam)) {
                    list = list.filter(item => item !== queryParam);
                    saveAllowedNumbers(list);
                    adminResponse = `🗑️ ID/Número **${queryParam}** removido de la lista de permitidos.`;
                } else {
                    adminResponse = `ℹ️ El ID/Número **${queryParam}** no se encontró en la lista de permitidos.`;
                }
            }
            break;

        case '/ignore':
            if (!queryParam) {
                adminResponse = "⚠️ Uso: `/ignore <numero_o_lid>`\nEjemplo: `/ignore 56912345678` o `/ignore 10982374619283`";
            } else {
                const list = getIgnoredNumbers();
                if (!list.includes(queryParam)) {
                    list.push(queryParam);
                    saveIgnoredNumbers(list);
                    adminResponse = `🚫 ID/Número **${queryParam}** agregado a la **IgnoreList** (el bot nunca le responderá).`;
                } else {
                    adminResponse = `ℹ️ El ID/Número **${queryParam}** ya estaba en la IgnoreList.`;
                }
            }
            break;

        case '/unignore':
            if (!queryParam) {
                adminResponse = "⚠️ Uso: `/unignore <numero_o_lid>`";
            } else {
                let list = getIgnoredNumbers();
                if (list.includes(queryParam)) {
                    list = list.filter(item => item !== queryParam);
                    saveIgnoredNumbers(list);
                    adminResponse = `✅ ID/Número **${queryParam}** removido de la **IgnoreList**.`;
                } else {
                    adminResponse = `ℹ️ El ID/Número **${queryParam}** no se encontró en la IgnoreList.`;
                }
            }
            break;

        case '/ignorelist':
            const currentIgnored = getIgnoredNumbers();
            if (currentIgnored.length === 0) {
                adminResponse = `📋 **IgnoreList (Lista Negra) vacía.** No hay números ni LIDs ignorados.`;
            } else {
                adminResponse = `🚫 **IgnoreList (Contactos / LIDs Ignorados):**\n\n${currentIgnored.map(n => `- ${n}`).join('\n')}`;
            }
            break;

        case '/list':
            const currentList = getAllowedNumbers();
            adminResponse = `📋 **Lista de Permitidos (AllowedList):**\n\n${currentList.map(n => `- ${n}`).join('\n')}`;
            break;

        case '/name':
        case '/alias':
            if (!queryParam || !queryParam.includes(' ')) {
                adminResponse = "⚠️ Uso: `/name <numero_o_lid> <nombre_agenda>`\nEjemplo: `/name 56944323815 Pedro Pizzería`";
            } else {
                const targetId = args[1].trim();
                const customName = args.slice(2).join(' ').trim();
                const db = getContactsDB();
                
                const existingKey = Object.keys(db).find(k => {
                    const item = db[k];
                    if (item.phone && item.phone.includes(targetId)) return true;
                    if (item.lid && item.lid.includes(targetId)) return true;
                    return k === targetId;
                });

                if (existingKey) {
                    db[existingKey].savedName = customName;
                    saveContactsDB(db);
                    adminResponse = `✅ Contacto **${db[existingKey].phone || existingKey}** asignado con el nombre de agenda: **"${customName}"**.`;
                } else {
                    const newRecord = upsertContactMetadata({
                        phoneNumber: targetId.length < 15 ? targetId : null,
                        lid: targetId.length >= 15 ? targetId : null,
                        savedName: customName,
                        isContact: true
                    });
                    adminResponse = `✅ Nuevo contacto registrado en agenda: **"${customName}"** (${targetId}).`;
                }
            }
            break;

        case '/search':
        case '/buscar':
            if (!queryParam) {
                adminResponse = "⚠️ Uso: `/search <nombre_tel_o_lid>`\nEjemplo: `/search Mamá` o `/search 569`";
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
                    adminResponse = `🔍 No se encontraron contactos coincidiendo con "${queryParam}".`;
                } else {
                    const resultsText = matches.slice(0, 10).map(c => 
                        `👤 **${c.savedName ? `${c.savedName} (Agenda)` : (c.pushName || 'Sin Nombre')}**\n` +
                        `  • Nombre Público: ${c.pushName || 'N/A'}\n` +
                        `  • Teléfono: ${c.phone || 'N/A'}\n` +
                        `  • LID: ${c.lid || 'N/A'}\n` +
                        `  • País: ${c.country}\n` +
                        `  • Estado/Bio: ${c.bio || 'Sin biografía'}\n` +
                        `  • En tu Agenda: ${c.isContact ? 'Sí ✅' : 'No ❌'}\n` +
                        `  • Mensajes: ${c.totalMessages || 1}`
                    ).join('\n\n');
                    
                    adminResponse = `🔍 **Coincidencias Encontradas (${matches.length}):**\n\n${resultsText}`;
                }
            }
            break;

        case '/contacts':
        case '/contactos':
            const contactsDB = getContactsDB();
            const totalContacts = Object.keys(contactsDB).length;
            const inAgenda = Object.values(contactsDB).filter(c => c.isContact || c.savedName).length;
            const recent = Object.values(contactsDB).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)).slice(0, 5);
            
            adminResponse = `📇 **Base de Contactos Registrados:**\n` +
                `- **Total registrados:** ${totalContacts}\n` +
                `- **En tu agenda telefónica:** ${inAgenda}\n\n` +
                `📌 **Últimos activos:**\n` +
                (recent.length ? recent.map(c => `• ${c.savedName ? `${c.savedName} (Agenda)` : (c.pushName || 'Anónimo')} (${c.phone || c.lid || 'Sin ID'})`).join('\n') : 'Sin registros');
            break;

        case '/sync':
        case '/resync':
            let syncedCount = 0;
            const contactsList = Array.from(contactStore.values());
            contactsList.forEach(c => {
                if (c && c.id && !isJunkJid(c.id)) {
                    const phone = c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null;
                    const lid = c.lid ? c.lid.split('@')[0] : (c.id.endsWith('@lid') ? c.id.split('@')[0] : null);
                    
                    const result = upsertContactMetadata({
                        phoneNumber: phone,
                        lid: lid,
                        savedName: c.name || null,
                        pushName: c.notify || c.pushName || null,
                        verifiedName: c.verifiedName || null,
                        isContact: true,
                        country: getCountryFromPhone(phone)
                    });
                    if (result) syncedCount++;
                }
            });

            const cleanDb = cleanContactsDB();
            const totalCount = Object.keys(cleanDb).length;
            
            adminResponse = `🔄 **Sincronización Incremental Ejecutada:**\n` +
                `- Contactos procesados de la sesión: **${syncedCount}**\n` +
                `- Total contactos activos en base de datos: **${totalCount}**\n` +
                `- Caché persistente actualizada en \`contacts_db.json\`.`;
            break;

        case '/export':
            const dbExport = getContactsDB();
            const exportList = Object.values(dbExport).map(c => 
                `• ${c.savedName ? `[Agenda] ${c.savedName}` : (c.pushName || 'Desconocido')} -> Tel: ${c.phone || 'N/A'} | LID: ${c.lid || 'N/A'}`
            );
            adminResponse = `📤 **Exportación de Libreta (${exportList.length}):**\n\n` + exportList.join('\n');
            break;

        case '/profile':
            if (!queryParam) {
                adminResponse = `⚠️ Uso: \`/profile <default|lucia|mateo>\`\nPerfil actual: *${state.CURRENT_PROFILE}*`;
            } else {
                state.CURRENT_PROFILE = queryParam.toLowerCase();
                adminResponse = `🎭 Perfil de bot cambiado a: **${state.CURRENT_PROFILE}**`;
            }
            break;

        case '/info':
        case '/whoami':
            adminResponse = `📱 **Información de Conexión Admin:**\n` +
                `- **Teléfono Admin:** ${state.ADMIN_PHONE || 'No detectado'}\n` +
                `- **LID Admin:** ${state.ADMIN_LID || 'No detectado'}\n` +
                `- **País:** ${getCountryFromPhone(state.ADMIN_PHONE)}\n` +
                `- **JID Actual:** ${remoteJid}\n\n` +
                `💡 *Consejo:* Usa \`/search <nombre>\` para buscar cualquier contacto en tu libreta.`;
            break;

        case '/status':
        case '/help':
            adminResponse = `🤖 **Estado del SDK-Bot:**\n` +
                `- **Estado:** ${state.IS_BOT_PAUSED ? '⏸️ Pausado' : '▶️ Activo'}\n` +
                `- **Perfil IA:** ${state.CURRENT_PROFILE}\n` +
                `- **Permitidos (Allowed):** ${getAllowedNumbers().length} regla(s)\n` +
                `- **Ignorados (IgnoreList):** ${getIgnoredNumbers().length} usuario(s)\n` +
                `- **Base de Contactos:** ${Object.keys(getContactsDB()).length} registrado(s)\n\n` +
                `📌 **Comandos Admin:**\n` +
                `• \`/name <num> <nombre>\` - Asignar o renombrar contacto en agenda manualmente\n` +
                `• \`/search <query>\` - Buscar en agenda (Nombre Agenda ↔ Nombre Público ↔ Phone ↔ LID)\n` +
                `• \`/sync\` - Ejecutar sincronización incremental de contactos\n` +
                `• \`/contacts\` - Resumen de contactos en BD\n` +
                `• \`/export\` - Exportar libreta de contactos\n` +
                `• \`/ignore <num/lid>\` - Agregar a IgnoreList\n` +
                `• \`/unignore <num/lid>\` - Quitar de IgnoreList\n` +
                `• \`/ignorelist\` - Ver ignorados\n` +
                `• \`/allow <num/lid/*>\` - Permitir usuario\n` +
                `• \`/remove <num/lid>\` - Remover permitido\n` +
                `• \`/list\` - Ver permitidos\n` +
                `• \`/pause\` / \`/resume\` - Pausar/Reanudar IA\n` +
                `• \`/profile <nombre>\` - Cambiar personalidad\n` +
                `• \`/info\` - Ver datos de Admin\n` +
                `• \`/status\` - Ver este menú`;
            break;

        default:
            adminResponse = `⚠️ Comando no reconocido: ${command}. Usa \`/help\` para ver la lista.`;
            break;
    }

    const sentMsg = await sock.sendMessage(remoteJid, { text: adminResponse });
    registerSentMessage(sentMsg);
}

module.exports = {
    handleAdminCommand
};
