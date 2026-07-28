const test = require('node:test');
const assert = require('node:assert/strict');

const { sendReplyToInboundChat } = require('../waReplyDelivery');

const LID_JID = '193720876068899@lid';
const PHONE_JID = '6285353726052@s.whatsapp.net';

function createMessage(remoteJid = LID_JID) {
    return {
        key: {
            remoteJid,
            senderPn: PHONE_JID,
        },
        message: {
            conversation: 'Cek',
        },
    };
}

test('stores the inbound LID and phone mapping before sending', async () => {
    const operations = [];
    const sock = {
        signalRepository: {
            lidMapping: {
                async storeLIDPNMappings(mappings) {
                    operations.push({ type: 'mapping', mappings });
                },
            },
        },
        async sendMessage(jid) {
            operations.push({ type: 'send', jid });
            return { key: { id: 'mapped-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg: createMessage(),
        text: 'Daftar menu',
    });

    assert.deepEqual(operations, [
        {
            type: 'mapping',
            mappings: [{ lid: LID_JID, pn: PHONE_JID }],
        },
        { type: 'send', jid: LID_JID },
    ]);
    assert.equal(result.mappingStored, true);
    assert.equal(result.mappingError, null);
});

test('sends to the exact LID when senderPn is unavailable', async () => {
    const msg = createMessage();
    delete msg.key.senderPn;
    const calls = [];
    const sock = {
        signalRepository: {
            lidMapping: {
                async storeLIDPNMappings() {
                    throw new Error('mapping must be skipped');
                },
            },
        },
        async sendMessage(jid) {
            calls.push(jid);
            return { key: { id: 'lid-without-pn-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg,
        text: 'Daftar menu',
    });

    assert.deepEqual(calls, [LID_JID]);
    assert.equal(result.mappingStored, false);
    assert.equal(result.mappingError, null);
});

test('surfaces a mapping failure and still attempts the exact LID', async () => {
    const calls = [];
    const sock = {
        signalRepository: {
            lidMapping: {
                async storeLIDPNMappings() {
                    throw new Error('mapping write failed');
                },
            },
        },
        async sendMessage(jid) {
            calls.push(jid);
            return { key: { id: 'unmapped-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg: createMessage(),
        text: 'Daftar menu',
    });

    assert.deepEqual(calls, [LID_JID]);
    assert.equal(result.mappingStored, false);
    assert.match(result.mappingError.message, /mapping write failed/);
});

test('preserves the mapping failure when both send targets fail', async () => {
    const sock = {
        signalRepository: {
            lidMapping: {
                async storeLIDPNMappings() {
                    throw new Error('mapping write failed');
                },
            },
        },
        async sendMessage(jid) {
            throw new Error(`send failed: ${jid}`);
        },
    };

    await assert.rejects(
        sendReplyToInboundChat({
            sock,
            msg: createMessage(),
            text: 'Daftar menu',
        }),
        (error) => {
            assert.equal(error.name, 'AggregateError');
            assert.match(error.mappingError.message, /mapping write failed/);
            return true;
        }
    );
});

test('does not store a LID mapping for a phone-JID inbound chat', async () => {
    let mappingCalls = 0;
    const sock = {
        signalRepository: {
            lidMapping: {
                async storeLIDPNMappings() {
                    mappingCalls += 1;
                },
            },
        },
        async sendMessage() {
            return { key: { id: 'phone-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg: createMessage(PHONE_JID),
        text: 'Halo',
    });

    assert.equal(mappingCalls, 0);
    assert.equal(result.mappingStored, false);
    assert.equal(result.mappingError, null);
});

test('uses the exact inbound LID as the only target when the primary send succeeds', async () => {
    const calls = [];
    const sock = {
        async sendMessage(jid, content, options) {
            calls.push({ jid, content, options });
            return { key: { id: 'primary-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg: createMessage(),
        text: 'Daftar menu',
    });

    assert.deepEqual(calls, [{
        jid: LID_JID,
        content: { text: 'Daftar menu' },
        options: {},
    }]);
    assert.equal(result.targetJid, LID_JID);
    assert.equal(result.usedFallback, false);
    assert.equal(result.message.key.id, 'primary-message-id');
});

test('uses senderPn once as fallback only after the exact inbound JID fails', async () => {
    const calls = [];
    const sock = {
        async sendMessage(jid, content, options) {
            calls.push({ jid, content, options });
            if (jid === LID_JID) {
                throw new Error('LID session unavailable');
            }
            return { key: { id: 'fallback-message-id' } };
        },
    };

    const result = await sendReplyToInboundChat({
        sock,
        msg: createMessage(),
        text: 'Daftar menu',
    });

    assert.deepEqual(calls.map(({ jid }) => jid), [LID_JID, PHONE_JID]);
    assert.deepEqual(calls[1], {
        jid: PHONE_JID,
        content: { text: 'Daftar menu' },
        options: {},
    });
    assert.equal(result.targetJid, PHONE_JID);
    assert.equal(result.usedFallback, true);
    assert.equal(result.message.key.id, 'fallback-message-id');
});

test('preserves both send failures when the primary and fallback targets fail', async () => {
    const sock = {
        async sendMessage(jid) {
            throw new Error(`send failed: ${jid}`);
        },
    };

    await assert.rejects(
        sendReplyToInboundChat({
            sock,
            msg: createMessage(),
            text: 'Daftar menu',
        }),
        (error) => {
            assert.equal(error.name, 'AggregateError');
            assert.match(error.message, /primary and fallback/i);
            assert.equal(error.errors.length, 2);
            return true;
        }
    );
});

test('keeps quoted context for a regular phone-JID inbound chat', async () => {
    const msg = createMessage(PHONE_JID);
    const calls = [];
    const sock = {
        async sendMessage(jid, content, options) {
            calls.push({ jid, content, options });
            return { key: { id: 'phone-message-id' } };
        },
    };

    await sendReplyToInboundChat({
        sock,
        msg,
        text: 'Halo',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].jid, PHONE_JID);
    assert.deepEqual(calls[0].options, { quoted: msg });
});
