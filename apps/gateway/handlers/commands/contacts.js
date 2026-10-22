/**
 * 🔍 CATEGORÍA 3: LIBRETA Y AGENDA DE CONTACTOS (/buscar /nombre /contactos /sincronizar /exportar)
 */
const { getContactsDB, saveContactsDB } = require('../../services/db');
const { contactStore, isJunkJid, cleanContactsDB, upsertContactMetadata, bulkUpsertContactsMetadata,
    resolveContactKeyByDigits, contactIdentityFromRaw } = require('../../services/contactsRepository');
const { getCountryFromPhone } = require('../../services/metadataService');
const { parsePhoneOrLid, isValidTargetId, usageOf, syntaxError, sanitizeMarkdown } = require('../commandHelpers');

function runBuscar({ queryParam }) {
    if (!queryParam) return usageOf('buscar');

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
        return `🔍 No se encontraron contactos coincidiendo con "${sanitizeMarkdown(queryParam)}".`;
    }

    const resultsText = matches.slice(0, 10).map(c => {
        const targetNum = c.phone || c.lid;
        return `👤 *${sanitizeMarkdown(c.savedName ? `${c.savedName} (Agenda)` : (c.pushName || 'Sin Nombre'))}*\n` +
        `  • Teléfono: \`${c.phone || 'N/A'}\` | LID: \`${c.lid || 'N/A'}\`\n` +
        `  • Estado Actual: \`${c.estado}\` ${c.estado === 'handoff' ? '🚨' : '🤖'}\n` +
        `  • Reanudar IA: \`\`\`/a ${targetNum}\`\`\`\n` +
        `  • Atención Humana: \`\`\`/h ${targetNum}\`\`\`\n` +
        `  • Limpiar IA: \`\`\`/c ${targetNum}\`\`\``;
    }).join('\n\n');
    
    return `🔍 *Coincidencias Encontradas (${matches.length}):*\n\n${resultsText}`;
}

function runNombre({ queryParam }) {
    const { targetId: nameTarget, customName } = parseNameArgs(queryParam);
    if (!nameTarget || !customName) return usageOf('nombre');
    if (!isValidTargetId(nameTarget) || nameTarget === '*') {
        return syntaxError('nombre', `ID/Número no válido: *"${sanitizeMarkdown(nameTarget)}"*.`);
    }

    const db = getContactsDB();
    const resolution = resolveContactKeyByDigits(nameTarget);
    if (resolution.status === 'partial' || resolution.status === 'ambiguous') {
        return syntaxError('nombre', `Indica el número o LID completo; *${sanitizeMarkdown(nameTarget)}* no identifica un contacto único.`);
    }
    const existingKey = resolution.status === 'found' ? resolution.key : null;

    if (existingKey) {
        db[existingKey].savedName = customName;
        saveContactsDB(db);
        return `✅ Contacto \`${db[existingKey].phone || existingKey}\` asignado con el nombre de agenda: *"${customName}"*.`;
    }

    upsertContactMetadata({
        phoneNumber: nameTarget.length < 15 ? nameTarget : null,
        lid: nameTarget.length >= 15 ? nameTarget : null,
        savedName: customName,
        isContact: true
    });
    return `✅ Nuevo contacto registrado en agenda: *"${customName}"* (\`${nameTarget}\`).`;
}

/**
 * 🔤 Parsear comando /nombre tolerando teléfonos formateados nativos (ej: /nombre +56 9 4252 3669 Pedro)
 */
function parseNameArgs(queryParam) {
    if (!queryParam) return { targetId: null, customName: null };
    const str = queryParam.trim();
    
    // Matchear teléfono o LID al inicio incluso con espacios o símbolos (ej: "+56 9 4252 3669 Pedro Pizzería")
    const phoneMatch = str.match(/^(\+?[\d\s\-()]{7,25})\s+(.+)$/);
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

function runContactos() {
    const contactsDB = getContactsDB();
    const totalContacts = Object.keys(contactsDB).length;
    const inAgenda = Object.values(contactsDB).filter(c => c.isContact || c.savedName).length;
    const inHandoff = Object.values(contactsDB).filter(c => c.estado === 'handoff').length;
    const recent = Object.values(contactsDB).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)).slice(0, 5);
    
    return `📇 *Base de Contactos Registrados:*\n` +
        `• *Total registrados:* ${totalContacts}\n` +
        `• *En tu agenda:* ${inAgenda}\n` +
        `• *En atención humana (Handoff):* ${inHandoff}\n\n` +
        `📌 *Últimos activos:*\n` +
        (recent.length ? recent.map(c => `• ${c.savedName ? `${c.savedName} (Agenda)` : (c.pushName || 'Anónimo')} (\`${c.phone || c.lid || 'Sin ID'}\`) ${c.estado === 'handoff' ? '[🚨 Humano]' : ''}`).join('\n') : 'Sin registros');
}

function runSincronizar() {
    const contactsList = Array.from(contactStore.values());
    const batch = [];

    contactsList.forEach(c => {
        if (c && c.id && !isJunkJid(c.id)) {
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
        }
    });

    const syncedCount = bulkUpsertContactsMetadata(batch);
    const cleanDb = cleanContactsDB();
    const totalCount = Object.keys(cleanDb).length;
    
    return `🔄 *Sincronización Incremental Ejecutada:*\n` +
        `• Contactos procesados de la sesión: *${syncedCount}*\n` +
        `• Total contactos activos en base de datos: *${totalCount}*\n` +
        `• Caché persistente actualizada en \`contacts_db.json\`.`;
}

function runExportar() {
    const dbExport = getContactsDB();
    const exportList = Object.values(dbExport).map(c => 
        `• ${sanitizeMarkdown(c.savedName ? `[Agenda] ${c.savedName}` : (c.pushName || 'Desconocido'))} -> Tel: \`${c.phone || 'N/A'}\` | LID: \`${c.lid || 'N/A'}\` [${c.estado.toUpperCase()}]`
    );
    return `📤 *Exportación de Libreta (${exportList.length}):*\n\n` + exportList.join('\n');
}

module.exports = [
    { aliases: ['/buscar', '/s', '/search'], run: runBuscar },
    { aliases: ['/nombre', '/n', '/name', '/alias'], run: runNombre },
    { aliases: ['/contactos', '/lc', '/contacts'], run: runContactos },
    { aliases: ['/sincronizar', '/sync', '/resync'], run: runSincronizar },
    { aliases: ['/exportar', '/export'], run: runExportar }
];
