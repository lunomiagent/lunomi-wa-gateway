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
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('Fetching auth state from Supabase...');
  const { state } = await useSupabaseAuthState(supabase);
  const { version } = await fetchLatestBaileysVersion();

  console.log('Connecting to WhatsApp Meta socket...');
  const sock = makeWASocket({
    version,
    auth: state,
    logger: require('pino')({ level: 'silent' })
  });

  sock.ev.on('connection.update', async (u) => {
    if (u.connection) console.log('Connection update:', u.connection);
    if (u.connection === 'open') {
      console.log('\n=== BOT WA LOGGED IN ACCOUNT ===');
      console.log('User ID:', sock.user?.id);
      console.log('User Name:', sock.user?.name);

      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log('\n=== LIST OF GROUPS BOT IS PARTICIPATING IN ===');
        const keys = Object.keys(groups);
        if (keys.length === 0) {
          console.log('⚠️ BOT ACCOUNT IS NOT IN ANY WHATSAPP GROUP YET!');
        } else {
          for (const [jid, group] of Object.entries(groups)) {
            console.log(`- JID: ${jid} | Nama Group: "${group.subject}" | Participant Count: ${group.participants?.length}`);
          }
        }

        console.log('\n=== CHECKING INVITE CODE F2X9YMfgPn4D7rjhjZjRv3 ===');
        try {
          const info = await sock.groupGetInviteInfo('F2X9YMfgPn4D7rjhjZjRv3');
          console.log('Group Info from Invite Code:');
          console.log('  -> JID:', info.id);
          console.log('  -> Subject:', info.subject);
          console.log('  -> Owner:', info.owner);
          console.log('  -> Size:', info.size);
        } catch (inviteErr) {
          console.error('Failed to get invite info:', inviteErr.message);
        }

      } catch (err) {
        console.error('Error fetching participating groups:', err.message);
      }
      process.exit(0);
    }
  });
})();
