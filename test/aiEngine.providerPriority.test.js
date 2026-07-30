const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';

const {
    getProviderOrder,
    normalizeWhatsAppFormatting,
    sanitizeResponseForRole,
} = require('../aiEngine');

test('prioritizes Gemini then Claude gateway before Groq for customer-service replies', () => {
    assert.deepEqual(getProviderOrder({
        hasGemini: true,
        hasOpenAgentic: true,
        hasGroq: true,
    }), ['gemini', 'openagentic', 'groq']);
});

test('skips unavailable providers without changing the remaining CS model priority', () => {
    assert.deepEqual(getProviderOrder({
        hasGemini: false,
        hasOpenAgentic: true,
        hasGroq: true,
    }), ['openagentic', 'groq']);
});

test('customer responses cannot expose or advertise internal business information', () => {
    assert.equal(typeof sanitizeResponseForRole, 'function');

    const unsafeResponse = [
        'Cleco Pii adalah outlet Lunomi Hub.',
        'Saya bisa bantu cek omset harian, absensi karyawan, HPP, dan resep produk.',
    ].join(' ');
    const sanitized = sanitizeResponseForRole(unsafeResponse, 'customer');

    assert.doesNotMatch(
        sanitized,
        /\b(lunomi|omset|absensi|hpp|resep|bahan baku|overhead)\b/i
    );
    assert.match(sanitized, /menu|harga|lokasi|jam buka|pesanan/i);

    const alternateSpelling = sanitizeResponseForRole(
        'Saya juga bisa menampilkan omzet outlet hari ini.',
        'customer'
    );
    assert.doesNotMatch(alternateSpelling, /\bomzet\b/i);

    const crossOutletResponse = sanitizeResponseForRole(
        'Mau lihat kopi di BJ Baby Joy atau outlet RB?',
        'customer'
    );
    assert.doesNotMatch(crossOutletResponse, /\b(?:BJ|Baby Joy|RB|Resep Bunce)\b/i);
    assert.match(crossOutletResponse, /Cleco Pii/i);
});

test('internal staff responses are not altered by the customer safety filter', () => {
    assert.equal(typeof sanitizeResponseForRole, 'function');

    const internalResponse = 'Omset harian outlet CP adalah Rp 1.000.000.';
    assert.equal(sanitizeResponseForRole(internalResponse, 'staff'), internalResponse);
    assert.equal(sanitizeResponseForRole(internalResponse, 'owner'), internalResponse);
});

test('normalizes markdown emphasis to WhatsApp syntax without visible extra stars', () => {
    const normalized = normalizeWhatsAppFormatting([
        '**HPP Americano**',
        '**Harga Jual:** Rp 22.000',
        '**Bahan Baku:**',
        '• Houseblend 19 gram',
    ].join('\n'));

    assert.equal(normalized, [
        '*HPP Americano*',
        '*Harga Jual:* Rp 22.000',
        'Bahan Baku:',
        '- Houseblend 19 gram',
    ].join('\n'));
});

test('preserves supported WhatsApp styles and limits bold emphasis to two spans', () => {
    const normalized = normalizeWhatsAppFormatting([
        '*Judul*',
        '_Catatan_',
        '~Tidak tersedia~',
        '> Kutipan pelanggan',
        '`kode`',
        '*Total*',
        '*Label berlebih*',
    ].join('\n'));

    assert.match(normalized, /\*Judul\*/);
    assert.match(normalized, /_Catatan_/);
    assert.match(normalized, /~Tidak tersedia~/);
    assert.match(normalized, /> Kutipan pelanggan/);
    assert.match(normalized, /`kode`/);
    assert.match(normalized, /\*Total\*/);
    assert.doesNotMatch(normalized, /\*Label berlebih\*/);
});
