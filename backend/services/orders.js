
const db = require('../db');
const cfg = require('../config');
const smsHelper = require('../lib/sms');
const whatsapp = require('../lib/whatsapp');
const { generateId } = require('../lib/misc');
const { appendPaymentEvent, createNotification } = require('../lib/audit');
const { getCallerStockist } = require('../lib/access');

async function getCommissionConfig(stockistId = null) {
  const configs = await db.getTable('commission_config');
  if (stockistId) {
    const storeCfg = configs.find(c => c.scope === 'STORE' && c.stockist_id === stockistId);
    if (storeCfg) return storeCfg;
  }
  const globalCfg = configs.find(c => c.scope === 'GLOBAL');
  if (globalCfg) return globalCfg;

  console.error('[CommissionConfig] Missing config row in database! Falling back to 50/40/12 defaults.');
  return {
    id: 'cc-fallback',
    scope: 'GLOBAL',
    stockist_id: null,
    stockist_reinvest_pct: 50,
    points_from_pot_pct: 40,
    partner_redemption_cut_pct: 12
  };
}

// Helper: Calculate Partner Payout
async function calculatePartnerPayout(redemptionValue, stockistId = null) {
  const cfg = await getCommissionConfig(stockistId);
  const cutPct = parseFloat(cfg.partner_redemption_cut_pct);
  const platformCut = Math.round(redemptionValue * cutPct) / 100;
  const partnerPayout = Math.round((redemptionValue - platformCut) * 100) / 100;
  return { platformCut, partnerPayout, cutPctUsed: cutPct };
}

// Helper: Settlement Engine (Profit-basis v2)
async function calculateSettlement(subtotal, totalProfitMargin, stockistId, _regionId) {
  const cfg = await getCommissionConfig(stockistId);

  // 2.1 Guard against negative or zero profit
  if (!totalProfitMargin || totalProfitMargin <= 0) {
    console.warn(`[Settlement] Non-positive profit margin (${totalProfitMargin}) for stockist ${stockistId}. Setting settlement outputs to 0.`);
    return {
      commission_model: 'profit_v2',
      config_row_id: cfg ? cfg.id : null,
      stockistReinvest: 0,
      platformPot: 0,
      platformCommission: 0,
      pointsCredited: 0,
      commissionRateUsed: null,
      earnRateUsed: null
    };
  }

  const reinvestPct = parseFloat(cfg.stockist_reinvest_pct) || 50;
  const pointsPct = parseFloat(cfg.points_from_pot_pct) || 40;

  const stockistReinvest = totalProfitMargin * (reinvestPct / 100);
  const platformPot = totalProfitMargin - stockistReinvest;

  const pointsCredited = Math.round(platformPot * (pointsPct / 100) * 100) / 100;
  const platformCommission = Math.round((platformPot - pointsCredited) * 100) / 100;

  return {
    commission_model: 'profit_v2',
    config_row_id: cfg.id,
    stockistReinvest,
    platformPot,
    platformCommission,
    pointsCredited,
    commissionRateUsed: null,
    earnRateUsed: null
  };
}

// Helper: Reverse points if order is cancelled (only if points were already credited)
async function reverseOrderPoints(orderId) {
  const ledger = await db.getTable('points_ledger');
  let _changed = false;

  const existingEarn = ledger.find(l => l.order_id === orderId && l.type === 'EARN');
  if (existingEarn) {
    const alreadyReversed = ledger.some(l => l.order_id === orderId && l.type === 'REVERSAL');
    if (!alreadyReversed) {
      await db.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: existingEarn.tenant_id,
        region_id: existingEarn.region_id,
        customer_id: existingEarn.customer_id,
        amount: -existingEarn.amount,
        type: 'REVERSAL',
        order_id: orderId,
        description: `Reversal of points earned from Cancelled Order #${orderId.substring(2).toUpperCase()}`,
        created_at: new Date().toISOString(),
        billing_sync_status: 'PENDING'
      });
      _changed = true;
    }
  }

  const existingCoupon = ledger.find(l => l.order_id === orderId && l.type === 'REDEEM' && l.redemption_type === 'COUPON');
  if (existingCoupon) {
    const alreadyCouponReversed = ledger.some(l => l.order_id === orderId && l.type === 'COUPON_REVERSAL');
    if (!alreadyCouponReversed) {
      await db.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: existingCoupon.tenant_id,
        region_id: existingCoupon.region_id,
        customer_id: existingCoupon.customer_id,
        amount: Math.abs(existingCoupon.amount),
        type: 'COUPON_REVERSAL',
        order_id: orderId,
        description: `Coupon points returned: cancelled order #${orderId.substring(2).toUpperCase()}`,
        created_at: new Date().toISOString(),
        billing_sync_status: 'PENDING'
      });
      _changed = true;
    }
  }

  // Points still held for bill verification are voided so they can never be
  // released for a cancelled order.
  const heldRows = ledger.filter(l => l.order_id === orderId && l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD');
  for (const heldRow of heldRows) {
    const alreadySettled = ledger.some(l => l.reference_id === heldRow.id && (l.type === 'EARN' || l.type === 'EARN_VOID'));
    if (!alreadySettled) {
      await db.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: heldRow.tenant_id,
        region_id: heldRow.region_id,
        customer_id: heldRow.customer_id,
        amount: 0, // held points were never in the balance, so nothing to take back
        type: 'EARN_VOID',
        order_id: orderId,
        description: `Held points (${heldRow.amount}) voided: cancelled order #${orderId.substring(2).toUpperCase()}`,
        created_at: new Date().toISOString(),
        billing_sync_status: 'VOIDED',
        reference_id: heldRow.id
      });
    }
    await db.updateRow('points_ledger', heldRow.id, { billing_sync_status: 'VOIDED' });
  }

  // db.saveTable('points_ledger') is strictly forbidden
}

// retainCommission: keep the platform fee out of the refund. Only a customer
// no-show does that; free-window and shop/admin cancellations refund in full.
async function processOrderCancellation(order, cancelledBy = 'system', { retainCommission = false } = {}) {
  order.cancelled_from_status = order.status;
  order.cancelled_by = cancelledBy;
  order.cancelled_at = new Date().toISOString();
  order.status = 'CANCELLED';

  // Restore stock ONLY if it was actually decremented (order had been marked READY)
  if (order.stock_decremented && !order.stock_restored) {
    const orderItems = (await db.getTable('order_items')).filter(oi => oi.order_id === order.id);
    if (orderItems.length > 0) {
      const inventory = await db.getTable('stockist_inventory');
      let changed = false;
      orderItems.forEach(oi => {
        const inv = inventory.find(i => i.stockist_id === order.stockist_id && i.product_id === oi.product_id);
        if (inv) {
          inv.stock_qty += parseInt(oi.quantity, 10);
          inv.stock_quantity = inv.stock_qty;              // keep both fields in sync (creation uses both)
          inv.is_available = inv.stock_qty > 0;
          changed = true;
        }
      });
      if (changed) await db.saveTable('stockist_inventory', inventory);
    }
    order.stock_restored = true;   // idempotency guard — never restore twice
  }

  // Remove any COD commission accrued for this order (it never completed)
  const codLedger = await db.getTable('cod_commission_ledger');
  const filtered = codLedger.filter(e => e.order_id !== order.id);
  if (filtered.length !== codLedger.length) {
    await db.saveTable('cod_commission_ledger', filtered);
  }

  await reverseOrderPoints(order.id);

  // Mark split_payouts row and any payout-due entry CANCELLED (keep for history)
  const splitPayouts = await db.getTable('split_payouts');
  let spChanged = false;
  for (const sp of splitPayouts) {
    if (sp.order_id === order.id && sp.status !== 'CANCELLED') {
      sp.status = 'CANCELLED';
      spChanged = true;
    }
  }
  if (spChanged) {
    await db.saveTable('split_payouts', splitPayouts);
  }

  // Refund only when money was received:
  // UNPAID -> payment_status 'CANCELLED_UNPAID', no refund.
  // Only PAID, PAID_ONLINE, or HELD orders become REFUND_DUE, with refund_amount = amount received minus any commission the policy keeps.
  // The actual gateway refund happens when the admin triggers it via POST /api/admin/orders/:id/refund (Rule 6).
  if (order.payment_status === 'HELD' || order.payment_status === 'PAID' || order.payment_status === 'PAID_ONLINE') {
    const payout = splitPayouts.find(sp => sp.order_id === order.id);
    const platformCommission = retainCommission && payout ? parseFloat(payout.platform_amount) : 0;

    let orderAmountPaid = order.amount_paid !== undefined && order.amount_paid !== null ? order.amount_paid : order.total_price;
    const refundAmount = Math.round(Math.max(0, orderAmountPaid - platformCommission) * 100) / 100;

    order.payment_status = 'REFUND_DUE';
    order.refund_amount = refundAmount;
    appendPaymentEvent(order.id, 'REFUND_DUE', refundAmount, {
      reason: 'Order cancellation',
      commission_retained: platformCommission
    });
    try {
      const users = await db.getTable('users');
      const customer = users.find(u => u.id === order.customer_id);
      const phone = customer ? customer.phone : order.customer_phone;
      if (phone) {
        try {
          await smsHelper.sendTemplateSms(phone, 'ORDER_CANCELLED', { orderId: order.id });
        } catch (sErr) {}
        try {
          await whatsapp.sendWhatsAppUpdate({
            phone,
            templateKey: 'ORDER_CANCELLED',
            params: { orderId: order.id },
            user: customer
          });
        } catch (waErr) {
          console.warn('[whatsapp:order_cancelled] Warning:', waErr.message);
        }
      }
    } catch (notifErr) {}
  } else if (order.payment_status !== 'REFUNDED') {
    order.payment_status = 'CANCELLED_UNPAID';
    order.refund_amount = 0;
  }

  // If cancelled by customer, update new_order notification item text and write order_cancelled notification
  if (cancelledBy === 'customer') {
    try {
      const stockists = await db.getTable('stockists');
      const stockistRow = stockists.find(s => s.id === order.stockist_id);
      if (stockistRow && stockistRow.user_id) {
        const notifs = await db.getTable('notifications');
        const existing = notifs.find(n => n.link === `order:${order.id}` && n.type === 'new_order');
        if (existing) {
          existing.body = 'Cancelled by customer';
          await db.updateRow('notifications', existing.id, { body: 'Cancelled by customer' });
        }
        await createNotification({
          userId: stockistRow.user_id,
          type: 'order_cancelled',
          title: 'Order cancelled',
          body: 'Cancelled by customer',
          link: `order:${order.id}`
        });
      }
    } catch (notifErr) {
      console.error('[notification] Failed to process order cancellation notification:', notifErr);
    }
  }
}

// Helper: Enrich Order
async function enrichOrder(o, req = null) {
  if (!o) return null;
  const orderItems = await db.getTable('order_items');
  const users = await db.getTable('users');
  const splitPayouts = await db.getTable('split_payouts');
  const feedbacks = await db.getTable('feedback_reports');
  const stockists = await db.getTable('stockists');

  const items = orderItems.filter(oi => oi.order_id === o.id);
  const customer = users.find(u => u.id === o.customer_id);
  const payout = splitPayouts.find(sp => sp.order_id === o.id);
  const stockistFeedback = feedbacks.find(fb => fb.order_id === o.id && fb.reporter_role === 'STOCKIST');
  const stockist = stockists.find(s => s.id === o.stockist_id);

  let platformCommission = o.platform_commission;
  let stockistPayout = o.stockist_payout;

  if (platformCommission === undefined) {
    if (payout) {
      platformCommission = parseFloat(payout.platform_amount);
    } else {
      const stockistCommissionRates = await db.getTable('stockist_commission_rates');
      const scr = stockistCommissionRates.find(r => r.stockist_id === o.stockist_id);
      const commissionRate = scr ? parseFloat(scr.rate_percent) : 10.00;
      platformCommission = (o.subtotal * commissionRate) / 100;
    }
  }

  if (stockistPayout === undefined) {
    if (payout) {
      stockistPayout = parseFloat(payout.stockist_amount);
    } else {
      stockistPayout = o.subtotal - platformCommission + (o.delivery_fee || 0);
    }
  }

  const platformPayout = payout ? parseFloat(payout.platform_amount) : (platformCommission + (o.low_order_fee || 0));

  let strippedPin = o.pickup_pin;
  if (req && req.user && req.user.role !== 'ADMIN' && req.user.role !== 'CUSTOMER') {
    strippedPin = undefined;
  } else if (!req || !req.user) {
    strippedPin = undefined;
  }

  const caller = req && req.user ? req.user : null;
  const role = caller ? caller.role : null;
  const callerUserId = caller ? (caller.userId || caller.id) : null;
  const isAdmin = role === 'ADMIN';

  const isOrderActive = !['DELIVERED', 'CANCELLED', 'NO_SHOW'].includes(o.status);
  const isOwnCustomer = Boolean(role === 'CUSTOMER' && callerUserId && callerUserId === o.customer_id);
  const isOwnActiveCustomer = isOwnCustomer && isOrderActive;

  let isOwnStockist = false;
  if (role === 'STOCKIST') {
    const callerStockist = await getCallerStockist(req);
    if (callerStockist && callerStockist.id === o.stockist_id) {
      isOwnStockist = true;
    }
  }

  // 4. Expose only contact_phone on customer's own active order (or admin/own stockist)
  const canSeeShopPhone = isAdmin || isOwnStockist || isOwnActiveCustomer;
  const shopContactPhone = canSeeShopPhone && stockist ? (stockist.contact_phone || stockist.phone || null) : undefined;

  // 5. Expose payout_upi_id / stockist_upi_id on customer's own active order (or admin/own stockist)
  const canSeeShopUpi = isAdmin || isOwnStockist || isOwnActiveCustomer;
  const shopUpi = canSeeShopUpi && stockist ? (stockist.payout_upi_id || stockist.upi_id || null) : undefined;

  // Customer phone: only admin, own customer, or own stockist
  const canSeeCustomerPhone = isAdmin || isOwnCustomer || isOwnStockist || !caller;
  const customerPhone = canSeeCustomerPhone ? (customer ? customer.phone : '') : undefined;

  const enriched = {
    ...o,
    pickup_pin: strippedPin,
    items,
    pointsCredited: o.points_credited !== undefined ? o.points_credited : 0,
    points_credited: o.points_credited !== undefined ? o.points_credited : 0,
    earnRatePercent: o.earn_rate_used !== undefined ? o.earn_rate_used : 40,
    earn_rate_used: o.earn_rate_used !== undefined ? o.earn_rate_used : 40,
    customer_name: customer ? customer.name : 'Unknown Subscriber',
    customer_phone: customerPhone,
    stockist_reviewed: !!stockistFeedback,
    payment_received_method: o.payment_received_method || null,
    paid_at: o.paid_at || null,
    amount_paid: o.amount_paid !== undefined && o.amount_paid !== null ? o.amount_paid : o.total_price,
    points_status: (await db.getTable('points_ledger')).some(l => l.order_id === o.id && l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD') ? 'HELD' : 'CREDITED'
  };

  if (shopUpi !== undefined) {
    enriched.payout_upi_id = shopUpi;
    enriched.stockist_upi_id = shopUpi;
  } else {
    delete enriched.payout_upi_id;
    delete enriched.stockist_upi_id;
  }

  if (shopContactPhone !== undefined) {
    enriched.contact_phone = shopContactPhone;
  } else {
    delete enriched.contact_phone;
  }

  // Remove any stray shop phone or user_id fields
  delete enriched.phone;
  delete enriched.released_phone;
  delete enriched.user_id;

  enriched.commission_model = o.commission_model || 'gross_v1';

  // Commission data: only for admin, own stockist, or internal calls without caller
  const canSeeCommission = isAdmin || isOwnStockist || !caller;
  if (canSeeCommission) {
    enriched.platform_commission = platformCommission;
    enriched.stockist_payout = stockistPayout;
    enriched.stockist_amount = stockistPayout;
    enriched.platform_amount = platformPayout;
    enriched.margin = o.margin !== undefined ? o.margin : (o.subtotal * 0.25);
  } else {
    delete enriched.platform_commission;
    delete enriched.stockist_payout;
    delete enriched.stockist_amount;
    delete enriched.platform_amount;
    delete enriched.margin;
    delete enriched.commission_rate;
  }

  return enriched;
}

// Helper: Run fraud detection scoring after an order is created
async function runFraudDetection(order, customer) {
  const orders = await db.getTable('orders');
  const allCustomerOrders = orders.filter(o => o.customer_id === customer.id);
  const rulesFired = [];
  const metricValues = {};

  // Rule 1: Repeat-pair frequency vs. region average
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentPairOrders = allCustomerOrders.filter(o => o.stockist_id === order.stockist_id && o.created_at >= last24h);
  const allRegionPairs = orders.filter(o => o.region_id === customer.region_id && o.created_at >= last24h);
  const uniquePairs = {};
  allRegionPairs.forEach(o => {
    const key = `${o.customer_id}:${o.stockist_id}`;
    uniquePairs[key] = (uniquePairs[key] || 0) + 1;
  });
  const pairCounts = Object.values(uniquePairs);
  const regionAvg = pairCounts.length > 0 ? pairCounts.reduce((s, v) => s + v, 0) / pairCounts.length : 1;
  metricValues.pair_count = recentPairOrders.length;
  metricValues.region_avg = Math.round(regionAvg * 100) / 100;
  if (recentPairOrders.length >= cfg.REPEAT_PAIR_MULTIPLIER * Math.max(regionAvg, 1)) {
    rulesFired.push('REPEAT_PAIR');
  }

  // Rule 2: Rapid cancel loops
  const rapidWindow = new Date(Date.now() - cfg.RAPID_CANCEL_WINDOW_MINUTES * 60 * 1000).toISOString();
  const recentCancels = allCustomerOrders.filter(o => o.status === 'CANCELLED' && o.created_at >= rapidWindow);
  metricValues.recent_cancels = recentCancels.length;
  if (recentCancels.length >= cfg.RAPID_CANCEL_THRESHOLD) {
    rulesFired.push('RAPID_CANCEL_LOOP');
  }

  // Rule 3: Points velocity vs. region (90th-percentile approximation — high earner)
  const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const pointsLedger = await db.getTable('points_ledger');
  const customerPts7d = pointsLedger.filter(l => l.customer_id === customer.id && l.type === 'EARN' && l.created_at >= last7d)
    .reduce((s, l) => s + l.amount, 0);
  const regionCustomers = (await db.getTable('users')).filter(u => u.region_id === customer.region_id && u.role === 'CUSTOMER');
  const allEarnings = regionCustomers.map(u =>
    pointsLedger.filter(l => l.customer_id === u.id && l.type === 'EARN' && l.created_at >= last7d).reduce((s, l) => s + l.amount, 0)
  ).sort((a, b) => a - b);
  const p90 = allEarnings[Math.floor(allEarnings.length * 0.9)] || 0;
  metricValues.points_7d = Math.round(customerPts7d * 100) / 100;
  metricValues.region_p90_pts = Math.round(p90 * 100) / 100;
  if (allEarnings.length >= 5 && customerPts7d > p90 * 2) {
    rulesFired.push('POINTS_VELOCITY');
  }

  // Rule 4: New-account burst
  const accountAgeMs = Date.now() - new Date(customer.created_at).getTime();
  const accountAgeHours = accountAgeMs / (1000 * 60 * 60);
  const recentOrderCount = allCustomerOrders.filter(o => o.created_at >= new Date(customer.created_at).toISOString()).length;
  metricValues.account_age_hours = Math.round(accountAgeHours * 10) / 10;
  metricValues.orders_since_signup = recentOrderCount;
  if (accountAgeHours < cfg.ACCOUNT_BURST_HOURS && recentOrderCount >= cfg.ACCOUNT_BURST_ORDER_THRESHOLD) {
    rulesFired.push('NEW_ACCOUNT_BURST');
  }

  // Rule 5: Self-dealing — address overlap between customer and stockist
  const stockists = await db.getTable('stockists');
  const users = await db.getTable('users');
  const stockistUser = users.find(u => u.id === (stockists.find(s => s.id === order.stockist_id) || {}).user_id);
  const custAddr = (customer.address || '').toLowerCase().trim();
  const stkAddr = (stockistUser ? stockistUser.address || '' : '').toLowerCase().trim();
  if (custAddr.length > 4 && stkAddr.length > 4 && (custAddr.includes(stkAddr) || stkAddr.includes(custAddr))) {
    rulesFired.push('SELF_DEALING');
    metricValues.customer_address = customer.address;
    metricValues.stockist_address = stockistUser ? stockistUser.address : '';
  }

  if (rulesFired.length > 0) {
    const anomalyLogs = await db.getTable('anomaly_logs');
    anomalyLogs.push({
      id: 'an-' + generateId(),
      tenant_id: customer.tenant_id,
      region_id: customer.region_id,
      customer_id: customer.id,
      customer_name: customer.name,
      stockist_id: order.stockist_id,
      stockist_name: order.stockist_name,
      order_id: order.id,
      rules_fired: rulesFired,
      metric_values: metricValues,
      reason: `Fraud rules fired: ${rulesFired.join(', ')}`,
      status: 'PENDING',
      dismissed: false,
      dismiss_reason: null,
      investigated: false,
      created_at: new Date().toISOString()
    });
    await db.saveTable('anomaly_logs', anomalyLogs);
  }
}

// Order status model. The UI uses RECEIVED/READY; older API paths use
// ACCEPTED/PREPARING and READY_FOR_PICKUP/OUT_FOR_DELIVERY. Both spellings are
// accepted and ranked together so that an order can only move forward.
const ORDER_STATUS_RANK = {
  CONFIRMING: 0, PENDING: 1, ACCEPTED: 2, RECEIVED: 2, PREPARING: 3,
  READY: 4, READY_FOR_PICKUP: 4, OUT_FOR_DELIVERY: 4, SHIPPED: 4, DELIVERED: 5
};
const FINAL_ORDER_STATUSES = ['DELIVERED', 'CANCELLED'];
const READY_ORDER_STATUSES = ['READY', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'SHIPPED']; // SHIPPED: legacy rows
const ORDER_FULFILLMENT_TYPES = ['PICKUP', 'DELIVERY', 'HOME_DELIVERY'];
const ORDER_PAYMENT_METHODS = ['UPI', 'COD', 'ONLINE', 'CARD', 'PAY_AT_HANDOVER'];

// Returns an error message, or null when the slot is acceptable. Accepts the
// named slots, a time range ("10:00–11:00", "10:00 AM - 11:00 AM") or the
// checkout's slot start ("2026-08-07T17:00", shop-local time).
function validatePickupSlot(slot) {
  if (typeof slot !== 'string' || !slot.trim() || slot.length > 64) return 'Invalid pickup slot.';
  const s = slot.trim();
  const norm = x => x.replace(/[–—]/g, '-').replace(/\s+/g, '').toUpperCase();
  if (cfg.SLOT_OPTIONS.some(o => norm(o) === norm(s))) return null;
  if (/^\d{1,2}(:\d{2})?\s*(AM|PM)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(AM|PM)?$/i.test(s)) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const when = new Date(y, mo - 1, d, h, mi);
    if (when.getMonth() !== mo - 1 || when.getDate() !== d || h > 23 || mi > 59) return 'Invalid pickup slot.';
    // A day of slack either side covers client/server time-zone differences.
    if (when.getTime() < Date.now() - 24 * 60 * 60 * 1000) return 'Pickup slot is in the past.';
    if (when.getTime() > Date.now() + 8 * 24 * 60 * 60 * 1000) return 'Pickup slot is too far ahead.';
    return null;
  }
  return 'Invalid pickup slot.';
}

async function _processReferralBonusOnDelivery(order) {
  try {
    const customerId = order.customer_id;
    if (!customerId) return;

    await db.transaction(async (tx) => {
      const users = await tx.getTable('users');
      const customer = users.find(u => u.id === customerId);
      if (!customer) return;

      if (customer.referral_bonus_paid) return;
      if (!customer.referred_by_user_id) return;

      const referrer = users.find(u => u.id === customer.referred_by_user_id);
      if (!referrer) return;

      const allOrders = await tx.getTable('orders');
      const deliveredOrders = allOrders.filter(o => o.customer_id === customerId && o.status === 'DELIVERED');
      if (deliveredOrders.length !== 1) return; // Must be genuinely 1st DELIVERED order

      const now = new Date().toISOString();

      // 1. Credit 50 pts to referrer
      await tx.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: referrer.tenant_id || customer.tenant_id || 't1',
        region_id: referrer.region_id || customer.region_id || null,
        customer_id: referrer.id,
        amount: 50,
        type: 'REFERRAL_BONUS',
        source: 'SYSTEM',
        order_id: order.id,
        description: `Referral bonus for inviting ${customer.name || customer.phone || 'customer'}`,
        created_at: now,
        billing_sync_status: 'PENDING'
      });

      // 2. Credit 50 pts to referee (this customer)
      await tx.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: customer.tenant_id || 't1',
        region_id: customer.region_id || null,
        customer_id: customer.id,
        amount: 50,
        type: 'REFERRAL_WELCOME',
        source: 'SYSTEM',
        order_id: order.id,
        description: `Welcome bonus for joining via referral from ${referrer.name || referrer.phone || 'referrer'}`,
        created_at: now,
        billing_sync_status: 'PENDING'
      });

      // 3. Mark referral_bonus_paid = true on referee
      await tx.updateRow('users', customer.id, { referral_bonus_paid: true });
    });
  } catch (err) {
    console.error('Error processing referral bonus on delivery:', err);
  }
}

async function _sendOrderConfirmedSms(order) {
  try {
    if (!smsHelper.isSmsConfigured()) return;
    if (order.sms_confirmed_sent) return;

    const users = await db.getTable('users');
    const customer = users.find(u => u.id === order.customer_id);
    const phone = customer ? customer.phone : order.customer_phone;
    if (!phone) return;

    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === order.stockist_id);
    const stockistName = stockist ? stockist.name : 'Stockist';

    const orderItems = (await db.getTable('order_items')).filter(oi => oi.order_id === order.id);
    const _itemCount = orderItems.reduce((sum, item) => sum + (item.quantity || 1), 0) || (order.items ? order.items.length : 1);
    const total = order.total_amount || order.subtotal || 0;
    const _etaTime = order.pickup_slot || 'scheduled time';

    await smsHelper.sendTemplateSms(phone, 'ORDER_PLACED', {
      orderId: order.id,
      shopName: stockistName,
      amount: total
    });
    try {
      await whatsapp.sendWhatsAppUpdate({
        phone,
        templateKey: 'ORDER_PLACED',
        params: { orderId: order.id, shopName: stockistName, amount: total },
        user: customer
      });
    } catch (waErr) {
      console.warn('[whatsapp:order_placed] Warning:', waErr.message);
    }

    await db.updateRow('orders', order.id, { sms_confirmed_sent: true });
    order.sms_confirmed_sent = true;
  } catch (err) {
    console.error('Error sending order confirmed SMS:', err);
  }
}

async function _sendOrderReadySms(order) {
  try {
    if (!smsHelper.isSmsConfigured()) return;
    if (order.sms_ready_sent) return;

    const users = await db.getTable('users');
    const customer = users.find(u => u.id === order.customer_id);
    const phone = customer ? customer.phone : order.customer_phone;
    if (!phone) return;

    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === order.stockist_id);
    const stockistName = stockist ? stockist.name : 'Stockist';
    const pickupPin = order.pickup_pin || '----';

    await smsHelper.sendTemplateSms(phone, 'READY_FOR_PICKUP', {
      orderId: order.id,
      shopName: stockistName,
      pin: pickupPin
    });
    try {
      await whatsapp.sendWhatsAppUpdate({
        phone,
        templateKey: 'READY_FOR_PICKUP',
        params: { orderId: order.id, shopName: stockistName, pin: pickupPin },
        user: customer
      });
    } catch (waErr) {
      console.warn('[whatsapp:ready_for_pickup] Warning:', waErr.message);
    }

    await db.updateRow('orders', order.id, { sms_ready_sent: true });
    order.sms_ready_sent = true;
  } catch (err) {
    console.error('Error sending order ready SMS:', err);
  }
}

// Internal: credit points when order is delivered (idempotent)
async function _creditPointsOnDelivery(order) {
  const ledger = await db.getTable('points_ledger');
  const alreadyEarned = ledger.some(l => l.order_id === order.id && (l.type === 'EARN' || l.type === 'EARN_HELD'));
  if (alreadyEarned) return;

  if (!order.points_credited || order.points_credited === 0) return;

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === order.stockist_id);

  const orderItems = await db.getTable('order_items');
  const items = orderItems.filter(oi => oi.order_id === order.id);
  const products = await db.getTable('products');
  const billPhotos = await db.getTable('product_bill_photos');

  let hasUnverifiedBill = false; console.log('checking order', order.id);
  for (const item of items) {
    const product = products.find(p => p.id === item.product_id);
    if (product && product.latest_bill_photo_id) {
      const bill = billPhotos.find(b => b.id === product.latest_bill_photo_id);
      if (!bill || bill.bill_status === 'PENDING' || bill.bill_status === 'REJECTED') {
        hasUnverifiedBill = true;
        console.log('hasUnverifiedBill is true because bill_status is', bill ? bill.bill_status : 'null (no bill)');
        break;
      }
    } else {
      hasUnverifiedBill = true;
      console.log('hasUnverifiedBill is true because no latest_bill_photo_id for product', product ? product.id : 'null');
      break;
    }
  }

  const earnType = hasUnverifiedBill ? 'EARN_HELD' : 'EARN';
  const syncStatus = hasUnverifiedBill ? 'HELD' : 'PENDING';

  await db.insertRow('points_ledger', {
    id: 'l-' + generateId(),
    tenant_id: order.tenant_id,
    region_id: order.region_id,
    customer_id: order.customer_id,
    amount: order.points_credited,
    type: earnType,
    order_id: order.id,
    description: `Earned from Order #${order.id.substring(2).toUpperCase()} at ${stockist ? stockist.name : 'Store'}`,
    created_at: new Date().toISOString(),
    billing_sync_status: syncStatus,
    reference_id: null
  });
}

function getRedemptionDescription(type, pts) {
  if (type === 'BROADBAND_DISCOUNT') return `Broadband Bill Discount - ₹${pts.toFixed(0)}`;
  if (type === 'BROADBAND_DISCOUNT_50') return 'Broadband Bill Discount - ₹50';
  if (type === 'BROADBAND_DISCOUNT_100') return 'Broadband Bill Discount - ₹100';
  if (type === 'WIFI_TOPUP') return 'WiFi Speed Booster 48h (100 Mbps)';
  if (type === 'DATA_TOPUP') return 'WiFi Data Top-up 10 GB';
  if (type === 'CABLE_RECHARGE') {
    if (pts === 100) return 'Cable TV Basic Pack - 1 Month Free';
    if (pts === 250) return 'Cable TV HD Premium Pack - 1 Month';
    if (pts === 120) return 'Cable TV Kids & Family Bundle';
    return 'Cable TV Recharge Package';
  }
  return 'Redeemed points against Broadband Bill';
}

module.exports = {
  getCommissionConfig,
  calculatePartnerPayout,
  calculateSettlement,
  reverseOrderPoints,
  processOrderCancellation,
  enrichOrder,
  runFraudDetection,
  ORDER_STATUS_RANK,
  FINAL_ORDER_STATUSES,
  READY_ORDER_STATUSES,
  ORDER_FULFILLMENT_TYPES,
  ORDER_PAYMENT_METHODS,
  validatePickupSlot,
  _processReferralBonusOnDelivery,
  _sendOrderConfirmedSms,
  _sendOrderReadySms,
  _creditPointsOnDelivery,
  getRedemptionDescription
};
