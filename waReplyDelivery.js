function normalizePhoneJid(jid) {
    if (!jid) return null;
    let raw = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '').trim();
    if (raw.startsWith('0')) raw = '62' + raw.substring(1);
    if (!raw) return null;
    return `${raw}@s.whatsapp.net`;
}

function resolveFallbackJid(key, primaryJid) {
        key?.participantAlt,
    ];

    for (const candidate of candidates) {
        const phoneJid = normalizePhoneJid(candidate);
        if (phoneJid && phoneJid !== primaryJid) return phoneJid;
    }

    return null;
}

async function storeInboundLidMapping(sock, key) {
    const lid = key?.remoteJid;
    const pn = resolveFallbackJid(key, lid);
    const lidMapping = sock?.signalRepository?.lidMapping;
    const storeMappings = lidMapping?.storeLIDPNMappings;

    if (!lid?.endsWith('@lid') || !pn || typeof storeMappings !== 'function') {
        return { mappingStored: false, mappingError: null, mappingPn: pn };
    }

    try {
        await storeMappings.call(lidMapping, [{ lid, pn }]);
        return { mappingStored: true, mappingError: null, mappingPn: pn };
    } catch (mappingError) {
        return { mappingStored: false, mappingError, mappingPn: pn };
    }
}

function preserveMappingError(error, mappingError) {
    if (mappingError && error && typeof error === 'object') {
        error.mappingError = mappingError;
    }
    return error;
}

async function sendReplyToInboundChat({ sock, msg, text }) {
    const primaryJid = msg?.key?.remoteJid;
    if (!primaryJid) {
        throw new Error('Cannot send WhatsApp reply without an inbound remoteJid');
    }

    const mapping = await storeInboundLidMapping(sock, msg.key);
    const primaryOptions = primaryJid.endsWith('@lid') ? {} : { quoted: msg };

    try {
        const message = await sock.sendMessage(
            primaryJid,
            { text },
            primaryOptions
        );
        return {
            message,
            targetJid: primaryJid,
            usedFallback: false,
            ...mapping,
        };
    } catch (primaryError) {
        const fallbackJid = resolveFallbackJid(msg.key, primaryJid);
        if (!fallbackJid) {
            throw preserveMappingError(primaryError, mapping.mappingError);
        }

        try {
            const message = await sock.sendMessage(
                fallbackJid,
                { text },
                {}
            );
            return {
                message,
                targetJid: fallbackJid,
                usedFallback: true,
                ...mapping,
            };
        } catch (fallbackError) {
            const sendError = new AggregateError(
                [primaryError, fallbackError],
                `WhatsApp reply failed for primary and fallback targets (${primaryJid}, ${fallbackJid})`
            );
            throw preserveMappingError(sendError, mapping.mappingError);
        }
    }
}

module.exports = {
    sendReplyToInboundChat,
};
