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

  const { state } = await useSupabaseAuthState(supabase);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: require('pino')({ level: 'silent' })
  });

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      console.log('CONNECTED AS:', sock.user?.id, sock.user?.name);
      
      try {
        console.log('Attempting groupGetInviteInfo for F2X9YMfgPn4D7rjhjZjRv3...');
        const info = await sock.groupGetInviteInfo('F2X9YMfgPn4D7rjhjZjRv3');
        console.log('Invite Info:', JSON.stringify(info, null, 2));
      } catch (err) {
        console.error('Invite Info Error:', err);
      }

      try {
        console.log('Attempting groupAcceptInvite for F2X9YMfgPn4D7rjhjZjRv3...');
        const res = await sock.groupAcceptInvite('F2X9YMfgPn4D7rjhjZjRv3');
        console.log('Group Accept Invite Result:', res);
      } catch (err) {
        console.error('Group Accept Invite Error:', err.message, err);
      }

      process.exit(0);
    }
  });
})();
