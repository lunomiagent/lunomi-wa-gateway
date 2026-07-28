function normalizePhoneJid(jid) {
    if (!jid) return null;
    if (jid.endsWith('@s.whatsapp.net')) return jid;
    if (jid.includes('@')) return null;
    return `${jid}@s.whatsapp.net`;
}

function resolveFallbackJid(key, primaryJid) {
    const candidates = [
        key?.senderPn,
        key?.remoteJidAlt,
        key?.participantAlt,
    ];

    for (const candidate of candidates) {
        const phoneJid = normalizePhoneJid(candidate);
        if (phoneJid && phoneJid !== primaryJid) return phoneJid;
    }

    return null;
}

async function sendReplyToInboundChat({ sock, msg, text }) {
    const primaryJid = msg?.key?.remoteJid;
    if (!primaryJid) {
        throw new Error('Cannot send WhatsApp reply without an inbound remoteJid');
    }

    const primaryOptions = primaryJid.endsWith('@lid') ? {} : { quoted: msg };

    try {
        const message = await sock.sendMessage(
            primaryJid,
            { text },
            primaryOptions
        );
        return { message, targetJid: primaryJid, usedFallback: false };
    } catch (primaryError) {
        const fallbackJid = resolveFallbackJid(msg.key, primaryJid);
        if (!fallbackJid) throw primaryError;

        try {
            const message = await sock.sendMessage(
                fallbackJid,
                { text },
                {}
            );
            return { message, targetJid: fallbackJid, usedFallback: true };
        } catch (fallbackError) {
            throw new AggregateError(
                [primaryError, fallbackError],
                `WhatsApp reply failed for primary and fallback targets (${primaryJid}, ${fallbackJid})`
            );
        }
    }
}

module.exports = {
    sendReplyToInboundChat,
};
