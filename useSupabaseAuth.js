const pino = require('pino');
const { loadBaileys } = require('./baileysRuntime');

function createAuthStateError(operation, id, error) {
    const detail = error?.message || String(error);
    return new Error(
        `Supabase auth ${operation} failed for [${id}]: ${detail}`,
        { cause: error }
    );
}

module.exports = async function useSupabaseAuthState(
    supabase,
    { loadRuntime = loadBaileys } = {}
) {
    const {
        initAuthCreds,
        BufferJSON,
        makeCacheableSignalKeyStore,
        proto,
    } = await loadRuntime();

    const writeData = async (data, id) => {
        try {
            const result = await supabase
                .from('wa_sessions')
                .upsert({
                    id,
                    data: JSON.parse(
                        JSON.stringify(data, BufferJSON.replacer)
                    ),
                });
            if (result?.error) throw result.error;
        } catch (error) {
            throw createAuthStateError('write', id, error);
        }
    };

    const readData = async (id) => {
        try {
            const { data, error } = await supabase
                .from('wa_sessions')
                .select('data')
                .eq('id', id)
                .single();

            if (error?.code === 'PGRST116') return null;
            if (error) throw error;
            if (!data) return null;

            return JSON.parse(
                JSON.stringify(data.data),
                BufferJSON.reviver
            );
        } catch (error) {
            throw createAuthStateError('read', id, error);
        }
    };

    const removeData = async (id) => {
        try {
            const result = await supabase
                .from('wa_sessions')
                .delete()
                .eq('id', id);
            if (result?.error) throw result.error;
        } catch (error) {
            throw createAuthStateError('delete', id, error);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    const supabaseStore = {
        get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.create(value);
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
                    writePromises.push(
                        value ? writeData(value, key) : removeData(key)
                    );
                }
            }
            await Promise.all(writePromises);
        },
    };

    const logger = pino({ level: 'silent' });
    const cacheableStore = makeCacheableSignalKeyStore(
        supabaseStore,
        logger
    );

    return {
        state: {
            creds,
            keys: cacheableStore,
        },
        saveCreds: () => writeData(creds, 'creds'),
        clearSession: async () => {
            try {
                const result = await supabase
                    .from('wa_sessions')
                    .delete()
                    .neq('id', 'dummy');
                if (result?.error) throw result.error;
                console.log('Sesi WhatsApp berhasil dibersihkan dari database.');
            } catch (error) {
                throw createAuthStateError('clear session', 'all', error);
            }
        },
    };
};
