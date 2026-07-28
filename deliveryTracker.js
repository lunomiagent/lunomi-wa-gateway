'use strict';

function createDeliveryTracker({
    timeoutMs = 30000,
    onTimeout = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    const pending = new Map();

    function track({ messageId, phoneNumber, targetJid }) {
        if (!messageId) return null;

        const existing = pending.get(messageId);
        if (existing) clearTimer(existing.timerId);

        const delivery = { messageId, phoneNumber, targetJid };
        const timerId = setTimer(() => {
            const current = pending.get(messageId);
            if (!current) return;
            pending.delete(messageId);
            onTimeout({
                messageId: current.messageId,
                phoneNumber: current.phoneNumber,
                targetJid: current.targetJid,
            });
        }, timeoutMs);

        pending.set(messageId, { ...delivery, timerId });
        return delivery;
    }

    function handleStatus({ messageId, status, deliveryAckStatus, errorStatus }) {
        const delivery = pending.get(messageId);
        if (!delivery || typeof status !== 'number') return null;

        const isError = status === errorStatus;
        const terminal = isError || status >= deliveryAckStatus;
        if (terminal) {
            clearTimer(delivery.timerId);
            pending.delete(messageId);
        }

        return {
            messageId,
            phoneNumber: delivery.phoneNumber,
            targetJid: delivery.targetJid,
            status,
            terminal,
            outcome: isError ? 'error' : terminal ? 'delivered' : 'pending',
        };
    }

    return {
        track,
        handleStatus,
        pendingCount: () => pending.size,
    };
}

function describeReachoutTimeLock(reachoutTimeLock) {
    if (!reachoutTimeLock) return null;
    const end = reachoutTimeLock.timeEnforcementEnds;
    return {
        active: reachoutTimeLock.isActive === true,
        enforcementEnds: end ? new Date(end).toISOString() : null,
        enforcementType: reachoutTimeLock.enforcementType || 'DEFAULT',
    };
}

module.exports = {
    createDeliveryTracker,
    describeReachoutTimeLock,
};
