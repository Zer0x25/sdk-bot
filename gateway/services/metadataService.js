const { state } = require('../config');
const { getContactsDB, upsertContactMetadata } = require('./storageService');

function getCountryFromPhone(phone) {
    if (!phone) return "Desconocido";
    const clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('56')) return "Chile (+56)";
    if (clean.startsWith('52')) return "México (+52)";
    if (clean.startsWith('54')) return "Argentina (+54)";
    if (clean.startsWith('57')) return "Colombia (+57)";
    if (clean.startsWith('51')) return "Perú (+51)";
    if (clean.startsWith('34')) return "España (+34)";
    if (clean.startsWith('1')) return "EE.UU. / Canadá (+1)";
    if (clean.startsWith('55')) return "Brasil (+55)";
    if (clean.startsWith('593')) return "Ecuador (+593)";
    if (clean.startsWith('58')) return "Venezuela (+58)";
    if (clean.startsWith('502')) return "Guatemala (+502)";
    return `+${clean.substring(0, 3)}`;
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

    const candidateIds = new Set();
    jids.forEach(j => {
        const clean = j.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (clean) candidateIds.add(clean);
        candidateIds.add(j);
    });

    const country = phoneNumber ? getCountryFromPhone(phoneNumber) : "Desconocido";

    return {
        remoteJid,
        remoteJidAlt,
        phoneNumber,
        lid,
        savedName,
        pushName,
        country,
        bio,
        profilePicUrl,
        isBusiness,
        isContact,
        candidateIds: Array.from(candidateIds)
    };
}

async function enrichContactExtraData(sock, jid, metadata) {
    if (!sock || !jid || jid.endsWith('@g.us')) return;

    try {
        let updated = false;
        const db = getContactsDB();
        const key = metadata.phoneNumber || metadata.lid;
        const record = db[key];

        if (!record || !record.profilePicUrl) {
            const picUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
            if (picUrl) {
                metadata.profilePicUrl = picUrl;
                updated = true;
            }
        }

        if (!record || !record.bio) {
            const statusObj = await sock.fetchStatus(jid).catch(() => null);
            if (statusObj && statusObj.status) {
                metadata.bio = statusObj.status;
                updated = true;
            }
        }

        if (updated) {
            upsertContactMetadata(metadata);
        }
    } catch (e) {
        // Ignorar errores de privacidad al consultar foto/bio de terceros
    }
}

function isSelfChat(remoteJid, isFromMe) {
    if (!isFromMe) return false;
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
    extractUserMetadata,
    enrichContactExtraData,
    isSelfChat
};
