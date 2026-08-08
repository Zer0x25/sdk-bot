const { state } = require('../config');
const { getContactsDB, upsertContactMetadata } = require('./storageService');

const TTL_ENRICHMENT_MS = 24 * 60 * 60 * 1000; // 24 Horas de TTL para refresco de foto/bio

const COUNTRY_CODES = [
    // --- América del Sur ---
    { code: '591', country: 'Bolivia (+591)' },
    { code: '56',  country: 'Chile (+56)' },
    { code: '54',  country: 'Argentina (+54)' },
    { code: '51',  country: 'Perú (+51)' },
    { code: '57',  country: 'Colombia (+57)' },
    { code: '55',  country: 'Brasil (+55)', language: 'Portugués (Português)' },
    { code: '593', country: 'Ecuador (+593)' },
    { code: '58',  country: 'Venezuela (+58)' },
    { code: '595', country: 'Paraguay (+595)' },
    { code: '598', country: 'Uruguay (+598)' },
    { code: '592', country: 'Guyana (+592)', language: 'Inglés (English)' },
    { code: '597', country: 'Surinam (+597)', language: 'Neerlandés (Nederlands)' },
    { code: '594', country: 'Guayana Francesa (+594)', language: 'Francés (Français)' },
    { code: '500', country: 'Islas Malvinas (+500)', language: 'Inglés (English)' },

    // --- América Central y Caribe ---
    { code: '502', country: 'Guatemala (+502)' },
    { code: '503', country: 'El Salvador (+503)' },
    { code: '504', country: 'Honduras (+504)' },
    { code: '505', country: 'Nicaragua (+505)' },
    { code: '506', country: 'Costa Rica (+506)' },
    { code: '507', country: 'Panamá (+507)' },
    { code: '501', country: 'Belice (+501)', language: 'Inglés (English)' },
    { code: '53',  country: 'Cuba (+53)' },
    { code: '509', country: 'Haití (+509)', language: 'Francés / Criollo (Français / Kreyòl)' },
    { code: '297', country: 'Aruba (+297)', language: 'Papiamento / Neerlandés' },
    { code: '599', country: 'Curazao / Caribe Neerlandés (+599)', language: 'Papiamento / Neerlandés' },
    { code: '590', country: 'Guadalupe / San Martín (+590)', language: 'Francés (Français)' },
    { code: '596', country: 'Martinica (+596)', language: 'Francés (Français)' },

    // --- América del Norte ---
    { code: '52',  country: 'México (+52)' },
    { code: '1',   country: 'EE.UU. / Canadá / Caribe (+1)', language: 'Inglés / Francés (English / Français)' },

    // --- Europa (Países no hispanohablantes) ---
    { code: '34',  country: 'España (+34)' },
    { code: '33',  country: 'Francia (+33)', language: 'Francés (Français)' },
    { code: '44',  country: 'Reino Unido (+44)', language: 'Inglés (English)' },
    { code: '49',  country: 'Alemania (+49)', language: 'Alemán (Deutsch)' },
    { code: '39',  country: 'Italia (+39)', language: 'Italiano' },
    { code: '351', country: 'Portugal (+351)', language: 'Portugués (Português)' },
    { code: '41',  country: 'Suiza (+41)', language: 'Alemán / Francés / Italiano' },
    { code: '31',  country: 'Países Bajos (+31)', language: 'Neerlandés (Nederlands)' },
    { code: '32',  country: 'Bélgica (+32)', language: 'Neerlandés / Francés' },
    { code: '43',  country: 'Austria (+43)', language: 'Alemán (Deutsch)' },
    { code: '46',  country: 'Suecia (+46)', language: 'Sueco (Svenska)' },
    { code: '47',  country: 'Noruega (+47)', language: 'Noruego (Norsk)' },
    { code: '45',  country: 'Dinamarca (+45)', language: 'Danés (Dansk)' },
    { code: '358', country: 'Finlandia (+358)', language: 'Finés / Sueco (Suomi)' },
    { code: '353', country: 'Irlanda (+353)', language: 'Inglés (English)' },
    { code: '48',  country: 'Polonia (+48)', language: 'Polaco (Polski)' },
    { code: '420', country: 'República Checa (+420)', language: 'Checo (Čeština)' },
    { code: '421', country: 'Eslovaquia (+421)', language: 'Eslovaco (Slovenčina)' },
    { code: '36',  country: 'Hungría (+36)', language: 'Húngaro (Magyar)' },
    { code: '30',  country: 'Grecia (+30)', language: 'Griego (Ελληνικά)' },
    { code: '40',  country: 'Rumania (+40)', language: 'Rumano (Română)' },
    { code: '380', country: 'Ucrania (+380)', language: 'Ucraniano (Українська)' },
    { code: '385', country: 'Croacia (+385)', language: 'Croata (Hrvatski)' },
    { code: '386', country: 'Eslovenia (+386)', language: 'Esloveno (Slovenščina)' },
    { code: '370', country: 'Lituania (+370)', language: 'Lituano (Lietuvių)' },
    { code: '371', country: 'Letonia (+371)', language: 'Letón (Latviešu)' },
    { code: '372', country: 'Estonia (+372)', language: 'Estonio (Eesti)' },
    { code: '354', country: 'Islandia (+354)', language: 'Islandés (Íslenska)' },
    { code: '352', country: 'Luxemburgo (+352)', language: 'Luxemburgués / Francés / Alemán' },
    { code: '376', country: 'Andorra (+376)' },
    { code: '377', country: 'Mónaco (+377)', language: 'Francés (Français)' },
    { code: '423', country: 'Liechtenstein (+423)', language: 'Alemán (Deutsch)' },
    { code: '378', country: 'San Marino (+378)', language: 'Italiano' },
    { code: '356', country: 'Malta (+356)', language: 'Maltés / Inglés' },
    { code: '357', country: 'Chipre (+357)', language: 'Griego / Turco' }
];

// Ordenar por longitud de código descendente para resolver prefijos de 3 dígitos antes que los de 2 o 1 dígito
const SORTED_COUNTRY_CODES = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);

function getCountryFromPhone(phone) {
    if (!phone) return "Desconocido";
    const clean = phone.replace(/[^0-9]/g, '');
    const match = SORTED_COUNTRY_CODES.find(c => clean.startsWith(c.code));
    if (match) return match.country;
    return `+${clean.substring(0, 3)}`;
}

function getLanguageFromPhone(phone) {
    if (!phone) return null;
    const clean = phone.replace(/[^0-9]/g, '');
    const match = SORTED_COUNTRY_CODES.find(c => clean.startsWith(c.code));
    return (match && match.language) ? match.language : null;
}

function extractUserMetadata(msg) {
    const remoteJid = msg.key.remoteJid || '';
    const remoteJidAlt = msg.key.remoteJidAlt || '';
    const participant = msg.key.participant || '';
    const participantAlt = msg.key.participantAlt || '';
    const pushName = msg.pushName || 'Desconocido';

    const jids = [remoteJid, remoteJidAlt, participant, participantAlt].filter(Boolean);

    let phoneJid = jids.find(j => j.endsWith('@s.whatsapp.net')) || null;
    let lidJid = jids.find(j => j.endsWith('@lid')) || null;

    const phoneNumber = phoneJid ? phoneJid.split('@')[0].split(':')[0] : null;
    const lid = lidJid ? lidJid.split('@')[0].split(':')[0] : null;

    const db = getContactsDB();
    const existingKey = Object.keys(db).find(k => {
        const item = db[k];
        if (phoneNumber && item.phone === phoneNumber) return true;
        if (lid && item.lid === lid) return true;
        return false;
    });

    const savedName = existingKey ? db[existingKey].savedName : null;
    const bio = existingKey ? db[existingKey].bio : null;
    const profilePicUrl = existingKey ? db[existingKey].profilePicUrl : null;
    const isBusiness = existingKey ? db[existingKey].isBusiness : false;
    const isContact = existingKey ? db[existingKey].isContact : false;
    const lastEnrichedAt = existingKey ? db[existingKey].lastEnrichedAt : null;

    const candidateIds = new Set();
    jids.forEach(j => {
        const clean = j.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (clean) candidateIds.add(clean);
        candidateIds.add(j);
    });

    const country = phoneNumber ? getCountryFromPhone(phoneNumber) : "Desconocido";
    const language = phoneNumber ? getLanguageFromPhone(phoneNumber) : null;

    return {
        remoteJid,
        remoteJidAlt,
        phoneNumber,
        lid,
        savedName,
        pushName,
        country,
        language,
        bio,
        profilePicUrl,
        isBusiness,
        isContact,
        lastEnrichedAt,
        candidateIds: Array.from(candidateIds)
    };
}

async function enrichContactExtraData(sock, jid, metadata, forceRefresh = false) {
    if (!sock || !jid || jid.endsWith('@g.us')) return;

    try {
        const db = getContactsDB();
        const key = metadata.phoneNumber || metadata.lid;
        const record = db[key];

        // 🧠 SMART TTL CHECK: Si ya fue enriquecido en las últimas 24h y no se fuerza refresco, omitir peticiones de red
        if (record && !forceRefresh) {
            const lastEnriched = record.lastEnrichedAt ? new Date(record.lastEnrichedAt).getTime() : 0;
            const ageMs = Date.now() - lastEnriched;
            if (ageMs < TTL_ENRICHMENT_MS && record.profilePicUrl && record.bio) {
                return; // Omitir red, datos frescos en caché
            }
        }

        let updated = false;

        // 1. Consultar Foto de Perfil
        if (forceRefresh || !record || !record.profilePicUrl) {
            const picUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
            if (picUrl && picUrl !== metadata.profilePicUrl) {
                metadata.profilePicUrl = picUrl;
                updated = true;
            }
        }

        // 2. Consultar Biografía / Estado
        if (forceRefresh || !record || !record.bio) {
            const statusObj = await sock.fetchStatus(jid).catch(() => null);
            if (statusObj && statusObj.status && statusObj.status !== metadata.bio) {
                metadata.bio = statusObj.status;
                updated = true;
            }
        }

        metadata.lastEnrichedAt = new Date().toISOString();
        if (updated || !record || !record.lastEnrichedAt) {
            upsertContactMetadata(metadata);
        }
    } catch (e) {
        // Ignorar errores de privacidad al consultar foto/bio de terceros
    }
}

function isSelfChat(remoteJid, isFromMe) {
    if (!remoteJid) return false;
    
    const cleanTarget = remoteJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const cleanAdminPhone = state.ADMIN_PHONE ? state.ADMIN_PHONE.split(':')[0].replace(/[^0-9]/g, '') : '';
    const cleanAdminLid = state.ADMIN_LID ? state.ADMIN_LID.split(':')[0].replace(/[^0-9]/g, '') : '';

    if (cleanAdminLid && cleanTarget === cleanAdminLid) return true;
    if (cleanAdminPhone && cleanTarget === cleanAdminPhone) return true;

    return false;
}

module.exports = {
    getCountryFromPhone,
    getLanguageFromPhone,
    extractUserMetadata,
    enrichContactExtraData,
    isSelfChat
};
