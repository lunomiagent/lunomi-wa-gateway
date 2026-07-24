const { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

module.exports = async function useSupabaseAuthState(supabase) {
    const writeData = async (data, id) => {
        try {
            await supabase
                .from('wa_sessions')
                .upsert({ id, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) });
        } catch (error) {
            console.error(`Error writing auth state to Supabase [${id}]:`, error);
        }
    };

    const readData = async (id) => {
        try {
            const { data, error } = await supabase
                .from('wa_sessions')
                .select('data')
                .eq('id', id)
                .single();
            if (error || !data) return null;
            return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await supabase
                .from('wa_sessions')
                .delete()
                .eq('id', id);
        } catch (error) {
            console.error(`Error removing auth state from Supabase [${id}]:`, error);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    // 1. Buat custom Supabase Store untuk operasi baca-tulis mentah
    const supabaseStore = {
        get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                    value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
            }
            return data;
        },
        set: async (data) => {
            const writePromises = [];
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const key = `${category}-${id}`;
                    if (value) {
                        writePromises.push(writeData(value, key));
                    } else {
                        writePromises.push(removeData(key));
                    }
                }
            }
            await Promise.all(writePromises);
        }
    };

    // 2. Bungkus dengan `makeCacheableSignalKeyStore` resmi dari Baileys
    // Ini mengimplementasikan in-memory cache standar produksi untuk mencegah race condition / MAC sync error
    const logger = pino({ level: 'silent' });
    const cacheableStore = makeCacheableSignalKeyStore(supabaseStore, logger);

    return {
        state: {
            creds,
            keys: cacheableStore,
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        },
        clearSession: async () => {
            try {
                await supabase.from('wa_sessions').delete().neq('id', 'dummy'); 
                console.log('✅ Sesi WhatsApp berhasil dibersihkan dari database.');
            } catch (err) {
                console.error('Error saat membersihkan sesi:', err);
            }
        }
    };
};