const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const { loadBaileys } = require('./baileysRuntime');
const useSupabaseAuthState = require('./useSupabaseAuth');
const sessionManager = require('./waSessionManager');
const aiEngine = require('./aiEngine');
const { sendReplyToInboundChat } = require('./waReplyDelivery');
const {
    createDeliveryTracker,
    describeReachoutTimeLock,
} = require('./deliveryTracker');
const { resolveEffectiveUserRole } = require('./orderPolicy');
const {
    detectBusinessCommitmentRisk,
    formatBusinessCommitmentNotification,
} = require('./notificationPolicy');

const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const authenticateToken = (req, res, next) => {
    const requiredToken = process.env.WA_GATEWAY_API_TOKEN;
    if (!requiredToken) {
        return next();
    }
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.startsWith('Bearer '))
        ? authHeader.substring(7)
        : (req.headers['x-api-token'] || req.query.token);

    if (token === requiredToken) {
        return next();
    }
    console.warn(`[WA Gateway Security] Unauthorized request attempt to ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing WA Gateway API token' });
};

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
let reachoutRestriction = null;
let downloadMediaMessage = null;

function getReachoutRestrictionResponse(error) {
    const message = String(error?.message || error || '');
    const restrictionActive = reachoutRestriction?.active === true;
    if (!restrictionActive && !message.toLowerCase().includes('account_reachout_restricted')) {
        return null;
    }

    const endsAt = reachoutRestriction?.enforcementEnds || null;
    return {
        status: 429,
        body: {
            code: 'account_reachout_restricted',
            retryable: true,
            enforcementEnds: endsAt,
            error: endsAt
                ? `WhatsApp sedang membatasi aksi akun. Coba lagi setelah ${endsAt}.`
                : 'WhatsApp sedang membatasi aksi akun. Auto-join belum dapat dilakukan; coba lagi setelah pembatasan berakhir.',
        },
    };
}

async function resolveGroupJidFromInvite(inviteCode) {
    try {
        return await sock.groupAcceptInvite(inviteCode);
    } catch (joinError) {
        const message = String(joinError?.message || joinError || '').toLowerCase();
        const restricted = reachoutRestriction?.active === true || message.includes('account_reachout_restricted');
        if (!restricted) throw joinError;

        // Jika akun sudah menjadi anggota, accept-invite dapat ditolak walaupun
        // metadata grup masih bisa dibaca. Gunakan JID metadata tersebut.
        const info = await sock.groupGetInviteInfo(inviteCode);
        if (!info?.id) throw joinError;
        await sock.groupMetadata(info.id);
        console.log('[WA Gateway] Join ditolak karena restriction; memakai JID grup yang sudah terhubung:', info.id);
        return info.id;
    }
}

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
        let groupJid = await sessionManager.getNotificationGroupJid();
        if (!groupJid) {
            const inviteCode = await sessionManager.getGroupInviteCode();
            if (inviteCode) {
                const joinedJid = await resolveGroupJidFromInvite(inviteCode);
                if (joinedJid) {
                    groupJid = await sessionManager.setNotificationGroupJid(joinedJid);
                    console.log('[Notif] Grup notifikasi otomatis di-join saat alert:', groupJid);
                }
            }
        }
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

// Track ID pesan yang dikirim oleh Bot AI agar tidak memicu self-pausing
const botSentMessageIds = new Set();
const configuredDeliveryTimeout = Number(process.env.WA_DELIVERY_RECEIPT_TIMEOUT_MS || 30000);
const deliveryReceiptTimeoutMs = Number.isFinite(configuredDeliveryTimeout) && configuredDeliveryTimeout > 0
    ? configuredDeliveryTimeout
    : 30000;
const deliveryTracker = createDeliveryTracker({
    timeoutMs: deliveryReceiptTimeoutMs,
    onTimeout: ({ messageId, phoneNumber, targetJid }) => {
        console.error(`[CS-AI] Delivery UNCONFIRMED_TIMEOUT untuk ${phoneNumber} via ${targetJid} setelah ${deliveryReceiptTimeoutMs}ms (messageId: ${messageId})`);
    },
});

function rememberOutboundMessage(delivery, phoneNumber) {
    const messageId = delivery?.message?.key?.id;
    if (!messageId) return null;

    botSentMessageIds.add(messageId);
    deliveryTracker.track({
        messageId,
        phoneNumber,
        targetJid: delivery.targetJid,
    });

    if (botSentMessageIds.size > 1000) {
        botSentMessageIds.clear();
    }

    return messageId;
}

async function forwardInboundImageToGroup({ message, phoneNumber, caption }) {
    if (!downloadMediaMessage) {
        throw new Error('Baileys media downloader belum siap.');
    }

    const groupJid = await sessionManager.getNotificationGroupJid();
    if (!groupJid) {
        throw new Error('notification_group JID belum diatur di wa_settings.');
    }

    const imageBuffer = await downloadMediaMessage(message, 'buffer', {});
    await sock.sendMessage(groupJid, {
        image: imageBuffer,
        caption: [
            '🖼️ *GAMBAR DARI PELANGGAN*',
            `📱 Nomor: ${phoneNumber || 'Tidak diketahui'}`,
            caption ? `💬 Caption: ${caption}` : '💬 Caption: (tidak ada)',
            '👉 Mohon tim Cleco Pii meninjau dan membalas manual.',
        ].join('\n'),
    });
}

// ─── AI Message Handler (Private Chat Only) ───────────────────────────────────
async function handleIncomingMessage(msg) {
    const jid = msg.key?.remoteJid;

    // Filter: hanya private chat
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;

    const inboundImage = msg.message?.imageMessage || null;

    // Ekstrak teks pesan. Gambar tanpa caption tetap diproses sebagai handover,
    // bukan dibuang diam-diam karena model CS saat ini menerima teks saja.
    let messageText = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';

    if (!messageText.trim() && inboundImage) {
        messageText = '[Pelanggan mengirim gambar]';
    }

    if (!messageText.trim()) return;

    // Balas ke exact JID dari stanza inbound agar tetap berada di chat yang sama.
    // Identitas nomor (senderPn) hanya dipakai sebagai fallback jika primary send gagal.
    const targetSendJid = jid;

    // Nomor HP pelanggan untuk sesi DB & audit log (utamakan senderPn real phone)
    const phoneIdentityJid = msg.senderPn
        || msg.key?.senderPn
        || msg.key?.remoteJidAlt
        || msg.key?.participantAlt
        || msg.key?.participant
        || msg.participant
        || (jid.endsWith('@s.whatsapp.net') ? jid : null);
    const rawPhoneJid = phoneIdentityJid || jid;
    const phoneNumber = sessionManager.normalizePhone(rawPhoneJid);
    const phoneIdentityVerified = phoneIdentityJid?.endsWith('@s.whatsapp.net') === true;

    // Handle pesan dari akun WhatsApp sendiri (fromMe = true)
    if (msg.key?.fromMe) {
        // Jika pesan ini dikirimkan oleh Bot AI kita sendiri, ABAIKAN! Jangan pause AI!
        if (msg.key?.id && botSentMessageIds.has(msg.key.id)) {
            botSentMessageIds.delete(msg.key.id);
            return;
        }

        const lower = messageText.trim().toLowerCase();
        const isSelfTest = /^(!test|\[test\]|test|tes|cek|ping|p|halo|hi|hello)/i.test(lower);
        if (!isSelfTest) {
            const botOwnerPhone = sessionManager.normalizePhone(process.env.DEFAULT_WA_PHONE || '085353726052');
            if (phoneNumber === botOwnerPhone) {
                console.log(`[CS-AI] Self-chat terdeteksi pada nomor bot/owner (${phoneNumber}). AI tetap aktif.`);
            } else {
                // Hanya jika manusia membalas manual dari HP kasir ke PELANGGAN LAIN -> Pause AI 60m untuk pelanggan tersebut
                const session = await sessionManager.getOrCreateSession(phoneNumber);
                await sessionManager.setAiPaused(session.id, 60);
                console.log(`[CS-AI] Kasir membalas manual dari HP ke pelanggan ${phoneNumber}. AI otomatis paused (60m).`);
                return;
            }
        }

        // Bersihkan prefix test agar AI menjawab pertanyaan utama dengan natural
        messageText = messageText.replace(/^(!test|\[test\]|test|tes|cek|ping)\s*/i, '').trim() || messageText;
    }

    // Helper pengiriman exact-JID-first dengan satu fallback ke phone JID.
    const safeSendReply = async (textToSend) => {
        try {
            console.log(`[CS-AI] Mengirim balasan ke exact inbound JID ${targetSendJid}`);
            const delivery = await sendReplyToInboundChat({
                sock,
                msg,
                text: textToSend,
            });
            const messageId = rememberOutboundMessage(delivery, phoneNumber);

            if (delivery.mappingStored) {
                console.log(`[CS-AI] Mapping LID tersimpan: ${targetSendJid} <-> ${delivery.mappingPn}`);
            } else if (delivery.mappingError) {
                console.error(`[CS-AI] Gagal menyimpan mapping LID ${targetSendJid}: ${delivery.mappingError.message}`);
            } else if (targetSendJid.endsWith('@lid')) {
                console.warn(`[CS-AI] Mapping LID ${targetSendJid} tidak tersedia; pengiriman exact-JID tetap dicoba.`);
            }

            if (delivery.usedFallback) {
                console.warn(`[CS-AI] Primary ${targetSendJid} gagal; stanza disubmit via fallback ${delivery.targetJid} (messageId: ${messageId || 'unknown'})`);
            }

            return delivery;
        } catch (sendError) {
            const causes = sendError instanceof AggregateError
                ? sendError.errors.map(error => error?.message || String(error)).join(' | ')
                : sendError.message;
            if (sendError.mappingError) {
                console.error(`[CS-AI] Gagal menyimpan mapping LID ${targetSendJid}: ${sendError.mappingError.message}`);
            }
            console.error(`[CS-AI] Pengiriman balasan gagal untuk ${phoneNumber}: ${causes}`);
            throw sendError;
        }
    };

    console.log(`[CS-AI] Incoming key:`, JSON.stringify(msg.key));
    console.log(`[CS-AI] Pesan masuk RAW JID: ${jid}, Target: ${targetSendJid}, Phone: ${phoneNumber}`);
    console.log(`[CS-AI] Pesan masuk dari ${phoneNumber} (Target JID: ${targetSendJid}): "${messageText.substring(0, 80)}..."`);

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

        // Verifikasi ulang role pada setiap pesan agar sesi lama atau lookup gagal tidak
        // pernah memperoleh hak membuat order sebagai pelanggan.
        const ownerPhone = sessionManager.normalizePhone(process.env.DEFAULT_WA_PHONE || '085353726052');
        const isOwnerPhone = phoneNumber === ownerPhone;
        const staffVerification = isOwnerPhone
            ? { verified: true, isStaff: false }
            : await sessionManager.checkStaffRole(phoneNumber);
        const effectiveUserRole = resolveEffectiveUserRole({
            sessionRole: session.user_role,
            isOwnerPhone,
            staffVerification,
        });
        const isOwnerOrStaff = effectiveUserRole === 'owner' || effectiveUserRole === 'staff';

        if (inboundImage && !isOwnerOrStaff) {
            const pauseMinutes = await sessionManager.getPauseDurationMinutes();
            await sessionManager.setAiPaused(session.id, pauseMinutes);

            try {
                await forwardInboundImageToGroup({
                    message: msg,
                    phoneNumber,
                    caption: inboundImage.caption,
                });
            } catch (imageError) {
                console.error('[Notif] Gagal meneruskan gambar pelanggan ke group:', imageError.message);
                await sendGroupNotification([
                    '🖼️ *GAMBAR PELANGGAN TIDAK TERKIRIM*',
                    `📱 Nomor: ${phoneNumber}`,
                    `⚠️ ${imageError.message}`,
                    '👉 Mohon tim buka chat pelanggan secara manual.',
                ].join('\n'));
            }

            const imageReply = 'Terima kasih Kak, gambarnya sudah saya teruskan ke tim Cleco Pii. Tim kami akan meninjau dan membalas langsung ya 🙏';
            try { await safeSendReply(imageReply); } catch (sendError) {
                console.error('[CS-AI] Gagal mengirim konfirmasi gambar:', sendError.message);
            }
            await sendGroupNotification([
                '🖼️ *HANDOVER GAMBAR PELANGGAN*',
                `📱 *Pelanggan*: ${phoneNumber}`,
                `⏸️ *Status*: AI dipause ${pauseMinutes} menit. Mohon tim meninjau gambar dan membalas manual.`,
            ].join('\n'));
            return;
        }

        // Deteksi secara natural jika pelanggan biasa ingin bicara dengan kasir / manusia
        const lowerMsg = messageText.trim().toLowerCase();
        const isKasirRequest = !isOwnerOrStaff && (lowerMsg.includes('kasir') || lowerMsg.includes('admin') || lowerMsg.includes('manusia') || lowerMsg.includes('hubungi mas') || lowerMsg.includes('hubungi mba') || lowerMsg.includes('bicara langsung') || lowerMsg.includes('stop ai') || lowerMsg === '!kasir' || lowerMsg === '!stop');

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

        // Cek apakah AI sedang di-pause (hanya untuk pelanggan biasa)
        const paused = isOwnerOrStaff ? false : await sessionManager.isAiPaused(session);
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
        try { await sock.sendPresenceUpdate('composing', targetSendJid); } catch (_) { }

        // Ambil nama karyawan jika role staff
        let karyawanNama = null;
        const verifiedKaryawanId = staffVerification?.verified && staffVerification?.isStaff
            ? staffVerification.karyawanData?.karyawan_id
            : null;
        if (verifiedKaryawanId) {
            const { data: karyawan } = await supabase
                .from('karyawan')
                .select('nama')
                .eq('karyawan_id', verifiedKaryawanId)
                .single();
            karyawanNama = karyawan?.nama || null;
        }

        // Proses dengan AI Engine
        let aiResult;
        try {
            aiResult = await aiEngine.processMessage({
                userMessage: messageText,
                session: {
                    ...session,
                    user_role: effectiveUserRole,
                    context_messages: session.context_messages || [],
                    phone_identity_verified: phoneIdentityVerified,
                    inbound_message_id: msg.key?.id || null,
                },
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
            try { await safeSendReply(fallbackText); } catch (_) { }
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
        try { await sock.sendPresenceUpdate('paused', targetSendJid); } catch (_) { }

        // Kirim balasan aman ke WhatsApp pelanggan
        let deliveryError = null;
        let mappingError = null;
        let delivery = null;
        try {
            delivery = await safeSendReply(replyText);
            mappingError = delivery.mappingError?.message || null;
        } catch (sendErr) {
            deliveryError = sendErr.message || 'Gagal mengirim ke socket WA';
            mappingError = sendErr.mappingError?.message || null;
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
            errorInfo: deliveryError || mappingError,
        });

        if (!isOwnerOrStaff && !deliveryError) {
            const risk = detectBusinessCommitmentRisk({
                inboundText: messageText,
                replyText,
            });
            if (risk) {
                const pauseMinutes = await sessionManager.getPauseDurationMinutes();
                await sessionManager.setAiPaused(session.id, pauseMinutes);
                await sendGroupNotification(formatBusinessCommitmentNotification({
                    phoneNumber,
                    risk,
                    pauseMinutes,
                }));
            }
        }

        if (deliveryError) {
            console.error(`[CS-AI] Balasan GAGAL disubmit ke ${phoneNumber}: ${deliveryError}`);
        } else {
            console.log(`[CS-AI] Balasan disubmit ke ${delivery.targetJid}; status delivery akan dicatat jika tersedia (messageId: ${delivery.message?.key?.id || 'unknown'}, model: ${aiResult.model}, tools: ${aiResult.toolsCalled?.join(', ') || 'none'})`);
        }

    } catch (err) {
        console.error(`[CS-AI] Unexpected error handling message from ${phoneNumber}:`, err.message);
    }
}

// ─── Connect to WhatsApp ──────────────────────────────────────────────────────
async function connectToWhatsApp() {
    const {
        default: makeWASocket,
        DisconnectReason,
        fetchLatestBaileysVersion,
        Browsers,
        WAMessageStatus,
        downloadMediaMessage: baileysDownloadMediaMessage,
    } = await loadBaileys();
    downloadMediaMessage = baileysDownloadMediaMessage;
    const { state, saveCreds } = await useSupabaseAuthState(supabase);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA] Memakai versi v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
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
        const { connection, lastDisconnect, qr, reachoutTimeLock } = update;

        if (reachoutTimeLock) {
            reachoutRestriction = describeReachoutTimeLock(reachoutTimeLock);
            const serialized = JSON.stringify(reachoutRestriction);
            if (reachoutRestriction.active) {
                console.error(`[WA Gateway] OUTGOING_MESSAGES_RESTRICTED ${serialized}`);
            } else {
                console.log(`[WA Gateway] Outgoing message restriction lifted ${serialized}`);
            }
        }

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
                setTimeout(startWhatsAppConnection, isConflict ? 5000 : 3000);
            } else {
                console.error('[WA Gateway] Sesi berstatus loggedOut. Data sesi dipertahankan; lakukan reset/relink eksplisit untuk mendapat QR baru.');
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
                    const jid = await resolveGroupJidFromInvite(inviteCode);
                    console.log('[WA Gateway] Joined group via invite code dari wa_settings:', jid);

                    // Simpan JID hasil join ke wa_settings.notification_group secara otomatis
                    if (jid) {
                        await sessionManager.setNotificationGroupJid(jid, 'WA Notif Outlet (auto-joined)');
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

    sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates) {
            const messageId = key?.id;
            const tracked = deliveryTracker.handleStatus({
                messageId,
                status: update?.status,
                deliveryAckStatus: WAMessageStatus.DELIVERY_ACK,
                errorStatus: WAMessageStatus.ERROR,
            });
            if (!tracked) continue;

            const statusName = Object.entries(WAMessageStatus)
                .find(([, value]) => value === update.status)?.[0] || `UNKNOWN_${update.status}`;

            if (tracked.outcome === 'error') {
                const details = update?.messageStubParameters?.join(', ') || 'detail tidak tersedia';
                console.error(`[CS-AI] Delivery ERROR untuk ${tracked.phoneNumber} via ${tracked.targetJid} (messageId: ${messageId}, detail: ${details})`);
            } else if (tracked.outcome === 'delivered') {
                console.log(`[CS-AI] Delivery ${statusName} untuk ${tracked.phoneNumber} via ${tracked.targetJid} (messageId: ${messageId})`);
            } else {
                console.log(`[CS-AI] Delivery ${statusName} untuk ${tracked.phoneNumber} via ${tracked.targetJid} (messageId: ${messageId})`);
            }
        }
    });
}

function startWhatsAppConnection() {
    connectToWhatsApp().catch((error) => {
        isConnected = false;
        console.error('[WA Gateway] Gagal memulai koneksi WhatsApp:', error);
    });
}

// Helper for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Endpoint: Send (existing, preserved) ────────────────────────────────────
app.post('/send', authenticateToken, async (req, res) => {
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
                const joinedJid = await resolveGroupJidFromInvite(code);
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

        if (formattedTarget.endsWith('@s.whatsapp.net')) {
            try {
                // Fix for iOS Baileys delivery issue (Waiting for this message...)
                // Force sync session state and verify number existence
                const [waRes] = await sock.onWhatsApp(formattedTarget);
                if (waRes && waRes.exists) {
                    formattedTarget = waRes.jid; // Update to actual JID (sometimes resolves LID)
                }
                await sock.presenceSubscribe(formattedTarget);
                await delay(300);
            } catch (e) {
                console.log('[WA Gateway Sync Note]:', e.message);
            }
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

        if (sentMsg?.key?.id) {
            botSentMessageIds.add(sentMsg.key.id);
        }

        console.log(`[WA Gateway] Pesan terkirim ke ${target}`, sentMsg?.key);
        return res.status(200).json({ success: true, message: `Berhasil mengirim ke ${target}`, key: sentMsg?.key });

    } catch (error) {
        console.error('[WA Gateway Error]', error);
        return res.status(500).json({ error: error.message });
    }
});

// ─── Endpoint: Broadcast (existing, preserved) ───────────────────────────────
app.post('/broadcast', authenticateToken, async (req, res) => {
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

                try {
                    const [waRes] = await sock.onWhatsApp(formattedTarget);
                    if (waRes && waRes.exists) {
                        formattedTarget = waRes.jid; 
                    }
                    await sock.presenceSubscribe(formattedTarget);
                    await delay(300);
                } catch (e) {
                    console.log('[WA Gateway Broadcast Sync Note]:', e.message);
                }

                const sentMsg = await sock.sendMessage(formattedTarget, { text: message });
                if (sentMsg?.key?.id) {
                    botSentMessageIds.add(sentMsg.key.id);
                }
                console.log(`[WA Gateway Broadcast] ${i + 1}/${targets.length} Terkirim ke ${target}`);

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

        const jid = await resolveGroupJidFromInvite(inviteCode);
        if (!jid) {
            return res.status(400).json({ error: 'Gagal join group. Periksa invite code dan pastikan akun WA belum ada di group.' });
        }

        // Simpan JID ke wa_settings.notification_group
        await sessionManager.setNotificationGroupJid(jid);

        console.log(`[WA Gateway] Manual join group sukses. JID: ${jid}`);
        return res.json({
            success: true,
            message: `Berhasil join group. JID tersimpan sebagai notification_group.`,
            jid,
        });
    } catch (err) {
        console.error('[WA Gateway] /api/wa/join-group error:', err.message);
        const restrictionResponse = getReachoutRestrictionResponse(err);
        if (restrictionResponse) {
            return res.status(restrictionResponse.status).json(restrictionResponse.body);
        }
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
    res.json({
        isConnected,
        hasQR: !!currentQR,
        aiMode: 'hybrid-groq-openagentic-gemini',
        pendingDeliveryReceipts: deliveryTracker.pendingCount(),
        reachoutRestriction,
    });
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
    startWhatsAppConnection();
});
