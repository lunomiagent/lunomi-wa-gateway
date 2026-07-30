const fs = require('fs');
const envText = fs.readFileSync('../lunomi-web/.env.local', 'utf8');
const env = {};
envText.split('\n').forEach(l => {
  const [k, ...v] = l.split('=');
  if (k && v) env[k.trim()] = v.join('=').trim();
});

const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const useSupabaseAuthState = require('./useSupabaseAuth');

(async () => {
  console.log('=== OPUS-GRADE TEST WITH PRE-FETCHED GROUP METADATA ===');
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { state } = await useSupabaseAuthState(supabase);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: require('pino')({ level: 'silent' })
  });

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      console.log('BOT LOGGED IN AS:', sock.user?.id, sock.user?.name);
      
      const targetGroupJid = '120363422372098957@g.us';

      console.log('1. Pre-fetching groupMetadata for', targetGroupJid);
      try {
        const meta = await sock.groupMetadata(targetGroupJid);
        console.log('  -> Group Metadata Loaded Successfully!');
        console.log('  -> Subject:', meta.subject);
        console.log('  -> Participants Count:', meta.participants?.length);
      } catch (e) {
        console.error('  -> Group Metadata Error:', e.message);
      }

      console.log('2. Sending message to WhatsApp Group Absensi Cleco...');
      try {
        const waMsg = `📍 NOTIFIKASI ABSENSI CHECK-IN (VERIFIKASI REAL-TIME)\n` +
          `👤 Karyawan: RIO KHOIRONI RASID\n` +
          `🏢 Outlet: Head Office (Pusat)\n` +
          `📅 Tanggal & Jam: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB\n` +
          `🟢 Radius GPS: Dalam Radius (Valid ✅)\n` +
          `📸 Foto Selfie Live: https://sihqouknrypvxibiovpq.supabase.co/storage/v1/object/public/absensi/selfie_test_1784808819505.jpg`;

        const msgRes = await sock.sendMessage(targetGroupJid, { text: waMsg });
        console.log('3. SEND MESSAGE SUCCESSFUL! Key:', JSON.stringify(msgRes.key));
        console.log('Message Status:', msgRes.status);
      } catch (sendErr) {
        console.error('Send Message Error:', sendErr);
      }

      process.exit(0);
    }
  });
})();
