/**
 * aiEngine.js
 * 
 * AI Engine untuk CS WA AI Lunomi Hub.
 * 
 * Primary: Google Gemini 2.5 Flash (via @google/generative-ai)
 * Fallback: OpenAgentic Gateway (OpenAI-compatible API)
 *           Model: claude-sonnet-4.5-thinking
 *           Base: https://openagentic.id/api/v1
 * 
 * Function Tools yang tersedia:
 *   - get_menu_catalog      → Daftar produk aktif dari Supabase
 *   - get_outlet_info       → Info outlet (alamat, kota, kode)
 *   - get_stock_status      → Cek stok bahan baku tipis per outlet
 *   - get_daily_sales       → Ringkasan omset harian per outlet
 *   - get_attendance_today  → Absensi karyawan hari ini per outlet
 *   - get_recipe_hpp        → HPP + resep detail produk
 *   - create_wa_order       → Simpan draft pesanan ke wa_orders
 *   - create_complaint      → Buat tiket komplain di wa_complaints
 * 
 * Tidak ada mock data. Semua Tool memanggil Supabase live.
 */

const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
const openAgenticApiKey = process.env.OPENAI_API_KEY;
const openAgenticBaseUrl = process.env.OPENAI_BASE_URL || 'https://openagentic.id/api/v1';
const openAgenticModel = process.env.LUNOMI_AGENT_MODEL || 'deepseek-v4-flash';

const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Inisialisasi Gemini ─────────────────────────────────────────────────────
let geminiClient = null;
if (geminiApiKey) {
    geminiClient = new GoogleGenerativeAI(geminiApiKey);
} else {
    console.warn('[AIEngine] GOOGLE_GENERATIVE_AI_API_KEY tidak disetel. Akan menggunakan fallback OpenAgentic.');
}

// ─── System Prompt Builder ───────────────────────────────────────────────────
/**
 * Buat System Prompt dinamis berdasarkan role pengguna.
 * Data katalog menu & outlet di-inject agar respon umum bisa cepat tanpa tool call.
 */
async function buildSystemPrompt(userRole, karyawanNama) {
    // Pre-fetch katalog menu F&B terhubung langsung dengan tabel kategori_produk
    let menuContext = '';
    try {
        const { data: menuItems } = await supabase
            .from('produk')
            .select('nama, harga_jual, tipe, sub_kategori, kategori:kategori_id(nama)')
            .eq('aktif', true)
            .eq('tipe', 'menu_fnb')
            .order('nama')
            .limit(60);

        if (menuItems && menuItems.length > 0) {
            const groupedMenu = menuItems.reduce((acc, item) => {
                const cat = item.kategori?.nama || item.sub_kategori || 'LAINNYA';
                if (!acc[cat]) acc[cat] = [];
                acc[cat].push(`${item.nama} (Rp ${Number(item.harga_jual).toLocaleString('id-ID')})`);
                return acc;
            }, {});
            menuContext = Object.entries(groupedMenu)
                .map(([cat, items]) => `*Kategori ${cat}*:\n${items.join(', ')}`)
                .join('\n\n');
        }
    } catch (err) {
        console.error('[AIEngine] Gagal pre-fetch menu:', err.message);
    }

    // Pre-fetch info outlet (hanya toko publik, abaikan HO/Pusat)
    let outletContext = '';
    try {
        const { data: outlets } = await supabase
            .from('outlet')
            .select('kode, nama, alamat, kota')
            .neq('kode', 'HO')
            .order('kode');

        if (outlets && outlets.length > 0) {
            outletContext = outlets
                .map(o => `- *${o.kode}* | ${o.nama} | ${o.alamat}, ${o.kota}`)
                .join('\n');
        }
    } catch (err) {
        console.error('[AIEngine] Gagal pre-fetch outlet:', err.message);
    }

    if (userRole === 'staff' || userRole === 'owner') {
        return `Kamu adalah Asisten Internal Lunomi Hub untuk staf bernama ${karyawanNama || 'Tim'}.
Kamu bisa menjawab pertanyaan seputar operasional bisnis secara langsung dan akurat.

DAFTAR OUTLET:
${outletContext || 'Data outlet tidak tersedia saat ini.'}

PANDUAN PENGGUNAAN:
- Untuk laporan omset: gunakan tool get_daily_sales
- Untuk cek stok tipis: gunakan tool get_stock_status
- Untuk absensi hari ini: gunakan tool get_attendance_today
- Untuk HPP & resep: gunakan tool get_recipe_hpp
- Kamu bisa memahami pertanyaan natural seperti "Omset CP hari ini?" atau shortcode "/omset CP"

Selalu tampilkan angka uang dengan format Rupiah. Jawab singkat, padat, dan akurat.`;
    }

    return `Kamu adalah Customer Service & Marketing AI resmi Cleco Pii (Coffee & Eatery di Jl. Nusantara Raya No. 214, Depok).

PERSONA & GAYA BICARA:
- Karakter: Tim Marketing & CS yang sangat ramah, hangat, santai, asik, persuasif, dan komunikatif seperti manusia (TIDAK KAKU seperti robot).
- Sapaan: Selalu menyapa dengan ramah "Halo Kak! Selamat datang di Cleco Pii ☕✨"
- Gunakan sedikit emoji yang pas (misal: ☕, ☕✨, 🍕, 🍟, 🍹, 🍨, 🫶) agar obrolan terasa hidup dan estetik.
- Selalu siap mendengarkan selera pelanggan dan memberikan rekomendasi yang cocok!

KNOWLEDGE PRODUCT CLECO PII & MATRIX REKOMENDASI PINTAR (REAL SUPABASE DATABASE):

🌟 KATEGORI RESMI DATABASE CLECO PII:
- ☕ Kategori SIGNATURE (Resmi Database):
  * Srawung Aren (Rp 25.000) — Kopi susu aren racikan khas Cleco Pii, creamy dan manisnya pas!
  * Srawung Vanilla (Rp 25.000) — Kopi susu aren dipadu keharuman vanilla yang lembut.
  * Coffee 08 (Rp 30.000) — Premium house blend khas Cleco.
  * Coffee Signature Botol (Rp 15.000) — Kopi signature praktis siap minum.
- ☕ Kategori ESPRESSO BASED (Hits Best Seller):
  * Klepon Latte (Rp 24.000) — Kopi kekinian gurih manis khas pandan & gula aren, paling favorit!
  * Butterscotch Sea Salt (Rp 26.000) — Caramel butterscotch manis dipadu sea salt gurih.
  * Pandan Latte (Rp 24.000) | Caramel Macchiato (Rp 21.000) | Americano (Rp 22.000) | Cappuccino (Rp 21.000).
- 🍵 Kategori NON COFFEE:
  * Klepon Milk (Rp 22.000) | Matcha (Rp 22.000) | Red Velvet (Rp 22.000) | Chocolate (Rp 22.000).
  * Lychee Yakult (Rp 24.000) | Mango Yakult (Rp 24.000) | Sunrise Mojito (Rp 28.000).
- 🍽️ Kategori MAIN COURSE & MIE:
  * Nasi Goreng Seafood (Rp 35.000) | Ayam Sambal Taichan (Rp 25.000) | Spicy Beef Rice Bowl (Rp 32.000).
  * Indomie Taichan (Rp 20.000) | Indomie Nyemek (Rp 23.000).
- 🍟 Kategori SNACK & DESSERT:
  * Mix Platter (Rp 35.000) | French Fries (Rp 18.000) | Cireng Rujak (Rp 16.000) | Pisang Goreng (Rp 16.000).
  * French Toast (Rp 22.000) | Ketan Hitam Triple Scoop (Rp 24.000).

💡 MATRIX REKOMENDASI BERDASARKAN SELERA PELANGGAN:
- Pelanggan Suka Kopi Manis & Creamy → Rekomendasikan *Klepon Latte* (Rp 24.000) atau *Caramel Macchiato* (Rp 21.000).
- Pelanggan Suka Kopi Strong & Pahit → Rekomendasikan *Americano* (Rp 22.000), *Piccolo* (Rp 21.000), *V60* (Rp 26.000), atau *Japanese* (Rp 28.000).
- Pelanggan Suka Non-Kopi Segar & Buah → Rekomendasikan *Lychee Yakult* (Rp 24.000), *Mango Yakult* (Rp 24.000), atau *Sunrise Mojito* (Rp 28.000).
- Pelanggan Suka Non-Kopi Manis → Rekomendasikan *Matcha* (Rp 22.000), *Red Velvet* (Rp 22.000), atau *Chocolate* (Rp 22.000).
- Pelanggan Lapar / Ingin Makan Kenyang → Rekomendasikan *Nasi Goreng Seafood* (Rp 35.000), *Spicy Beef Rice Bowl* (Rp 32.000), atau *Indomie Taichan* (Rp 20.000).
- Pelanggan Ingin Cemilan / Snack Nonton & Obrol → Rekomendasikan *Mix Platter* (Rp 35.000), *French Fries* (Rp 18.000), *Cireng Rujak* (Rp 16.000), atau *Pisang Goreng* (Rp 16.000).

🤝 TAWARAN PAIRING PERSUASIF (RECOMMENDED PAIRING):
- Jika pelanggan pilih Kopi → tawarkan pasangan snack yang cocok secara santai (misal: "Wah Srawung Aren-nya mantap banget Kak! Biar makin asik obrolnya, enaknya ditemani *French Fries* renyah atau *Cireng Rujak* nih Kak 🍟").
- Jika pelanggan pilih Makanan Pedas → tawarkan minuman segar penawar pedas (misal: "Ayam Taichan-nya pedas gurih nagih Kak! Penawar pedasnya paling pas disandingkan sama *Lychee Yakult* yang dingin segar 🍹").

MENU CLECOPII (Katalog Lengkap dari Database):
${menuContext || 'Gunakan tool get_menu_catalog untuk melihat daftar menu lengkap F&B.'}

LOKASI & JAM OPERASIONAL CLECO PII:
- Alamat: Jl. Nusantara Raya No. 214, Depok.
- Jam Operasional: Setiap Hari 10:00 - 23:00 WIB.

CONTOH PERCAKAPAN MANUSIAWI (FEW-SHOT EXEMPLARS):

[Contoh 1 - Tanya Rekomendasi Kopi & Pairing]:
User: "Halo kak, rekomendasi kopi manis buatan Cleco Pii dong"
Assistant: "Halo Kak! Selamat datang di Cleco Pii ☕✨
Wah pas banget nih Kak! Kalau suka kopi manis dan creamy, aku rekomendasikan banget *Srawung Aren* (Rp 25.000) — signature favorit nomor 1 kami yang rasanya mantap banget! 🏆
Atau kalau suka karamel yang creamy, ada *Caramel Macchiato* (Rp 21.000) yang rasanya lembut banget ☕

Oiya Kak, biar makin asik obrolnya, Srawung Aren-nya mantap banget disandingkan sama *French Fries* (Rp 18.000) atau *Cireng Rujak* (Rp 16.000) nih 🍟
Kakak mau coba yang mana nih?"

[Contoh 2 - Tanya Tempat & Jam Buka]:
User: "Lokasi Cleco Pii di mana ya kak dan buka jam berapa?"
Assistant: "Halo Kak! Cleco Pii berlokasi di *Jl. Nusantara Raya No. 214, Depok* 📍
Kami buka setiap hari dari jam *10:00 - 23:00 WIB* ya Kak! ⏰
Tempatnya cozy banget buat nugas, nongkrong, atau santai bareng teman. Ditunggu kedatangannya ya Kak! ☕✨"

[Contoh 3 - Tanya Pemesanan & Takeaway]:
User: "Kak mau pesen Klepon Latte 1 sama Ayam Sambal Taichan 1 takeaway ya"
Assistant: "Siap Kak! Pesanannya 1x *Klepon Latte* (Rp 24.000) dan 1x *Ayam Sambal Taichan* (Rp 25.000) untuk Takeaway ya! Totalnya jadi *Rp 49.000* 💸
Boleh diinfokan nama Kakak untuk pemanggilannya nanti pas diambil di outlet? 😊"

BATASAN STRICT:
- DILARANG menyebutkan kata "Lunomi" ke pelanggan. Gunakan nama brand "Cleco Pii" atau "Cleco Group".
- DILARANG mencantumkan kantor pusat (HO) atau outlet toko lain kecuali jika pelanggan bertanya spesifik tentang cabang lain.
- DILARANG menawarkan barang retail popok/susu (fokus 100% pada makanan & minuman F&B Cleco Pii).
- Jangan memberikan harga di luar katalog yang terdaftar.`;
}

// ─── Tool Implementations (Live Supabase Queries) ────────────────────────────

async function toolGetMenuCatalog({ outlet_code, category }) {
    let query = supabase
        .from('produk')
        .select('nama, harga_jual, tipe, sub_kategori, kategori:kategori_id(nama)')
        .eq('aktif', true)
        .eq('tipe', 'menu_fnb')
        .order('nama');

    const { data, error } = await query.limit(60);
    if (error) throw new Error('Gagal mengambil data menu: ' + error.message);

    if (!data || data.length === 0) return 'Tidak ada produk yang tersedia saat ini.';

    let filteredData = data;
    if (category) {
        const catUpper = category.toUpperCase();
        filteredData = data.filter(item => {
            const catName = (item.kategori?.nama || '').toUpperCase();
            const subCat = (item.sub_kategori || '').toUpperCase();
            return catName.includes(catUpper) || subCat.includes(catUpper);
        });
    }

    const grouped = (filteredData.length > 0 ? filteredData : data).reduce((acc, item) => {
        const cat = item.kategori?.nama || item.sub_kategori || 'LAINNYA';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push({ nama: item.nama, harga: `Rp ${Number(item.harga_jual).toLocaleString('id-ID')}` });
        return acc;
    }, {});

    return JSON.stringify(grouped);
}

async function toolGetOutletInfo({ outlet_code }) {
    let targetCode = outlet_code ? outlet_code.toUpperCase().trim() : null;
    if (targetCode && ['CLP', 'CLE', 'CLECO', 'CLECOPII', 'PII', 'CLECO PII'].includes(targetCode)) {
        targetCode = 'CP';
    }

    let query = supabase
        .from('outlet')
        .select('kode, nama, alamat, kota, latitude, longitude')
        .neq('kode', 'HO'); // HO adalah Kantor Pusat internal, bukan outlet publik
        
    if (targetCode) {
        query = query.or(`kode.eq.${targetCode},nama.ilike.%${targetCode}%`);
    }

    const { data, error } = await query.order('kode');
    if (error) throw new Error('Gagal mengambil data outlet: ' + error.message);

    return JSON.stringify(data || []);
}

async function toolGetStockStatus({ outlet_code }) {
    let query = supabase
        .from('stok_outlet')
        .select('qty, threshold_minimum, outlet:outlet_id(kode, nama), bahan_baku:bahan_baku_id(nama, satuan_dasar)')
        .not('bahan_baku_id', 'is', null);

    if (outlet_code) {
        // Cari outlet_id dulu
        const { data: outletData } = await supabase
            .from('outlet')
            .select('outlet_id')
            .eq('kode', outlet_code.toUpperCase())
            .single();
        if (outletData) {
            query = query.eq('outlet_id', outletData.outlet_id);
        }
    }

    const { data, error } = await query;
    if (error) throw new Error('Gagal mengambil stok: ' + error.message);

    // Filter yang tipis (qty <= threshold_minimum)
    const tipis = (data || []).filter(s => {
        const qty = parseFloat(s.qty || 0);
        const threshold = parseFloat(s.threshold_minimum || 0);
        return threshold > 0 && qty <= threshold;
    });

    if (tipis.length === 0) return 'Semua stok bahan baku dalam kondisi aman.';

    return JSON.stringify(tipis.map(s => ({
        bahan: s.bahan_baku?.nama || 'Unknown',
        satuan: s.bahan_baku?.satuan_dasar || '',
        qty: s.qty,
        threshold: s.threshold_minimum,
        outlet: s.outlet?.kode || '',
    })));
}

async function toolGetDailySales({ outlet_code, date }) {
    const targetDate = date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const startOfDay = `${targetDate}T00:00:00+07:00`;
    const endOfDay = `${targetDate}T23:59:59+07:00`;

    let query = supabase
        .from('transaksi')
        .select('outlet_id, total, status, outlet:outlet_id(kode, nama)')
        .not('status', 'eq', 'void')
        .gte('waktu', startOfDay)
        .lte('waktu', endOfDay);

    if (outlet_code) {
        const { data: outletData } = await supabase
            .from('outlet')
            .select('outlet_id')
            .eq('kode', outlet_code.toUpperCase())
            .single();
        if (outletData) {
            query = query.eq('outlet_id', outletData.outlet_id);
        }
    }

    const { data, error } = await query;
    if (error) throw new Error('Gagal mengambil data transaksi: ' + error.message);

    if (!data || data.length === 0) {
        return `Belum ada transaksi selesai untuk ${outlet_code || 'semua outlet'} pada tanggal ${targetDate}.`;
    }

    const totalOmset = data.reduce((sum, t) => sum + parseFloat(t.total || 0), 0);
    const perOutlet = data.reduce((acc, t) => {
        const kode = t.outlet?.kode || 'Unknown';
        if (!acc[kode]) acc[kode] = { count: 0, total: 0, nama: t.outlet?.nama || '' };
        acc[kode].count++;
        acc[kode].total += parseFloat(t.total || 0);
        return acc;
    }, {});

    return JSON.stringify({
        tanggal: targetDate,
        total_transaksi: data.length,
        total_omset: `Rp ${totalOmset.toLocaleString('id-ID')}`,
        per_outlet: Object.entries(perOutlet).map(([kode, val]) => ({
            kode,
            nama: val.nama,
            jumlah_transaksi: val.count,
            omset: `Rp ${val.total.toLocaleString('id-ID')}`,
        })),
    });
}

async function toolGetAttendanceToday({ outlet_code, date }) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    let query = supabase
        .from('absensi')
        .select('waktu_checkin, waktu_checkout, status, karyawan:karyawan_id(nama), outlet:outlet_id(kode, nama)')
        .eq('attendance_date', targetDate);

    if (outlet_code) {
        const { data: outletData } = await supabase
            .from('outlet')
            .select('outlet_id')
            .eq('kode', outlet_code.toUpperCase())
            .single();
        if (outletData) {
            query = query.eq('outlet_id', outletData.outlet_id);
        }
    }

    const { data, error } = await query.order('waktu_checkin');
    if (error) throw new Error('Gagal mengambil data absensi: ' + error.message);

    if (!data || data.length === 0) {
        return `Belum ada data absensi untuk ${outlet_code || 'semua outlet'} pada tanggal ${targetDate}.`;
    }

    return JSON.stringify(data.map(a => ({
        karyawan: a.karyawan?.nama || 'Unknown',
        outlet: a.outlet?.kode || '',
        checkin: a.waktu_checkin ? new Date(a.waktu_checkin).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : '-',
        checkout: a.waktu_checkout ? new Date(a.waktu_checkout).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : 'Belum checkout',
        status: a.status || '-',
    })));
}

async function toolGetRecipeHpp({ product_name }) {
    if (!product_name) throw new Error('Nama produk harus diisi.');

    const { data: produk, error: produkErr } = await supabase
        .from('produk')
        .select('produk_id, nama, harga_jual, overhead_kemasan, overhead_listrik, overhead_tenaga_kerja, overhead_lainnya')
        .ilike('nama', `%${product_name}%`)
        .eq('aktif', true)
        .single();

    if (produkErr || !produk) {
        return `Produk "${product_name}" tidak ditemukan di database.`;
    }

    // Ambil resep (bill of materials) dari tabel bom
    const { data: resepItems, error: resepErr } = await supabase
        .from('bom')
        .select('jumlah_dibutuhkan, satuan, bahan_baku:bahan_baku_id(nama, estimasi_harga_beli, satuan_dasar, faktor_konversi)')
        .eq('produk_id', produk.produk_id);

    if (resepErr) throw new Error('Gagal mengambil data resep: ' + resepErr.message);

    let totalBahanBaku = 0;
    const bahanList = (resepItems || []).map(r => {
        const hargaBahan = parseFloat(r.bahan_baku?.estimasi_harga_beli || 0);
        const faktorKonversi = parseFloat(r.bahan_baku?.faktor_konversi || 1);
        const qtyButuh = parseFloat(r.jumlah_dibutuhkan || 0);
        const biayaBahan = (qtyButuh / faktorKonversi) * hargaBahan;
        totalBahanBaku += biayaBahan;
        return {
            nama: r.bahan_baku?.nama || 'Unknown',
            qty: `${qtyButuh} ${r.satuan || r.bahan_baku?.satuan_dasar || ''}`,
            biaya: `Rp ${biayaBahan.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`,
        };
    });

    const overheadKemasan = parseFloat(produk.overhead_kemasan || 0);
    const overheadListrik = parseFloat(produk.overhead_listrik || 0);
    const overheadTK = parseFloat(produk.overhead_tenaga_kerja || 0);
    const overheadLain = parseFloat(produk.overhead_lainnya || 0);
    const totalOverhead = overheadKemasan + overheadListrik + overheadTK + overheadLain;
    const totalHPP = totalBahanBaku + totalOverhead;
    const hargaJual = parseFloat(produk.harga_jual || 0);
    const marginNominal = hargaJual - totalHPP;
    const marginPct = hargaJual > 0 ? ((marginNominal / hargaJual) * 100).toFixed(1) : '0';

    return JSON.stringify({
        produk: produk.nama,
        harga_jual: `Rp ${hargaJual.toLocaleString('id-ID')}`,
        bahan_baku: bahanList,
        total_bahan_baku: `Rp ${totalBahanBaku.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`,
        overhead: {
            kemasan: `Rp ${overheadKemasan.toLocaleString('id-ID')}`,
            listrik: `Rp ${overheadListrik.toLocaleString('id-ID')}`,
            tenaga_kerja: `Rp ${overheadTK.toLocaleString('id-ID')}`,
            lainnya: `Rp ${overheadLain.toLocaleString('id-ID')}`,
            total: `Rp ${totalOverhead.toLocaleString('id-ID')}`,
        },
        total_hpp: `Rp ${totalHPP.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`,
        margin_nominal: `Rp ${marginNominal.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`,
        margin_persen: `${marginPct}%`,
    });
}

// ─── Tool Definitions untuk Gemini ───────────────────────────────────────────
const GEMINI_TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'get_menu_catalog',
                description: 'Mengambil daftar menu produk Lunomi yang aktif dari database. Gunakan saat pelanggan bertanya tentang menu, harga, atau pilihan produk.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        outlet_code: { type: 'STRING', description: 'Kode outlet (misal: CP, BJ, RB). Opsional.' },
                        category: { type: 'STRING', description: 'Filter berdasarkan kategori/tipe produk. Opsional.' },
                    },
                },
            },
            {
                name: 'get_outlet_info',
                description: 'Mengambil informasi outlet Lunomi (alamat, kota, kode). Gunakan saat pelanggan bertanya lokasi atau jam operasional.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        outlet_code: { type: 'STRING', description: 'Kode outlet spesifik. Opsional, jika kosong mengembalikan semua outlet.' },
                    },
                },
            },
            {
                name: 'get_stock_status',
                description: 'Mengecek status stok bahan baku yang tipis atau hampir habis di outlet. Untuk staf internal atau sebelum konfirmasi pesanan.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        outlet_code: { type: 'STRING', description: 'Kode outlet (CP, BJ, RB, dll). Opsional.' },
                    },
                },
            },
            {
                name: 'get_daily_sales',
                description: 'Mengambil ringkasan omset dan jumlah transaksi harian per outlet. Khusus untuk staf/owner internal.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        outlet_code: { type: 'STRING', description: 'Kode outlet. Opsional.' },
                        date: { type: 'STRING', description: 'Tanggal format YYYY-MM-DD. Opsional, default hari ini.' },
                    },
                },
            },
            {
                name: 'get_attendance_today',
                description: 'Mengambil data absensi karyawan hari ini per outlet. Khusus untuk staf/owner internal.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        outlet_code: { type: 'STRING', description: 'Kode outlet. Opsional.' },
                        date: { type: 'STRING', description: 'Tanggal format YYYY-MM-DD. Opsional, default hari ini.' },
                    },
                },
            },
            {
                name: 'get_recipe_hpp',
                description: 'Mengambil resep detail dan kalkulasi HPP (Harga Pokok Produksi) untuk suatu produk. Khusus untuk staf/owner internal.',
                parameters: {
                    type: 'OBJECT',
                    required: ['product_name'],
                    properties: {
                        product_name: { type: 'STRING', description: 'Nama produk yang ingin dicari resepnya.' },
                    },
                },
            },
            {
                name: 'create_wa_order',
                description: 'Menyimpan draft pesanan pelanggan ke database dan akan dikirim notifikasi ke WA Group outlet. Gunakan setelah pelanggan mengonfirmasi pesanan mereka.',
                parameters: {
                    type: 'OBJECT',
                    required: ['customer_name', 'phone_number', 'order_items'],
                    properties: {
                        customer_name: { type: 'STRING', description: 'Nama pelanggan.' },
                        phone_number: { type: 'STRING', description: 'Nomor HP pelanggan.' },
                        outlet_code: { type: 'STRING', description: 'Kode outlet tujuan pesanan.' },
                        order_items: {
                            type: 'ARRAY',
                            description: 'Daftar item pesanan.',
                            items: {
                                type: 'OBJECT',
                                properties: {
                                    nama: { type: 'STRING' },
                                    qty: { type: 'NUMBER' },
                                    harga: { type: 'NUMBER' },
                                    catatan: { type: 'STRING' },
                                },
                            },
                        },
                        total_estimated: { type: 'NUMBER', description: 'Total estimasi harga.' },
                        notes: { type: 'STRING', description: 'Catatan tambahan pesanan.' },
                    },
                },
            },
            {
                name: 'create_complaint',
                description: 'Membuat tiket komplain pelanggan di database, mematikan AI auto-reply selama durasi tertentu agar tim manusia bisa menangani. Gunakan SEGERA saat pelanggan mengungkapkan ketidakpuasan, kecewa, komplain, atau meminta bicara dengan manusia.',
                parameters: {
                    type: 'OBJECT',
                    required: ['phone_number', 'complaint_text'],
                    properties: {
                        phone_number: { type: 'STRING', description: 'Nomor HP pelanggan yang komplain.' },
                        complaint_text: { type: 'STRING', description: 'Ringkasan isi komplain pelanggan.' },
                    },
                },
            },
        ],
    },
];

// ─── Tool OpenAgentic (OpenAI format) ────────────────────────────────────────
const OPENAI_TOOLS = [
    { type: 'function', function: { name: 'get_menu_catalog', description: 'Mengambil daftar menu produk Lunomi yang aktif dari database.', parameters: { type: 'object', properties: { outlet_code: { type: 'string' }, category: { type: 'string' } } } } },
    { type: 'function', function: { name: 'get_outlet_info', description: 'Mengambil informasi outlet Lunomi (alamat, kota, kode).', parameters: { type: 'object', properties: { outlet_code: { type: 'string' } } } } },
    { type: 'function', function: { name: 'get_stock_status', description: 'Mengecek status stok bahan baku yang tipis di outlet.', parameters: { type: 'object', properties: { outlet_code: { type: 'string' } } } } },
    { type: 'function', function: { name: 'get_daily_sales', description: 'Mengambil ringkasan omset dan jumlah transaksi harian per outlet.', parameters: { type: 'object', properties: { outlet_code: { type: 'string' }, date: { type: 'string' } } } } },
    { type: 'function', function: { name: 'get_attendance_today', description: 'Mengambil data absensi karyawan hari ini per outlet.', parameters: { type: 'object', properties: { outlet_code: { type: 'string' }, date: { type: 'string' } } } } },
    { type: 'function', function: { name: 'get_recipe_hpp', description: 'Mengambil resep detail dan kalkulasi HPP untuk suatu produk.', parameters: { type: 'object', required: ['product_name'], properties: { product_name: { type: 'string' } } } } },
    { type: 'function', function: { name: 'create_wa_order', description: 'Menyimpan draft pesanan pelanggan ke database.', parameters: { type: 'object', required: ['customer_name', 'phone_number', 'order_items'], properties: { customer_name: { type: 'string' }, phone_number: { type: 'string' }, outlet_code: { type: 'string' }, order_items: { type: 'array', items: { type: 'object' } }, total_estimated: { type: 'number' }, notes: { type: 'string' } } } } },
    { type: 'function', function: { name: 'create_complaint', description: 'Membuat tiket komplain dan mematikan AI auto-reply sementara.', parameters: { type: 'object', required: ['phone_number', 'complaint_text'], properties: { phone_number: { type: 'string' }, complaint_text: { type: 'string' } } } } },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────
/**
 * Eksekusi function tool berdasarkan nama yang dipanggil AI.
 * @param {string} toolName - nama tool
 * @param {object} toolArgs - argumen dari AI
 * @param {object} sessionContext - { sessionId, phoneNumber }
 * @returns {string} hasil tool sebagai string untuk dikirim kembali ke AI
 */
async function executeTool(toolName, toolArgs, sessionContext, onOrderCreated, onComplaintCreated) {
    console.log(`[AIEngine] Tool call: ${toolName}`, toolArgs);

    switch (toolName) {
        case 'get_menu_catalog':
            return await toolGetMenuCatalog(toolArgs);

        case 'get_outlet_info':
            return await toolGetOutletInfo(toolArgs);

        case 'get_stock_status':
            return await toolGetStockStatus(toolArgs);

        case 'get_daily_sales':
            return await toolGetDailySales(toolArgs);

        case 'get_attendance_today':
            return await toolGetAttendanceToday(toolArgs);

        case 'get_recipe_hpp':
            return await toolGetRecipeHpp(toolArgs);

        case 'create_wa_order': {
            const { saveWaOrder } = require('./waSessionManager');
            const orderData = await saveWaOrder({
                sessionId: sessionContext.sessionId,
                customerName: toolArgs.customer_name,
                phoneNumber: toolArgs.phone_number || sessionContext.phoneNumber,
                outletCode: toolArgs.outlet_code,
                orderItems: toolArgs.order_items,
                totalEstimated: toolArgs.total_estimated,
                notes: toolArgs.notes,
            });
            if (onOrderCreated) onOrderCreated(orderData);
            return JSON.stringify({ success: true, order_id: orderData.id, message: 'Pesanan berhasil dicatat dan notifikasi akan dikirim ke tim outlet.' });
        }

        case 'create_complaint': {
            const { createComplaintTicket } = require('./waSessionManager');
            const ticket = await createComplaintTicket({
                sessionId: sessionContext.sessionId,
                phoneNumber: toolArgs.phone_number || sessionContext.phoneNumber,
                complaintText: toolArgs.complaint_text,
            });
            if (onComplaintCreated) onComplaintCreated(ticket);
            return JSON.stringify({ success: true, ticket_id: ticket.id, message: 'Tiket komplain dibuat. AI auto-reply dimatikan sementara. Tim kami akan segera menghubungi.' });
        }

        default:
            return JSON.stringify({ error: `Tool "${toolName}" tidak dikenali.` });
    }
}

// ─── Gemini Engine ────────────────────────────────────────────────────────────
async function runWithGemini(systemPrompt, contextMessages, userMessage, sessionContext, onOrderCreated, onComplaintCreated) {
    const candidateModels = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
    let lastErr = null;

    for (const modelName of candidateModels) {
        try {
            const model = geminiClient.getGenerativeModel({
                model: modelName,
                systemInstruction: systemPrompt,
                tools: GEMINI_TOOLS,
            });

            // Konversi contextMessages ke format Gemini
            const history = (contextMessages || []).map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            }));

            const chat = model.startChat({ history });

            let result = await chat.sendMessage(userMessage);
            let response = result.response;
            const toolsCalledLog = [];

            // Agentic loop untuk tool calls
            let maxIterations = 5;
            while (maxIterations-- > 0) {
                const functionCalls = response.functionCalls();
                if (!functionCalls || functionCalls.length === 0) break;

                const toolResults = [];
                for (const fc of functionCalls) {
                    toolsCalledLog.push(fc.name);
                    const toolResult = await executeTool(fc.name, fc.args, sessionContext, onOrderCreated, onComplaintCreated);
                    toolResults.push({
                        functionResponse: {
                            name: fc.name,
                            response: { content: toolResult },
                        },
                    });
                }

                result = await chat.sendMessage(toolResults);
                response = result.response;
            }

            const finalText = response.text();
            return {
                text: finalText,
                model: modelName,
                toolsCalled: toolsCalledLog.length > 0 ? toolsCalledLog : null,
                tokensUsed: response.usageMetadata?.totalTokenCount || null,
            };
        } catch (err) {
            console.warn(`[AIEngine] Gemini model ${modelName} note:`, err.message);
            lastErr = err;
        }
    }

    throw lastErr || new Error('All Gemini candidate models failed.');
}

// ─── OpenAgentic (OpenAI-compatible) Fallback Engine ─────────────────────────
async function runWithOpenAgentic(systemPrompt, contextMessages, userMessage, sessionContext, onOrderCreated, onComplaintCreated) {
    const messages = [
        { role: 'system', content: systemPrompt },
        ...(contextMessages || []).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage },
    ];

    const toolsCalledLog = [];
    let maxIterations = 5;

    const targetModel = (openAgenticModel && !openAgenticModel.includes('claude')) ? openAgenticModel : 'deepseek-v4-flash';

    while (maxIterations-- > 0) {
        const response = await fetch(`${openAgenticBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openAgenticApiKey}`,
            },
            body: JSON.stringify({
                model: targetModel,
                messages,
                tools: OPENAI_TOOLS,
                tool_choice: 'auto',
                max_tokens: 1024,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAgentic API error ${response.status}: ${errText}`);
        }

        const rawText = await response.text();
        const jsonText = rawText.split('data:')[0].trim();
        const data = JSON.parse(jsonText);
        const choice = data.choices?.[0];

        if (!choice) throw new Error('OpenAgentic: Response tidak valid (tidak ada choices)');

        const assistantMessage = choice.message;
        messages.push(assistantMessage);

        if (choice.finish_reason === 'tool_calls' && assistantMessage.tool_calls) {
            for (const toolCall of assistantMessage.tool_calls) {
                const toolName = toolCall.function.name;
                let rawArgs = toolCall.function.arguments || '{}';
                rawArgs = rawArgs.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
                if (rawArgs.includes('```json')) {
                    rawArgs = rawArgs.split('```json')[1].split('```')[0].trim();
                } else if (rawArgs.includes('```')) {
                    rawArgs = rawArgs.split('```')[1].split('```')[0].trim();
                }
                let toolArgs = {};
                try {
                    toolArgs = JSON.parse(rawArgs);
                } catch (pErr) {
                    console.warn('[AIEngine] OpenAgentic toolArgs parse note:', pErr.message);
                }

                toolsCalledLog.push(toolName);
                const toolResult = await executeTool(toolName, toolArgs, sessionContext, onOrderCreated, onComplaintCreated);
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: toolResult,
                });
            }
            continue; // Loop lagi dengan tool results
        }

        // Respon final
        const finalText = assistantMessage.content || '';
        const tokensUsed = data.usage?.total_tokens || null;
        return {
            text: finalText,
            model: openAgenticModel,
            toolsCalled: toolsCalledLog.length > 0 ? toolsCalledLog : null,
            tokensUsed,
        };
    }

    throw new Error('OpenAgentic: Terlalu banyak iterasi tool calling tanpa respon final.');
}

// ─── Main Process Message ─────────────────────────────────────────────────────
/**
 * Proses pesan dari pengguna melalui AI engine.
 * @param {object} params
 * @param {string} params.userMessage - teks pesan pengguna
 * @param {object} params.session - objek sesi dari wa_chat_sessions
 * @param {string} params.karyawanNama - nama karyawan jika role staff
 * @param {function} params.onOrderCreated - callback saat pesanan dibuat
 * @param {function} params.onComplaintCreated - callback saat tiket komplain dibuat
 * @returns {{ text: string, model: string, toolsCalled: string[]|null, tokensUsed: number|null }}
 */
async function processMessage({ userMessage, session, karyawanNama, onOrderCreated, onComplaintCreated }) {
    const systemPrompt = await buildSystemPrompt(session.user_role, karyawanNama);
    const contextMessages = session.context_messages || [];
    const sessionContext = { sessionId: session.id, phoneNumber: session.phone_number };

    // 1. Coba OpenAgentic (DeepSeek V4 Flash) terlebih dahulu karena stabil & terverifikasi
    if (openAgenticApiKey) {
        try {
            return await runWithOpenAgentic(systemPrompt, contextMessages, userMessage, sessionContext, onOrderCreated, onComplaintCreated);
        } catch (openAgenticErr) {
            console.error('[AIEngine] OpenAgentic error, mencoba fallback ke Gemini:', openAgenticErr.message);
        }
    }

    // 2. Fallback ke Gemini
    if (geminiClient) {
        try {
            return await runWithGemini(systemPrompt, contextMessages, userMessage, sessionContext, onOrderCreated, onComplaintCreated);
        } catch (geminiErr) {
            console.error('[AIEngine] Gemini error:', geminiErr.message);
        }
    }

    throw new Error('Tidak ada AI engine yang tersedia. Periksa OPENAI_API_KEY atau GOOGLE_GENERATIVE_AI_API_KEY.');
}

module.exports = {
    processMessage,
    buildSystemPrompt,
};
