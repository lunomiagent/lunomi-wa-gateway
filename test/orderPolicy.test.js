const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isOrderToolAllowed,
    filterToolsForSession,
    canonicalizeOrderPayload,
    executeAuthorizedOrder,
    resolveEffectiveUserRole,
    createOrderIdempotencyId,
    classifyStaffVerification,
} = require('../orderPolicy');

const pendingContext = [
    {
        role: 'assistant',
        content: 'Pesanan: 2 Coffee 08 dari outlet CP. Apakah pesanan ini sudah benar dan ingin dikonfirmasi?',
    },
];

test('never exposes create_wa_order to staff or owner sessions', () => {
    const tools = [
        { type: 'function', function: { name: 'get_menu_catalog' } },
        { type: 'function', function: { name: 'create_wa_order' } },
    ];

    for (const userRole of ['staff', 'owner']) {
        const filtered = filterToolsForSession(tools, {
            userRole,
            currentUserMessage: 'Ya, konfirmasi pesanan',
            contextMessages: pendingContext,
        });
        assert.deepEqual(filtered.map(tool => tool.function.name), ['get_menu_catalog']);
    }
});

test('generic messages cannot authorize order creation', () => {
    for (const currentUserMessage of [
        'Tes',
        'Tes pesan',
        'Pesan',
        'Cek',
        'ok',
        'Pesanan ini benar?',
        'Saya tidak setuju dengan pesanan ini',
        'Jangan konfirmasi order ini',
        'Batalkan pesanan ini',
        'Saya tak setuju dengan pesanan ini',
        'Saya enggak setuju dengan pesanan ini',
        'Tdk setuju pesanan ini',
        'Jgn konfirmasi order ini',
        'Cancel order ini',
    ]) {
        assert.equal(isOrderToolAllowed({
            userRole: 'customer',
            currentUserMessage,
            contextMessages: pendingContext,
        }), false, currentUserMessage);
    }
});

test('requires an explicit confirmation immediately after an assistant confirmation prompt', () => {
    assert.equal(isOrderToolAllowed({
        userRole: 'customer',
        currentUserMessage: 'Ya, saya konfirmasi pesanan ini',
        contextMessages: pendingContext,
    }), true);

    assert.equal(isOrderToolAllowed({
        userRole: 'customer',
        currentUserMessage: 'Ya, saya konfirmasi pesanan ini',
        contextMessages: [
            pendingContext[0],
            { role: 'user', content: 'Ada promo?' },
        ],
    }), false);
});

test('canonicalizes the order with session phone and catalog prices', () => {
    const result = canonicalizeOrderPayload({
        toolArgs: {
            customer_name: 'Yogha',
            phone_number: '081234567890',
            outlet_code: 'cp',
            order_items: [
                { product_name: 'Coffee 08', quantity: 2, harga: 1 },
                { nama: 'French Toast', qty: 1, harga: 1 },
            ],
            total_estimated: 1,
            notes: 'Tanpa gula',
        },
        sessionPhone: '085353726052',
        sessionPhoneVerified: true,
        catalogProducts: [
            { produk_id: 'p1', nama: 'Coffee 08', harga_jual: 30000 },
            { produk_id: 'p2', nama: 'French Toast', harga_jual: 22000 },
        ],
        validOutletCodes: ['CP', 'BJ'],
    });

    assert.deepEqual(result, {
        customerName: 'Yogha',
        phoneNumber: '085353726052',
        outletCode: 'CP',
        orderItems: [
            { produk_id: 'p1', nama: 'Coffee 08', qty: 2, harga: 30000, subtotal: 60000, catatan: null },
            { produk_id: 'p2', nama: 'French Toast', qty: 1, harga: 22000, subtotal: 22000, catatan: null },
        ],
        totalEstimated: 82000,
        notes: 'Tanpa gula',
    });
});

test('rejects unknown products, outlets, and invalid quantities', () => {
    const base = {
        toolArgs: {
            customer_name: 'Yogha',
            outlet_code: 'CP',
            order_items: [{ nama: 'Coffee 08', qty: 1 }],
        },
        sessionPhone: '085353726052',
        sessionPhoneVerified: true,
        catalogProducts: [{ produk_id: 'p1', nama: 'Coffee 08', harga_jual: 30000 }],
        validOutletCodes: ['CP'],
    };

    assert.throws(() => canonicalizeOrderPayload({
        ...base,
        toolArgs: { ...base.toolArgs, order_items: [{ nama: 'Kopi Halusinasi', qty: 1 }] },
    }), /tidak tersedia/i);
    assert.throws(() => canonicalizeOrderPayload({
        ...base,
        toolArgs: { ...base.toolArgs, outlet_code: 'XX' },
    }), /outlet/i);
    assert.throws(() => canonicalizeOrderPayload({
        ...base,
        toolArgs: { ...base.toolArgs, order_items: [{ nama: 'Coffee 08', qty: 0 }] },
    }), /jumlah/i);
    assert.throws(() => canonicalizeOrderPayload({
        ...base,
        sessionPhoneVerified: false,
    }), /nomor.*terverifikasi/i);
});

test('derives an effective role from fresh trusted identity checks', () => {
    assert.equal(resolveEffectiveUserRole({
        sessionRole: 'customer',
        isOwnerPhone: true,
        staffVerification: { verified: true, isStaff: false },
    }), 'owner');
    assert.equal(resolveEffectiveUserRole({
        sessionRole: 'customer',
        isOwnerPhone: false,
        staffVerification: { verified: true, isStaff: true },
    }), 'staff');
    assert.equal(resolveEffectiveUserRole({
        sessionRole: 'customer',
        isOwnerPhone: false,
        staffVerification: { verified: true, isStaff: false },
    }), 'customer');
    assert.equal(resolveEffectiveUserRole({
        sessionRole: 'customer',
        isOwnerPhone: false,
        staffVerification: { verified: false, isStaff: false },
    }), 'unknown');
    assert.equal(resolveEffectiveUserRole({
        sessionRole: 'superadmin',
        isOwnerPhone: false,
        staffVerification: { verified: true, isStaff: false },
    }), 'staff');
});

test('classifies bounded staff lookup results without treating ambiguity as customer', () => {
    assert.deepEqual(classifyStaffVerification({ data: [], error: null }), {
        verified: true,
        isStaff: false,
        karyawanData: null,
    });
    assert.deepEqual(classifyStaffVerification({
        data: [{ karyawan_id: 'staff-1' }],
        error: null,
    }), {
        verified: true,
        isStaff: true,
        karyawanData: { karyawan_id: 'staff-1' },
    });
    assert.deepEqual(classifyStaffVerification({
        data: [{ karyawan_id: 'staff-1' }, { karyawan_id: 'staff-2' }],
        error: null,
    }), {
        verified: true,
        isStaff: true,
        karyawanData: { karyawan_id: 'staff-1' },
    });
    assert.deepEqual(classifyStaffVerification({
        data: null,
        error: new Error('database unavailable'),
    }), {
        verified: false,
        isStaff: false,
        karyawanData: null,
    });
});

test('derives a stable UUID idempotency ID from session and inbound message IDs', () => {
    assert.equal(
        createOrderIdempotencyId('session-1', 'message-1'),
        '88bde0ed-a696-505a-8539-b23ed721140d'
    );
    assert.notEqual(
        createOrderIdempotencyId('session-1', 'message-1'),
        createOrderIdempotencyId('session-1', 'message-2')
    );
    assert.throws(() => createOrderIdempotencyId('session-1', null), /message/i);
});

test('rejects an unauthorized order before loading data or saving', async () => {
    let externalCalls = 0;
    const externalCall = async () => {
        externalCalls += 1;
        return [];
    };

    await assert.rejects(executeAuthorizedOrder({
        toolArgs: {
            customer_name: 'Yogha',
            outlet_code: 'CP',
            order_items: [{ nama: 'Coffee 08', qty: 1 }],
        },
        sessionContext: {
            userRole: 'staff',
            currentUserMessage: 'Pesan',
            contextMessages: pendingContext,
            phoneNumber: '085353726052',
            phoneIdentityVerified: true,
            sessionId: 'session-1',
            inboundMessageId: 'message-1',
        },
        loadCatalogProducts: externalCall,
        loadValidOutletCodes: externalCall,
        saveOrder: externalCall,
    }), error => error?.code === 'ORDER_NOT_AUTHORIZED');

    assert.equal(externalCalls, 0);
});

test('saves only canonical order data and awaits its callback', async () => {
    const events = [];
    const order = await executeAuthorizedOrder({
        toolArgs: {
            customer_name: 'Yogha',
            phone_number: '081234567890',
            outlet_code: 'cp',
            order_items: [{ product_name: 'Coffee 08', quantity: 2, harga: 1 }],
            total_estimated: 1,
        },
        sessionContext: {
            userRole: 'customer',
            currentUserMessage: 'Ya, konfirmasi pesanan ini',
            contextMessages: pendingContext,
            phoneNumber: '085353726052',
            phoneIdentityVerified: true,
            sessionId: 'session-1',
            inboundMessageId: 'message-1',
        },
        loadCatalogProducts: async () => [
            { produk_id: 'p1', nama: 'Coffee 08', harga_jual: 30000 },
        ],
        loadValidOutletCodes: async () => ['CP'],
        saveOrder: async payload => {
            events.push({ type: 'save', payload });
            return { id: 'order-1', ...payload };
        },
        onOrderCreated: async savedOrder => {
            await Promise.resolve();
            events.push({ type: 'callback', orderId: savedOrder.id });
        },
    });

    assert.equal(order.id, 'order-1');
    assert.deepEqual(events, [
        {
            type: 'save',
            payload: {
                orderId: '88bde0ed-a696-505a-8539-b23ed721140d',
                sessionId: 'session-1',
                customerName: 'Yogha',
                phoneNumber: '085353726052',
                outletCode: 'CP',
                orderItems: [
                    {
                        produk_id: 'p1',
                        nama: 'Coffee 08',
                        qty: 2,
                        harga: 30000,
                        subtotal: 60000,
                        catatan: null,
                    },
                ],
                totalEstimated: 60000,
                notes: null,
            },
        },
        { type: 'callback', orderId: 'order-1' },
    ]);
});

test('allows only one save and notification per inbound message execution', async () => {
    let saves = 0;
    let callbacks = 0;
    const sessionContext = {
        userRole: 'customer',
        currentUserMessage: 'Ya, konfirmasi pesanan ini',
        contextMessages: pendingContext,
        phoneNumber: '085353726052',
        phoneIdentityVerified: true,
        sessionId: 'session-1',
        inboundMessageId: 'message-1',
    };
    const params = {
        toolArgs: {
            customer_name: 'Yogha',
            outlet_code: 'CP',
            order_items: [{ nama: 'Coffee 08', qty: 1 }],
        },
        sessionContext,
        loadCatalogProducts: async () => [
            { produk_id: 'p1', nama: 'Coffee 08', harga_jual: 30000 },
        ],
        loadValidOutletCodes: async () => ['CP'],
        saveOrder: async payload => {
            saves += 1;
            return { id: payload.orderId };
        },
        onOrderCreated: async () => {
            callbacks += 1;
        },
    };
    const first = await executeAuthorizedOrder(params);
    const second = await executeAuthorizedOrder(params);

    assert.equal(first, second);
    assert.equal(first.id, '88bde0ed-a696-505a-8539-b23ed721140d');
    assert.equal(saves, 1);
    assert.equal(callbacks, 1);
});
