'use strict';

const BUSINESS_CONTEXT_PATTERN = /\b(?:jadwal|ketemu|bertemu|meeting|offline|kolaborasi|kerja sama|kerjasama|partnership|promosi|tiktok)\b/i;
const COMMITMENT_PATTERN = /\b(?:sudah\s+(?:fix|pasti|dicatat|dikonfirmasi)|akan\s+(?:siapkan|menyiapkan|hubungi|menghubungi|koordinasikan|koordinasi)|panggilkan|sambungkan|ditunggu|bisa\s+langsung\s+datang|tim\s+(?:kami|kita)\s+(?:akan|sudah)|saya\s+(?:panggilkan|sambungkan|koordinasikan))\b/i;

function compactText(value, maxLength = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function detectBusinessCommitmentRisk({ inboundText, replyText }) {
    const inbound = compactText(inboundText);
    const reply = compactText(replyText);
    if (!inbound || !reply) return null;
    if (!BUSINESS_CONTEXT_PATTERN.test(inbound) || !COMMITMENT_PATTERN.test(reply)) return null;

    return {
        reason: 'AI membuat komitmen jadwal, pertemuan, promosi, atau handoff tanpa konfirmasi manusia.',
        inboundText: inbound,
        replyText: reply,
    };
}

function formatBusinessCommitmentNotification({ phoneNumber, risk, pauseMinutes }) {
    return [
        '⚠️ *REVIEW WAJIB: KOMITMEN BISNIS AI*',
        '----------------------------------------',
        `📱 *Pelanggan*: ${phoneNumber || 'Tidak diketahui'}`,
        `💬 *Pesan pelanggan*: "${risk.inboundText}"`,
        `🤖 *Balasan AI*: "${risk.replyText}"`,
        '',
        `⏸️ *Status*: AI dipause ${pauseMinutes} menit untuk mencegah janji lanjutan.`,
        '👉 *Tindakan*: Tim Cleco Pii wajib memverifikasi jadwal dan menghubungi pelanggan secara manual.',
    ].join('\n');
}

module.exports = {
    compactText,
    detectBusinessCommitmentRisk,
    formatBusinessCommitmentNotification,
};
