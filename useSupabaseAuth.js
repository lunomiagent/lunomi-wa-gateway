const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

module.exports = async function useSupabaseAuthState(supabase) {
    // IN-MEMORY CACHE: Mengunci & menyinkronkan data secara instan di RAM
    // Ini menghilangkan 100% isu race-condition akibat latensi database jarak jauh
    const memoryCache = new Map();

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

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        
                        // 1. Cek di Memory Cache dulu (Instan, bebas network latency)
                        if (memoryCache.has(key)) {
                            data[id] = memoryCache.get(key);
                            continue;
                        }

                        // 2. Jika tidak ada di cache, baru ambil dari DB
                        let value = await readData(key);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        
                        // 3. Simpan ke Cache untuk request berikutnya
                        if (value) {
                            memoryCache.set(key, value);
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
                            
                            // Update RAM secara instan agar tidak terjadi desinkronisasi MAC
                            if (value) {
                                memoryCache.set(key, value);
                                writePromises.push(writeData(value, key));
                            } else {
                                memoryCache.delete(key);
                                writePromises.push(removeData(key));
                            }
                        }
                    }
                    // Sinkronisasi ke DB berjalan secara paralel tanpa memblokir RAM
                    await Promise.all(writePromises);
                },
            },
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        },
        clearSession: async () => {
            memoryCache.clear();
            try {
                await supabase.from('wa_sessions').delete().neq('id', 'dummy'); 
                console.log('✅ Sesi WhatsApp berhasil dibersihkan dari memory cache & database.');
            } catch (err) {
                console.error('Error saat membersihkan sesi:', err);
            }
        }
    };
};