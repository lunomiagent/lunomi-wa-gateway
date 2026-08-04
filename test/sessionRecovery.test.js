const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyDisconnect,
    resetWhatsAppSession,
} = require('../sessionRecovery');

test('classifies logged out sessions as a reset-and-relink event', () => {
    assert.deepEqual(
        classifyDisconnect(401, { loggedOut: 401 }),
        { type: 'logged_out', shouldClearSession: true, reconnectDelayMs: 500 },
    );
});

test('keeps conflict recovery separate from logout recovery', () => {
    assert.deepEqual(
        classifyDisconnect(440, { loggedOut: 401 }),
        { type: 'conflict', shouldClearSession: false, reconnectDelayMs: 5000 },
    );
});

test('manual reset clears the stored session before reconnecting', async () => {
    const events = [];
    const result = await resetWhatsAppSession({
        clearSession: async () => events.push('clear'),
        closeSocket: () => events.push('close'),
        scheduleReconnect: (delayMs) => events.push(`reconnect:${delayMs}`),
        reconnectDelayMs: 500,
    });

    assert.deepEqual(events, ['clear', 'close', 'reconnect:500']);
    assert.deepEqual(result, { cleared: true, reconnectDelayMs: 500 });
});
