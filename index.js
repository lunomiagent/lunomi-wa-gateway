const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

let sock = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
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
            console.log('Silakan SCAN Barcode ini menggunakan WhatsApp (Linked Devices)');
            qrcode.generate(qr, { small: true });
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

        // Format nomor agar sesuai dengan standar WhatsApp (628xxx@s.whatsapp.net)
        let formattedTarget = target.replace(/[^0-9]/g, '');
        if (formattedTarget.startsWith('0')) {
            formattedTarget = '62' + formattedTarget.substring(1);
        }
        formattedTarget = formattedTarget + '@s.whatsapp.net';

        // Kirim pesan
        await sock.sendMessage(formattedTarget, { text: message });
        
        console.log(`[WA Gateway] Pesan terkirim ke ${target}`);
        return res.status(200).json({ success: true, message: `Berhasil mengirim ke ${target}` });

    } catch (error) {
        console.error('[WA Gateway Error]', error);
        return res.status(500).json({ error: error.message });
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
