
const db = require('../db');
const cfg = require('../config');
const { requireAuth } = require('../lib/authz');
const { generateId } = require('../lib/misc');
const { createNotification, appendPaymentEvent } = require('../lib/audit');
const {
  calculateIsShopOpen,
  getRegionDeliveryFee
} = require('../services/stockists');
const {
  calculateSettlement, validatePickupSlot,
  runFraudDetection, _creditPointsOnDelivery
} = require('../services/orders');

const payments = require('../lib/payments');
const webpush = require('web-push');
const { assertSelfOrAdmin } = require('../lib/access');
const { ORDER_FULFILLMENT_TYPES, ORDER_PAYMENT_METHODS, enrichOrder, _sendOrderConfirmedSms } = require('../services/orders');
const { isCustomerVisible } = require('../services/stockists');
const { handleOrderStatusUpdate } = require('./orders');

function registerOrderCreateRoutes(app) {
const handleCreateOrderRoute = async (req, res) => {
  // Supports both old format { customerId, stockistId, items, fulfillmentType }
  // Only admins may place an order on someone else's account.
  if (req.body.customerId && !assertSelfOrAdmin(req, res, req.body.customerId)) return;

  // and new format { customerId, stores: [{ stockistId, items, pickupSlot }], fulfillmentType, paymentMethod }
  const { customerId, fulfillmentType, paymentMethod } = req.body;
  let stores = req.body.stores;

  // Backwards-compat: if old single-store format
  if (!stores && req.body.stockistId && req.body.items) {
    stores = [{ stockistId: req.body.stockistId, items: req.body.items, pickupSlot: req.body.pickupSlot || null }];
  }

  if (!customerId || !stores || stores.length === 0) {
    return res.status(400).json({ error: 'Invalid order request' });
  }

  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  if (fulfillmentType !== undefined && fulfillmentType !== null && typeof fulfillmentType !== 'string') {
    return res.status(400).json({ error: 'Invalid fulfillment type' });
  }
  const reqFulfillment = (fulfillmentType || 'PICKUP').toUpperCase();
  if (!ORDER_FULFILLMENT_TYPES.includes(reqFulfillment)) {
    return res.status(400).json({ error: 'Invalid fulfillment type' });
  }

  // §C9: multi-store cart forces PICKUP
  if (stores.length > 1 && (reqFulfillment === 'DELIVERY' || reqFulfillment === 'HOME_DELIVERY')) {
    return res.status(400).json({ error: 'Multi-store orders are pickup only. Please switch to Store Pickup.' });
  }

  // Delivery address required for Home Delivery
  if (reqFulfillment === 'DELIVERY' || reqFulfillment === 'HOME_DELIVERY') {
    const reqAddress = req.body.deliveryAddress !== undefined ? req.body.deliveryAddress : req.body.delivery_address !== undefined ? req.body.delivery_address : req.body.address;
    const deliveryAddr = ((reqAddress !== undefined ? reqAddress : customer.address) || '').trim();
    if (!deliveryAddr || deliveryAddr.length < 5) {
      return res.status(400).json({ error: 'Delivery address is required for home delivery (minimum 5 characters).' });
    }
  }

  // §E13: pickup orders require a slot per store
  if (reqFulfillment === 'PICKUP') {
    for (const store of stores) {
      if (!store.pickupSlot) {
        return res.status(400).json({ error: `Pickup slot is required for store order. Please select a time slot.` });
      }
      const slotError = validatePickupSlot(store.pickupSlot);
      if (slotError) return res.status(400).json({ error: slotError });
    }
  }

  // prepaid-pickup restriction check for excessive no-shows
  if (reqFulfillment === 'PICKUP' && (customer.prepaid_pickup_restricted || (customer.no_show_count || 0) >= cfg.MAX_NOSHOWS_BEFORE_RESTRICTION)) {
    return res.status(400).json({ error: 'Prepaid pickup is restricted due to excessive no-shows. Please choose Home Delivery (COD).' });
  }

  if (paymentMethod !== undefined && paymentMethod !== null && paymentMethod !== '' &&
      (typeof paymentMethod !== 'string' || !ORDER_PAYMENT_METHODS.includes(paymentMethod.toUpperCase()))) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }
  const reqPaymentMethod = paymentMethod ? paymentMethod.toUpperCase() : 'PAY_AT_HANDOVER';
  
  const couponRewardId = req.body.coupon_reward_id;
  let reward = null;
  if (couponRewardId) {
    if (stores.length > 1) {
      return res.status(400).json({ error: 'coupon_single_store_only' });
    }
    if (reqPaymentMethod.includes('COD')) {
      return res.status(400).json({ error: 'coupon_prepaid_only' });
    }
    const genericRewards = await db.getTable('generic_rewards');
    reward = genericRewards.find(r => r.id === couponRewardId);
    if (!reward || reward.is_active === false) {
      return res.status(404).json({ error: 'reward_missing' });
    }
    if (reward.valid_until && new Date() > new Date(reward.valid_until)) {
      return res.status(400).json({ error: 'reward_expired' });
    }

    const ledgers = await db.getTable('points_ledger');
    const customerPointsBalance = ledgers
      .filter(row => row.customer_id === customerId && row.type !== 'EARN_HELD')
      .reduce((sum, row) => sum + parseFloat(row.amount), 0);

    if (customerPointsBalance < reward.point_cost) {
      return res.status(400).json({ error: 'Insufficient points balance', code: 'INSUFFICIENT_POINTS' });
    }

    const ct = reward.cooldown_type || 'NONE';
    if (ct !== 'NONE') {
      const allOrders = await db.getTable('orders');
      const latestMatch = allOrders
        .filter(o => o.customer_id === customerId && o.status !== 'CANCELLED' && o.coupon_reward_id === reward.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

      if (latestMatch) {
        if (ct === 'ONCE') {
          return res.status(400).json({ error: 'already_redeemed', message: 'Already used' });
        } else if (ct === 'DAYS') {
          const cd = parseInt(reward.cooldown_days, 10);
          if (cd > 0) {
            const nextAllowedIso = new Date(new Date(latestMatch.created_at).getTime() + (cd * 24 * 60 * 60 * 1000)).toISOString();
            if (new Date() < new Date(nextAllowedIso)) {
              return res.status(400).json({
                error: 'Already redeemed',
                message: 'Available again in N days',
                available_at: nextAllowedIso
              });
            }
          }
        }
      }
    }
  }

  const stockistsTable = await db.getTable('stockists');
  const products = await db.getTable('products');
  const inventory = await db.getTable('stockist_inventory');
  const regionsTable = await db.getTable('regions');
  const now = new Date();
  const cancelDeadline = new Date(now.getTime() + cfg.CANCEL_WINDOW_MINUTES * 60 * 1000).toISOString();
  const cartId = 'cart-' + generateId();
  const createdOrders = [];
  // Every store is validated and priced before anything is written, so a bad
  // store in a multi-store cart cannot leave the other stores' orders behind.
  const preparedOrders = [];

  for (const storeEntry of stores) {
    const { stockistId, items, pickupSlot } = storeEntry;
    if (!stockistId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Each store entry must have a stockistId and items' });
    }

    // Group and aggregate items by productId
    const aggregatedItemsMap = new Map();
    for (const item of items) {
      if (!item.productId) return res.status(400).json({ error: 'validation_failed', message: 'Missing productId', fields: { productId: 'required' } });
      const qty = item.quantity;
      if (typeof qty !== 'number' || !Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > cfg.MAX_ITEM_QUANTITY_PER_LINE) {
        return res.status(400).json({ error: 'validation_failed', message: 'Invalid quantity', fields: { quantity: 'must be an integer >= 1 and <= MAX_ITEM_QUANTITY_PER_LINE' } });
      }
      if (aggregatedItemsMap.has(item.productId)) {
        aggregatedItemsMap.get(item.productId).quantity += qty;
      } else {
        aggregatedItemsMap.set(item.productId, { ...item, quantity: qty });
      }
    }
    const aggregatedItems = Array.from(aggregatedItemsMap.values());
    if (!stockistId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Each store entry must have a stockistId and items' });
    }

    const stockist = stockistsTable.find(s => s.id === stockistId);
    if (!stockist) return res.status(404).json({ error: `Stockist ${stockistId} not found` });
    if (!isCustomerVisible(stockist, users)) {
      return res.status(400).json({ error: 'stockist_unavailable', message: 'This shop is no longer accepting orders.' });
    }
    if (!calculateIsShopOpen(stockist)) {
      return res.status(400).json({ error: 'stockist_closed', message: 'This shop is currently closed and not accepting orders.' });
    }

    let subtotal = 0;
    let totalProfitMargin = 0;
    const orderItems = [];

    for (const item of aggregatedItems) {
      const product = products.find(p => p.id === item.productId);
      if (!product) return res.status(400).json({ error: `Product ${item.productId} not found` });
      if (product.deleted_at) {
        return res.status(400).json({ error: 'product_unavailable', message: `${product.name} is no longer available.` });
      }
      if (product.is_sellable === false) {
        return res.status(400).json({ error: 'product_unavailable', message: 'One or more items are no longer available.' });
      }
      const inv = inventory.find(i => i.stockist_id === stockistId && i.product_id === product.id);
      if (!inv || inv.stock_qty < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${product.name}` });
      }

      const itemPrice = parseFloat(product.price);
      const itemCost = parseFloat(product.cost_price);
      subtotal += itemPrice * item.quantity;
      totalProfitMargin += (itemPrice - itemCost) * item.quantity;

      orderItems.push({
        id: 'oi-' + generateId(),
        product_id: product.id,
        name: product.name,
        quantity: item.quantity,
        price: itemPrice,
        cost_price: itemCost
      });
    }

    let deliveryFee = 0.00;
    if (reqFulfillment === 'DELIVERY' || reqFulfillment === 'HOME_DELIVERY') {
      const regionRow = regionsTable.find(r => r.id === stockist.region_id);
      const fee = getRegionDeliveryFee(regionRow);
      if (fee === null) {
        return res.status(400).json({ error: 'delivery_unavailable', message: 'Home delivery is not available for this shop yet.' });
      }
      deliveryFee = fee;
    }
    
    let couponDiscount = 0;
    let couponPointsSpent = 0;
    if (reward) {
      if (reward.min_order_value && subtotal < reward.min_order_value) {
        return res.status(400).json({ error: 'below_min_order', min_order_value: reward.min_order_value });
      }
      couponDiscount = Math.min(parseFloat(reward.value_rupees), subtotal);
      couponDiscount = Math.round(couponDiscount * 100) / 100;
      couponPointsSpent = reward.point_cost;
    }

    const totalPrice = subtotal + deliveryFee;
    const amountPaid = totalPrice - couponDiscount;
    if (subtotal <= 0 || totalPrice <= 0) {
      return res.status(400).json({ error: 'validation_failed', message: 'Order total must be positive', fields: { total_price: 'must be > 0' } });
    }

    // The commission model is server policy. Only admins may pick the legacy
    // model (used for historical/test orders); everyone else gets profit_v2.
    const isAdminCaller = req.user && req.user.role === 'ADMIN';
    const reqModel = isAdminCaller && ['gross_v1', 'profit_v2'].includes(req.body.commission_model)
      ? req.body.commission_model
      : (isAdminCaller && !req.body.commission_model && !req.body.stores ? 'gross_v1' : 'profit_v2');
    let settlement;
    let platformCommission, pointsCredited, stockistReinvest, platformPot, stockistPayout, platformPayout;

    if (reqModel === 'gross_v1') {
      const stockistCommissionRates = await db.getTable('stockist_commission_rates');
      const scr = stockistCommissionRates.find(r => r.stockist_id === stockistId);
      const commissionRate = scr ? parseFloat(scr.rate_percent) : 10.00;
      platformCommission = (subtotal * commissionRate) / 100;

      const pointsEarnConfig = await db.getTable('points_earn_config');
      const pecStockist = pointsEarnConfig.find(r => r.stockist_id === stockistId);
      const pecRegion = pointsEarnConfig.find(r => r.region_id === customer.region_id && !r.stockist_id);
      const earnRatePercent = pecStockist ? parseFloat(pecStockist.earn_rate_percent) : (pecRegion ? parseFloat(pecRegion.earn_rate_percent) : 45.0);

      pointsCredited = Math.round(totalProfitMargin * (earnRatePercent / 100) * 100) / 100;
      stockistReinvest = 0;
      platformPot = platformCommission;
      stockistPayout = subtotal - platformCommission + deliveryFee;
      platformPayout = platformCommission;

      settlement = {
        commission_model: 'gross_v1',
        config_row_id: null,
        stockistReinvest: 0,
        platformPot: platformCommission,
        platformCommission,
        pointsCredited,
        commissionRateUsed: commissionRate,
        earnRateUsed: earnRatePercent
      };
    } else {
      settlement = await calculateSettlement(subtotal, totalProfitMargin, stockistId, customer.region_id);
      platformCommission = settlement.platformCommission;
      pointsCredited = settlement.pointsCredited;
      stockistReinvest = settlement.stockistReinvest;
      platformPot = settlement.platformPot;
      stockistPayout = subtotal + deliveryFee - platformPot;
      platformPayout = platformCommission;
    }

    // Determine payment status
    // Default PAY_AT_HANDOVER → UNPAID. COD → COD. Online gateway → PENDING_PAYMENT.
    const effectivePaymentMethod = reqPaymentMethod;
    let paymentStatus = 'UNPAID';
    if (effectivePaymentMethod === 'PAY_AT_HANDOVER') {
      paymentStatus = 'UNPAID';
    } else if (effectivePaymentMethod?.includes('COD')) {
      paymentStatus = 'COD';
    } else if (effectivePaymentMethod === 'ONLINE') {
      paymentStatus = 'PENDING_PAYMENT';
    } else {
      paymentStatus = 'HELD';
    }

    // Stock deduction removed here. It now happens when the order is marked READY.

    const orderId = 'o-' + generateId();

    let razorpayOrderId = null;
    let razorpayPaymentId = null;
    let checkoutUrl = null;

    if (effectivePaymentMethod === 'ONLINE' || effectivePaymentMethod === 'UPI') {
      const paymentOrder = await payments.createPaymentOrder({
        orderId,
        amount: totalPrice,
        currency: 'INR',
        notes: { orderId, customerId: customer.id, stockistId },
        linkedAccountId: stockist.linked_account_id || stockist.linked_account || null,
        transferAmount: stockistPayout
      });
      razorpayOrderId = paymentOrder.id;
      checkoutUrl = paymentOrder.checkout_url || payments.getCheckoutUrl(orderId);
    }

    const order = {
      id: orderId,
      cart_id: cartId,
      tenant_id: customer.tenant_id,
      region_id: customer.region_id,
      customer_id: customer.id,
      stockist_id: stockistId,
      stockist_name: stockist.name,
      status: 'CONFIRMING',          // §F17: holds for cancel window
      subtotal,
      delivery_fee: deliveryFee,
      low_order_fee: 0,
      total_price: totalPrice,
      fulfillment_type: reqFulfillment,
      pickup_slot: reqFulfillment === 'PICKUP' ? pickupSlot : null,
      pickup_eta_minutes: stockist.prep_eta_minutes || cfg.DEFAULT_PREP_ETA_MINUTES,
      pickup_pin: Math.floor(1000 + Math.random() * 9000).toString(),
      payment_status: paymentStatus,
      payment_method: effectivePaymentMethod,
      commission_model: settlement.commission_model,
      config_row_id: settlement.config_row_id,
      platform_commission: platformCommission,
      points_credited: pointsCredited,
      stockist_reinvest: stockistReinvest,
      platform_pot: platformPot,
      stockist_payout: stockistPayout,
      margin: totalProfitMargin,
      earn_rate_used: settlement.earnRateUsed,
      cancel_deadline: cancelDeadline,
      no_show_count: 0,
      reschedule_used: false,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      split_released: false,
      coupon_reward_id: couponRewardId || null,
      coupon_name: reward ? reward.name : null,
      coupon_discount: couponDiscount,
      coupon_points_spent: couponPointsSpent,
      amount_paid: amountPaid,
      created_at: now.toISOString()
    };

    preparedOrders.push({ order, orderItems, stockistPayout, platformPayout, settlement, effectivePaymentMethod, paymentStatus, couponDiscount, couponPointsSpent, checkoutUrl });
  }

  for (const { order, orderItems, stockistPayout, platformPayout, settlement, effectivePaymentMethod, paymentStatus, couponDiscount, couponPointsSpent } of preparedOrders) {
    const orderId = order.id;
    const stockistId = order.stockist_id;
    await db.insertRow('orders', order);

    for (const oi of orderItems) { oi.order_id = orderId; await db.insertRow('order_items', oi); }

    // Never create HELD split payouts for PAY_AT_HANDOVER
    if (effectivePaymentMethod !== 'PAY_AT_HANDOVER') {
      await db.insertRow('split_payouts', {
        id: 'sp-' + generateId(),
        order_id: orderId,
        stockist_id: stockistId,
        stockist_amount: stockistPayout,
        platform_amount: platformPayout,
        commission_rate_used: settlement.commissionRateUsed,
        earn_rate_used: settlement.earnRateUsed,
        is_cod: effectivePaymentMethod?.includes('COD'),
        status: effectivePaymentMethod === 'ONLINE' ? 'PENDING_PAYMENT' : (paymentStatus === 'HELD' ? 'HELD' : 'PENDING_COD'),
        coupon_cost: couponDiscount,
        created_at: now.toISOString()
      });
    }

    // Payment ledger event
    appendPaymentEvent(orderId, effectivePaymentMethod === 'PAY_AT_HANDOVER' ? 'PAY_AT_HANDOVER_ORDER_CREATED' : (paymentStatus === 'COD' ? 'COD_ORDER_CREATED' : (effectivePaymentMethod === 'ONLINE' ? 'PENDING_PAYMENT' : 'HELD')), order.amount_paid, {
      method: effectivePaymentMethod,
      gateway_order_id: order.razorpay_order_id,
      stockist_share: stockistPayout,
      platform_share: platformPayout - couponDiscount,
      coupon_discount: couponDiscount
    });

    if (couponRewardId && couponPointsSpent > 0) {
      await db.insertRow('points_ledger', {
        id: 'pl-' + generateId(),
        customer_id: customerId,
        type: 'REDEEM',
        redemption_type: 'COUPON',
        amount: -couponPointsSpent,
        order_id: orderId,
        description: `Coupon: ${reward.name}`,
        billing_sync_status: 'PENDING',
        created_at: now.toISOString()
      });
    }

    // Fraud detection
    await runFraudDetection(order, customer);

    createdOrders.push(await enrichOrder(order, req));

    await _sendOrderConfirmedSms(order);

    // Stockist only sees and receives notification for confirmed orders
    if (effectivePaymentMethod !== 'ONLINE' || paymentStatus === 'PAID_ONLINE') {
      try {
        const stockistRow = stockistsTable.find(s => s.id === stockistId);
        if (stockistRow && stockistRow.user_id) {
          await createNotification({
            userId: stockistRow.user_id,
            type: 'new_order',
            title: 'New order',
            body: `Order #${orderId} received`,
            link: `order:${orderId}`
          });
        }
      } catch (notifErr) {
        console.error('[notification] Failed to create new_order notification:', notifErr);
      }
    }
  }

  // Push notification for non-online orders
  try {
    const allSubs = await db.getTable('stockist_push_subscriptions');
    let subsUpdated = false;
    for (const order of createdOrders) {
      if (order.payment_method === 'ONLINE') continue;
      const subs = allSubs.filter(s => s.stockist_id === order.stockist_id);
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            sub.subscription,
            JSON.stringify({ title: 'New Order', body: `New order #${order.id} received.`, url: '/' })
          );
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            const idx = allSubs.indexOf(sub);
            if (idx > -1) {
              allSubs.splice(idx, 1);
              subsUpdated = true;
            }
          } else {
            console.error('[push] Send failed for stockist:', order.stockist_id, err);
          }
        }
      }
    }
    if (subsUpdated) {
      await db.saveTable('stockist_push_subscriptions', allSubs);
    }
  } catch (err) {
    console.error('[push] Error processing push notifications:', err);
  }

  const primaryCheckoutUrl = preparedOrders.find(p => p.checkoutUrl)?.checkoutUrl || null;
  const returnedOrders = createdOrders.map((o, idx) => ({
    ...o,
    ...(preparedOrders[idx]?.checkoutUrl ? { checkout_url: preparedOrders[idx].checkoutUrl } : {})
  }));

  return res.json({
    success: true,
    cart_id: cartId,
    orders: returnedOrders,
    checkout_url: primaryCheckoutUrl,
    // Backwards compat: expose first order's id/points for single-store clients
    orderId: returnedOrders[0].id,
    pointsCredited: returnedOrders.reduce((sum, o) => sum + (o.points_credited || 0), 0),
    totalPointsCredited: returnedOrders.reduce((sum, o) => sum + (o.points_credited || 0), 0),
    margin: returnedOrders[0].margin,
    earnRatePercent: returnedOrders[0].earn_rate_used,
    order: returnedOrders[0]
  });
};
app.post('/api/orders', requireAuth, handleCreateOrderRoute);
app.post('/api/orders/create', requireAuth, handleCreateOrderRoute);

app.post('/api/orders/sync', requireAuth, async (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: 'Invalid sync payload' });
  }

  if (req.user.role !== 'ADMIN' && req.user.role !== 'STOCKIST') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Each queued update is applied exactly like PATCH /api/orders/:id/status,
  // with the same ownership, status-transition and PIN checks.
  let syncCount = 0;
  const results = [];
  for (const upd of updates) {
    if (!upd || typeof upd.orderId !== 'string') {
      results.push({ orderId: upd && upd.orderId, ok: false, error: 'Invalid update' });
      continue;
    }
    const outcome = { statusCode: 200, body: null };
    const captureRes = {
      status(code) { outcome.statusCode = code; return captureRes; },
      json(body) { outcome.body = body; return captureRes; }
    };
    const subReq = Object.create(req);
    subReq.params = { id: upd.orderId };
    subReq.body = { status: upd.status, pin: upd.pin };
    await handleOrderStatusUpdate(subReq, captureRes);
    const ok = outcome.statusCode >= 200 && outcome.statusCode < 300;
    if (ok) syncCount++;
    results.push({ orderId: upd.orderId, ok, error: ok ? undefined : (outcome.body && outcome.body.error) });
  }

  return res.json({ success: true, synced_count: syncCount, failed_count: results.length - syncCount, results });
});
}

module.exports = { registerOrderCreateRoutes };
