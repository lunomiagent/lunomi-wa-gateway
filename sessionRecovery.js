function classifyDisconnect(statusCode, disconnectReason = {}) {
    if (statusCode === disconnectReason.loggedOut) {
        return {
            type: 'logged_out',
            shouldClearSession: true,
            reconnectDelayMs: 500,
        };
    }

    if (statusCode === 440) {
        return {
            type: 'conflict',
            shouldClearSession: false,
            reconnectDelayMs: 5000,
        };
    }

    return {
        type: 'retry',
        shouldClearSession: false,
        reconnectDelayMs: 3000,
    };
}

async function resetWhatsAppSession({
    clearSession,
    closeSocket,
    scheduleReconnect,
    reconnectDelayMs = 500,
}) {
    if (typeof clearSession !== 'function') {
        throw new Error('WhatsApp session reset belum siap.');
    }
    if (typeof closeSocket !== 'function' || typeof scheduleReconnect !== 'function') {
        throw new Error('WhatsApp session reset tidak dikonfigurasi dengan lengkap.');
    }

    await clearSession();
    closeSocket();
    scheduleReconnect(reconnectDelayMs);

    return { cleared: true, reconnectDelayMs };
}

module.exports = {
    classifyDisconnect,
    resetWhatsAppSession,
};
