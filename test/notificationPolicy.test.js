'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    detectBusinessCommitmentRisk,
    formatBusinessCommitmentNotification,
} = require('../notificationPolicy');

test('detects an unverified meeting or partnership commitment from the AI', () => {
    const risk = detectBusinessCommitmentRisk({
        inboundText: 'Saya mau kerja sama promosi TikTok, bisa ketemu besok?',
        replyText: 'Sudah fix besok jam 11. Tim kami akan siapkan waktu khusus dan saya sambungkan ke kasir.',
    });

    assert.ok(risk);
    assert.match(risk.reason, /komitmen/i);
});

test('does not alert for ordinary menu or greeting replies', () => {
    assert.equal(detectBusinessCommitmentRisk({
        inboundText: 'Ada kopi apa saja?',
        replyText: 'Boleh Kak, saya bantu cek menu kopi Cleco Pii.',
    }), null);
});

test('formats an actionable group alert without exposing unbounded text', () => {
    const message = formatBusinessCommitmentNotification({
        phoneNumber: '081234567890',
        pauseMinutes: 60,
        risk: {
            inboundText: 'Saya mau kerja sama promosi TikTok, bisa ketemu besok?',
            replyText: 'Sudah fix besok jam 11.',
        },
    });

    assert.match(message, /REVIEW WAJIB/);
    assert.match(message, /081234567890/);
    assert.match(message, /Tim Cleco Pii wajib memverifikasi/);
});
