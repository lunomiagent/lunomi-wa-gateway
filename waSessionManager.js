/**
 * waSessionManager.js
 * 
 * Mengelola sesi percakapan WhatsApp, verifikasi role karyawan,
 * penanganan ai_paused (Human Takeover), dan pencatatan audit log pesan.
 * 
 * Tidak ada mock data. Semua data diambil dari Supabase live.
 */

const { createClient } = require('@supabase/supabase-js');
const { classifyStaffVerification } = require('./orderPolicy');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('[SessionManager] FATAL: SUPABASE_URL atau SUPABASE_KEY tidak disetel!');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Context memory: simpan maksimal N pesan terakhir per sesi
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 1600;

/**
 * Normalisasi nomor HP dari format JID Baileys ke format 62xxx
 * Contoh: "628123456789@s.whatsapp.net" → "628123456789"
 */
function normalizePhone(jid) {
    if (!jid) return '';
    const raw = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '').trim();
    const clean = raw.split(':')[0].trim();
    if (clean.startsWith('62') && clean.length >= 10) {
        return '0' + clean.substring(2);
    }
    return clean;
}

/**
 * Ambil nama pelanggan dari tabel `pelanggan` berdasarkan nomor HP
 */
async function getCustomerName(phoneNumber) {
    if (!phoneNumber) return null;
    try {
        const clean = phoneNumber.replace(/[^0-9]/g, '');
        const with62 = clean.startsWith('0') ? '62' + clean.substring(1) : clean;
        const withZero = clean.startsWith('62') ? '0' + clean.substring(2) : clean;

        const { data } = await supabase
            .from('pelanggan')
            .select('nama')
            .or(`no_wa.eq.${clean},no_wa.eq.${with62},no_wa.eq.${withZero},nomor_telepon.eq.${clean},nomor_telepon.eq.${withZero}`)
            .limit(1)
            .maybeSingle();

        return data?.nama || null;
    } catch {
        return null;
    }
}

/**
 * Cek apakah nomor HP terdaftar sebagai karyawan aktif di Supabase.
 * Nomor disimpan di kolom `no_hp` tabel `karyawan`.
 * Format di DB bisa: 08xxx atau 628xxx → kita coba keduanya.
 * @returns {{ isStaff: boolean, karyawanData: object|null, verified: boolean }}
 */
async function checkStaffRole(phoneNumber) {
    try {
        // Normalisasi nomor: kita store bisa 08xx atau 628xx
        const withCountryCode = phoneNumber.startsWith('62') ? phoneNumber : '62' + phoneNumber.substring(1);
        const withZero = phoneNumber.startsWith('62') ? '0' + phoneNumber.substring(2) : phoneNumber;

        const { data, error } = await supabase
            .from('karyawan')
            .select('karyawan_id, nama, no_hp, status, employment_status, can_access_mobile, can_access_web')
            .or(`no_hp.eq.${withCountryCode},no_hp.eq.${withZero},no_hp.eq.${phoneNumber}`)
            .eq('status', 'aktif')
            .in('employment_status', ['aktif', 'probation', 'cuti_panjang'])
            .limit(2);

        if (error) {
            console.error('[SessionManager] Error cek role karyawan:', error.message);
        }
        return classifyStaffVerification({ data, error });
    } catch (err) {
        console.error('[SessionManager] Unexpected error checkStaffRole:', err.message);
        return { isStaff: false, karyawanData: null, verified: false };
    }
}

/**
 * Ambil atau buat sesi chat untuk nomor telepon ini.
 * Jika sesi baru, otomatis cek role karyawan.
 * @returns {object} sesi wa_chat_sessions
 */
async function getOrCreateSession(phoneNumber) {
    try {
        // Coba ambil sesi existing
        const { data: existingSession, error: fetchError } = await supabase
            .from('wa_chat_sessions')
            .select('*')
            .eq('phone_number', phoneNumber)
            .single();

        if (existingSession && !fetchError) {
            // Update last_message_at
            await supabase
                .from('wa_chat_sessions')
                .update({ last_message_at: new Date().toISOString() })
                .eq('phone_number', phoneNumber);
            return existingSession;
        }

        // Sesi belum ada → cek role karyawan lalu buat baru
        const { isStaff, karyawanData } = await checkStaffRole(phoneNumber);

        const newSessionData = {
            phone_number: phoneNumber,
            user_role: isStaff ? 'staff' : 'customer',
            karyawan_id: karyawanData?.karyawan_id || null,
            ai_paused: false,
            paused_until: null,
            last_message_at: new Date().toISOString(),
            context_messages: [],
            created_at: new Date().toISOString(),
        };

        const { data: newSession, error: createError } = await supabase
            .from('wa_chat_sessions')
            .insert(newSessionData)
            .select()
            .single();

        if (createError) {
            console.error('[SessionManager] Gagal membuat sesi baru:', createError.message);
            // Return object sementara agar AI tetap bisa merespon
            return { ...newSessionData, id: null };
        }

        console.log(`[SessionManager] Sesi baru dibuat: ${phoneNumber} (role: ${newSessionData.user_role})`);
        return newSession;
    } catch (err) {
        console.error('[SessionManager] Unexpected error getOrCreateSession:', err.message);
        return {
            phone_number: phoneNumber,
            user_role: 'customer',
            karyawan_id: null,
            ai_paused: false,
            paused_until: null,
            context_messages: [],
            id: null,
        };
    }
}

/**
 * Cek apakah AI sedang dalam status paused untuk nomor ini.
 * Jika paused_until sudah lewat, otomatis reset ai_paused = false.
 * @returns {boolean} true jika AI harus diam
 */
async function isAiPaused(session) {
    if (!session.ai_paused) return false;

    const now = new Date();
    const pausedUntil = session.paused_until ? new Date(session.paused_until) : null;

    if (!pausedUntil || now > pausedUntil) {
        // Pause sudah kedaluwarsa, reset
        if (session.id) {
            await supabase
                .from('wa_chat_sessions')
                .update({ ai_paused: false, paused_until: null })
                .eq('id', session.id);
        }
        return false;
    }

    return true;
}

/**
 * Set status AI paused untuk sesi ini.
 * @param {string} sessionId
 * @param {number} durationMinutes - durasi pause dalam menit
 */
async function setAiPaused(sessionId, durationMinutes = 60) {
    if (!sessionId) return;

    const pausedUntil = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
    const { error } = await supabase
        .from('wa_chat_sessions')
        .update({ ai_paused: true, paused_until: pausedUntil })
        .eq('id', sessionId);

    if (error) {
        console.error('[SessionManager] Gagal set ai_paused:', error.message);
        throw error;
    }

    console.log(`[SessionManager] AI Paused hingga ${pausedUntil} untuk sesi ${sessionId}`);
}

/**
 * Resume AI (nonaktifkan pause) untuk sesi ini.
 */
async function resumeAi(sessionId) {
    if (!sessionId) return;
    const { error } = await supabase
        .from('wa_chat_sessions')
        .update({ ai_paused: false, paused_until: null })
        .eq('id', sessionId);

    if (error) {
        console.error('[SessionManager] Gagal resume AI:', error.message);
        throw error;
    }
    console.log(`[SessionManager] AI Resumed untuk sesi ${sessionId}`);
}

/**
 * Ambil durasi pause dari wa_settings (default 60 menit).
 */
async function getPauseDurationMinutes() {
    try {
        const { data } = await supabase
            .from('wa_settings')
            .select('value')
            .eq('key', 'ai_pause_duration_minutes')
            .single();
        return data ? parseInt(data.value, 10) || 60 : 60;
    } catch {
        return 60;
    }
}

/**
 * Update konteks percakapan (riwayat pesan) di sesi.
 * Simpan maks MAX_CONTEXT_MESSAGES pesan terakhir.
 */
async function updateContextMessages(sessionId, currentMessages, newMessage) {
    if (!sessionId) return;

    const compactMessage = (message) => {
        if (!message || typeof message !== 'object') return null;
        if (typeof message.content !== 'string') return message;
        return {
            ...message,
            content: message.content.length > MAX_CONTEXT_CHARS
                ? `${message.content.slice(0, MAX_CONTEXT_CHARS)}…`
                : message.content,
        };
    };
    const updatedMessages = [...(currentMessages || []), newMessage]
        .map(compactMessage)
        .filter(Boolean)
        .slice(-MAX_CONTEXT_MESSAGES);
    
    const { error } = await supabase
        .from('wa_chat_sessions')
        .update({ context_messages: updatedMessages })
        .eq('id', sessionId);

    if (error) {
        console.error('[SessionManager] Gagal update context_messages:', error.message);
    }

    return updatedMessages;
}

/**
 * Catat pesan ke wa_message_logs untuk audit trail.
 */
async function logMessage({ sessionId, phoneNumber, direction, messageText, aiModel, toolsCalled, tokensUsed, errorInfo }) {
    try {
        const { error } = await supabase
            .from('wa_message_logs')
            .insert({
                session_id: sessionId || null,
                phone_number: phoneNumber,
                direction,
                message_text: messageText,
                ai_model: aiModel || null,
                tools_called: toolsCalled || null,
                tokens_used: tokensUsed || null,
                error_info: errorInfo || null,
                created_at: new Date().toISOString(),
            });

        if (error) {
            console.error('[SessionManager] Gagal log pesan:', error.message);
        }
    } catch (err) {
        console.error('[SessionManager] Unexpected error logMessage:', err.message);
    }
}

/**
 * Simpan draft pesanan dari pelanggan ke tabel wa_orders.
 * @returns {object|null} data pesanan yang tersimpan
 */
async function saveWaOrder({ orderId, sessionId, customerName, phoneNumber, outletCode, orderItems, totalEstimated, notes }) {
    const { data, error } = await supabase
        .from('wa_orders')
        .upsert({
            id: orderId,
            session_id: sessionId || null,
            customer_name: customerName,
            phone_number: phoneNumber,
            outlet_code: outletCode || null,
            order_items: orderItems,
            total_estimated: totalEstimated || null,
            status: 'draft_from_wa',
            notes: notes || null,
            created_at: new Date().toISOString(),
        }, { onConflict: 'id', ignoreDuplicates: true })
        .select()
        .maybeSingle();

    if (error) {
        console.error('[SessionManager] Gagal simpan wa_orders:', error.message);
        throw error;
    }

    if (data) return data;

    const { data: existing, error: existingError } = await supabase
        .from('wa_orders')
        .select('id, session_id, customer_name, phone_number, outlet_code, order_items, total_estimated, status, notes, created_at')
        .eq('id', orderId)
        .single();
    if (existingError) throw new Error(`Gagal membaca ulang idempotent wa_order: ${existingError.message}`);
    Object.defineProperty(existing, '_idempotentReplay', {
        value: true,
        enumerable: false,
    });
    return existing;
}

/**
 * Tandai pesanan sudah dikirim notifikasi ke group.
 */
async function markOrderNotified(orderId) {
    const { error } = await supabase
        .from('wa_orders')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', orderId);

    if (error) {
        console.error('[SessionManager] Gagal update notified_at:', error.message);
    }
}

/**
 * Buat tiket komplain dan set ai_paused.
 * @returns {object|null} tiket yang tersimpan
 */
async function createComplaintTicket({ sessionId, phoneNumber, complaintText }) {
    const { data, error } = await supabase
        .from('wa_complaints')
        .insert({
            session_id: sessionId || null,
            phone_number: phoneNumber,
            complaint_text: complaintText,
            status: 'open',
            created_at: new Date().toISOString(),
        })
        .select()
        .single();

    if (error) {
        console.error('[SessionManager] Gagal buat wa_complaints:', error.message);
        throw error;
    }

    // Otomatis pause AI
    if (sessionId) {
        const pauseDuration = await getPauseDurationMinutes();
        await setAiPaused(sessionId, pauseDuration);
    }

    return data;
}

/**
 * Ambil JID Group notifikasi dari wa_settings.
 * @returns {string|null}
 */
async function getNotificationGroupJid() {
    try {
        const { data } = await supabase
            .from('wa_settings')
            .select('value')
            .eq('key', 'notification_group')
            .single();
        return data?.value?.jid || null;
    } catch {
        return null;
    }
}

/**
 * Simpan JID grup notifikasi setelah auto-join atau join manual.
 */
async function setNotificationGroupJid(jid, name = 'WA Notif Outlet') {
    if (!jid || !String(jid).endsWith('@g.us')) {
        throw new Error('JID grup notifikasi tidak valid.');
    }

    const { error } = await supabase
        .from('wa_settings')
        .upsert(
            { key: 'notification_group', value: { jid, name }, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
        );
    if (error) throw error;
    return jid;
}

/**
 * Ambil invite code WhatsApp Group dari wa_settings.
 * Digunakan saat gateway pertama connect untuk auto-join group notifikasi.
 * @returns {string|null}
 */
async function getGroupInviteCode() {
    try {
        const { data } = await supabase
            .from('wa_settings')
            .select('value')
            .eq('key', 'group_invite_code')
            .single();
        // value bisa string langsung atau object { code: "xxx" }
        const val = data?.value;
        if (!val) return null;
        if (typeof val === 'string') return val.trim() || null;
        if (typeof val === 'object') return val.code?.trim() || null;
        return null;
    } catch {
        return null;
    }
}

/**
 * Cek apakah AI secara global diaktifkan (from wa_settings).
 */
async function isAiGloballyEnabled() {
    try {
        const { data } = await supabase
            .from('wa_settings')
            .select('value')
            .eq('key', 'ai_enabled')
            .single();
        return data ? data.value === true || data.value === 'true' : true;
    } catch {
        return true;
    }
}

module.exports = {
    normalizePhone,
    checkStaffRole,
    getCustomerName,
    getOrCreateSession,
    isAiPaused,
    setAiPaused,
    resumeAi,
    getPauseDurationMinutes,
    updateContextMessages,
    logMessage,
    saveWaOrder,
    markOrderNotified,
    createComplaintTicket,
    getNotificationGroupJid,
    setNotificationGroupJid,
    getGroupInviteCode,
    isAiGloballyEnabled,
};
