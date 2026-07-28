const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const useSupabaseAuthState = require('./useSupabaseAuth');
const sessionManager = require('./waSessionManager');
const aiEngine = require('./aiEngine');

const cors = require('cors');

const app = express();
app.use(cors());
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

    // Filter: hanya private chat
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;

    // Ekstrak teks pesan
    let messageText = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';

    if (!messageText.trim()) return;

    // Ekstrak real phone JID & nomor HP di paling atas (mencegah ReferenceError TDZ)
    const realJid = msg.key?.remoteJidAlt || msg.key?.participantAlt || msg.key?.remoteJid;
    const phoneNumber = sessionManager.normalizePhone(realJid || jid);

    // Handle pesan dari akun WhatsApp sendiri (fromMe = true)
    if (msg.key?.fromMe) {
        const lower = messageText.trim().toLowerCase();
        const isSelfTest = lower.startsWith('!test') || lower.startsWith('[test]') || lower.startsWith('test');
        if (!isSelfTest) {
            // Tim Kasir mengetik balasan manual dari HP -> AI otomatis pause secara hening (silent pause)
            const session = await sessionManager.getOrCreateSession(phoneNumber);
            await sessionManager.setAiPaused(session.id, 60);
            console.log(`[CS-AI] Kasir membalas manual dari HP. AI otomatis paused (60m) untuk ${phoneNumber}.`);
            return;
        }

        // Bersihkan prefix test agar AI menjawab pertanyaan utama dengan natural
        messageText = messageText.replace(/^(!test|\[test\]|test)\s*/i, '').trim() || messageText;
    }
    
    // Resolusi target JID balasan: Utamakan 628xxx@s.whatsapp.net / remoteJidAlt agar pesan dipastikan masuk ke HP pembeli
    const resolveTargetJid = () => {
        if (realJid && realJid.endsWith('@s.whatsapp.net')) return realJid;
        if (jid && jid.endsWith('@s.whatsapp.net')) return jid;
        if (phoneNumber) {
            let digits = phoneNumber.replace(/[^0-9]/g, '');
            if (digits.startsWith('0')) digits = '62' + digits.substring(1);
            if (digits.startsWith('62') && digits.length >= 10 && digits.length <= 15) {
                return digits + '@s.whatsapp.net';
            }
        }
        return jid;
    };
    const targetSendJid = resolveTargetJid();

    // Helper aman pengiriman pesan WhatsApp dengan quoted context & fallback
    const safeSendReply = async (textToSend) => {
        try {
            return await sock.sendMessage(targetSendJid, { text: textToSend }, { quoted: msg });
        } catch (primaryErr) {
            console.error(`[CS-AI] Primary sendMessage gagal ke ${targetSendJid}:`, primaryErr.message);
            if (jid && jid !== targetSendJid) {
                try {
                    return await sock.sendMessage(jid, { text: textToSend }, { quoted: msg });
                } catch (fallbackErr) {
                    console.error(`[CS-AI] Fallback sendMessage ke ${jid} juga gagal:`, fallbackErr.message);
                    throw fallbackErr;
                }
            }
            throw primaryErr;
        }
    };

    console.log(`[CS-AI] Pesan masuk dari ${phoneNumber} (JID: ${targetSendJid}): "${messageText.substring(0, 80)}..."`);

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

        // Deteksi secara natural jika pelanggan ingin bicara dengan kasir / manusia
        const lowerMsg = messageText.trim().toLowerCase();
        const isKasirRequest = lowerMsg.includes('kasir') || lowerMsg.includes('admin') || lowerMsg.includes('manusia') || lowerMsg.includes('hubungi mas') || lowerMsg.includes('hubungi mba') || lowerMsg.includes('bicara langsung') || lowerMsg.includes('stop ai') || lowerMsg === '!kasir' || lowerMsg === '!stop';

        if (isKasirRequest) {
            const pauseMinutes = await sessionManager.getPauseDurationMinutes();
            await sessionManager.setAiPaused(session.id, pauseMinutes);
            
            // Balasan hangat dan sangat natural seperti manusia (tanpa kode command kaku)
            const replyMsg = `Boleh banget Kak! Sebentar ya, aku panggilkan tim kasir kita yang lagi jaga di toko buat lanjut ngobrol langsung sama Kakak di sini 😊`;
            await safeSendReply(replyMsg);

            // Ambil nama pelanggan jika terdaftar
            const custName = await sessionManager.getCustomerName(phoneNumber);
            const customerDisplay = custName ? `*${custName}* (${phoneNumber})` : phoneNumber;

            const alertText = `🔔 *KASIR HANDOVER ALERT*\n----------------------------------------\n📱 *Pelanggan*: ${customerDisplay}\n💬 *Pesan*: "${messageText}"\n⚠️ *Status*: Pelanggan ingin chat langsung dengan Kasir/Admin. AI telah di-pause (${pauseMinutes}m). Mohon tim kasir lanjut jawab di WA ini!`;
            await sendGroupNotification(alertText);
            return;
        }

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
        try { await sock.sendPresenceUpdate('composing', targetSendJid); } catch (_) {}

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
            try { await safeSendReply(fallbackText); } catch (_) {}
            await sessionManager.logMessage({
                sessionId: session.id,
                phoneNumber,
                direction: 'outbound',
                messageText: fallbackText,
                errorInfo: aiErr.message,
            });
            return;
        }

        const replyText = aiResult.text || 'Maaf Kak, ada gangguan sementara. Coba lagi ya! 🙏';
        
        // Simulasi waktu mengetik alami manusia (1.2 - 2.5 detik)
        const typingDelayMs = Math.min(2500, Math.max(1200, replyText.length * 12));
        await delay(typingDelayMs);

        // Hentikan typing indicator & kirim balasan AI
        try { await sock.sendPresenceUpdate('paused', targetSendJid); } catch (_) {}
        
        // Kirim balasan aman ke WhatsApp pelanggan
        let deliveryError = null;
        try {
            await safeSendReply(replyText);
        } catch (sendErr) {
            deliveryError = sendErr.message || 'Gagal mengirim ke socket WA';
        }

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
            tokensUsed: aiResult.tokensUsed,
            toolsCalled: aiResult.toolsCalled,
            errorInfo: deliveryError,
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
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const isConflict = statusCode === 440 || lastDisconnect?.error?.message?.includes('conflict');

            if (isConflict) {
                console.log('[WA Gateway] Terdeteksi Session Conflict / Dual Deployment (statusCode 440). Menunggu instance lain termination (5s)...');
            } else {
                console.log('Koneksi terputus karena:', lastDisconnect?.error?.message || lastDisconnect?.error, ', mencoba reconnect:', shouldReconnect);
            }

            isConnected = false;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, isConflict ? 5000 : 3000);
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

            // Auto-join group notifikasi dari wa_settings (flexible, tidak hardcode)
            try {
                const inviteCode = await sessionManager.getGroupInviteCode();
                if (inviteCode) {
                    const jid = await sock.groupAcceptInvite(inviteCode);
                    console.log('[WA Gateway] Joined group via invite code dari wa_settings:', jid);

                    // Simpan JID hasil join ke wa_settings.notification_group secara otomatis
                    if (jid) {
                        await supabase
                            .from('wa_settings')
                            .upsert(
                                { key: 'notification_group', value: { jid, name: 'WA Notif Outlet (auto-joined)' }, updated_at: new Date().toISOString() },
                                { onConflict: 'key' }
                            );
                        console.log('[WA Gateway] Notification group JID otomatis tersimpan:', jid);
                    }
                } else {
                    console.log('[WA Gateway] group_invite_code belum diatur di wa_settings. Lewati auto-join.');
                    console.log('[WA Gateway] Set via: POST /api/wa/settings { key: "group_invite_code", value: "INVITE_CODE" }');
                }
            } catch (err) {
                console.log('[WA Gateway Group Join Check]:', err.message);
            }
        }
    });

    // ─── LISTENER PESAN MASUK (CS AI) ────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Proses pesan real-time ('notify') maupun pesan self-chat ('append')
        for (const msg of messages) {
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
                if (joinedJid) {
                    formattedTarget = joinedJid;
                } else {
                    // Fallback: ambil dari wa_settings, bukan hardcode
                    formattedTarget = (await sessionManager.getNotificationGroupJid()) || null;
                    if (!formattedTarget) throw new Error('Gagal join group dan notification_group JID belum dikonfigurasi di wa_settings');
                }
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.log('[WA Gateway Group Join Note]:', err.message);
                try {
                    const info = await sock.groupGetInviteInfo(code);
                    formattedTarget = info.id;
                } catch (e) {
                    // Fallback terakhir: ambil dari wa_settings
                    formattedTarget = (await sessionManager.getNotificationGroupJid()) || null;
                    if (!formattedTarget) {
                        return res.status(400).json({ error: 'Tidak dapat menentukan target group. Pastikan group_invite_code dan notification_group sudah diatur di wa_settings.' });
                    }
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

/**
 * POST /api/wa/join-group
 * Trigger manual join WA Group via invite code dari wa_settings atau dari body.
 * Body opsional: { inviteCode: "ABCD1234" }
 * Setelah join, JID otomatis tersimpan ke wa_settings.notification_group.
 */
app.post('/api/wa/join-group', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(503).json({ error: 'WhatsApp Gateway belum terhubung. Scan QR terlebih dahulu.' });
        }

        // Prioritas: dari body request, lalu dari wa_settings
        let inviteCode = req.body?.inviteCode?.trim() || null;
        if (!inviteCode) {
            inviteCode = await sessionManager.getGroupInviteCode();
        }

        if (!inviteCode) {
            return res.status(400).json({
                error: 'Invite code tidak ditemukan. Set via body { inviteCode: "CODE" } atau via POST /api/wa/settings { key: "group_invite_code", value: "CODE" }',
            });
        }

        // Bersihkan jika URL lengkap dimasukkan
        if (inviteCode.includes('chat.whatsapp.com/')) {
            inviteCode = inviteCode.split('chat.whatsapp.com/')[1].split('/')[0].split('?')[0].trim();
        }

        const jid = await sock.groupAcceptInvite(inviteCode);
        if (!jid) {
            return res.status(400).json({ error: 'Gagal join group. Periksa invite code dan pastikan akun WA belum ada di group.' });
        }

        // Simpan JID ke wa_settings.notification_group
        const { error: upsertErr } = await supabase
            .from('wa_settings')
            .upsert(
                { key: 'notification_group', value: { jid, name: 'WA Notif Outlet' }, updated_at: new Date().toISOString() },
                { onConflict: 'key' }
            );

        if (upsertErr) throw upsertErr;

        console.log(`[WA Gateway] Manual join group sukses. JID: ${jid}`);
        return res.json({
            success: true,
            message: `Berhasil join group. JID tersimpan sebagai notification_group.`,
            jid,
        });
    } catch (err) {
        console.error('[WA Gateway] /api/wa/join-group error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});


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

app.post('/api/wa/test-ai', async (req, res) => {
    try {
        const { message, phoneNumber } = req.body;
        if (!message) return res.status(400).json({ error: 'message wajib diisi' });
        const targetPhone = phoneNumber || '6280000000000';
        const session = await sessionManager.getOrCreateSession(targetPhone);
        const result = await aiEngine.processMessage({
            messageText: message,
            phoneNumber: targetPhone,
            userRole: session.user_role || 'customer',
            contextMessages: session.context_messages || [],
        });
        return res.json({ success: true, response: result });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
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