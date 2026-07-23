const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const useSupabaseAuthState = require('./useSupabaseAuth');

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

async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState(supabase);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA] Memakai versi v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "121.0.0.0"], // Menyamar sebagai Chrome di Mac untuk menghindari blokir
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
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
                connectToWhatsApp();
            } else {
                console.log('Anda sudah LOGOUT. Silakan hapus folder auth_info_baileys dan restart.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('\n✅ BERHASIL TERHUBUNG KE WHATSAPP SERVER META!');
            try {
                const jid = await sock.groupAcceptInvite('F2X9YMfgPn4D7rjhjZjRv3');
                console.log('[WA Gateway] Joined group via invite code:', jid);
            } catch (err) {
                console.log('[WA Gateway Group Join Check]:', err.message);
            }
        }
    });
}

// Endpoint untuk menerima laporan
app.post('/send', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(503).json({ error: 'WhatsApp Gateway belum siap / belum scan QR' });
        }

        const { target, message } = req.body;
        
        if (!target || !message) {
            return res.status(400).json({ error: 'Target atau Message tidak boleh kosong' });
        }

        // Format nomor / grup ID agar sesuai dengan standar WhatsApp
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

        // Kirim pesan
        const sentMsg = await sock.sendMessage(formattedTarget, { text: message });
        
        console.log(`[WA Gateway] Pesan terkirim ke ${target}`, sentMsg?.key);
        return res.status(200).json({ success: true, message: `Berhasil mengirim ke ${target}`, key: sentMsg?.key });


    } catch (error) {
        console.error('[WA Gateway Error]', error);
        return res.status(500).json({ error: error.message });
    }
});

// Helper for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Endpoint untuk BROADCAST (CRM)
app.post('/broadcast', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(503).json({ error: 'WhatsApp Gateway belum siap / belum scan QR' });
        }

        const { targets, message } = req.body;
        
        if (!targets || !Array.isArray(targets) || targets.length === 0 || !message) {
            return res.status(400).json({ error: 'Targets (array) atau Message tidak valid' });
        }

        // Respond immediately so we don't hold the HTTP connection
        res.status(202).json({ success: true, message: `Menerima ${targets.length} nomor untuk antrean broadcast.` });

        // Process in background
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

                // Jeda acak antara 5-10 detik (5000 - 10000 ms) agar aman dari blokir SPAM Meta
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

// Endpoint untuk status/ping (berguna untuk Render Healthcheck)
app.get('/', (req, res) => {
    res.send(isConnected ? 'Lunomi WA Gateway is ONLINE' : 'Lunomi WA Gateway is WAITING FOR QR SCAN');
});

// Mulai API Server
app.listen(PORT, () => {
    console.log(`🚀 WA Gateway API berjalan di http://localhost:${PORT}`);
    // Mulai koneksi ke WhatsApp
    connectToWhatsApp();
});