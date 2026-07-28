const test = require('node:test');
const assert = require('node:assert/strict');

const useSupabaseAuthState = require('../useSupabaseAuth');

function createSupabaseFake(initialRows = {}, failures = {}) {
    const rows = new Map(Object.entries(initialRows));

    function resultFor(operation) {
        const error = failures[operation] || null;
        return error ? { data: null, error } : { data: null, error: null };
    }

    const supabase = {
        from(table) {
            assert.equal(table, 'wa_sessions');
            return {
                async upsert(row) {
                    const result = resultFor('upsert');
                    if (!result.error) rows.set(row.id, row.data);
                    return result;
                },
                select() {
                    return {
                        eq(column, id) {
                            assert.equal(column, 'id');
                            return {
                                async single() {
                                    const result = resultFor('read');
                                    if (result.error) return result;
                                    if (!rows.has(id)) {
                                        return {
                                            data: null,
                                            error: {
                                                code: 'PGRST116',
                                                message: 'No rows found',
                                            },
                                        };
                                    }
                                    return {
                                        data: { data: rows.get(id) },
                                        error: null,
                                    };
                                },
                            };
                        },
                    };
                },
                delete() {
                    const remove = (predicate) => {
                        const result = resultFor('delete');
                        if (!result.error) {
                            for (const id of rows.keys()) {
                                if (predicate(id)) rows.delete(id);
                            }
                        }
                        return Promise.resolve(result);
                    };

                    return {
                        eq(column, id) {
                            assert.equal(column, 'id');
                            return remove((rowId) => rowId === id);
                        },
                        neq(column, id) {
                            assert.equal(column, 'id');
                            return remove((rowId) => rowId !== id);
                        },
                    };
                },
            };
        },
    };

    return { supabase, rows };
}

const runtime = {
    initAuthCreds: () => ({ registered: false }),
    BufferJSON: {
        replacer: (_key, value) => value,
        reviver: (_key, value) => value,
    },
    makeCacheableSignalKeyStore: (store) => store,
    proto: {
        Message: {
            AppStateSyncKeyData: {
                create: (value) => ({ ...value, converted: true }),
            },
        },
    },
};

test('persists and reads v7 signal-key categories', async () => {
    const { supabase, rows } = createSupabaseFake();
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    await auth.state.keys.set({
        'lid-mapping': { '123@lid': { pn: '6281@s.whatsapp.net' } },
        'device-list': { device: { devices: ['0'] } },
        tctoken: { token: { token: 'abc' } },
    });

    assert.deepEqual(rows.get('lid-mapping-123@lid'), {
        pn: '6281@s.whatsapp.net',
    });
    assert.deepEqual(rows.get('device-list-device'), {
        devices: ['0'],
    });
    assert.deepEqual(rows.get('tctoken-token'), {
        token: 'abc',
    });
    assert.deepEqual(
        await auth.state.keys.get('lid-mapping', ['123@lid']),
        { '123@lid': { pn: '6281@s.whatsapp.net' } }
    );
});

test('converts app-state keys with the v7 create API', async () => {
    const { supabase } = createSupabaseFake({
        'app-state-sync-key-critical': { keyData: 'value' },
    });
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    const result = await auth.state.keys.get(
        'app-state-sync-key',
        ['critical']
    );

    assert.deepEqual(result.critical, {
        keyData: 'value',
        converted: true,
    });
});

test('propagates Supabase upsert failures with the auth key', async () => {
    const { supabase } = createSupabaseFake({}, {
        upsert: new Error('database unavailable'),
    });
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    await assert.rejects(
        auth.state.keys.set({
            'lid-mapping': { broken: { pn: '6281@s.whatsapp.net' } },
        }),
        /lid-mapping-broken.*database unavailable/i
    );
});

test('propagates Supabase delete and explicit clear failures', async () => {
    const { supabase } = createSupabaseFake({}, {
        delete: new Error('delete denied'),
    });
    const auth = await useSupabaseAuthState(supabase, {
        loadRuntime: async () => runtime,
    });

    await assert.rejects(
        auth.state.keys.set({ 'device-list': { broken: null } }),
        /device-list-broken.*delete denied/i
    );
    await assert.rejects(auth.clearSession(), /clear.*delete denied/i);
});

test('propagates unexpected Supabase read failures', async () => {
    const { supabase } = createSupabaseFake({}, {
        read: new Error('read denied'),
    });

    await assert.rejects(
        useSupabaseAuthState(supabase, {
            loadRuntime: async () => runtime,
        }),
        /read.*creds.*read denied/i
    );
});
