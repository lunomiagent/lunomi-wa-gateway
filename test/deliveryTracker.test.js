const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createDeliveryTracker,
    describeReachoutTimeLock,
} = require('../deliveryTracker');

function createFakeTimers() {
    let nextId = 1;
    const callbacks = new Map();
    return {
        setTimer(callback) {
            const id = nextId++;
            callbacks.set(id, callback);
            return id;
        },
        clearTimer(id) {
            callbacks.delete(id);
        },
        fire(id) {
            const callback = callbacks.get(id);
            callbacks.delete(id);
            callback?.();
        },
        ids() {
            return [...callbacks.keys()];
        },
    };
}

test('marks a pending message unconfirmed when its delivery receipt times out', () => {
    const timers = createFakeTimers();
    const timeouts = [];
    const tracker = createDeliveryTracker({
        timeoutMs: 30000,
        onTimeout: pending => timeouts.push(pending),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });

    tracker.track({
        messageId: 'message-1',
        phoneNumber: '085353726052',
        targetJid: '193720876068899@lid',
    });
    timers.fire(timers.ids()[0]);

    assert.equal(tracker.pendingCount(), 0);
    assert.deepEqual(timeouts, [{
        messageId: 'message-1',
        phoneNumber: '085353726052',
        targetJid: '193720876068899@lid',
    }]);
});

test('clears a pending message after delivery acknowledgement', () => {
    const timers = createFakeTimers();
    const tracker = createDeliveryTracker({
        timeoutMs: 30000,
        onTimeout: () => assert.fail('timeout must be cleared'),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    tracker.track({ messageId: 'message-2', phoneNumber: '081', targetJid: 'target@lid' });

    const result = tracker.handleStatus({
        messageId: 'message-2',
        status: 3,
        deliveryAckStatus: 3,
        errorStatus: 0,
    });

    assert.equal(result.terminal, true);
    assert.equal(result.outcome, 'delivered');
    assert.equal(tracker.pendingCount(), 0);
    assert.deepEqual(timers.ids(), []);
});

test('keeps a pending message for a non-terminal server acknowledgement', () => {
    const timers = createFakeTimers();
    const tracker = createDeliveryTracker({
        timeoutMs: 30000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    tracker.track({ messageId: 'message-3', phoneNumber: '081', targetJid: 'target@lid' });

    const result = tracker.handleStatus({
        messageId: 'message-3',
        status: 1,
        deliveryAckStatus: 3,
        errorStatus: 0,
    });

    assert.equal(result.terminal, false);
    assert.equal(result.outcome, 'pending');
    assert.equal(tracker.pendingCount(), 1);
});

test('describes active and lifted WhatsApp reachout restrictions', () => {
    assert.deepEqual(describeReachoutTimeLock({
        isActive: true,
        timeEnforcementEnds: new Date('2026-07-28T15:00:00.000Z'),
        enforcementType: 'DEFAULT',
    }), {
        active: true,
        enforcementEnds: '2026-07-28T15:00:00.000Z',
        enforcementType: 'DEFAULT',
    });

    assert.deepEqual(describeReachoutTimeLock({ isActive: false }), {
        active: false,
        enforcementEnds: null,
        enforcementType: 'DEFAULT',
    });
});
