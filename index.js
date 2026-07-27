const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const useSupabaseAuthState = require('./useSupabaseAuth');
const sessionManager = require('./waSessionManager');
const aiEngine = require('./aiEngine');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn("⚠️ PERINGATAN: SUPABASE_URL atau SUPABASE_KEY belum disetel. Pastikan untuk menambahkannya di Render!");
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

let sock = null;
let isConnected = false;
let currentQR = null;

// ─── Helper: Format Nomor WA ─────────────────────────────────────────────────
function formatWaNumber(target) {
    if (!target) return null;
    if (target.endsWith('@g.us') || target.endsWith('@s.whatsapp.net')) return target.trim();
    let digits = target.replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = '62' + digits.substring(1);
    return digits + '@s.whatsapp.net';
}

// ─── Helper: Kirim Pesan ke Group Notifikasi ─────────────────────────────────
async function sendGroupNotification(text) {
    if (!isConnected || !sock) {
        console.warn('[Notif] WA belum terhubung, tidak bisa kirim notifikasi group.');
        return;
    }
    try {
        const groupJid = await sessionManager.getNotificationGroupJid();
        if (!groupJid) {
            console.warn('[Notif] notification_group JID belum diatur di wa_settings.');
            return;
        }
        await sock.sendMessage(groupJid, { text });
        console.log('[Notif] Pesan notifikasi dikirim ke group:', groupJid);
    } catch (err) {
        console.error('[Notif] Gagal kirim notifikasi group:', err.message);
    }
}

// ─── Format Pesan Order ke Group ─────────────────────────────────────────────
function formatOrderNotification(order) {
    const items = (order.order_items || []).map(item => {
        const catatan = item.catatan ? ` _(${item.catatan})_` : '';
        const harga = item.harga ? ` - Rp ${Number(item.harga).toLocaleString('id-ID')}` : '';
        return `- ${item.qty || 1}x ${item.nama}${harga}${catatan}`;
    }).join('\n');

    const total = order.total_estimated
        ? `Rp ${Number(order.total_estimated).toLocaleString('id-ID')}`
        : 'Belum dikalkulasi';

    return `🔔 *PESANAN BARU VIA CS WA AI*\n` +
        `----------------------------------------\n` +
        `👤 *Pelanggan*: ${order.customer_name}\n` +
        `📱 *No HP*: ${order.phone_number}\n` +
        `📍 *Outlet Target*: ${order.outlet_code || 'Belum dipilih'}\n\n` +
        `🛒 *Rincian Pesanan*:\n${items || '-'}\n\n` +
        (order.notes ? `📝 *Catatan*: ${order.notes}\n` : '') +
        `💰 *Estimasi Total*: ${total}\n\n` +
        `⚠️ *Status*: Draft Pesanan (Mohon Kasir Hubungi/Konfirmasi Pembayaran)`;
}

// ─── Format Pesan Komplain ke Group ──────────────────────────────────────────
function formatComplaintNotification(ticket, phoneNumber) {
    const waktu = new Date().toLocaleString('id-ID', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Asia/Jakarta',
    });
    return `🚨 *ALERT KOMPLAIN PELANGGAN (AI PAUSED)*\n` +
        `----------------------------------------\n` +
        `👤 *Pelanggan*: ${phoneNumber}\n` +
        `⏰ *Waktu*: ${waktu} WIB\n\n` +
        `💬 *Isi Komplain*: "${ticket.complaint_text}"\n\n` +
        `⚠️ *Status System*: AI Auto-Reply TELAH DIMATIKAN sementara.\n` +
        `👉 *Mohon Tim CS / Kasir segera buka chat nomor ini & bantu selesaikan!*`;
}

// ─── AI Message Handler (Private Chat Only) ───────────────────────────────────
async function handleIncomingMessage(msg) {
    const jid = msg.key?.remoteJid;

    // Filter: hanya private chat, bukan pesan dari bot sendiri
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;
    if (msg.key?.fromMe) return;

    // Ekstrak teks pesan
    const messageText = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';

    if (!messageText.trim()) return;

    const phoneNumber = sessionManager.normalizePhone(jid);
    console.log(`[CS-AI] Pesan masuk dari ${phoneNumber}: "${messageText.substring(0, 80)}..."`);

    try {
        // Ambil/buat sesi
        const session = await sessionManager.getOrCreateSession(phoneNumber);

        // Catat pesan masuk ke audit log
        await sessionManager.logMessage({
            sessionId: session.id,
            phoneNumber,
            direction: 'inbound',
            messageText,
        });

        // Cek apakah AI sedang di-pause (human takeover aktif)
        const paused = await sessionManager.isAiPaused(session);
        if (paused) {
            console.log(`[CS-AI] AI paused untuk ${phoneNumber}. Pesan diabaikan (human handling).`);
            return;
        }

        // Cek apakah AI secara global diaktifkan
        const aiEnabled = await sessionManager.isAiGloballyEnabled();
        if (!aiEnabled) {
            console.log(`[CS-AI] AI globally disabled. Pesan dari ${phoneNumber} diabaikan.`);
            return;
        }

        // Tandai "typing..." (mengetik indicator)
        await sock.sendPresenceUpdate('composing', jid);

        // Ambil nama karyawan jika role staff
        let karyawanNama = null;
        if (session.karyawan_id) {
            const { data: karyawan } = await supabase
                .from('karyawan')
                .select('nama')
                .eq('karyawan_id', session.karyawan_id)
                .single();
            karyawanNama = karyawan?.nama || null;
        }

        // Proses dengan AI Engine
        let aiResult;
        try {
            aiResult = await aiEngine.processMessage({
                userMessage: messageText,
                session: { ...session, context_messages: session.context_messages || [] },
                karyawanNama,
                onOrderCreated: async (orderData) => {
                    // Kirim notifikasi order ke WA Group
                    const notifText = formatOrderNotification(orderData);
                    await sendGroupNotification(notifText);
                    await sessionManager.markOrderNotified(orderData.id);
                },
                onComplaintCreated: async (ticketData) => {
                    // Kirim alert komplain ke WA Group
                    const alertText = formatComplaintNotification(ticketData, phoneNumber);
                    await sendGroupNotification(alertText);
                },
            });
        } catch (aiErr) {
            console.error('[CS-AI] AI Engine error:', aiErr.message);
            // Fallback response jika AI error total
            const fallbackText = 'Mohon maaf Kak, sistem kami sedang memproses data. Tim kasir kami akan segera membantu Kakak ya! 🙏';
            await sock.sendMessage(jid, { text: fallbackText });
            await sessionManager.logMessage({
                sessionId: session.id,
                phoneNumber,
                direction: 'outbound',
                messageText: fallbackText,
                errorInfo: aiErr.message,
            });
            return;
        }

        // Hentikan typing indicator
        await sock.sendPresenceUpdate('paused', jid);

        // Kirim balasan AI
        const replyText = aiResult.text || 'Maaf Kak, ada gangguan sementara. Coba lagi ya! 🙏';
        await sock.sendMessage(jid, { text: replyText });

        // Update context messages
        const updatedContext = await sessionManager.updateContextMessages(
            session.id,
            session.context_messages,
            { role: 'user', content: messageText }
        );
        await sessionManager.updateContextMessages(
            session.id,
            updatedContext,
            { role: 'assistant', content: replyText }
        );

        // Catat balasan ke audit log
        await sessionManager.logMessage({
            sessionId: session.id,
            phoneNumber,
            direction: 'outbound',
            messageText: replyText,
            aiModel: aiResult.model,
            toolsCalled: aiResult.toolsCalled,
            tokensUsed: aiResult.tokensUsed,
        });

        console.log(`[CS-AI] Balasan dikirim ke ${phoneNumber} (model: ${aiResult.model}, tools: ${aiResult.toolsCalled?.join(', ') || 'none'})`);

    } catch (err) {
        console.error(`[CS-AI] Unexpected error handling message from ${phoneNumber}:`, err.message);
    }
}

// ─── Connect to WhatsApp ──────────────────────────────────────────────────────
async function connectToWhatsApp() {
    const { state, saveCreds, clearSession } = await useSupabaseAuthState(supabase);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA] Memakai versi v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "121.0.0.0"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 30000,
        options: {
            timeout: 60000
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = qr;
            console.log('\n============== PERHATIAN ==============');
            console.log('Barcode di layar ini terpotong oleh tulisan jam dari Render.');
            console.log('Silakan BUKA / KLIK LINK di bawah ini untuk melihat Barcode secara utuh:');
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
            console.log('=======================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus karena:', lastDisconnect?.error, ', mencoba reconnect:', shouldReconnect);
            isConnected = false;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('Anda sudah LOGOUT. Membersihkan sesi dari database...');
                clearSession().then(() => {
                    console.log('Sesi dibersihkan. Memulai ulang gateway untuk mendapat QR baru...');
                    connectToWhatsApp();
                });
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;

            console.log('\n✅ BERHASIL TERHUBUNG KE WHATSAPP SERVER META!');
            console.log('[CS-AI] AI Agent CS Mode: AKTIF');
            try {
                const jid = await sock.groupAcceptInvite('F2X9YMfgPn4D7rjhjZjRv3');
                console.log('[WA Gateway] Joined group via invite code:', jid);
            } catch (err) {
                console.log('[WA Gateway Group Join Check]:', err.message);
            }
        }
    });

    // ─── LISTENER PESAN MASUK (CS AI) ────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Hanya proses tipe 'notify' (pesan masuk real-time)
        if (type !== 'notify') return;
        for (const msg of messages) {
            // Proses tiap pesan secara async, tidak blocking satu sama lain
            handleIncomingMessage(msg).catch(err => {
                console.error('[CS-AI] Uncaught error in handleIncomingMessage:', err.message);
            });
        }
    });
}

// Helper for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Endpoint: Send (existing, preserved) ────────────────────────────────────
app.post('/send', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(503).json({ error: 'WhatsApp Gateway belum siap / belum scan QR' });
        }

        const { target, message, imageUrl } = req.body;
        
        if (!target || (!message && !imageUrl)) {
            return res.status(400).json({ error: 'Target dan konten (Message atau Image) tidak boleh kosong' });
        }

        let formattedTarget;
        if (target.includes('chat.whatsapp.com/')) {
            const code = target.split('chat.whatsapp.com/')[1].split('/')[0].split('?')[0].trim();
            try {
                const joinedJid = await sock.groupAcceptInvite(code);
                formattedTarget = joinedJid || '120363422372098957@g.us';
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.log('[WA Gateway Group Join Note]:', err.message);
                try {
                    const info = await sock.groupGetInviteInfo(code);
                    formattedTarget = info.id;
                } catch (e) {
                    formattedTarget = '120363422372098957@g.us';
                }
            }
        } else if (target.endsWith('@g.us')) {
            formattedTarget = target.trim();
        } else {
            let digits = target.replace(/[^0-9]/g, '');
            if (digits.startsWith('0')) {
                digits = '62' + digits.substring(1);
            }
            formattedTarget = digits + '@s.whatsapp.net';
        }

        if (formattedTarget.endsWith('@g.us')) {
            try {
                await sock.groupMetadata(formattedTarget);
            } catch (e) {
                console.log('[WA Gateway Group Metadata Note]:', e.message);
            }
        }

        let sentMsg;
        if (imageUrl) {
            sentMsg = await sock.sendMessage(formattedTarget, { 
                image: { url: imageUrl }, 
                caption: message || '' 
            });
        } else {
            sentMsg = await sock.sendMessage(formattedTarget, { text: message });
        }
        
        console.log(`[WA Gateway] Pesan terkirim ke ${target}`, sentMsg?.key);
        return res.status(200).json({ success: true, message: `Berhasil mengirim ke ${target}`, key: sentMsg?.key });

    } catch (error) {
        console.error('[WA Gateway Error]', error);
        return res.status(500).json({ error: error.message });
    }
});

// ─── Endpoint: Broadcast (existing, preserved) ───────────────────────────────
app.post('/broadcast', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(503).json({ error: 'WhatsApp Gateway belum siap / belum scan QR' });
        }

        const { targets, message } = req.body;
        
        if (!targets || !Array.isArray(targets) || targets.length === 0 || !message) {
            return res.status(400).json({ error: 'Targets (array) atau Message tidak valid' });
        }

        res.status(202).json({ success: true, message: `Menerima ${targets.length} nomor untuk antrean broadcast.` });

        console.log(`[WA Gateway] Memulai broadcast ke ${targets.length} nomor...`);
        for (let i = 0; i < targets.length; i++) {
            try {
                let target = targets[i];
                let formattedTarget = target.replace(/[^0-9]/g, '');
                if (formattedTarget.startsWith('0')) {
                    formattedTarget = '62' + formattedTarget.substring(1);
                }
                formattedTarget = formattedTarget + '@s.whatsapp.net';

                await sock.sendMessage(formattedTarget, { text: message });
                console.log(`[WA Gateway Broadcast] ${i+1}/${targets.length} Terkirim ke ${target}`);

                if (i < targets.length - 1) {
                    const randomDelay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
                    console.log(`[WA Gateway Broadcast] Jeda ${randomDelay}ms...`);
                    await delay(randomDelay);
                }
            } catch (err) {
                console.error(`[WA Gateway Broadcast] Gagal mengirim ke ${targets[i]}:`, err.message);
            }
        }
        console.log(`[WA Gateway] Broadcast SELESAI.`);
    } catch (error) {
        console.error('[WA Gateway Broadcast Error]', error);
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

// ─── Admin Endpoints: Pause / Resume AI ──────────────────────────────────────
/**
 * POST /api/wa/pause
 * Body: { phoneNumber: "628xxx", durationMinutes: 60 }
 * Matikan AI untuk nomor tertentu (manual override CS/kasir)
 */
app.post('/api/wa/pause', async (req, res) => {
    try {
        const { phoneNumber, durationMinutes } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber wajib diisi' });

        const session = await sessionManager.getOrCreateSession(phoneNumber);
        if (!session.id) return res.status(404).json({ error: 'Sesi tidak ditemukan untuk nomor ini' });

        await sessionManager.setAiPaused(session.id, durationMinutes || 60);
        return res.json({ success: true, message: `AI di-pause untuk ${phoneNumber} selama ${durationMinutes || 60} menit.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/wa/resume
 * Body: { phoneNumber: "628xxx" }
 * Hidupkan kembali AI untuk nomor tertentu (setelah CS manusia selesai)
 */
app.post('/api/wa/resume', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber wajib diisi' });

        const { error } = await supabase
            .from('wa_chat_sessions')
            .update({ ai_paused: false, paused_until: null })
            .eq('phone_number', phoneNumber);

        if (error) throw error;
        return res.json({ success: true, message: `AI di-resume untuk ${phoneNumber}.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/wa/settings
 * Body: { key: "notification_group", value: { jid: "120363xxx@g.us", name: "..." } }
 * Update wa_settings (misalnya Group JID notifikasi)
 */
app.post('/api/wa/settings', async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key || value === undefined) return res.status(400).json({ error: 'key dan value wajib diisi' });

        const { error } = await supabase
            .from('wa_settings')
            .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

        if (error) throw error;
        return res.json({ success: true, message: `Setting "${key}" berhasil diupdate.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/wa/settings
 * Ambil semua wa_settings
 */
app.get('/api/wa/settings', async (req, res) => {
    try {
        const { data, error } = await supabase.from('wa_settings').select('*').order('key');
        if (error) throw error;
        return res.json({ success: true, settings: data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/wa/sessions
 * Daftar sesi chat aktif (untuk monitoring CS)
 */
app.get('/api/wa/sessions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wa_chat_sessions')
            .select('id, phone_number, user_role, ai_paused, paused_until, last_message_at, created_at')
            .order('last_message_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        return res.json({ success: true, sessions: data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── Status & QR Endpoints ────────────────────────────────────────────────────
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding: 40px;">
                <h2 style="color: #10b981;">✅ WhatsApp Gateway ONLINE & Terhubung!</h2>
                <p>Status: Active & Ready to send messages</p>
                <p style="color: #6b7280;">CS AI Mode: <strong style="color: #10b981;">AKTIF</strong></p>
            </div>
        `);
    }
    if (!currentQR) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding: 40px;">
                <h2>⏳ Memuat QR Code WhatsApp...</h2>
                <p>Silakan refresh halaman ini dalam beberapa detik.</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </div>
        `);
    }
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(currentQR)}`;
    return res.send(`
        <div style="text-align: center; font-family: sans-serif; padding: 40px;">
            <h2>📱 Scan QR Code WhatsApp Gateway</h2>
            <p>Buka WhatsApp di HP ➔ Perangkat Tertaut (Linked Devices) ➔ Tautkan Perangkat</p>
            <img src="${qrImageUrl}" alt="QR Code WhatsApp Gateway" style="border: 4px solid #10b981; border-radius: 12px; padding: 12px; margin: 15px 0;" />
            <p style="color: #666; margin-top: 10px;">Halaman ini akan otomatis me-refresh jika terhubung.</p>
            <script>setTimeout(() => location.reload(), 4000);</script>
        </div>
    `);
});

app.get('/status', (req, res) => {
    res.json({ isConnected, hasQR: !!currentQR, aiMode: 'hybrid-gemini-openagentic' });
});

app.get('/', (req, res) => {
    if (isConnected) {
        res.send('Lunomi WA Gateway is ONLINE | CS AI Mode: AKTIF');
    } else {
        res.redirect('/qr');
    }
});

// --- Master Cron Scheduler ---
const cron = require('node-cron');
const VERCEL_CRON_SECRET = process.env.CRON_SECRET || 'lunomi_cron_secret_2026';

// 1. Cron Laporan Harian (Setiap Hari jam 17:00 WIB)
cron.schedule('0 17 * * *', async () => {
    console.log('[CRON] Memicu Laporan Harian ke Vercel...');
    try {
        const res = await fetch(`https://lunomi-web.vercel.app/api/cron/daily-report?secret=${VERCEL_CRON_SECRET}`);
        const text = await res.text();
        console.log('[CRON] Hasil Laporan Harian:', text);
    } catch (e) {
        console.error('[CRON Error]', e.message);
    }
}, { scheduled: true, timezone: "Asia/Jakarta" });

// 2. Cron Automations Engine (Setiap Jam pada menit 00)
cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Memicu Automations Canvas Engine ke Vercel...');
    try {
        const res = await fetch(`https://lunomi-web.vercel.app/api/cron/automations?secret=${VERCEL_CRON_SECRET}`);
        const text = await res.text();
        console.log('[CRON] Hasil Automations Engine:', text);
    } catch (e) {
        console.error('[CRON Error]', e.message);
    }
}, { scheduled: true, timezone: "Asia/Jakarta" });

// Mulai API Server
app.listen(PORT, () => {
    console.log(`🚀 WA Gateway API berjalan di http://localhost:${PORT}`);
    console.log(`🤖 CS AI Engine: Gemini 2.5 Flash (Primary) + OpenAgentic Claude (Fallback)`);
    connectToWhatsApp();
});