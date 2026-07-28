'use strict';

const { createHash } = require('node:crypto');

const ORDER_TOOL_NAME = 'create_wa_order';
const CUSTOMER_OUTLET_CODE = String(process.env.WA_CUSTOMER_OUTLET_CODE || 'CP')
    .trim()
    .toUpperCase();
const CUSTOMER_OUTLET_SCOPED_TOOL_NAMES = new Set([
    'get_menu_catalog',
    'get_outlet_info',
    'get_stock_status',
    'get_daily_sales',
    'get_attendance_today',
    'get_recipe_hpp',
    ORDER_TOOL_NAME,
]);
const PUBLIC_CS_TOOL_NAMES = new Set([
    'get_menu_catalog',
    'get_outlet_info',
    'create_complaint',
]);
const INTERNAL_TOOL_NAMES = new Set([
    'get_stock_status',
    'get_daily_sales',
    'get_attendance_today',
    'get_recipe_hpp',
]);
const AFFIRMATIVE_ORDER_CONFIRMATIONS = new Set([
    'ya saya konfirmasi pesanan ini',
    'saya konfirmasi pesanan ini',
    'ya konfirmasi pesanan ini',
    'ya konfirmasi pesanan',
    'saya setuju dengan pesanan ini',
    'ya saya setuju dengan pesanan ini',
    'saya setuju pesanan ini',
    'ya setuju pesanan ini',
]);

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isExplicitConfirmation(message) {
    const normalized = normalizeText(message);
    return AFFIRMATIVE_ORDER_CONFIRMATIONS.has(normalized);
}

function isPendingConfirmationPrompt(contextMessages) {
    const latest = Array.isArray(contextMessages)
        ? contextMessages[contextMessages.length - 1]
        : null;
    if (!latest || latest.role !== 'assistant') return false;

    const normalized = normalizeText(latest.content);
    const mentionsOrder = /\b(pesan(?:an)?|order)\b/.test(normalized);
    const asksConfirmation = /\b(konfirmasi|sudah benar|apakah benar|setuju)\b/.test(normalized);
    return mentionsOrder && asksConfirmation;
}

function isOrderToolAllowed({ userRole, currentUserMessage, contextMessages }) {
    if (userRole !== 'customer') return false;
    return isExplicitConfirmation(currentUserMessage)
        && isPendingConfirmationPrompt(contextMessages);
}

function resolveEffectiveUserRole({ sessionRole, isOwnerPhone, staffVerification }) {
    if (isOwnerPhone) return 'owner';
    if (!staffVerification?.verified) return 'unknown';
    if (staffVerification.isStaff) return 'staff';
    if (sessionRole && sessionRole !== 'customer') return 'staff';
    return 'customer';
}

function classifyStaffVerification({ data, error }) {
    if (error || !Array.isArray(data)) {
        return { verified: false, isStaff: false, karyawanData: null };
    }
    if (data.length === 0) {
        return { verified: true, isStaff: false, karyawanData: null };
    }
    return { verified: true, isStaff: true, karyawanData: data[0] };
}

function createOrderIdempotencyId(sessionId, inboundMessageId) {
    if (!sessionId) throw new Error('Session ID wajib tersedia untuk idempotency order.');
    if (!inboundMessageId) throw new Error('Inbound message ID wajib tersedia untuk idempotency order.');

    const bytes = createHash('sha256')
        .update(`${sessionId}:${inboundMessageId}`)
        .digest()
        .subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isToolAllowedForSession(toolName, sessionContext) {
    if (PUBLIC_CS_TOOL_NAMES.has(toolName)) return true;

    const userRole = sessionContext?.userRole;
    if (userRole === 'staff' || userRole === 'owner') {
        return INTERNAL_TOOL_NAMES.has(toolName);
    }

    return toolName === ORDER_TOOL_NAME && isOrderToolAllowed(sessionContext || {});
}

function filterToolsForSession(tools, sessionContext, nameSelector = tool => tool?.function?.name) {
    if (!Array.isArray(tools)) return [];
    return tools.filter(tool => isToolAllowedForSession(nameSelector(tool), sessionContext));
}

function scopeToolArgsForSession(toolName, toolArgs, sessionContext) {
    const scopedArgs = toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)
        ? { ...toolArgs }
        : {};
    if (CUSTOMER_OUTLET_SCOPED_TOOL_NAMES.has(toolName)) {
        scopedArgs.outlet_code = CUSTOMER_OUTLET_CODE;
    }
    return scopedArgs;
}

function canonicalizeOrderPayload({
    toolArgs,
    sessionPhone,
    sessionPhoneVerified,
    catalogProducts,
    validOutletCodes,
}) {
    const customerName = String(toolArgs?.customer_name || '').trim();
    if (!customerName) throw new Error('Nama pelanggan wajib diisi.');

    const phoneNumber = String(sessionPhone || '').trim();
    if (
        sessionPhoneVerified !== true
        || !/^(?:08\d{8,11}|628\d{8,11})$/.test(phoneNumber)
    ) {
        throw new Error('Nomor telepon sesi belum terverifikasi dari identitas PN WhatsApp.');
    }

    const outletCode = String(toolArgs?.outlet_code || '').trim().toUpperCase();
    const allowedOutlets = new Set(
        (validOutletCodes || []).map(code => String(code || '').trim().toUpperCase())
    );
    if (!outletCode || !allowedOutlets.has(outletCode)) {
        throw new Error(`Outlet "${outletCode || '-'}" tidak valid.`);
    }

    const productsByName = new Map(
        (catalogProducts || []).map(product => [normalizeText(product.nama), product])
    );
    const requestedItems = Array.isArray(toolArgs?.order_items) ? toolArgs.order_items : [];
    if (requestedItems.length === 0) throw new Error('Pesanan harus memiliki minimal satu item.');
    if (requestedItems.length > 20) throw new Error('Pesanan melebihi batas 20 jenis item.');

    const orderItems = requestedItems.map(item => {
        const requestedName = String(item?.nama || item?.product_name || '').trim();
        const product = productsByName.get(normalizeText(requestedName));
        if (!product) throw new Error(`Produk "${requestedName || '-'}" tidak tersedia di katalog aktif.`);

        const quantity = Number(item?.qty ?? item?.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
            throw new Error(`Jumlah produk "${product.nama}" harus bilangan bulat 1-100.`);
        }

        const price = Number(product.harga_jual);
        if (!Number.isFinite(price) || price < 0) {
            throw new Error(`Harga katalog produk "${product.nama}" tidak valid.`);
        }

        return {
            produk_id: product.produk_id,
            nama: product.nama,
            qty: quantity,
            harga: price,
            subtotal: price * quantity,
            catatan: String(item?.catatan || '').trim() || null,
        };
    });

    return {
        customerName,
        phoneNumber,
        outletCode,
        orderItems,
        totalEstimated: orderItems.reduce((sum, item) => sum + item.subtotal, 0),
        notes: String(toolArgs?.notes || '').trim() || null,
    };
}

async function executeAuthorizedOrder({
    toolArgs,
    sessionContext,
    loadCatalogProducts,
    loadValidOutletCodes,
    saveOrder,
    onOrderCreated,
}) {
    if (!isOrderToolAllowed(sessionContext)) {
        const error = new Error('Order ditolak: pelanggan belum melakukan konfirmasi pesanan yang valid.');
        error.code = 'ORDER_NOT_AUTHORIZED';
        throw error;
    }
    if (sessionContext.createdOrder) return sessionContext.createdOrder;

    let orderId;
    try {
        orderId = createOrderIdempotencyId(
            sessionContext.sessionId,
            sessionContext.inboundMessageId
        );
    } catch (error) {
        error.code = 'ORDER_VALIDATION_FAILED';
        throw error;
    }

    const [catalogProducts, validOutletCodes] = await Promise.all([
        loadCatalogProducts(),
        loadValidOutletCodes(),
    ]);
    let canonical;
    try {
        canonical = canonicalizeOrderPayload({
            toolArgs,
            sessionPhone: sessionContext.phoneNumber,
            sessionPhoneVerified: sessionContext.phoneIdentityVerified,
            catalogProducts,
            validOutletCodes,
        });
    } catch (error) {
        error.code = error.code || 'ORDER_VALIDATION_FAILED';
        throw error;
    }

    const order = await saveOrder({
        orderId,
        sessionId: sessionContext.sessionId,
        ...canonical,
    });

    sessionContext.createdOrder = order;
    if (!order?._idempotentReplay && onOrderCreated) await onOrderCreated(order);
    return order;
}

module.exports = {
    ORDER_TOOL_NAME,
    isOrderToolAllowed,
    resolveEffectiveUserRole,
    classifyStaffVerification,
    createOrderIdempotencyId,
    isToolAllowedForSession,
    filterToolsForSession,
    scopeToolArgsForSession,
    canonicalizeOrderPayload,
    executeAuthorizedOrder,
};
