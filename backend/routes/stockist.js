
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { getCallerStockist, assertOwnsStockist } = require('../lib/access');
const { generateId , getISTDateString } = require('../lib/misc');
const { validatePayoutFields } = require('../lib/payout');
const { capturePayoutEvent } = require('../lib/audit');
const { checkPhone , maskIdNumber } = require('../lib/validation');
const {
  calculateIsShopOpen,
  isCustomerVisible, publicStockist, getCustomerVisibleProducts
} = require('../services/stockists');

const { resolveStockistRate } = require('../services/stockists');
const { enrichOrder } = require('../services/orders');

function registerStockistRoutes(app) {
app.patch('/api/stockist/profile', requireAuth, async (req, res) => {
  let stockistId;
  let callerStockist = null;
  if (req.user.role === 'ADMIN') {
    stockistId = req.headers['x-user-id'] || req.body.stockistId || req.body.stockist_id || req.body.id;
    if (!stockistId) return res.status(400).json({ error: 'Admin requires explicit stockist id' });
  } else {
    callerStockist = await getCallerStockist(req);
    if (!callerStockist) return res.status(403).json({ error: 'Unauthorized' });
    stockistId = callerStockist.id;
  }

  if (!await assertOwnsStockist(req, res, stockistId)) return;
  try {
    if (req.user.role !== 'ADMIN') {
      if (req.body.id && req.body.id !== stockistId) {
        return res.status(403).json({ error: 'Forbidden: Cannot edit another stockist profile' });
      }
      if (req.body.stockist_id && req.body.stockist_id !== stockistId) {
        return res.status(403).json({ error: 'Forbidden: Cannot edit another stockist profile' });
      }
    }

    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === stockistId || s.user_id === stockistId);
    if (!stockist) return res.status(404).json({ error: 'Stockist not found' });

    const payload = req.body;

    // Reject locked fields
    const lockedFields = ['region_id', 'vendor_id', 'commission_rate', 'min_order_value'];
    for (const field of lockedFields) {
      if (payload[field] !== undefined && payload[field] !== stockist[field]) {
        return res.status(400).json({ error: `Cannot edit locked field: ${field}` });
      }
    }

    // Validate delivery radius
    if (payload.delivery_radius_km !== undefined) {
      const parsedRadius = parseFloat(payload.delivery_radius_km);
      if (isNaN(parsedRadius)) {
        return res.status(400).json({ error: 'Invalid delivery radius' });
      }
      const maxRadius = stockist.max_delivery_radius_km !== undefined ? parseFloat(stockist.max_delivery_radius_km) : 5.0;
      if (parsedRadius > maxRadius) {
        return res.status(400).json({ error: `Delivery radius cannot exceed ${maxRadius}km` });
      }
      stockist.delivery_radius_km = parsedRadius;
    }

    // Validate prep time
    if (payload.prep_eta_minutes !== undefined) {
      const prep = parseInt(payload.prep_eta_minutes, 10);
      if (isNaN(prep) || prep < 5 || prep > 120) {
        return res.status(400).json({ error: 'Preparation time must be between 5 and 120 minutes' });
      }
      stockist.prep_eta_minutes = prep;
    }

    // Validate times
    if (payload.opening_time !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.opening_time)) {
        return res.status(400).json({ error: 'Invalid opening time' });
      }
      stockist.opening_time = payload.opening_time;
    }
    if (payload.closing_time !== undefined) {
      if (payload.closing_time === '24:00' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.closing_time)) {
        return res.status(400).json({ error: 'Invalid closing time (24:00 is not allowed)' });
      }
      stockist.closing_time = payload.closing_time;
    }

    // Validate payout fields
    const payoutVal = validatePayoutFields(payload);
    if (!payoutVal.ok) {
      return res.status(400).json({ error: payoutVal.error });
    }
    const oldStockist = { ...stockist };
    if (payoutVal.values.payout_upi_id !== undefined) stockist.payout_upi_id = payoutVal.values.payout_upi_id;
    if (payoutVal.values.payout_ifsc !== undefined) stockist.payout_ifsc = payoutVal.values.payout_ifsc;
    if (payoutVal.values.payout_bank_account !== undefined) stockist.payout_bank_account = payoutVal.values.payout_bank_account;
    if (payoutVal.values.payout_account_name !== undefined) stockist.payout_account_name = payoutVal.values.payout_account_name;
    
    if (payload.contact_phone !== undefined) {
      if (payload.contact_phone) {
        const validPhone = checkPhone(payload.contact_phone, res);
        if (!validPhone) return;
        stockist.contact_phone = validPhone;
      } else {
        stockist.contact_phone = '';
      }
    }

    // Handle Manual Closed
    if (payload.manual_closed !== undefined) {
      stockist.manual_closed = payload.manual_closed;
      stockist.closed_reason = payload.closed_reason || null;
      
      if (payload.manual_closed) {
        if (payload.closed_until) {
          stockist.closed_until = payload.closed_until;
        } else {
          // Compute next opening time if closed_until is empty
          const now = new Date();
          const opening = stockist.opening_time || '09:00';
          const [h, m] = opening.split(':').map(Number);
          
          const nextOpen = new Date(now);
          nextOpen.setHours(h, m, 0, 0);
          
          if (nextOpen <= now) {
            nextOpen.setDate(nextOpen.getDate() + 1);
          }
          stockist.closed_until = nextOpen.toISOString();
        }
      } else {
        stockist.closed_until = null;
      }
    }

    await capturePayoutEvent(req, 'stockist', stockist.id, oldStockist, stockist, req.user ? req.user.userId : stockist.user_id);
    await db.saveTable('stockists', stockists);
    
    // Audit log
    try {
      const auditLogs = await db.getTable('audit_logs').catch(() => []) || [];
      auditLogs.push({
        id: 'aud-' + Math.random().toString(36).substring(2, 9),
        action: 'STOCKIST_PROFILE_UPDATE',
        actor_id: stockistId,
        target_id: stockist.id,
        target_type: 'STOCKIST',
        details: 'Stockist updated their profile settings',
        created_at: new Date().toISOString()
      });
      await db.saveTable('audit_logs', auditLogs).catch(() => {}); // silently ignore if missing
    } catch(err) {
      console.warn('[Audit Log] Failed to write audit log:', err.message);
    }

    const _latestRate = await resolveStockistRate(stockist.id);
    res.json({ success: true, stockist: { ...stockist, commission_rate: _latestRate, is_shop_open: calculateIsShopOpen(stockist) } });
  } catch (e) {
    console.error('[stockist/profile PATCH]', stockistId, e);
    return res.status(500).json({ error: 'save_failed', message: e.message });
  }
});


app.get('/api/stockists', async (req, res) => {
  const { regionId } = req.query;
  const stockists = await db.getTable('stockists');
  const users = await db.getTable('users');
  
  const visibleStockists = stockists.filter(s => isCustomerVisible(s, users));
  const filtered = regionId ? visibleStockists.filter(s => s.region_id === regionId) : visibleStockists;

  const orders = await db.getTable('orders');
  const products = await db.getTable('products');
  const enriched = filtered.map(s => {
    const shopOrders = orders.filter(o => o.stockist_id === s.id);
    const finished = shopOrders.filter(o => ['DELIVERED', 'CANCELLED'].includes(o.status));
    const delivered = finished.filter(o => o.status === 'DELIVERED').length;
    const totalFinished = finished.length;
    const shopProducts = getCustomerVisibleProducts(s, products);

    let reliabilityBadge = 'Active Partner';
    if (totalFinished > 0) {
      const rate = (delivered / totalFinished) * 100;
      if (rate >= 90) reliabilityBadge = 'Highly Reliable (90%+ Fulfilled)';
      else if (rate >= 80) reliabilityBadge = 'Reliable Partner';
    } else {
      reliabilityBadge = 'New Stockist (Verified)';
    }

    return publicStockist({ ...s, reliabilityBadge, product_count: shopProducts.length, is_shop_open: calculateIsShopOpen(s) });
  });

  return res.json(enriched);
});

app.get('/api/stockists/by-user/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (req.user.role !== 'ADMIN' && req.user.userId !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.user_id === userId);
  if (!stockist) {
    return res.status(404).json({ error: 'Stockist record not found or pending KYC' });
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  
  let kyc = {};
  if (user && user.kyc_details) {
    kyc = user.kyc_details;
    if (typeof kyc === 'string') {
      try { kyc = JSON.parse(kyc); } catch(e) {}
    }
  }
  const rawId = kyc.id_number || (user ? user.kyc_id_number : '') || '';

  const latestRate = await resolveStockistRate(stockist.id);
  return res.json({
    ...stockist,
    personal_name: user ? user.name : '',
    phone: user ? user.phone : '',
    id_type: kyc.id_type || (user ? user.kyc_id_type : '') || '',
    id_number: maskIdNumber(rawId),
    shop_name: kyc.shop_name || stockist.name,
    shop_address: kyc.shop_address || (user ? user.address : ''),
    commission_rate: latestRate,
    is_shop_open: calculateIsShopOpen(stockist)
  });
});

app.get('/api/stockists/:id', async (req, res) => {
  const { id } = req.params;
  const stockists = await db.getTable('stockists');
  const users = await db.getTable('users');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist || !isCustomerVisible(stockist, users)) return res.status(404).json({ error: 'Stockist not found' });

  const orders = await db.getTable('orders');
  const products = await db.getTable('products');
  const shopOrders = orders.filter(o => o.stockist_id === stockist.id);
  const finished = shopOrders.filter(o => ['DELIVERED', 'CANCELLED'].includes(o.status));
  const delivered = finished.filter(o => o.status === 'DELIVERED').length;
  const totalFinished = finished.length;
  const shopProducts = getCustomerVisibleProducts(stockist, products);

  let reliabilityBadge = 'Active Partner';
  if (totalFinished > 0) {
    const rate = (delivered / totalFinished) * 100;
    if (rate >= 90) reliabilityBadge = 'Highly Reliable (90%+ Fulfilled)';
    else if (rate >= 80) reliabilityBadge = 'Reliable Partner';
  } else {
    reliabilityBadge = 'New Stockist (Verified)';
  }

  return res.json(publicStockist({
    ...stockist,
    reliabilityBadge,
    product_count: shopProducts.length,
    is_shop_open: calculateIsShopOpen(stockist)
  }));
});

app.get('/api/stockists/:id/stats', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!await assertOwnsStockist(req, res, id)) return;
  const stockists = await db.getTable('stockists');
  const users = await db.getTable('users');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist || !isCustomerVisible(stockist, users)) return res.status(404).json({ error: 'Stockist not found' });

  const orders = (await db.getTable('orders')).filter(o => o.stockist_id === id);
  const todayStr = getISTDateString();

  const todayOrders = orders.filter(o => getISTDateString(new Date(o.created_at)) === todayStr);
  const todayDelivered = todayOrders.filter(o => o.status === 'DELIVERED');

  let today_earnings = 0; for (const o of todayDelivered) { const enriched = await enrichOrder(o, req); today_earnings += (enriched.stockist_amount || 0); }

  const today_order_count = todayDelivered.length;

  const deliveredOrders = orders.filter(o => o.status === 'DELIVERED');
  let totalDeliveredValue = 0; for (const o of deliveredOrders) { const enriched = await enrichOrder(o, req); totalDeliveredValue += (enriched.stockist_amount || 0); }
  const avg_order_value = deliveredOrders.length > 0 ? (totalDeliveredValue / deliveredOrders.length) : 0;

  const total_fulfilled = deliveredOrders.length;
  const total_cancelled = orders.filter(o => o.status === 'CANCELLED').length;

  const orderItems = await db.getTable('order_items');
  const deliveredOrderIds = new Set(deliveredOrders.map(o => o.id));
  const items = orderItems.filter(oi => deliveredOrderIds.has(oi.order_id));

  const productQuantities = {};
  items.forEach(item => {
    if (!productQuantities[item.product_id]) {
      productQuantities[item.product_id] = { id: item.product_id, name: item.name, qty: 0 };
    }
    productQuantities[item.product_id].qty += item.quantity;
  });

  const top_products = Object.values(productQuantities).sort((a, b) => b.qty - a.qty).slice(0, 5);

  const weekly_data = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const istStr = getISTDateString(d);
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' });
    const dayOrders = orders.filter(o => o.status === 'DELIVERED' && getISTDateString(new Date(o.created_at)) === istStr);
    const dayEarnings = dayOrders.reduce((sum, o) => sum + (enrichOrder(o, req).stockist_amount || 0), 0);
    weekly_data.push({ day: dayName, earnings: Math.round(dayEarnings * 100) / 100 });
  }

  const monthly_data = [];
  for (let i = 3; i >= 0; i--) {
    const startOffset = (i + 1) * 7;
    const endOffset = i * 7;
    let weekEarnings = 0;
    for (let dayOffset = startOffset - 1; dayOffset >= endOffset; dayOffset--) {
      const d = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
      const istStr = getISTDateString(d);
      const dayOrders = orders.filter(o => o.status === 'DELIVERED' && getISTDateString(new Date(o.created_at)) === istStr);
      weekEarnings += dayOrders.reduce((sum, o) => sum + (enrichOrder(o, req).stockist_amount || 0), 0);
    }
    monthly_data.push({ day: `Wk -${i}`, earnings: Math.round(weekEarnings * 100) / 100 });
  }

  // COD commission outstanding for this stockist
  const codLedger = await db.getTable('cod_commission_ledger');
  const cod_commission_outstanding = codLedger
    .filter(e => e.stockist_id === id && !e.settled)
    .reduce((sum, e) => sum + e.amount_owed, 0);

  return res.json({
    today_earnings,
    today_order_count,
    avg_order_value,
    total_fulfilled,
    total_cancelled,
    top_products,
    weekly_data,
    monthly_data,
    cod_commission_outstanding: Math.round(cod_commission_outstanding * 100) / 100
  });
});

// Restock inventory
app.post('/api/stockists/restock', requireAuth, async (req, res) => {
  const { stockistId, items, vendorId } = req.body;
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  if (!stockistId || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Invalid restock parameters' });
  }

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === stockistId);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });

  const stockistVendors = await db.getTable('stockist_vendors');
  const approved = stockistVendors.filter(sv => sv.stockist_id === stockistId);
  if (approved.length === 0) {
    return res.status(400).json({ error: 'No approved Wholesalers assigned. Please contact Admin.' });
  }

  if (vendorId) {
    const isApproved = approved.some(sv => sv.vendor_id === vendorId);
    if (!isApproved) {
      return res.status(400).json({ error: 'Selected wholesaler is not approved for this store.' });
    }
  }

  const inventory = await db.getTable('stockist_inventory');
  items.forEach(item => {
    let inv = inventory.find(i => i.stockist_id === stockistId && i.product_id === item.productId);
    if (inv) {
      inv.stock_qty += parseInt(item.quantity, 10);
      inv.is_available = inv.stock_qty > 0;
    } else {
      inventory.push({
        id: 'sinv-' + generateId(),
        stockist_id: stockistId,
        product_id: item.productId,
        stock_qty: parseInt(item.quantity, 10),
        stock_quantity: parseInt(item.quantity, 10),
        is_available: true,
        created_at: new Date().toISOString()
      });
    }
  });

  await db.saveTable('stockist_inventory', inventory);
  return res.json({ success: true, message: 'Stock updated successfully.' });
});

app.post('/api/stockist/push-subscription', requireAuth, async (req, res) => {
  const stockistId = req.body.stockistId || req.headers['x-user-id'];
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  
  const subscriptions = await db.getTable('stockist_push_subscriptions');
  const existingIndex = subscriptions.findIndex(s => s.endpoint === subscription.endpoint);
  
  const subRecord = {
    id: existingIndex >= 0 ? subscriptions[existingIndex].id : 'sub-' + generateId(),
    stockist_id: stockistId,
    endpoint: subscription.endpoint,
    keys_p256dh: subscription.keys.p256dh,
    keys_auth: subscription.keys.auth,
    created_at: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    subscriptions[existingIndex] = subRecord;
  } else {
    subscriptions.push(subRecord);
  }
  await db.saveTable('stockist_push_subscriptions', subscriptions);
  res.json({ success: true });
});

app.get('/api/stockists/:stockistId/vendors', requireAuth, async (req, res) => {
  const { stockistId } = req.params;
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  const stockistVendors = await db.getTable('stockist_vendors');
  const vendors = await db.getTable('vendors');
  const approvedIds = stockistVendors.filter(sv => sv.stockist_id === stockistId).map(sv => sv.vendor_id);
  return res.json(vendors.filter(v => approvedIds.includes(v.id)));
});

app.get('/api/stockists/:stockistId/available-vendors', requireAuth, async (req, res) => {
  const { stockistId } = req.params;
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  const vendors = await db.getTable('vendors');
  return res.json(vendors.filter(v => v.is_active !== false));
});
}

module.exports = { registerStockistRoutes };
