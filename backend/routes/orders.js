
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { getCallerStockist, assertOwnsStockist, assertOrderAccess } = require('../lib/access');
const { withLock } = require('../lib/mutex');
const { generateId } = require('../lib/misc');
const { appendAudit, createNotification, appendPaymentEvent } = require('../lib/audit');
const smsHelper = require('../lib/sms');
const whatsapp = require('../lib/whatsapp');
const {
  processOrderCancellation, enrichOrder, ORDER_STATUS_RANK,
  _processReferralBonusOnDelivery, _sendOrderConfirmedSms,
  _sendOrderReadySms, _creditPointsOnDelivery
} = require('../services/orders');

const cfg = require('../config');
const payments = require('../lib/payments');
const { reverseOrderPoints, READY_ORDER_STATUSES, validatePickupSlot, FINAL_ORDER_STATUSES, calculateSettlement } = require('../services/orders');
const { getRegionDeliveryFee } = require('../services/stockists');

const handleOrderStatusUpdate = async (req, res) => {
  const { id } = req.params;
  let { status, pin } = req.body;

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const isAdmin = req.user && req.user.role === 'ADMIN';
  const callerStockist = await getCallerStockist(req);
  if (!isAdmin && (!callerStockist || order.stockist_id !== callerStockist.id)) {
    return res.status(403).json({ error: 'Not authorized for this order' });
  }

  if (status === 'SHIPPED') {
    status = order.fulfillment_type === 'PICKUP' ? 'READY_FOR_PICKUP' : 'OUT_FOR_DELIVERY';
  }

  const validStatuses = ['CONFIRMING', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RECEIVED', 'READY'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid order status' });
  }

  // Final states stay final; repeating the current status is a no-op.
  if (FINAL_ORDER_STATUSES.includes(order.status)) {
    if (order.status === status) return res.json({ success: true, order: await enrichOrder(order, req) });
    if (!(isAdmin && req.body.force && status === 'CANCELLED')) {
      return res.status(400).json({ error: `Order is already ${order.status.toLowerCase()}.`, code: 'ORDER_FINAL' });
    }
  }
  // Orders only move forward (cancellation is handled below).
  if (status !== 'CANCELLED' && (ORDER_STATUS_RANK[status] || 0) < (ORDER_STATUS_RANK[order.status] || 0)) {
    return res.status(400).json({ error: `Cannot move an order from ${order.status} back to ${status}.`, code: 'INVALID_TRANSITION' });
  }

  if ((status === 'DELIVERED' || status === 'PICKED_UP') && !isAdmin) {
    if (!pin || !/^\d{4}$/.test(String(pin).trim())) {
      return res.status(400).json({
        error: 'Direct transition blocked. PIN verification required for handoff completion.',
        code: 'PIN_REQUIRED'
      });
    }
    const validPins = [order.delivery_pin, order.pickup_pin]
      .filter(p => p !== undefined && p !== null && p !== '')
      .map(String);
    if (!validPins.includes(String(pin).trim())) {
      return res.status(400).json({ error: 'Invalid PIN' });
    }
  } else if ((status === 'DELIVERED' || status === 'PICKED_UP') && isAdmin) {
    if (order.fulfillment_type === 'PICKUP' || order.fulfillment_type === 'DELIVERY') {
      await appendAudit(req, 'ADMIN_MANUAL_DELIVERY_OVERRIDE', 'orders', id, null, { note: `Admin overridden PIN for ${status}` });
    }
  }

  if (status === 'CANCELLED') {
    // Only an admin may force-cancel an order past the PENDING stage.
    if (!(isAdmin && req.body.force) && !['CONFIRMING', 'PENDING'].includes(order.status)) {
      return res.status(403).json({
        error: 'Cancellation locked. Stockists can only cancel orders in CONFIRMING or PENDING states.',
        code: 'STOCKIST_CANCEL_LOCKED'
      });
    }
    // Shop- or admin-side cancellation is not the customer's fault: full refund.
    await processOrderCancellation(order, req.user?.role === 'ADMIN' ? 'admin' : 'stockist', { retainCommission: false });
  }

  // Take the stock before saving a "ready" status, so a stock failure leaves the order unchanged.
  if (['READY_FOR_PICKUP', 'READY'].includes(status)) {
    if (!order.stock_decremented) {
      const orderItems = (await db.getTable('order_items')).filter(oi => oi.order_id === id);
      const lockRes = await withLock('stockist_inventory', async () => {
        const inventory = await db.getTable('stockist_inventory');
        let insufficient = null;
        orderItems.forEach(oi => {
          const inv = inventory.find(i => i.stockist_id === order.stockist_id && i.product_id === oi.product_id);
          if (inv && inv.stock_qty < oi.quantity) insufficient = { product: oi.product_id, have: inv.stock_qty, need: oi.quantity };
        });
        if (insufficient) return { insufficient };

        for (const oi of orderItems) {
          const inv = inventory.find(i => i.stockist_id === order.stockist_id && i.product_id === oi.product_id);
          if (inv) {
            const prevStock = inv.stock_qty;
            inv.stock_qty -= parseInt(oi.quantity, 10);
            inv.stock_quantity = inv.stock_qty;
            inv.is_available = inv.stock_qty > 0;
            await db.updateRow('stockist_inventory', inv.id, inv);
            if (prevStock > 0 && inv.stock_qty <= 0) {
              try {
                const stockists = await db.getTable('stockists');
                const stk = stockists.find(s => s.id === order.stockist_id);
                if (stk && stk.user_id) {
                  const products = await db.getTable('products');
                  const p = products.find(prod => prod.id === oi.product_id);
                  await createNotification({
                    userId: stk.user_id,
                    type: 'product_out_of_stock',
                    title: 'Product out of stock',
                    body: `${p ? p.name : 'Product'} is out of stock`,
                    link: `product:${oi.product_id}`
                  });
                }
              } catch (notifErr) {
                console.error('[notification] Failed to create out_of_stock notification:', notifErr);
              }
            }
          }
        }
        return { success: true };
      });

      if (lockRes.insufficient) {
        return res.status(400).json({ 
          error: `Not enough stock to fulfill — you have ${lockRes.insufficient.have}, order needs ${lockRes.insufficient.need}`, 
          code: 'INSUFFICIENT_STOCK' 
        });
      }
      order.stock_decremented = true;
    }
  }

  if (status === 'DELIVERED') {
    const paymentReceivedMethod = req.body.payment_received_method ? String(req.body.payment_received_method).trim().toUpperCase() : null;
    if (order.payment_status === 'UNPAID' || order.payment_method === 'PAY_AT_HANDOVER') {
      if (!paymentReceivedMethod || !['CASH', 'UPI'].includes(paymentReceivedMethod)) {
        if (!isAdmin) {
          return res.status(400).json({ error: 'Payment method required (CASH or UPI)', code: 'PAYMENT_METHOD_REQUIRED' });
        }
        order.payment_status = 'PAID';
        order.payment_received_method = 'CASH';
        order.paid_at = new Date().toISOString();
      } else {
        order.payment_status = 'PAID';
        order.payment_received_method = paymentReceivedMethod;
        order.paid_at = new Date().toISOString();
      }
    } else if (paymentReceivedMethod && ['CASH', 'UPI'].includes(paymentReceivedMethod)) {
      order.payment_status = 'PAID';
      order.payment_received_method = paymentReceivedMethod;
      order.paid_at = new Date().toISOString();
    }
  }

  if (status !== 'CANCELLED') order.status = status;
  await db.updateRow('orders', order.id, order);

  if (['READY_FOR_PICKUP', 'READY'].includes(status)) {
    await _sendOrderReadySms(order);
  }

  if (status === 'OUT_FOR_DELIVERY') {
    try {
      const users = await db.getTable('users');
      const customer = users.find(u => u.id === order.customer_id);
      const phone = customer ? customer.phone : order.customer_phone;
      if (phone) {
        const stockists = await db.getTable('stockists');
        const stockist = stockists.find(s => s.id === order.stockist_id);
        const stockistName = stockist ? stockist.name : 'Stockist';
        try {
          await smsHelper.sendTemplateSms(phone, 'OUT_FOR_DELIVERY', { orderId: order.id, shopName: stockistName });
        } catch (sErr) {}
        try {
          await whatsapp.sendWhatsAppUpdate({
            phone,
            templateKey: 'OUT_FOR_DELIVERY',
            params: { orderId: order.id, shopName: stockistName },
            user: customer
          });
        } catch (waErr) {
          console.warn('[whatsapp:out_for_delivery] Warning:', waErr.message);
        }
      }
    } catch (notifErr) {
      console.warn('[notification:out_for_delivery] Error:', notifErr.message);
    }
  }

  if (status === 'DELIVERED') {
    try {
      const users = await db.getTable('users');
      const customer = users.find(u => u.id === order.customer_id);
      const phone = customer ? customer.phone : order.customer_phone;
      if (phone) {
        const pts = order.points_credited || 0;
        try {
          await smsHelper.sendTemplateSms(phone, 'ORDER_DELIVERED', { orderId: order.id, points: pts });
        } catch (sErr) {}
        try {
          await whatsapp.sendWhatsAppUpdate({
            phone,
            templateKey: 'ORDER_DELIVERED',
            params: { orderId: order.id, points: pts },
            user: customer
          });
        } catch (waErr) {
          console.warn('[whatsapp:order_delivered] Warning:', waErr.message);
        }
      }
    } catch (notifErr) {
      console.warn('[notification:order_delivered] Error:', notifErr.message);
    }
  }

  if (status === 'DELIVERED') {
    // §REGULATORY: credit points only on delivery
    if (order.commission_model !== 'gross_v1') {
      const products = await db.getTable('products');
      const orderItems = (await db.getTable('order_items')).filter(oi => oi.order_id === id);
      let totalProfitMargin = 0;
      orderItems.forEach(oi => {
        const product = products.find(p => p.id === oi.product_id);
        const cost = product ? parseFloat(product.cost_price) : oi.cost_price || oi.price * 0.75;
        totalProfitMargin += (oi.price - cost) * oi.quantity;
      });
      const settlement = await calculateSettlement(order.subtotal, totalProfitMargin, order.stockist_id, order.region_id);
      order.points_credited = settlement.pointsCredited;
      await db.updateRow('orders', order.id, order);
    }
    await _creditPointsOnDelivery(order);
    await _processReferralBonusOnDelivery(order);

    // Commission accrues ONLY on delivery: for COD and PAY_AT_HANDOVER
    if (order.payment_method?.includes('COD') || order.payment_status === 'COD' || order.payment_method === 'PAY_AT_HANDOVER') {
      const codLedger = await db.getTable('cod_commission_ledger');
      // guard against double-accrual
      const already = codLedger.some(e => e.order_id === order.id);
      if (!already) {
        const payout = (await db.getTable('split_payouts')).find(sp => sp.order_id === order.id);
        const platformCommission = payout ? parseFloat(payout.platform_amount) : (parseFloat(order.platform_commission) || 0);
        await db.insertRow('cod_commission_ledger', {
          id: 'cod-' + generateId(),
          stockist_id: order.stockist_id,
          order_id: order.id,
          amount_owed: platformCommission,
          settled: false,
          created_at: new Date().toISOString()
        });
        appendPaymentEvent(order.id, 'COD_COMMISSION_ACCRUED', platformCommission, { stockist_id: order.stockist_id });
      }
    }

    // Release split if HELD or ONLINE
    if (order.payment_method === 'ONLINE' || order.payment_status === 'PAID_ONLINE') {
      const stockists = await db.getTable('stockists');
      const stockist = stockists.find(s => s.id === order.stockist_id);
      const splitPayouts = await db.getTable('split_payouts');
      const payout = splitPayouts.find(sp => sp.order_id === order.id);
      try {
        const releaseRes = await payments.releaseTransfer({ order, splitPayout: payout, stockist });
        order.split_released = true;
        order.transfer_released = true;
        if (releaseRes.transfer_id) order.razorpay_transfer_id = releaseRes.transfer_id;
        await db.updateRow('orders', order.id, order);

        if (payout) {
          payout.status = 'SPLIT_RELEASED';
          await db.updateRow('split_payouts', payout.id, payout);
        }
        appendPaymentEvent(order.id, 'TRANSFER_RELEASED', payout ? payout.stockist_amount : 0, {
          stockist_id: order.stockist_id,
          transfer_id: releaseRes.transfer_id
        });
      } catch (transferErr) {
        console.error('[payment:delivery] Failed to release transfer:', transferErr);
      }
    }
  }

  return res.json({ success: true, order: await enrichOrder(order, req) });
};

function registerOrderRoutes(app) {
app.post('/api/orders/:id/cancel', requireAuth, async (req, res) => {
  const { id } = req.params;
  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'ADMIN' && req.user.userId !== order.customer_id) return res.status(403).json({ error: 'Forbidden' });

  if (['CANCELLED', 'DELIVERED'].includes(order.status)) {
    return res.status(400).json({ error: 'Order is already completed or cancelled' });
  }

  if (['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'].includes(order.status)) {
    return res.status(400).json({
      error: 'Order is ready or out for delivery, cancellation locked',
      code: 'CANCEL_LOCKED_READY'
    });
  }

  const now = new Date();
  const deadline = new Date(order.cancel_deadline || order.created_at);
  if (now > deadline) {
    return res.status(400).json({
      error: 'Cancellation window has closed. You can no longer cancel this order.',
      code: 'CANCEL_WINDOW_CLOSED'
    });
  }

  if (!['CONFIRMING', 'PENDING', 'ACCEPTED', 'PREPARING'].includes(order.status)) {
    return res.status(400).json({ error: 'Order status does not allow cancellation' });
  }

  // Inside the free cancellation window: full refund, no platform fee retained.
  await processOrderCancellation(order, 'customer', { retainCommission: false });

  // Record no-show / late cancel on customer profile
  const users = await db.getTable('users');
  const custIdx = users.findIndex(u => u.id === order.customer_id);
  if (custIdx > -1) {
    if (!users[custIdx].no_show_count) users[custIdx].no_show_count = 0;
  }

  await db.updateRow('orders', order.id, order);
  if (custIdx > -1) await db.updateRow('users', order.customer_id, users[custIdx]);

  // Reverse any points that may have been credited (safety guard — should be 0 per regulatory constraint)
  await reverseOrderPoints(id);

  return res.json({ success: true, order: await enrichOrder(order, req) });
});

// No-show action: RESCHEDULE or CANCEL
app.post('/api/orders/:id/noshw-action', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action, newSlot } = req.body;

  if (!['RESCHEDULE', 'CANCEL'].includes(action)) {
    return res.status(400).json({ error: 'action must be RESCHEDULE or CANCEL' });
  }

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!await assertOrderAccess(req, res, order)) return;
  if (req.user.role === 'STOCKIST') return res.status(403).json({ error: 'Forbidden' });

  // A no-show only applies to an order that is waiting at the shop for pickup.
  if (!READY_ORDER_STATUSES.includes(order.status) || order.fulfillment_type !== 'PICKUP') {
    return res.status(400).json({ error: 'No-show actions are only available for orders ready for pickup.', code: 'NOT_A_NO_SHOW' });
  }

  if (action === 'RESCHEDULE') {
    if (order.reschedule_used) {
      return res.status(400).json({ error: 'Reschedule already used. You may only reschedule once.' });
    }
    if (!newSlot) {
      return res.status(400).json({ error: 'newSlot is required for reschedule' });
    }
    const slotError = validatePickupSlot(newSlot);
    if (slotError) return res.status(400).json({ error: slotError });
    order.pickup_slot = newSlot;
    order.reschedule_used = true;
    order.status = 'READY'; // Still ready at the shop, for the new pickup window
    await db.updateRow('orders', order.id, order);
    return res.json({ success: true, order: await enrichOrder(order, req) });
  }

  if (action === 'CANCEL') {
    // A no-show is the customer's fault, so the platform fee is retained.
    await processOrderCancellation(order, req.user?.role?.toLowerCase() || 'system', { retainCommission: true });

    // Record no-show on customer profile
    const users = await db.getTable('users');
    const custIdx = users.findIndex(u => u.id === order.customer_id);
    if (custIdx > -1) {
      users[custIdx].no_show_count = (users[custIdx].no_show_count || 0) + 1;
      if (users[custIdx].no_show_count >= cfg.MAX_NOSHOWS_BEFORE_RESTRICTION) {
        users[custIdx].prepaid_pickup_restricted = true;
      }
    }
    if (custIdx > -1) await db.updateRow('users', order.customer_id, users[custIdx]);

    await db.updateRow('orders', order.id, order);
    await reverseOrderPoints(id);
    return res.json({ success: true, order: await enrichOrder(order, req) });
  }
});

// Verify pickup PIN and complete order
app.post('/api/orders/:id/verify-pickup', requireAuth, async (req, res) => {
  const { id } = req.params;
  const pin = req.body.pin || req.body.pickup_pin;

  if (!pin || !/^\d{4}$/.test(String(pin).trim())) {
    return res.status(400).json({ error: 'Incorrect pickup verification PIN.' });
  }

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'ADMIN') {
    const callerStockist = await getCallerStockist(req);
    if (!callerStockist || callerStockist.id !== order.stockist_id) return res.status(403).json({ error: 'Forbidden' });
  }

  if (FINAL_ORDER_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: `Order is already ${order.status.toLowerCase()}.`, code: 'ORDER_FINAL' });
  }
  if (!order.pickup_pin || String(order.pickup_pin) !== String(pin || '').trim()) {
    return res.status(400).json({ error: 'Incorrect pickup verification PIN.' });
  }

  const isAdmin = req.user.role === 'ADMIN';
  const paymentReceivedMethod = req.body.payment_received_method ? String(req.body.payment_received_method).trim().toUpperCase() : null;
  if (order.payment_status === 'UNPAID' || order.payment_method === 'PAY_AT_HANDOVER') {
    if (!paymentReceivedMethod || !['CASH', 'UPI'].includes(paymentReceivedMethod)) {
      if (!isAdmin) {
        return res.status(400).json({ error: 'Payment method required (CASH or UPI)', code: 'PAYMENT_METHOD_REQUIRED' });
      }
      order.payment_status = 'PAID';
      order.payment_received_method = 'CASH';
      order.paid_at = new Date().toISOString();
    } else {
      order.payment_status = 'PAID';
      order.payment_received_method = paymentReceivedMethod;
      order.paid_at = new Date().toISOString();
    }
  } else if (paymentReceivedMethod && ['CASH', 'UPI'].includes(paymentReceivedMethod)) {
    order.payment_status = 'PAID';
    order.payment_received_method = paymentReceivedMethod;
    order.paid_at = new Date().toISOString();
  }

  order.status = 'DELIVERED';
  await db.updateRow('orders', order.id, order);

  // §REGULATORY: Points credited only on delivery confirmation
  await _creditPointsOnDelivery(order);
  await _processReferralBonusOnDelivery(order);

  // Commission accrues ONLY on delivery: for COD and PAY_AT_HANDOVER
  if (order.payment_method?.includes('COD') || order.payment_status === 'COD' || order.payment_method === 'PAY_AT_HANDOVER') {
    const codLedger = await db.getTable('cod_commission_ledger');
    // guard against double-accrual
    const already = codLedger.some(e => e.order_id === order.id);
    if (!already) {
      const payout = (await db.getTable('split_payouts')).find(sp => sp.order_id === order.id);
      const platformCommission = payout ? parseFloat(payout.platform_amount) : (parseFloat(order.platform_commission) || 0);
      await db.insertRow('cod_commission_ledger', {
        id: 'cod-' + generateId(),
        stockist_id: order.stockist_id,
        order_id: order.id,
        amount_owed: platformCommission,
        settled: false,
        created_at: new Date().toISOString()
      });
      appendPaymentEvent(order.id, 'COD_COMMISSION_ACCRUED', platformCommission, { stockist_id: order.stockist_id });
    }
  }

  const splitPayouts = await db.getTable('split_payouts');
  const payout = splitPayouts.find(sp => sp.order_id === id);
  if (payout) {
    payout.status = 'PROCESSED_IMMEDIATELY';
    await db.updateRow('split_payouts', payout.id, payout);
  }

  if (order.payment_method === 'ONLINE' || order.payment_status === 'PAID_ONLINE') {
    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === order.stockist_id);
    try {
      const releaseRes = await payments.releaseTransfer({ order, splitPayout: payout, stockist });
      order.split_released = true;
      order.transfer_released = true;
      if (releaseRes.transfer_id) order.razorpay_transfer_id = releaseRes.transfer_id;
      await db.updateRow('orders', order.id, order);

      if (payout) {
        payout.status = 'SPLIT_RELEASED';
        await db.updateRow('split_payouts', payout.id, payout);
      }
      appendPaymentEvent(order.id, 'TRANSFER_RELEASED', payout ? payout.stockist_amount : 0, {
        stockist_id: order.stockist_id,
        transfer_id: releaseRes.transfer_id
      });
    } catch (transferErr) {
      console.error('[payment:verify-pickup] Failed to release transfer:', transferErr);
    }
  }

  return res.json({ success: true, order: await enrichOrder(order, req) });
});

app.patch('/api/orders/:id/acknowledge', requireAuth, async (req, res) => {
  let stockistId = req.headers['x-user-id'];
  if (req.user.role !== 'ADMIN') {
    const callerStockist = await getCallerStockist(req);
    if (!callerStockist) return res.status(403).json({ error: 'Unauthorized' });
    stockistId = callerStockist.id;
  }
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  
  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'ADMIN' && order.stockist_id !== stockistId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  if (!order.acknowledged_at) {
    order.acknowledged_at = new Date().toISOString();
    await db.saveTable('orders', orders);
  }
  res.json({ success: true, order });
});


app.get('/api/orders', requireAuth, async (req, res) => {
  let { customerId, stockistId } = req.query;
  if (req.user.role === 'CUSTOMER') {
    if (customerId && customerId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
    customerId = req.user.userId;
  } else if (req.user.role === 'STOCKIST') {
    const callerStockist = await getCallerStockist(req);
    if (!callerStockist) return res.status(403).json({ error: 'Forbidden' });
    if (stockistId && stockistId !== callerStockist.id) return res.status(403).json({ error: 'Forbidden' });
    stockistId = callerStockist.id;
  }
  const orders = await db.getTable('orders');
  let filtered = orders;

  if (customerId) filtered = filtered.filter(o => o.customer_id === customerId);
  if (stockistId) filtered = filtered.filter(o => o.stockist_id === stockistId);

  // Shop isolation: stockist never sees online orders that are not PAID_ONLINE
  if (stockistId && !customerId) {
    filtered = filtered.filter(o => !(o.payment_method === 'ONLINE' && o.payment_status !== 'PAID_ONLINE'));
  }

  // For stockist view: transition CONFIRMING→PENDING in DB if window has closed
  if (stockistId && !customerId) {
    const now = new Date();
    // Transition CONFIRMING→PENDING in DB if window has closed
    const allOrders = await db.getTable('orders');
    let changed = false;
    allOrders.forEach(o => {
      if (o.status === 'CONFIRMING' && o.stockist_id === stockistId && new Date(o.cancel_deadline) <= now) {
        if (!(o.payment_method === 'ONLINE' && o.payment_status !== 'PAID_ONLINE')) {
          o.status = 'PENDING';
          changed = true;
        }
      }
    });
    if (changed) await db.saveTable('orders', allOrders);
  }

  const enriched = (await Promise.all(filtered.map(o => enrichOrder(o, req)))).reverse();
  return res.json(enriched);
});

// Update Order Status (also used for each entry of the offline sync)
app.patch('/api/orders/:id/status', requireAuth, handleOrderStatusUpdate);

// PATCH fulfillment — slot change enforced, one-way delivery switch
app.patch('/api/orders/:id/fulfillment', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { fulfillmentType, pickupSlot } = req.body;

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!await assertOrderAccess(req, res, order)) return;
  if (req.user.role === 'STOCKIST') return res.status(403).json({ error: 'Forbidden' });

  if ((fulfillmentType || pickupSlot !== undefined) && FINAL_ORDER_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: `Order is already ${order.status.toLowerCase()}.`, code: 'ORDER_FINAL' });
  }

  if (fulfillmentType) {
    if (fulfillmentType === 'PICKUP') {
      if (order.fulfillment_type === 'DELIVERY') {
        return res.status(400).json({ error: 'Already switched to delivery. Cannot switch back.', code: 'ONE_WAY_DELIVERY' });
      }
      order.fulfillment_type = 'PICKUP';
    } else if (fulfillmentType === 'DELIVERY') {
      if (order.fulfillment_type !== 'DELIVERY') {
        // Once the order is handed over or out, the fulfillment can no longer change.
        if ((ORDER_STATUS_RANK[order.status] || 0) >= ORDER_STATUS_RANK.READY) {
          return res.status(400).json({ error: 'Fulfillment is locked once the order is ready.', code: 'FULFILLMENT_LOCKED' });
        }
        order.fulfillment_type = 'DELIVERY';
        const stockistsTable = await db.getTable('stockists');
        const stockist = stockistsTable.find(s => s.id === order.stockist_id);
        const regionsTable = await db.getTable('regions');
        const regionRow = regionsTable.find(r => r.id === (stockist || {}).region_id);
        const deliveryFee = getRegionDeliveryFee(regionRow);
        if (deliveryFee === null) {
          return res.status(400).json({ error: 'delivery_unavailable', message: 'Home delivery is not available for this shop yet.' });
        }

        order.delivery_fee = deliveryFee;
        order.total_price = order.subtotal + deliveryFee + (order.low_order_fee || 0);
        order.amount_paid = Math.max(0, order.subtotal - (order.coupon_discount || 0)) + deliveryFee + (order.low_order_fee || 0);
        order.pickup_slot = null;

        // Keep the split computed at checkout and only add the delivery fee to the
        // stockist's share; the platform share does not change with fulfillment.
        const splitPayouts = await db.getTable('split_payouts');
        const payout = splitPayouts.find(sp => sp.order_id === id);
        // (The switch is one-way from pickup, so no earlier delivery fee is included.)
        const stockistPayout = payout
          ? Math.round((parseFloat(payout.stockist_amount) + deliveryFee) * 100) / 100
          : null;
        const platformPayout = payout ? parseFloat(payout.platform_amount) : null;
        if (order.stockist_payout !== undefined && order.stockist_payout !== null) {
          order.stockist_payout = Math.round((parseFloat(order.stockist_payout) + deliveryFee) * 100) / 100;
        }

        if (payout) {
          payout.stockist_amount = stockistPayout;
          payout.platform_amount = platformPayout;
          await db.updateRow('split_payouts', payout.id, payout);
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid parameters.' });
    }
  }

  if (pickupSlot !== undefined) {
    // §E14: slot is locked once order is READY_FOR_PICKUP or later
    const lockedStatuses = ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP'];
    if (lockedStatuses.includes(order.status)) {
      return res.status(400).json({ error: 'Pickup slot is locked once the order is ready for pickup.', code: 'SLOT_LOCKED' });
    }
    if (order.fulfillment_type === 'DELIVERY') {
      return res.status(400).json({ error: 'Cannot set pickup slot for delivery orders.' });
    }
    const slotError = validatePickupSlot(pickupSlot);
    if (slotError) return res.status(400).json({ error: slotError });
    order.pickup_slot = pickupSlot;
  }

  await db.updateRow('orders', order.id, order);
  return res.json({ success: true, order: await enrichOrder(order, req) });
});
}

module.exports = { registerOrderRoutes, handleOrderStatusUpdate };
