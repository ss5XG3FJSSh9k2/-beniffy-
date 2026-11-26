const express = require('express');
const { requireAuth, requireRole } = require('./lib/authz');
const webpush = require('web-push');

let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const vapidKeys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  console.log('Generated ephemeral VAPID keys for local testing');
}
webpush.setVapidDetails(
  'mailto:support@beniffy.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);



require('express-async-errors');
const cors = require('cors');
const db = require('./db');

// BF-SEC-3 Helpers

const cfg = require('./config');


const fs = require('fs');
const path = require('path');
const r2 = require('./lib/r2');
const { issueOtp, verifyOtp } = require('./lib/otp');
const integrations = require('./lib/integrations');
const payments = require('./lib/payments');
const outbox = require('./lib/outbox');

const app = express();

const {
  sanitizeUser, generateId, getISTDateString,
  getSetupProgressCounts, ALLOWED_SERVICE_TYPES
} = require('./lib/misc');
const {
  escapeHtml, unescapeHtml, sanitizePlainText, normalizePhone,
  checkPhone, checkEmail,
  maskIdNumber, validateSupportPhone, validateSupportWhatsapp, validateSupportEmail
} = require('./lib/validation');
const {
  apiRateLimitMap, loginRateLimitMap, otpRateLimitMap, otpHourlyLimitMap,
  checkOtpRateLimit, clearOtpRateLimit,
  loginPasswordFailedAttempts, otpRequestAttempts, resetTokens,
  phoneChangeMarkers, sendCurrentRateLimits, sendNewRateLimits,
  getPhoneChangeMarker, checkSendRateLimit
} = require('./lib/rate-limits');
const {
  appendPaymentEvent, createNotification, appendAudit
} = require('./lib/audit');
const {
  signBillUrl, signBillRow
} = require('./lib/bills');
const {
  getCustomerVisibleProducts, findStockistOwner,
  getCustomerVisibility, isCustomerVisible, setMainWholesaler
} = require('./services/stockists');
const {
  getCommissionConfig, calculatePartnerPayout, calculateSettlement,
  enrichOrder,
  _processReferralBonusOnDelivery, _sendOrderConfirmedSms, _sendOrderReadySms,
  _creditPointsOnDelivery
} = require('./services/orders');
const {
  assertNoDuplicateRoutes: checkDuplicateRoutes,
  reportMalformedPhones, assertProductionConfig
} = require('./lib/startup-checks');
const assertNoDuplicateRoutes = (appToTest) => checkDuplicateRoutes(appToTest, app);

// Boot-Time Missing-Config Warnings (Part 3.1) — kept in server.js for regression test #539/#540
function checkConfigWarnings() {
  if (!process.env.DATABASE_URL) {
    console.log('[Config] WARNING: DATABASE_URL missing. Set DATABASE_URL for production or fallback to mem in dev.');
  }
  if (!process.env.JWT_SECRET) {
    console.log('[Config] WARNING: JWT_SECRET missing. Set JWT_SECRET for production.');
  }
  if (!process.env.EMAIL_MOCK && !process.env.SENDGRID_API_KEY) {
    console.log('[Config] WARNING: Email delivery disabled. Set EMAIL_MOCK=true for dev, or SENDGRID_API_KEY for production.');
  }
  if (!process.env.SMS_MOCK && !process.env.MSG91_AUTH_KEY) {
    console.log('[Config] WARNING: SMS delivery disabled. Set SMS_MOCK=true for dev, or MSG91_AUTH_KEY for production.');
  }
  if (!process.env.R2_MOCK && !process.env.R2_ACCESS_KEY_ID) {
    console.log('[Config] WARNING: R2 storage disabled. Set R2_MOCK=true for dev, or R2_ACCESS_KEY_ID for production.');
  }
}
if (process.env.NODE_ENV === 'production') {
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim());
  app.use(cors({ origin: (origin, cb) => {
    if (!origin || allowed.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }}));
} else {
  app.use(cors());
}
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '0', 10));

const securityHeaders = require('./middleware/security-headers');
const apiRateLimit = require('./middleware/api-rate-limit');
const authContext = require('./middleware/auth-context');
const adminGate = require('./middleware/admin-gate');
const errorHandler = require('./middleware/error-handler');

// Security Headers & HTTPS Redirect Middleware (Item 20)
app.use(securityHeaders);

// Rate limiting state (Items 11, 13, 14)

// General API Rate Limiting Middleware (Item 14) - 100 req/min per IP
app.use('/api/', apiRateLimit);

// Server-Side Auth Verification Middleware (Item 6, Issue 1 KYC Gate)
app.use(authContext);

// HTTP Request Logging Middleware (Part 3.3) — kept in server.js for regression test #536
app.use((req, res, next) => {
  const start = Date.now();
  const rawPath = req.path || req.originalUrl?.split('?')[0] || req.url?.split('?')[0];
  res.on('finish', () => {
    const duration = Date.now() - start;
    const isoString = new Date().toISOString();
    console.log(`[HTTP] ${isoString} ${req.method} ${rawPath} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health Check Endpoint (Part 3.2)
const { registerHealthConfigRoutes, registerVapidConfigRoute, registerPostErrorConfigRoutes } = require('./routes/health-config');
const { registerAuthRoutes } = require('./routes/auth');
const { registerUserRoutes } = require('./routes/users');
const { registerSetupRoutes } = require('./routes/setup');
const { registerKycRoutes } = require('./routes/kyc');
const { registerPreAdminProductRoutes, registerPostAdminProductRoutes } = require('./routes/products');
const { registerBillsImagesRoutes } = require('./routes/bills-images');
const { registerStockistRoutes } = require('./routes/stockist');
const { registerOrderCreateRoutes } = require('./routes/orders-create');
const { registerOrderRoutes } = require('./routes/orders');
const { registerPaymentRoutes } = require('./routes/payments');
const { registerLedgerRoutes } = require('./routes/ledger');
const { registerFeedbackRoutes } = require('./routes/feedback');
const { registerCustomerRoutes } = require('./routes/customer');
const { registerPartnerLeadRoutes } = require('./routes/partner-leads');
const { registerTestRoutes } = require('./routes/test-routes');
const { registerPartnerAuthRoutes } = require('./routes/partner-auth');
const { registerPartnerRoutes } = require('./routes/partner');
const { registerPartnerProfileRoutes } = require('./routes/partner-profile');
const { registerRegionRoutes } = require('./routes/regions');
const { registerNotificationRoutes } = require('./routes/notifications');
registerHealthConfigRoutes(app);
registerAuthRoutes(app);
registerUserRoutes(app);
registerKycRoutes(app);
registerPreAdminProductRoutes(app);

app.get('/api/admin/outbox', requireAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const channel = req.query.channel;
  const messages = outbox.getOutbox({ channel });
  return res.json({ success: true, messages });
});

app.post('/api/admin/outbox/clear', requireAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  outbox.clearOutbox();
  return res.json({ success: true, message: 'Outbox cleared' });
});

app.get('/api/admin/integrations', requireAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const status = integrations.getIntegrationsStatus();
  return res.json({
    success: true,
    integrations: status,
    database_reset: {
      enabled: integrations.isDbResetAllowed(),
      status_text: integrations.getDbResetStatusText()
    }
  });
});

// Boot-Time Missing-Config Warnings (Part 3.1)


const bcrypt = require('bcrypt');
const emailHelper = require('./lib/email');
const smsHelper = require('./lib/sms');
const sessionHelper = require('./lib/session');

if (!r2.isR2Configured()) {
  console.warn('[Storage Warning] bill upload disabled. R2 not configured');
}

if (!emailHelper.isEmailConfigured()) {
  console.warn('email delivery disabled. Mock and SendGrid both off');
}

if (!smsHelper.isSmsConfigured()) {
  console.warn('[SMS Warning] SMS delivery disabled. Mock and real both off.');
}

// In-memory rate limiting and token stores

// Helper: sanitize user object (remove password_hash)

// In-memory OTP storage


// Helper to generate IDs

// Helper for IST Day Boundary

// Helper: append a payment ledger event (append-only audit)

// ----------------------------------------------------
// AUTH & SETUP ENDPOINTS
// ----------------------------------------------------

// POST /api/auth/verify-captcha (Item 12)

// GET /api/users/:id (Item 7, Item 19)

// GET /api/setup/status


// POST /api/admin/setup-complete and /api/setup/complete
const handleAdminSetupComplete = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    let user = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const session = sessionHelper.verifySession(token);
        if (session && session.userId) {
          const users = await db.getTable('users');
          user = users.find(u => u.id === session.userId);
        }
      } catch (e) {}
    } else if (req.body && req.body.admin_id) {
      const users = await db.getTable('users');
      user = users.find(u => u.id === req.body.admin_id);
    } else if (req.body && req.body.phone) {
      const users = await db.getTable('users');
      user = users.find(u => u.phone === String(req.body.phone).trim());
    }

    if (!user || user.role !== 'ADMIN') {
      return res.status(401).json({ error: 'Unauthorized. Admin privileges required.' });
    }

    const setupCompletedAt = new Date().toISOString();
    const summary = await getSetupProgressCounts();
    await appendAudit(req, 'SETUP_COMPLETE', 'users', user.id, null, { setup_completed_at: setupCompletedAt, summary }, 'Admin setup complete confirmed');

    res.status(200).json({
      success: true,
      setup_completed_at: setupCompletedAt,
      summary
    });
  } catch (err) {
    console.error('Error completing setup:', err);
    res.status(500).json({ error: 'Failed to complete setup.' });
  }
};

app.post('/api/admin/setup-complete', handleAdminSetupComplete);
registerSetupRoutes(app, { handleAdminSetupComplete });

// GET /api/admin/setup-progress (ADMIN only)
app.get('/api/admin/setup-progress', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const counts = await getSetupProgressCounts();
    res.status(200).json(counts);
  } catch (err) {
    console.error('Error fetching setup progress:', err);
    res.status(500).json({ error: 'Failed to fetch setup progress.' });
  }
});

// Verify OTP & Login


// Serve KYC document photo

// Register new Stockist (PENDING KYC)

// ----------------------------------------------------
// PRODUCT & INVENTORY ENDPOINTS
// ----------------------------------------------------



// --- ADMIN GATE ---
app.use('/api/admin', adminGate);

// GET /api/admin/bill-photos
app.get('/api/admin/bill-photos', async (req, res) => {
  const { stockist_id, date_from, date_to, bill_status, page = 1 } = req.query;
  let billPhotos = await db.getTable('product_bill_photos');
  const products = await db.getTable('products');
  const stockists = await db.getTable('stockists');

  if (stockist_id) {
    billPhotos = billPhotos.filter(b => b.stockist_id === stockist_id);
  }
  if (bill_status) {
    billPhotos = billPhotos.filter(b => b.bill_status === bill_status);
  }
  if (date_from) {
    const fromTime = new Date(date_from).getTime();
    billPhotos = billPhotos.filter(b => new Date(b.uploaded_at).getTime() >= fromTime);
  }
  if (date_to) {
    const toTime = new Date(date_to).getTime();
    billPhotos = billPhotos.filter(b => new Date(b.uploaded_at).getTime() <= toTime);
  }

  const pageSize = 50;
  const pageNum = parseInt(page, 10) || 1;
  const startIndex = (pageNum - 1) * pageSize;

  const ledger = await db.getTable('points_ledger');
  const orderItems = await db.getTable('order_items');
  const commissionRates = await db.getTable('commission_rates');

  const enrichedList = billPhotos.map(b => {
    const p = products.find(prod => prod.id === b.product_id);
    const s = stockists.find(st => st.id === b.stockist_id);

    const sp = b.selling_price_at_upload || (p ? p.price : 0);
    const cp = b.cost_price_at_upload || (p ? p.cost_price : 0);
    const marginPct = sp > 0 ? ((sp - cp) / sp) * 100 : 0;

    const cat = p ? p.category : 'groceries';
    const catConfig = commissionRates.find(c => c.category === cat);
    const marginThreshold = catConfig && catConfig.margin_threshold_percent !== undefined ? parseFloat(catConfig.margin_threshold_percent) : 50.00;

    let heldPoints = 0;
    let affectedOrdersCount = 0;
    if (b.bill_status === 'PENDING') {
      const heldRows = ledger.filter(l => l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD');
      for (const hr of heldRows) {
        const items = orderItems.filter(oi => oi.order_id === hr.order_id);
        if (items.some(oi => oi.product_id === b.product_id)) {
          heldPoints += parseFloat(hr.amount);
          affectedOrdersCount++;
        }
      }
    }

    return {
      ...b,
      created_at: b.uploaded_at,
      product_name: p ? (p.deleted_at ? p.name + ' (Deleted by shopkeeper)' : p.name) : 'Unknown Product',
      stockist_name: s ? s.name : 'Unknown Stockist',
      margin_pct: marginPct,
      margin_threshold: marginThreshold,
      held_points: heldPoints,
      affected_orders: affectedOrdersCount
    };
  });

  enrichedList.sort((a, b) => {
    if (a.bill_status === 'PENDING' && b.bill_status !== 'PENDING') return -1;
    if (b.bill_status === 'PENDING' && a.bill_status !== 'PENDING') return 1;
    if (b.held_points !== a.held_points) return b.held_points - a.held_points;
    return new Date(b.uploaded_at) - new Date(a.uploaded_at);
  });

  const paginated = enrichedList.slice(startIndex, startIndex + pageSize);

  return res.json({
    total: enrichedList.length,
    page: pageNum,
    page_size: pageSize,
    data: paginated.map(signBillRow)
  });
});



// POST /api/admin/bill-photos/:id/verify
app.post('/api/admin/bill-photos/:id/verify', async (req, res) => {
  const { id } = req.params;
  const billPhotos = await db.getTable('product_bill_photos');
  const bill = billPhotos.find(b => b.id === id);
  if (!bill) return res.status(404).json({ error: 'Bill photo not found' });

  bill.bill_status = 'VERIFIED';
  await db.saveTable('product_bill_photos', billPhotos);

  const products = await db.getTable('products');
  let product = products.find(p => p.id === bill.product_id);
  if (product && product.latest_bill_photo_id === bill.id) {
    product.is_sellable = true;
    await db.saveTable('products', products);
  }

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === bill.stockist_id);
  if (stockist) {
    stockist.verified_bill_streak = (stockist.verified_bill_streak || 0) + 1;
    await db.saveTable('stockists', stockists);
  }

  const ledger = await db.getTable('points_ledger');
  const heldRows = ledger.filter(l => l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD');
  const orderItems = await db.getTable('order_items');

  for (const heldRow of heldRows) {
    const items = orderItems.filter(oi => oi.order_id === heldRow.order_id);
    const hasThisProduct = items.some(oi => oi.product_id === bill.product_id);
    if (!hasThisProduct) continue;

    let allVerified = true;
    for (const item of items) {
      const p = products.find(prod => prod.id === item.product_id);
      if (p && p.latest_bill_photo_id) {
        const b = billPhotos.find(bp => bp.id === p.latest_bill_photo_id);
        if (!b || b.bill_status === 'PENDING' || b.bill_status === 'REJECTED') {
          allVerified = false;
          break;
        }
      } else {
        allVerified = false;
        break;
      }
    }

    if (allVerified) {
      const alreadyReleased = ledger.some(l => l.reference_id === heldRow.id && (l.type === 'EARN' || l.type === 'EARN_VOID'));
      if (!alreadyReleased) {
        await db.insertRow('points_ledger', {
          id: 'l-' + generateId(),
          tenant_id: heldRow.tenant_id,
          region_id: heldRow.region_id,
          customer_id: heldRow.customer_id,
          amount: heldRow.amount,
          type: 'EARN',
          order_id: heldRow.order_id,
          description: heldRow.description + ' (Verified)',
          created_at: new Date().toISOString(),
          billing_sync_status: 'PENDING',
          reference_id: heldRow.id
        });
        await db.updateRow('points_ledger', heldRow.id, { billing_sync_status: 'RELEASED' });
      }
    }
  }

  try {
    if (stockist && stockist.user_id) {
      await createNotification({
        userId: stockist.user_id,
        type: 'bill_approved',
        title: 'Bill approved',
        body: `Bill for ${product ? product.name : 'product'} approved`,
        link: `product:${bill.product_id}`
      });
    }
  } catch (notifErr) {
    console.error('[notification] Failed to create bill_approved notification:', notifErr);
  }

  return res.json({ success: true, bill: signBillRow(bill), product });
});

// POST /api/admin/bill-photos/:id/reject
app.post('/api/admin/bill-photos/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ error: 'reason_too_short', message: 'Reject reason must be at least 5 characters' });
  }

  const billPhotos = await db.getTable('product_bill_photos');
  const bill = billPhotos.find(b => b.id === id);
  if (!bill) return res.status(404).json({ error: 'Bill photo not found' });

  bill.bill_status = 'REJECTED';
  bill.rejection_reason = reason;
  await db.saveTable('product_bill_photos', billPhotos);

  const products = await db.getTable('products');
  const product = products.find(p => p.id === bill.product_id);
  if (product && product.latest_bill_photo_id === bill.id) {
    product.is_sellable = false;
    await db.saveTable('products', products);
  }

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === bill.stockist_id);
  if (stockist) {
    stockist.verified_bill_streak = 0;
    await db.saveTable('stockists', stockists);
  }

  const ledger = await db.getTable('points_ledger');
  const heldRows = ledger.filter(l => l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD');
  const orderItems = await db.getTable('order_items');
  const users = await db.getTable('users');

  if (stockist) {
    const user = users.find(u => u.id === stockist.user_id);
    if (user && user.phone) {
      if (smsHelper.isSmsConfigured()) {
        try {
          const prodName = product ? product.name : 'a product';
          await smsHelper.sendSms(user.phone, `Beniffy: your bill for ${prodName} was rejected. Reason: ${reason}. Upload a new bill in the app to resume selling.`);
        } catch (e) {
          console.error('[SMS] Failed to send rejection SMS:', e.message);
        }
      }
    }
  }

  for (const heldRow of heldRows) {
    const items = orderItems.filter(oi => oi.order_id === heldRow.order_id);
    const hasThisProduct = items.some(oi => oi.product_id === bill.product_id);
    if (!hasThisProduct) continue;

    const alreadyVoided = ledger.some(l => l.reference_id === heldRow.id && (l.type === 'EARN' || l.type === 'EARN_VOID'));
    if (!alreadyVoided) {
      await db.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: heldRow.tenant_id,
        region_id: heldRow.region_id,
        customer_id: heldRow.customer_id,
        amount: 0, // held points were never in the balance; a positive amount here would credit them
        type: 'EARN_VOID',
        order_id: heldRow.order_id,
        description: `Points voided for Order #${heldRow.order_id.substring(2).toUpperCase()} (${heldRow.amount} pts): ${reason.trim()}`,
        created_at: new Date().toISOString(),
        billing_sync_status: 'VOIDED',
        reference_id: heldRow.id
      });
      await db.updateRow('points_ledger', heldRow.id, { billing_sync_status: 'VOIDED' });
      const customer = users.find(u => u.id === heldRow.customer_id);
      if (customer && customer.phone) {
        await smsHelper.sendSms(customer.phone, `Beniffy: Your pending points for order ${heldRow.order_id.substring(2).toUpperCase()} could not be credited. Reason: ${reason.trim()}`);
      }
    }
  }

  try {
    if (stockist && stockist.user_id) {
      await createNotification({
        userId: stockist.user_id,
        type: 'bill_rejected',
        title: 'Bill rejected',
        body: `Bill for ${product ? product.name : 'product'} rejected: ${reason}`,
        link: `product:${bill.product_id}`
      });
    }
  } catch (notifErr) {
    console.error('[notification] Failed to create bill_rejected notification:', notifErr);
  }

  return res.json({ success: true, bill: signBillRow(bill), product });
});

// POST /api/admin/bill-photos/:id/signed-url
app.post('/api/admin/bill-photos/:id/signed-url', async (req, res) => {
  const { id } = req.params;
  const billPhotos = await db.getTable('product_bill_photos');
  const bill = billPhotos.find(b => b.id === id);
  if (!bill) return res.status(404).json({ error: 'Bill photo not found' });

  try {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const signedUrl = signBillUrl(bill.r2_key, 3600);
    return res.json({ signed_url: signedUrl, expires_at: expiresAt });
  } catch (err) {
    console.error('Failed to generate signed URL:', err);
    return res.status(500).json({ error: 'failed_signed_url', message: 'Could not generate signed bill URL.' });
  }
});

// GET /api/bills/* — serve mock bill image or redirect to signed URL
registerBillsImagesRoutes(app);
registerPostAdminProductRoutes(app);
registerStockistRoutes(app);
registerVapidConfigRoute(app, { VAPID_PUBLIC_KEY });
registerOrderCreateRoutes(app);
registerOrderRoutes(app);
registerPaymentRoutes(app);
registerLedgerRoutes(app);
registerFeedbackRoutes(app);
registerCustomerRoutes(app);
registerPartnerLeadRoutes(app);
registerTestRoutes(app);
registerPartnerAuthRoutes(app);
registerPartnerRoutes(app);
registerPartnerProfileRoutes(app);
registerRegionRoutes(app);
registerNotificationRoutes(app);

// ----------------------------------------------------
// STOCKIST ENDPOINTS
// ----------------------------------------------------

// OPEN/CLOSED RULE (Issue 6):
// If closing <= opening, the shop is treated as closing after midnight (overnight shop).
// An overnight shop (e.g. 22:00 to 02:00) is open if currentTime >= opening OR currentTime < closing.
// A daytime shop (e.g. 09:00 to 21:00) is open if currentTime >= opening AND currentTime < closing.


// ----------------------------------------------------
// ORDER & PAYMENT SPLIT ENDPOINTS
// ----------------------------------------------------

// Helper: Settlement Engine
// Helper: Get Commission Config (STORE first, GLOBAL fallback)

// POST /api/orders & /api/orders/create — multi-store aware, slot-required, HELD payment, CONFIRMING state

// Internal: process referral bonus on first delivered order

// Get orders

// Web Push VAPID Key

// ----------------------------------------------------
// ADMIN — RELEASE SPLIT (idempotent)
// ----------------------------------------------------

app.post('/api/admin/release-split/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.split_released) {
    return res.json({ success: true, no_op: true, message: 'Split already released. No action taken.' });
  }

  if (order.payment_status !== 'HELD' && order.payment_status !== 'PAID_ONLINE') {
    return res.status(400).json({ error: 'Order is not in HELD state. Cannot release.' });
  }

  if (order.payment_method === 'ONLINE' || order.razorpay_payment_id) {
    try {
      await payments.releaseTransfer({
        orderId: order.id,
        transferId: order.transfer_id,
        stockistId: order.stockist_id
      });
    } catch (relErr) {
      console.warn('[release-split] Transfer release notice:', relErr.message);
    }
  }

  order.payment_status = 'SPLIT_RELEASED';
  order.split_released = true;
  await db.saveTable('orders', orders);

  const splitPayouts = await db.getTable('split_payouts');
  const payout = splitPayouts.find(sp => sp.order_id === orderId);
  if (payout) {
    payout.status = 'SPLIT_RELEASED';
    await db.updateRow('split_payouts', payout.id, payout);
  }

  appendPaymentEvent(orderId, 'SPLIT_RELEASED', order.total_price, {
    stockist_share: payout ? payout.stockist_amount : 0,
    platform_share: payout ? payout.platform_amount : 0
  });



  return res.json({ success: true, order: await enrichOrder(order, req) });
});

app.post('/api/admin/orders/:id/refund', async (req, res) => {
  const { id } = req.params;
  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.payment_status === 'REFUNDED') {
    return res.json({ success: true, order: await enrichOrder(order, req) });
  }

  if (order.payment_status !== 'REFUND_DUE') {
    return res.status(400).json({ error: 'Order is not in REFUND_DUE state' });
  }

  // The cancellation decided the refund (full, or minus the fee for a no-show).
  let refundAmount;
  if (order.refund_amount !== undefined && order.refund_amount !== null) {
    refundAmount = parseFloat(order.refund_amount);
  } else {
    // Orders cancelled before refund_amount was recorded.
    const splitPayouts = await db.getTable('split_payouts');
    const payout = splitPayouts.find(sp => sp.order_id === id);
    const platformCommission = payout ? parseFloat(payout.platform_amount) : 0;
    const orderAmountPaid = order.amount_paid !== undefined && order.amount_paid !== null ? order.amount_paid : order.total_price;
    refundAmount = Math.max(0, orderAmountPaid - platformCommission);
  }

  if (order.payment_method === 'ONLINE' || order.razorpay_payment_id) {
    try {
      const refundRes = await payments.refundPayment({
        orderId: order.id,
        paymentId: order.razorpay_payment_id,
        amount: refundAmount,
        reason: 'Admin refund'
      });
      order.refund_id = refundRes?.id || refundRes?.refund_id;
    } catch (refErr) {
      console.error('[admin:refund] Failed to process online refund:', refErr);
      return res.status(500).json({ error: 'Gateway refund failed: ' + refErr.message });
    }
  }

  order.payment_status = 'REFUNDED';
  order.refund_amount = refundAmount;
  await db.saveTable('orders', orders);

  appendPaymentEvent(id, 'REFUNDED', refundAmount, { net_refund: refundAmount, refund_id: order.refund_id });

  return res.json({ success: true, order: await enrichOrder(order, req) });
});

// GET /api/admin/transactions — enriched with payment state
app.get('/api/admin/transactions', async (req, res) => {
  const orders = await db.getTable('orders');
  const enriched = (await Promise.all(orders.map(o => enrichOrder(o, req)))).reverse();
  return res.json(enriched);
});

// GET /api/admin/cod-commission — per-stockist COD outstanding
app.get('/api/admin/cod-commission', async (req, res) => {
  const codLedger = await db.getTable('cod_commission_ledger');
  const stockists = await db.getTable('stockists');

  const summary = {};
  codLedger.forEach(e => {
    if (!summary[e.stockist_id]) {
      const s = stockists.find(st => st.id === e.stockist_id);
      summary[e.stockist_id] = { stockist_id: e.stockist_id, stockist_name: s ? s.name : 'Unknown', total_outstanding: 0, total_settled: 0 };
    }
    if (e.settled) summary[e.stockist_id].total_settled += e.amount_owed;
    else summary[e.stockist_id].total_outstanding += e.amount_owed;
  });

  return res.json(Object.values(summary));
});

// GET /api/admin/payment-ledger
app.get('/api/admin/payment-ledger', async (req, res) => {
  const { orderId } = req.query;
  const ledger = await db.getTable('payment_ledger');
  const filtered = orderId ? ledger.filter(e => e.order_id === orderId) : ledger;
  return res.json(filtered.reverse());
});

// GET /api/admin/payouts - Unified payout queue
app.get('/api/admin/payouts', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  let decoded;
  try {
    decoded = sessionHelper.verifySession(token);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!decoded || (!decoded.userId && !decoded.user_id)) return res.status(401).json({ error: 'Unauthorized' });
  const users = await db.getTable('users');
  const userId = decoded.userId || decoded.user_id;
  const user = users.find(u => u.id === userId);
  if (!user || user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });

  const splitPayouts = await db.getTable('split_payouts');
  const codCommLedger = await db.getTable('cod_commission_ledger');
  const stockistCodComm = await db.getTable('stockist_cod_commissions');
  const stockists = await db.getTable('stockists');
  const orders = await db.getTable('orders');
  const cancelledOrderIds = new Set(orders.filter(o => o.status === 'CANCELLED').map(o => o.id));
  
  const payouts = [];
  
  for (const sp of splitPayouts) {
    if (sp.is_cod) continue;
    const isCancelled = sp.status === 'CANCELLED' || (sp.order_id && cancelledOrderIds.has(sp.order_id));
    payouts.push({
      id: sp.id,
      source: 'split_payouts',
      direction: 'OUTGOING',
      order_id: sp.order_id,
      stockist_id: sp.stockist_id,
      stockist_name: stockists.find(s => s.id === sp.stockist_id)?.name || 'Unknown',
      amount: parseFloat(sp.stockist_amount),
      type: 'ORDER_SPLIT',
      status: isCancelled ? 'CANCELLED' : sp.status,
      is_paid: !!sp.is_paid,
      created_at: sp.created_at,
      paid_at: sp.paid_at,
      payment_reference: sp.payment_reference
    });
  }
  
  for (const cc of codCommLedger) {
    payouts.push({
      id: cc.id,
      source: 'cod_commission_ledger',
      direction: 'INCOMING',
      order_id: cc.order_id,
      stockist_id: cc.stockist_id,
      stockist_name: stockists.find(s => s.id === cc.stockist_id)?.name || 'Unknown',
      amount: parseFloat(cc.amount_owed),
      type: 'COD_COMMISSION',
      is_paid: !!cc.settled,
      settled_method: cc.settled_method || null,
      settled_via: cc.settled_via || null,
      created_at: cc.created_at,
      paid_at: cc.settled_at,
      payment_reference: cc.payment_reference
    });
  }
  
  for (const scc of stockistCodComm) {
    payouts.push({
      id: scc.id,
      source: 'stockist_cod_commissions',
      direction: 'INCOMING',
      order_id: null,
      stockist_id: scc.stockist_id,
      stockist_name: stockists.find(s => s.id === scc.stockist_id)?.name || 'Unknown',
      amount: parseFloat(scc.commission_amount),
      type: 'COD_COMMISSION_MONTHLY',
      is_paid: !!scc.is_paid,
      created_at: scc.date,
      paid_at: scc.paid_at,
      payment_reference: scc.payment_reference
    });
  }
  
  return res.json(payouts);
});

// GET /api/admin/partner-payouts
app.get('/api/admin/partner-payouts', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  let decoded;
  try { decoded = sessionHelper.verifySession(token); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }
  if (!decoded || (!decoded.userId && !decoded.user_id)) return res.status(401).json({ error: 'Unauthorized' });
  const users = await db.getTable('users');
  const userId = decoded.userId || decoded.user_id;
  const user = users.find(u => u.id === userId);
  if (!user || user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });

  const partners = await db.getTable('partners');
  const redemptions = await db.getTable('redemption_approvals');
  
  const partnerMap = {};
  for (const r of redemptions) {
    if (r.status === 'FULFILLED' && r.partner_paid !== true) {
      if (!partnerMap[r.partner_id]) {
        const p = partners.find(p => p.id === r.partner_id);
        partnerMap[r.partner_id] = {
          partner_id: r.partner_id,
          partner_name: p ? (p.name || p.display_name || p.business_name || 'Unknown Partner') : 'Unknown Partner',
          payout_upi_id: p ? p.payout_upi_id : null,
          payout_bank_account: p ? p.payout_bank_account : null,
          payout_bank_ifsc: p ? p.payout_bank_ifsc : null,
          amount_owed: 0,
          redemption_count: 0
        };
      }
      
      const faceVal = Number(r.face_value_rupees || r.rupees_value);
      const { partnerPayout } = await calculatePartnerPayout(faceVal);
      partnerMap[r.partner_id].amount_owed += partnerPayout;
      partnerMap[r.partner_id].redemption_count += 1;
    }
  }

  const payouts = Object.values(partnerMap);
  return res.json(payouts);
});

// POST /api/admin/partner-payouts/:partnerId/mark-paid
app.post('/api/admin/partner-payouts/:partnerId/mark-paid', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let decoded;
    try { decoded = sessionHelper.verifySession(token); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }
    if (!decoded || (!decoded.userId && !decoded.user_id)) return res.status(401).json({ error: 'Unauthorized' });
    const users = await db.getTable('users');
    const userId = decoded.userId || decoded.user_id;
    const user = users.find(u => u.id === userId);
    if (!user || user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });

    const { payment_reference } = req.body;
    if (!payment_reference || payment_reference.length < 4) {
      return res.status(400).json({ error: 'Valid payment reference (min 4 chars) is required' });
    }

    const partnerId = req.params.partnerId;
    const redemptions = await db.getTable('redemption_approvals');
    
    const now = new Date().toISOString();
    let paidCount = 0;
    let paidAmount = 0;

    for (const r of redemptions) {
      if (r.partner_id === partnerId && r.status === 'FULFILLED' && r.partner_paid !== true) {
        r.partner_paid = true;
        r.partner_payout_ref = payment_reference;
        r.partner_payout_at = now;
        await db.updateRow('redemption_approvals', r.id, r);
        
        const faceVal = Number(r.face_value_rupees || r.rupees_value);
        const { partnerPayout } = await calculatePartnerPayout(faceVal);
        paidAmount += partnerPayout;
        paidCount++;
      }
    }

    if (paidCount > 0) {
      await appendAudit(req, 'PARTNER_PAYOUT_PAID', 'partner', partnerId, null,
        { payment_reference, count: paidCount, amount: paidAmount });
    }

    return res.json({ success: true, count: paidCount, amount: paidAmount });
  } catch (e) {
    console.error('[partner-payout mark-paid]', req.params.partnerId, e);
    return res.status(500).json({ error: 'payout_failed', message: e.message });
  }
});

// POST /api/admin/payouts/mark-paid
app.post('/api/admin/payouts/mark-paid', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  let decoded;
  try {
    decoded = sessionHelper.verifySession(token);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!decoded || (!decoded.userId && !decoded.user_id)) return res.status(401).json({ error: 'Unauthorized' });
  const users = await db.getTable('users');
  const userId = decoded.userId || decoded.user_id;
  const user = users.find(u => u.id === userId);
  if (!user || user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });

  const { payouts, payment_reference } = req.body;
  if (!payment_reference || payment_reference.length < 4) {
    return res.status(400).json({ error: 'Valid payment reference (min 4 chars) is required' });
  }
  if (!Array.isArray(payouts) || payouts.length === 0) {
    return res.status(400).json({ error: 'No payouts selected' });
  }

  const splitPayouts = await db.getTable('split_payouts');
  const codCommLedger = await db.getTable('cod_commission_ledger');
  const stockistCodComm = await db.getTable('stockist_cod_commissions');
  const auditLogs = await db.getTable('admin_audit_log');
  
  let modifiedSplit = false;
  let modifiedCodLedger = false;
  let modifiedStockistCod = false;
  let modifiedAudit = false;
  const now = new Date().toISOString();
  const notifiedStockistIds = new Set();

  for (const p of payouts) {
    if (p.source === 'split_payouts') {
      const sp = splitPayouts.find(s => s.id === p.id);
      if (sp && !sp.is_paid && sp.status !== 'CANCELLED') {
        sp.is_paid = true;
        sp.paid_at = now;
        sp.paid_by_admin_id = user.id;
        sp.payment_reference = payment_reference;
        modifiedSplit = true;
        modifiedAudit = true;
        if (sp.stockist_id) notifiedStockistIds.add(sp.stockist_id);
        auditLogs.push({
          id: 'aud-' + generateId(),
          admin_user_id: user.id,
          entity_type: 'PAYOUT',
          entity_id: sp.id,
          action: 'MARK_PAYOUT_PAID',
          details: { amount: sp.stockist_amount, payment_reference },
          created_at: now
        });
      }
    } else if (p.source === 'cod_commission_ledger') {
      const cc = codCommLedger.find(c => c.id === p.id);
      if (cc && !cc.settled) {
        cc.settled = true;
        cc.settled_at = now;
        cc.settled_by_admin_id = user.id;
        cc.payment_reference = payment_reference;
        modifiedCodLedger = true;
        modifiedAudit = true;
        if (cc.stockist_id) notifiedStockistIds.add(cc.stockist_id);
        auditLogs.push({
          id: 'aud-' + generateId(),
          admin_user_id: user.id,
          entity_type: 'PAYOUT',
          entity_id: cc.id,
          action: 'MARK_PAYOUT_PAID',
          details: { amount: cc.amount_owed, payment_reference },
          created_at: now
        });
      }
    } else if (p.source === 'stockist_cod_commissions') {
      const scc = stockistCodComm.find(s => s.id === p.id);
      if (scc && !scc.is_paid) {
        scc.is_paid = true;
        scc.paid_at = now;
        scc.paid_by_admin = user.id;
        scc.payment_reference = payment_reference;
        modifiedStockistCod = true;
        modifiedAudit = true;
        if (scc.stockist_id) notifiedStockistIds.add(scc.stockist_id);
        auditLogs.push({
          id: 'aud-' + generateId(),
          admin_user_id: user.id,
          entity_type: 'PAYOUT',
          entity_id: scc.id,
          action: 'MARK_PAYOUT_PAID',
          details: { amount: scc.commission_amount, payment_reference },
          created_at: now
        });
      }
    }
  }

  if (modifiedSplit) await db.saveTable('split_payouts', splitPayouts);
  if (modifiedCodLedger) await db.saveTable('cod_commission_ledger', codCommLedger);
  if (modifiedStockistCod) await db.saveTable('stockist_cod_commissions', stockistCodComm);
  if (modifiedAudit) await db.saveTable('admin_audit_log', auditLogs);

  try {
    const stockists = await db.getTable('stockists');
    for (const sId of notifiedStockistIds) {
      const stk = stockists.find(s => s.id === sId);
      if (stk && stk.user_id) {
        await createNotification({
          userId: stk.user_id,
          type: 'payout_paid',
          title: 'Payout marked paid',
          body: `Payout marked paid (Ref: ${payment_reference})`,
          link: 'payout'
        });
      }
    }
  } catch (notifErr) {
    console.error('[notification] Failed to create payout_paid notifications:', notifErr);
  }

  return res.json({ success: true });
});

// ----------------------------------------------------
// POINTS LEDGER & REDEMPTION ENDPOINTS
// ----------------------------------------------------


// ----------------------------------------------------
// FEEDBACK & REPORT ENDPOINTS
// ----------------------------------------------------


app.get('/api/admin/feedback', async (req, res) => {
  const feedback = await db.getTable('feedback_reports');
  const users = await db.getTable('users');
  const stockists = await db.getTable('stockists');

  const enriched = feedback.map(fb => {
    let reporterName = 'Unknown';
    let targetName = 'Unknown';

    if (fb.reporter_role === 'CUSTOMER') {
      const u = users.find(x => x.id === fb.reporter_id);
      reporterName = u ? u.name : 'Unknown Customer';
    } else {
      const s = stockists.find(x => x.id === fb.reporter_id || x.id === fb.reporter_stockist_id || x.user_id === fb.reporter_id);
      reporterName = s ? s.name : 'Unknown Shopkeeper';
    }

    if (fb.target_role === 'CUSTOMER') {
      const u = users.find(x => x.id === fb.target_id);
      targetName = u ? u.name : 'Unknown Customer';
    } else {
      const s = stockists.find(x => x.id === fb.target_id || x.user_id === fb.target_id);
      targetName = s ? s.name : 'Unknown Shopkeeper';
    }

    return { ...fb, reporter_name: reporterName, target_name: targetName };
  }).reverse();

  return res.json(enriched);
});

// ----------------------------------------------------
// ADMIN ENDPOINTS
// ----------------------------------------------------

// Commission Config (Part 5)
app.get('/api/admin/commission-config', async (req, res) => {
  const configs = await db.getTable('commission_config');
  return res.json(configs);
});

app.get('/api/admin/commission-config/effective', async (req, res) => {
  const stockistId = req.query.stockist_id || null;
  const cfg = await getCommissionConfig(stockistId);
  return res.json(cfg);
});

app.post('/api/admin/commission-config', async (req, res) => {
  const { scope, stockist_id, stockist_reinvest_pct, points_from_pot_pct, partner_redemption_cut_pct } = req.body;

  if (!scope || !['GLOBAL', 'STORE'].includes(scope)) {
    return res.status(400).json({ error: 'Valid scope required (GLOBAL or STORE)' });
  }

  if (scope === 'STORE' && !stockist_id) {
    return res.status(400).json({ error: 'stockist_id is required for STORE scope' });
  }

  const reinvest = parseFloat(stockist_reinvest_pct);
  const points = parseFloat(points_from_pot_pct);
  const cut = parseFloat(partner_redemption_cut_pct);

  if (isNaN(reinvest) || reinvest < 0 || reinvest > 100 ||
      isNaN(points) || points < 0 || points > 100 ||
      isNaN(cut) || cut < 0 || cut > 100) {
    return res.status(400).json({ error: 'Config values must be numbers between 0 and 100' });
  }

  const configs = await db.getTable('commission_config');
  let row = null;
  let isCreate = false;

  if (scope === 'GLOBAL') {
    row = configs.find(c => c.scope === 'GLOBAL');
    if (!row) {
      isCreate = true;
      row = {
        id: 'cc-default',
        scope: 'GLOBAL',
        stockist_id: null,
        created_at: new Date().toISOString()
      };
      configs.push(row);
    }
  } else {
    row = configs.find(c => c.scope === 'STORE' && c.stockist_id === stockist_id);
    if (!row) {
      isCreate = true;
      row = {
        id: 'cc-' + generateId(),
        scope: 'STORE',
        stockist_id,
        created_at: new Date().toISOString()
      };
      configs.push(row);
    }
  }

  const before = { ...row };

  row.stockist_reinvest_pct = reinvest;
  row.points_from_pot_pct = points;
  row.partner_redemption_cut_pct = cut;
  row.updated_at = new Date().toISOString();

  await db.saveTable('commission_config', configs);

  const action = isCreate ? 'COMMISSION_CONFIG_CREATE' : 'COMMISSION_CONFIG_UPDATE';
  await appendAudit(req, action, 'commission_config', row.id, before, row);

  return res.json({ success: true, config: row });
});

app.delete('/api/admin/commission-config/:id', async (req, res) => {
  const { id } = req.params;
  const configs = await db.getTable('commission_config');
  const index = configs.findIndex(c => c.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Config not found' });
  }

  const target = configs[index];
  if (target.scope === 'GLOBAL' || target.id === 'cc-default') {
    return res.status(400).json({ error: 'cannot delete global default' });
  }

  const deletedRow = configs.splice(index, 1)[0];
  await db.saveTable('commission_config', configs);

  await appendAudit(req, 'COMMISSION_CONFIG_DELETE', 'commission_config', target.id, deletedRow, null);

  return res.json({ success: true, message: 'Store override deleted' });
});


app.get('/api/admin/kyc-queue', async (req, res) => {
  const users = await db.getTable('users');
  const regFlags = (await db.getTable('registration_flags')) || [];

  const pending = users.filter(u => u.role === 'STOCKIST' && u.kyc_status === 'PENDING').map(u => {
    let kyc = u.kyc_details || {};
    if (typeof kyc === 'string') {
      try { kyc = JSON.parse(kyc); } catch (e) { kyc = {}; }
    }
    const rawId = kyc.id_number || u.kyc_id_number || '';
    const maskedId = maskIdNumber(rawId);
    
    const userFlags = regFlags.filter(f => f.user_id === u.id);
    const summary = { high: 0, medium: 0, low: 0 };
    for (const f of userFlags) {
      if (!f.cleared_at) {
        if (f.severity === 'HIGH') summary.high++;
        else if (f.severity === 'MEDIUM') summary.medium++;
        else if (f.severity === 'LOW') summary.low++;
      }
    }

    return {
      ...u,
      kyc_id_number: maskedId,
      kyc_details: {
        ...kyc,
        id_number: maskedId
      },
      flags: userFlags,
      flag_summary: summary
    };
  });
  return res.json(pending);
});

app.post('/api/admin/kyc/:userId/flags/:flagId/clear', async (req, res) => {
  const note = req.body.note;
  if (!note) return res.status(400).json({ error: 'Note is required' });

  const regFlags = (await db.getTable('registration_flags')) || [];
  const flag = regFlags.find(f => f.id === req.params.flagId && f.user_id === req.params.userId);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  if (flag.cleared_at) return res.status(400).json({ error: 'Flag already cleared' });

  const clearedBy = req.user?.userId || req.headers['x-admin-user-id'] || 'admin';
  flag.cleared_by = clearedBy;
  flag.cleared_at = new Date().toISOString();
  flag.cleared_note = note;

  await db.saveTable('registration_flags', regFlags);
  await appendAudit(req, 'CLEAR_KYC_FLAG', 'registration_flags', flag.id, null, { note, cleared_by: clearedBy });
  return res.json({ success: true, flag });
});

app.get('/api/admin/kyc/:userId/document', async (req, res) => {
  const userId = req.params.userId;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'Stockist user not found' });
  }

  let kyc = user.kyc_details || {};
  if (typeof kyc === 'string') {
    try { kyc = JSON.parse(kyc); } catch (e) { kyc = {}; }
  }

  const idNumber = kyc.id_number || user.kyc_id_number || '';
  const idType = kyc.id_type || user.kyc_id_type || 'Aadhaar';
  const docUrl = kyc.document_photo_url || user.document_photo_url || null;

  await appendAudit(req, 'VIEW_KYC_DOCUMENT', 'user', userId, null, { id_number_accessed: true });

  let finalUrl = docUrl;
  if (docUrl) {
    const crypto = require('crypto');
    const ttl = (cfg.KYC_DOC_URL_TTL_SECONDS || 300) * 1000;
    const expires = Date.now() + ttl;
    const secret = require('./lib/session').getSecret();
    let pathPart = docUrl;
    try { const u = new URL(docUrl, 'http://localhost'); pathPart = u.pathname; } catch(e) {}
    const sig = crypto.createHmac('sha256', secret).update(pathPart + ':' + expires).digest('hex');
    const joiner = docUrl.includes('?') ? '&' : '?';
    finalUrl = `${docUrl}${joiner}expires=${expires}&sig=${sig}`;
  }

  return res.json({
    success: true,
    user_id: userId,
    id_number: idNumber,
    id_type: idType,
    document_photo_url: finalUrl
  });
});

app.post('/api/admin/approve-kyc', async (req, res) => {
  const { userId, vendorId, deliveryRadius, minOrderValue } = req.body;
  if (!userId || !vendorId) {
    return res.status(400).json({ error: 'User ID and Vendor ID are required' });
  }

  const users = await db.getTable('users');
  const userIndex = users.findIndex(u => u.id === userId);
  if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

  users[userIndex].kyc_status = 'APPROVED';
  await db.saveTable('users', users);

  const regFlags = (await db.getTable('registration_flags')) || [];
  const activeHighFlags = regFlags.filter(f => f.user_id === userId && !f.cleared_at && f.severity === 'HIGH');
  if (activeHighFlags.length > 0) {
    await appendAudit(req, 'APPROVE_FLAGGED_KYC', 'users', userId, null, { flags: activeHighFlags.map(f => f.flag_type) });
  }

  const user = users[userIndex];
  const stockists = await db.getTable('stockists');
  const shopName = (user.kyc_details && user.kyc_details.shop_name) ? user.kyc_details.shop_name : user.name + ' Store';
  let targetStockist = stockists.find(s => s.user_id === userId || (s.phone && s.phone === user.phone) || (s.contact_phone && s.contact_phone === user.phone));
  if (!targetStockist) {
    targetStockist = {
      id: 's-' + generateId(),
      tenant_id: user.tenant_id,
      region_id: user.region_id,
      user_id: user.id,
      name: shopName,
      phone: user.phone,
      contact_phone: user.phone,
      contact_name: user.name,
      vendor_id: vendorId,
      delivery_radius_km: parseFloat(deliveryRadius) || 5.0,
      min_order_value: 0,
      is_active: true,
      opening_time: cfg.DEFAULT_OPENING_TIME,
      closing_time: cfg.DEFAULT_CLOSING_TIME,
      prep_eta_minutes: cfg.DEFAULT_PREP_ETA_MINUTES,
      created_at: new Date().toISOString()
    };
    stockists.push(targetStockist);
  } else {
    targetStockist.is_active = true;
    if (deliveryRadius) targetStockist.delivery_radius_km = parseFloat(deliveryRadius) || targetStockist.delivery_radius_km || 5.0;
    if (minOrderValue !== undefined) targetStockist.min_order_value = parseFloat(minOrderValue) || 0;
    if (shopName) targetStockist.name = shopName;
  }
  await db.saveTable('stockists', stockists);

  if (vendorId) {
    await setMainWholesaler(targetStockist.id, vendorId);
  }

  const products = (await db.getTable('products')).filter(p => p.region_id === user.region_id);
  const inventory = await db.getTable('stockist_inventory');
  products.forEach(p => {
    if (!inventory.some(inv => inv.stockist_id === targetStockist.id && inv.product_id === p.id)) {
      inventory.push({
        id: 'sinv-' + generateId(),
        stockist_id: targetStockist.id,
        product_id: p.id,
        stock_qty: 0,
        stock_quantity: 0,
        is_available: false,
        created_at: new Date().toISOString()
      });
    }
  });
  await db.saveTable('stockist_inventory', inventory);

  try {
    await createNotification({
      userId: user.id,
      type: 'kyc_approved',
      title: 'KYC approved',
      body: 'Your KYC application has been approved',
      link: 'kyc'
    });
  } catch (notifErr) {
    console.error('[notification] Failed to create kyc_approved notification:', notifErr);
  }

  return res.json({ success: true, stockist: targetStockist });
});

app.post('/api/admin/kyc/:userId/disapprove', async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  
  if (!reason) {
    return res.status(400).json({ error: 'Reason is required' });
  }
  
  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user || user.role !== 'STOCKIST') {
    return res.status(404).json({ error: 'Stockist not found' });
  }
  
  // Update user status
  user.kyc_status = 'REJECTED';
  user.kyc_rejection_reason = reason;
  user.kyc_rejection_at = new Date().toISOString();
  
  await db.saveTable('users', users);
  
  // Send notification
  if (user.phone && smsHelper.isSmsConfigured()) {
    try {
      await smsHelper.sendSms(user.phone, `KYC Application Rejected: Your KYC application was rejected. Reason: ${reason}. You can reapply anytime.`);
    } catch (e) {
      console.error('Failed to send KYC rejection SMS:', e);
    }
  }
  
  // Log audit
  await appendAudit(req, 'DISAPPROVE_KYC', 'user', userId, 
    { kyc_status: 'PENDING' }, 
    { kyc_status: 'REJECTED', kyc_rejection_reason: reason }
  );
  
  return res.json({ success: true, message: 'KYC rejected' });
});

// KYC Approval Endpoint (Alias / explicit)
app.post('/api/admin/kyc/:userId/approve', async (req, res) => {
  const { userId } = req.params;
  const { vendorId, deliveryRadius, minOrderValue } = req.body;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user) {
    const partnerLeads = await db.getTable('partner_leads') || [];
    if (partnerLeads.some(l => l.id === userId)) {
      return res.status(409).json({ error: 'wrong_record_type', message: 'This is a partner lead. Use the lead actions.' });
    }
    return res.status(404).json({ error: 'User not found' });
  }

  user.kyc_status = 'APPROVED';
  user.kyc_approved_at = new Date().toISOString();
  await db.saveTable('users', users);

  const stockists = await db.getTable('stockists');
  let stockist = stockists.find(s => s.user_id === userId);
  if (!stockist) {
    const shopName = (user.kyc_details && user.kyc_details.shop_name) ? user.kyc_details.shop_name : user.name + ' Store';
    stockist = {
      id: 's-' + generateId(),
      tenant_id: user.tenant_id || 't1',
      region_id: user.region_id,
      user_id: user.id,
      name: shopName,
      vendor_id: vendorId,
      delivery_radius_km: parseFloat(deliveryRadius) || 5.0,
      min_order_value: parseFloat(minOrderValue) || 0.0,
      is_active: true,
      opening_time: cfg.DEFAULT_OPENING_TIME,
      closing_time: cfg.DEFAULT_CLOSING_TIME,
      prep_eta_minutes: cfg.DEFAULT_PREP_ETA_MINUTES,
      created_at: new Date().toISOString()
    };
    stockists.push(stockist);
    await db.saveTable('stockists', stockists);
  } else {
    stockist.is_active = true;
    await db.saveTable('stockists', stockists);
  }

  if (vendorId) {
    await setMainWholesaler(stockist.id, vendorId);
  }

  await appendAudit(req, 'APPROVE_KYC', 'user', userId, { kyc_status: 'PENDING' }, { kyc_status: 'APPROVED' });

  try {
    await createNotification({
      userId: user.id,
      type: 'kyc_approved',
      title: 'KYC approved',
      body: 'Your KYC application has been approved',
      link: 'kyc'
    });
  } catch (notifErr) {
    console.error('[notification] Failed to create kyc_approved notification:', notifErr);
  }

  return res.json({ success: true, status: 'APPROVED', stockist });
});

// Reject KYC (consolidated with legacy reject-with-appeal)
app.post(['/api/admin/kyc/:userId/reject', '/api/admin/kyc/:userId/reject-with-appeal'], async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body || {};
  if (!reason || reason.trim().length < 5) return res.status(400).json({ error: 'Reason must be at least 5 characters' });

  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.kyc_status = 'REJECTED';
  user.kyc_rejection_reason = reason;
  user.kyc_rejection_count = (parseInt(user.kyc_rejection_count, 10) || 0) + 1;
  user.kyc_rejected_at = new Date().toISOString();
  
  if (user.kyc_rejection_count >= 3) {
    user.repeat_rejection = true;
  }

  await db.saveTable('users', users);
  await appendAudit(req, 'REJECT_KYC', 'user', userId, null, { kyc_status: user.kyc_status, reason, repeat_rejection: user.repeat_rejection || false });
  return res.json({ success: true, status: user.kyc_status, can_reapply: true });
});

// Blacklist User Endpoint
const handleBlacklistUserRoute = async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  if (!reason || reason.trim().length < 5) return res.status(400).json({ error: 'Reason must be at least 5 characters' });

  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.kyc_status = 'BLACKLISTED';
  user.kyc_blacklist_reason = reason;

  const blacklist = await db.getTable('user_blacklist');
  blacklist.push({
    id: 'bl-' + generateId(),
    user_id: user.id,
    phone: user.phone,
    reason: reason,
    blacklisted_at: new Date().toISOString(),
    blacklisted_by_admin_id: req.user ? req.user.id : 'admin-system'
  });
  await db.saveTable('user_blacklist', blacklist);

  // If user is a stockist, deactivate stockist record
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.user_id === userId);
  if (stockist) {
    stockist.is_active = false;
    await db.saveTable('stockists', stockists);
  }

  await db.saveTable('users', users);
  await appendAudit(req, 'BLACKLIST_USER', 'user', userId, null, { kyc_status: 'BLACKLISTED', reason });
  return res.json({ success: true, status: 'BLACKLISTED', can_reapply: false });
};
app.post('/api/admin/kyc/:userId/blacklist', handleBlacklistUserRoute);
app.post('/api/admin/users/:userId/blacklist', handleBlacklistUserRoute);

// Admin Get Blacklist

// TESTER-39: Account Removal Endpoints
app.get('/api/admin/users/:userId/references', async (req, res) => {
  const userId = req.params.userId;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.kyc_status !== 'REJECTED' && user.kyc_status !== 'BLACKLISTED') {
    return res.status(400).json({ error: 'Only rejected or blacklisted users can be checked for removal' });
  }

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.user_id === userId);
  const stockistId = stockist ? stockist.id : null;

  let totalRefs = 0;
  const references_by_table = {};

  const tables = [
    'orders', 'points_ledger', 'split_payouts', 'cod_commission_ledger', 'products', 
    'inventory', 'stockist_inventory', 'redemption_approvals',
    'customer_partner_bindings', 'fraud_reports', 'feedback_reports', 'anomaly_logs',
    'partner_users', 'partner_notifications', 'notifications', 'partner_feedback',
    'product_bill_photos', 'stockist_commission_rates', 'points_earn_config', 'commission_config'
  ];

  for (const t of tables) {
    const records = await db.getTable(t);
    let count = 0;
    for (const row of records) {
      if (!row) continue;
      let matched = false;
      for (const val of Object.values(row)) {
        if (val === userId || (stockistId && val === stockistId)) {
          matched = true;
          break;
        }
      }
      if (matched) count++;
    }
    if (count > 0) {
      references_by_table[t] = count;
      totalRefs += count;
    }
  }

  return res.json({ success: true, reference_count: totalRefs, references_by_table });
});

app.delete('/api/admin/users/:userId/account', async (req, res) => {
  const userId = req.params.userId;
  let users = await db.getTable('users');
  const userIndex = users.findIndex(u => u.id === userId);
  if (userIndex === -1) {
    const partnerLeads = await db.getTable('partner_leads') || [];
    if (partnerLeads.some(l => l.id === userId)) {
      return res.status(409).json({ error: 'wrong_record_type', message: 'This is a partner lead. Use the lead actions.' });
    }
    return res.status(404).json({ error: 'User not found' });
  }
  const user = users[userIndex];

  if (user.kyc_status !== 'REJECTED' && user.kyc_status !== 'BLACKLISTED') {
    return res.status(400).json({ error: 'Only rejected or blacklisted users can be removed' });
  }

  const stockists = await db.getTable('stockists');
  const stockistIndex = stockists.findIndex(s => s.user_id === userId);
  const stockistId = stockistIndex !== -1 ? stockists[stockistIndex].id : null;

  let totalRefs = 0;
  const references_by_table = {};
  const tables = [
    'orders', 'points_ledger', 'split_payouts', 'cod_commission_ledger', 'products', 
    'inventory', 'stockist_inventory', 'redemption_approvals',
    'customer_partner_bindings', 'fraud_reports', 'feedback_reports', 'anomaly_logs',
    'partner_users', 'partner_notifications', 'notifications', 'partner_feedback',
    'product_bill_photos', 'stockist_commission_rates', 'points_earn_config', 'commission_config'
  ];

  for (const t of tables) {
    const records = await db.getTable(t);
    let count = 0;
    for (const row of records) {
      if (!row) continue;
      let matched = false;
      for (const val of Object.values(row)) {
        if (val === userId || (stockistId && val === stockistId)) {
          matched = true;
          break;
        }
      }
      if (matched) count++;
    }
    if (count > 0) {
      references_by_table[t] = count;
      totalRefs += count;
    }
  }

  if (totalRefs === 0) {
    // Outcome A: Hard Delete
    const deletedUser = users.splice(userIndex, 1)[0];
    await db.saveTable('users', users);
    if (stockistIndex !== -1) {
      stockists.splice(stockistIndex, 1);
      await db.saveTable('stockists', stockists);
    }
    if (stockistId) {
      let stockistVendors = await db.getTable('stockist_vendors') || [];
      const svBefore = stockistVendors.length;
      stockistVendors = stockistVendors.filter(sv => sv.stockist_id !== stockistId);
      if (stockistVendors.length !== svBefore) {
        await db.saveTable('stockist_vendors', stockistVendors);
      }
    }
    // Delete kyc document file
    try {
      const kycDir = path.join(__dirname, 'uploads', 'kyc');
      if (fs.existsSync(kycDir)) {
        const files = fs.readdirSync(kycDir);
        for (const f of files) {
          if (f.startsWith(`${userId}_`)) {
            try { fs.unlinkSync(path.join(kycDir, f)); } catch (_) {}
          }
        }
      }
      if (deletedUser.kyc_details?.document_photo_url) {
        const filename = path.basename(deletedUser.kyc_details.document_photo_url);
        const filePath = path.join(__dirname, 'uploads', 'kyc', filename);
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (_) {}
        }
      }
    } catch (_) {}

    await appendAudit(req, 'DELETE_ACCOUNT', 'user', userId, deletedUser, { references: 0, by: req.user ? req.user.userId : 'admin-system' });
    return res.json({ success: true, action: 'DELETED', reference_count: 0, references_by_table });
  } else {
    // Outcome B: Release
    const previousStatus = user.kyc_status;
    user.kyc_status = 'RELEASED';
    user.released_at = new Date().toISOString();
    if (user.phone) {
      user.released_phone = user.phone;
      user.phone = null;
    }
    if (user.email) {
      user.released_email = user.email;
      user.email = null;
    }
    await db.saveTable('users', users);

    if (stockistIndex !== -1) {
      const stockistRow = stockists[stockistIndex];
      stockistRow.is_active = false;
      const stPhone = stockistRow.phone || stockistRow.contact_phone;
      if (stPhone) {
        stockistRow.released_phone = stPhone;
      }
      stockistRow.phone = null;
      stockistRow.contact_phone = null;
      await db.saveTable('stockists', stockists);
    }

    await appendAudit(req, 'RELEASE_ACCOUNT', 'user', userId, { previous_status: previousStatus }, { new_status: 'RELEASED', references_by_table, total_references: totalRefs, by: req.user ? req.user.userId : 'admin-system' });
    return res.json({ success: true, action: 'RELEASED', reference_count: totalRefs, references_by_table });
  }
});

app.get('/api/admin/blacklist', async (req, res) => {
  const users = await db.getTable('users');
  const blacklistRecords = (await db.getTable('user_blacklist')) || [];
  const partnerLeads = (await db.getTable('partner_leads')) || [];

  const rejectedOrBlacklistedUsers = users.filter(u => 
    u.kyc_status === 'BLACKLISTED' || u.kyc_status === 'REJECTED'
  );

  const userResults = rejectedOrBlacklistedUsers.map(u => {
    const record = blacklistRecords.find(b => b.user_id === u.id) || {};
    return {
      source: 'USER',
      id: u.id,
      user_id: u.id,
      name: u.name || 'Unnamed User',
      phone: u.phone || '',
      role: u.role || 'STOCKIST',
      type: u.role === 'PARTNER' ? 'Partner' : 'Stockist',
      kyc_status: u.kyc_status,
      reason: u.kyc_blacklist_reason || u.kyc_rejection_reason || record.reason || null,
      blacklisted_at: (u.kyc_status === 'BLACKLISTED') ? (record.blacklisted_at || u.kyc_rejected_at || u.created_at || null) : null,
      blacklisted_by: record.blacklisted_by_admin_id || null,
      repeat_rejection: u.repeat_rejection || false,
      blacklist_until: null
    };
  });

  const rejectedOrBlacklistedLeads = partnerLeads.filter(l => 
    l.status === 'REJECTED' || l.status === 'BLACKLISTED'
  );

  const leadResults = rejectedOrBlacklistedLeads.map(l => ({
    source: 'LEAD',
    id: l.id,
    user_id: l.id,
    name: l.name || l.contact_name || 'Partner Lead',
    phone: l.phone || '',
    role: 'PARTNER_LEAD',
    type: 'Partner Lead',
    kyc_status: l.status || 'REJECTED',
    reason: l.rejection_reason || l.reason || null,
    blacklisted_at: l.status === 'BLACKLISTED' ? (l.blacklisted_at || l.updated_at || l.created_at || null) : null,
    blacklisted_by: l.blacklisted_by || null,
    blacklist_until: null
  }));

  const result = [...userResults, ...leadResults];
  return res.json({ success: true, blacklist: result });
});

// Admin Restore Blacklisted/Rejected User to Pending
app.post('/api/admin/blacklist/:userId/restore', async (req, res) => {
  const { userId } = req.params;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const beforeStatus = user.kyc_status;
  
  user.kyc_status = 'PENDING';
  user.is_blacklisted = false;
  user.kyc_blacklist_until = null;
  user.kyc_blacklist_reason = null;
  user.kyc_rejection_reason = null;
  user.repeat_rejection = false;

  await db.saveTable('users', users);

  const blacklists = await db.getTable('user_blacklist');
  const filtered = blacklists.filter(b => b.user_id !== userId);
  await db.saveTable('user_blacklist', filtered);

  await appendAudit(req, 'RESTORE_TO_PENDING', 'user', userId, { kyc_status: beforeStatus }, { kyc_status: 'PENDING' });
  return res.json({ success: true, message: 'User restored to pending successfully.' });
});

// Patch Stockist (Deactivate / Reactivate / Blacklist)
app.patch('/api/admin/stockists/:id', async (req, res) => {
  const { id } = req.params;
  const { action, reason, days } = req.body;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });

  const users = await db.getTable('users');
  const user = stockist.user_id ? users.find(u => u.id === stockist.user_id) : null;

  if (action === 'DEACTIVATE') {
    stockist.is_active = false;
    await db.saveTable('stockists', stockists);
    if (user) { user.is_active = false; await db.saveTable('users', users); }
    await appendAudit(req, 'DEACTIVATE_STOCKIST', 'stockist', id, { is_active: true }, { is_active: false });
  } else if (action === 'REACTIVATE') {
    stockist.is_active = true;
    await db.saveTable('stockists', stockists);
    if (user) { user.is_active = true; await db.saveTable('users', users); }
    await appendAudit(req, 'REACTIVATE_STOCKIST', 'stockist', id, { is_active: false }, { is_active: true });
  } else if (action === 'BLACKLIST') {
    if (!reason || reason.trim().length < 5) return res.status(400).json({ error: 'Reason must be at least 5 characters' });
    stockist.is_active = false;
    await db.saveTable('stockists', stockists);
    if (user) {
      user.kyc_status = 'BLACKLISTED';
      user.kyc_blacklist_reason = reason || 'Fraud/Abuse flag from admin portal';
      await db.saveTable('users', users);

      const blacklist = await db.getTable('user_blacklist');
      blacklist.push({
        id: 'bl-' + generateId(),
        user_id: user.id,
        phone: user.phone,
        reason: user.kyc_blacklist_reason,
        blacklisted_at: new Date().toISOString(),
        blacklisted_by_admin_id: req.user ? req.user.id : 'admin-system'
      });
      await db.saveTable('user_blacklist', blacklist);
    }
    await appendAudit(req, 'BLACKLIST_STOCKIST', 'stockist', id, null, { action, reason });
  }

  if (req.body.linked_account_id !== undefined) {
    if (integrations.getPaymentsMode() === 'live' && (!req.body.linked_account_id || !req.body.linked_account_id.trim())) {
      return res.status(400).json({ error: 'Linked account ID (Razorpay Route) is required in live payments mode' });
    }
    stockist.linked_account_id = req.body.linked_account_id ? req.body.linked_account_id.trim() : null;
    await db.saveTable('stockists', stockists);
  }

  return res.json({ success: true, stockist, user, is_active: stockist.is_active });
});

// COD Commission Tracking per stockist
app.get('/api/admin/stockists/:id/cod-commission', async (req, res) => {
  const { id } = req.params;
  const orders = await db.getTable('orders');
  const codComms = await db.getTable('stockist_cod_commissions');

  // Filter DELIVERED COD orders for this stockist
  const stockistCodOrders = orders.filter(o => o.stockist_id === id && o.status === 'DELIVERED' && o.payment_method === 'COD');

  // Group by date
  const dateMap = {};
  stockistCodOrders.forEach(o => {
    const d = o.delivered_at ? new Date(o.delivered_at).toISOString().split('T')[0] : (o.created_at ? new Date(o.created_at).toISOString().split('T')[0] : '2026-09-07');
    if (!dateMap[d]) dateMap[d] = { count: 0, revenue: 0, commission: 0 };
    dateMap[d].count += 1;
    dateMap[d].revenue += parseFloat(o.subtotal || o.total_price || 0);
    dateMap[d].commission += parseFloat(o.platform_commission || (o.subtotal * 0.025) || 0);
  });

  const history = Object.keys(dateMap).map(d => {
    const existingRecord = codComms.find(c => c.stockist_id === id && c.date === d);
    return {
      date: d,
      cod_orders_count: dateMap[d].count,
      cod_revenue_total: dateMap[d].revenue,
      commission_amount: existingRecord ? existingRecord.commission_amount : dateMap[d].commission,
      is_paid: existingRecord ? existingRecord.is_paid === true : false,
      paid_at: existingRecord ? existingRecord.paid_at : null,
      paid_by_admin: existingRecord ? existingRecord.paid_by_admin : null
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  const totalOutstanding = history.filter(h => !h.is_paid).reduce((sum, h) => sum + h.commission_amount, 0);

  return res.json({ success: true, stockist_id: id, total_outstanding: totalOutstanding, history, commissions: history });
});

app.post(['/api/admin/stockist/:id/cod-commission/mark-paid', '/api/admin/stockists/:id/cod-commission/mark-paid'], async (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  const codComms = await db.getTable('stockist_cod_commissions');
  let comm = codComms.find(c => c.stockist_id === id && c.date === date);

  if (!comm) {
    const orders = await db.getTable('orders');
    const dayOrders = orders.filter(o => o.stockist_id === id && o.status === 'DELIVERED' && o.payment_method === 'COD');
    const totalRev = dayOrders.reduce((sum, o) => sum + parseFloat(o.subtotal || o.total_price || 0), 0);
    const commAmt = dayOrders.reduce((sum, o) => sum + parseFloat(o.platform_commission || (o.subtotal * 0.025) || 0), 0);

    comm = {
      id: 'cod-comm-' + generateId(),
      stockist_id: id,
      date: date || new Date().toISOString().split('T')[0],
      cod_orders_count: dayOrders.length,
      cod_revenue_total: totalRev,
      commission_rate: 0.025,
      commission_amount: commAmt,
      is_paid: true,
      paid_at: new Date().toISOString(),
      paid_by_admin: req.user ? req.user.id : 'admin'
    };
    codComms.push(comm);
  } else {
    comm.is_paid = true;
    comm.paid_at = new Date().toISOString();
    comm.paid_by_admin = req.user ? req.user.id : 'admin';
  }

  await db.saveTable('stockist_cod_commissions', codComms);
  await appendAudit(req, 'COD_COMMISSION_PAID', 'stockist', id, { is_paid: false }, { is_paid: true, date, amount: comm.commission_amount });
  return res.json({ success: true, commission: comm });
});

// Self-service Phone Change Requests & Verification

app.get('/api/admin/commission-rates', async (req, res) => res.json(await db.getTable('commission_rates')));

app.post('/api/admin/commission-rates', async (req, res) => {
  const { category, ratePercent, regionId } = req.body;
  if (!category || ratePercent === undefined || !regionId) {
    return res.status(400).json({ error: 'Category, regionId and ratePercent are required' });
  }
  const rates = await db.getTable('commission_rates');
  const idx = rates.findIndex(r => r.region_id === regionId && r.category === category);
  if (idx > -1) { rates[idx].rate_percent = parseFloat(ratePercent); }
  else { rates.push({ id: 'cr-' + generateId(), tenant_id: 't1', region_id: regionId, category, rate_percent: parseFloat(ratePercent), created_at: new Date().toISOString() }); }
  await db.saveTable('commission_rates', rates);
  return res.json({ success: true, rates });
});

app.get('/api/admin/stockist-commission-rates', async (req, res) => res.json(await db.getTable('stockist_commission_rates')));

app.post('/api/admin/stockist-commission-rates', async (req, res) => {
  const { stockistId, ratePercent } = req.body;
  if (!stockistId || ratePercent === undefined) return res.status(400).json({ error: 'stockistId and ratePercent are required' });
  const rates = await db.getTable('stockist_commission_rates');
  const idx = rates.findIndex(r => r.stockist_id === stockistId);
  if (idx > -1) { rates[idx].rate_percent = parseFloat(ratePercent); }
  else { rates.push({ id: 'scr-' + generateId(), stockist_id: stockistId, rate_percent: parseFloat(ratePercent), created_at: new Date().toISOString() }); }
  await db.saveTable('stockist_commission_rates', rates);
  return res.json({ success: true, rates });
});

app.get('/api/admin/points-earn-config', async (req, res) => res.json(await db.getTable('points_earn_config')));

app.post('/api/admin/points-earn-config', async (req, res) => {
  const { regionId, stockistId, earnRatePercent } = req.body;
  if (earnRatePercent === undefined) return res.status(400).json({ error: 'earnRatePercent is required' });
  const configs = await db.getTable('points_earn_config');
  let idx = stockistId ? configs.findIndex(c => c.stockist_id === stockistId) : regionId ? configs.findIndex(c => c.region_id === regionId && !c.stockist_id) : -1;
  if (!stockistId && !regionId) return res.status(400).json({ error: 'Either regionId or stockistId is required' });
  const updatedConfig = { id: idx > -1 ? configs[idx].id : 'pec-' + generateId(), region_id: regionId || null, stockist_id: stockistId || null, earn_rate_percent: parseFloat(earnRatePercent), created_at: idx > -1 ? configs[idx].created_at : new Date().toISOString() };
  if (idx > -1) configs[idx] = updatedConfig; else configs.push(updatedConfig);
  await db.saveTable('points_earn_config', configs);
  return res.json({ success: true, configs });
});

app.post('/api/admin/stockist-vendors', async (req, res) => {
  const { stockistId, vendorId } = req.body;
  if (!stockistId || !vendorId) return res.status(400).json({ error: 'stockistId and vendorId are required' });
  const stockistVendors = await db.getTable('stockist_vendors');
  if (!stockistVendors.some(sv => sv.stockist_id === stockistId && sv.vendor_id === vendorId)) {
    stockistVendors.push({ id: 'sv-' + generateId(), stockist_id: stockistId, vendor_id: vendorId, approved_at: new Date().toISOString() });
    await db.saveTable('stockist_vendors', stockistVendors);
  }

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === stockistId);
  if (stockist && !stockist.vendor_id) {
    await setMainWholesaler(stockistId, vendorId);
  }

  return res.json({ success: true, stockistVendors });
});


app.get('/api/admin/anomalies', async (req, res) => {
  const logs = await db.getTable('anomaly_logs');
  return res.json(logs);
});

app.post('/api/admin/anomalies/:id/flag', async (req, res) => {
  const { id } = req.params;
  const logs = await db.getTable('anomaly_logs');
  const idx = logs.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Anomaly log not found.' });
  logs[idx].status = 'FLAGGED';
  await db.saveTable('anomaly_logs', logs);
  return res.json({ success: true, log: logs[idx] });
});

app.post('/api/admin/anomalies/:id/dismiss', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const logs = await db.getTable('anomaly_logs');
  const idx = logs.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Anomaly log not found.' });
  logs[idx].status = 'DISMISSED';
  logs[idx].dismissed = true;
  logs[idx].dismiss_reason = reason || 'No reason provided';
  logs[idx].dismiss_at = new Date().toISOString();
  await db.saveTable('anomaly_logs', logs);
  return res.json({ success: true, log: logs[idx] });
});

app.post('/api/admin/anomalies/:id/investigate', async (req, res) => {
  const { id } = req.params;
  const logs = await db.getTable('anomaly_logs');
  const idx = logs.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Anomaly log not found.' });
  logs[idx].status = 'INVESTIGATED';
  logs[idx].investigated = true;
  await db.saveTable('anomaly_logs', logs);
  return res.json({ success: true, log: logs[idx] });
});

// Admin: customer no-show count and reset
app.get('/api/admin/customer-noshows', async (req, res) => {
  const users = await db.getTable('users');
  const customers = users.filter(u => u.role === 'CUSTOMER' && (u.no_show_count || 0) > 0);
  return res.json(customers.map(u => ({ id: u.id, name: u.name, phone: u.phone, no_show_count: u.no_show_count || 0, prepaid_pickup_restricted: !!u.prepaid_pickup_restricted })));
});

app.post('/api/admin/reset-noshows/:userId', async (req, res) => {
  const { userId } = req.params;
  const users = await db.getTable('users');
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].no_show_count = 0;
  users[idx].prepaid_pickup_restricted = false;
  await db.saveTable('users', users);
  return res.json({ success: true });
});

app.get('/api/admin/redemptions', async (req, res) => {
  const ledger = await db.getTable('points_ledger');
  const users = await db.getTable('users');
  const redemptions = ledger.filter(l => l.type === 'REDEEM').map(l => {
    const user = users.find(u => u.id === l.customer_id);
    return { ...l, customer_name: user ? user.name : 'Unknown Customer', customer_phone: user ? user.phone : '' };
  }).reverse();
  return res.json(redemptions);
});

app.post('/api/admin/complete-redemption', async (req, res) => {
  const { ledgerId } = req.body;
  if (!ledgerId) return res.status(400).json({ error: 'Ledger ID required' });
  const ledger = await db.getTable('points_ledger');
  const idx = ledger.findIndex(l => l.id === ledgerId);
  if (idx === -1) return res.status(404).json({ error: 'Ledger entry not found' });
  await db.query("UPDATE points_ledger SET billing_sync_status = $1 WHERE id = $2", ['SYNCED', ledgerId]);
  return res.json({ success: true, entry: ledger[idx] });
});

// GET /api/admin/vendors/load
app.get('/api/admin/vendors/load', async (req, res) => {
  const { region_id } = req.query;
  if (!region_id) return res.status(400).json({ error: 'region_id is required' });

  const vendors = await db.getTable('vendors');
  const stockists = await db.getTable('stockists');
  const stockistVendors = await db.getTable('stockist_vendors');

  const activeVendors = vendors.filter(v => v.region_id === region_id && v.is_active !== false);

  const loadData = activeVendors.map(v => {
    const approved_stockists = stockistVendors
      .filter(sv => sv.vendor_id === v.id)
      .map(sv => stockists.find(st => st.id === sv.stockist_id))
      .filter(s => s && s.is_active !== false)
      .filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i);

    return {
      id: v.id,
      name: v.name,
      stockist_count: approved_stockists.length
    };
  });

  return res.json(loadData);
});

app.get('/api/admin/vendors', async (req, res) => {
  const vendors = await db.getTable('vendors');
  const includeInactive = req.query.include_inactive === 'true';
  const visible = vendors.filter(v => includeInactive || v.is_active !== false);

  const stockists = await db.getTable('stockists');
  const stockistVendors = await db.getTable('stockist_vendors');

  const enriched = visible.map(v => {
    const approved_stockists = stockistVendors
      .filter(sv => sv.vendor_id === v.id)
      .map(sv => stockists.find(st => st.id === sv.stockist_id))
      .filter(s => s && s.is_active !== false)
      // dedupe in case of duplicate join rows:
      .filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i)
      .map(s => ({
        id: s.id,
        name: s.name,
        shop_name: s.shop_name,
        is_main: s.vendor_id === v.id
      }));

    return { 
      ...v, 
      approved_stockists, 
      approved_count: approved_stockists.length 
    };
  });

  res.json(enriched);
});

app.post('/api/admin/vendors', async (req, res) => {
  const { name, regionId } = req.body;
  if (!name || !regionId) return res.status(400).json({ error: 'Name and regionId required' });
  const vendors = await db.getTable('vendors');
  const newVendor = { id: 'v-' + generateId(), tenant_id: 't1', region_id: regionId, name, created_at: new Date().toISOString() };
  vendors.push(newVendor);
  await db.saveTable('vendors', vendors);
  return res.json({ success: true, vendor: newVendor });
});

app.patch('/api/admin/vendors/:id', async (req, res) => {
  const vendors = await db.getTable('vendors');
  const vendor = vendors.find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

  const { name, region_id, is_active } = req.body;
  if (name === undefined && region_id === undefined && is_active === undefined) {
    return res.status(400).json({ error: 'no_fields', message: 'No fields to update.' });
  }

  const before = { ...vendor };

  if (name !== undefined) {
    const clean = String(name).trim();
    if (clean.length < 2) {
      return res.status(400).json({ error: 'invalid_name', message: 'Wholesaler name must be at least 2 characters.' });
    }
    vendor.name = clean;
  }

  if (region_id !== undefined) {
    const regions = await db.getTable('regions');
    if (!regions.find(r => r.id === region_id)) {
      return res.status(400).json({ error: 'invalid_region', message: 'Region does not exist.' });
    }
    vendor.region_id = region_id;
  }

  if (is_active !== undefined) {
    vendor.is_active = Boolean(is_active);
    vendor.deactivated_at = vendor.is_active ? null : new Date().toISOString();
  }

  await db.saveTable('vendors', vendors);
  await appendAudit(req, 'UPDATE_VENDOR', 'vendor', vendor.id, before, { ...vendor });
  return res.json({ success: true, vendor });
});

app.delete('/api/admin/vendors/:id', async (req, res) => {
  const vendors = await db.getTable('vendors');
  const vendor = vendors.find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

  const stockists = await db.getTable('stockists');
  const links = await db.getTable('stockist_vendors');
  const refCount = stockists.filter(s => s.vendor_id === vendor.id).length
                 + links.filter(l => l.vendor_id === vendor.id).length;

  const before = { ...vendor };

  if (refCount === 0) {
    const next = vendors.filter(v => v.id !== vendor.id);
    await db.saveTable('vendors', next);
    await appendAudit(req, 'DELETE_VENDOR', 'vendor', vendor.id, before, { reference_count: 0 });
    return res.json({ success: true, action: 'DELETED', reference_count: 0 });
  }

  return res.status(409).json({ error: 'vendor_in_use', reference_count: refCount });
});

app.get('/api/admin/vendors/:id/references', async (req, res) => {
  const stockists = await db.getTable('stockists');
  const links = await db.getTable('stockist_vendors');
  const refCount = stockists.filter(s => s.vendor_id === req.params.id).length
                 + links.filter(l => l.vendor_id === req.params.id).length;
  return res.json({ reference_count: refCount });
});

// Partner Leads Routes

app.get('/api/admin/partner-leads', async (req, res) => {
  let leads = await db.getTable('partner_leads');
  const { status, region_id } = req.query;
  if (status) leads = leads.filter(l => l.status === status);
  if (region_id) leads = leads.filter(l => l.region_id === region_id);
  const enriched = leads.map(l => {
    let stArray = l.service_types;
    if (!stArray || !Array.isArray(stArray) || stArray.length === 0) {
      if (l.service_type === 'BOTH') stArray = ['CABLE', 'BROADBAND'];
      else if (l.service_type) stArray = [l.service_type];
      else stArray = ['CABLE'];
    }
    return {
      ...l,
      service_types: stArray,
      notes: l.notes || [],
      status: l.status || 'NEW'
    };
  }).reverse();
  return res.json(enriched);
});

app.post('/api/admin/partner-leads/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body;
  const validStatuses = ['NEW', 'CONTACTED', 'NEGOTIATING', 'ONBOARDED', 'REJECTED'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  if (status === 'REJECTED') {
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'Rejection reason must be at least 5 characters' });
    }
  }

  const leads = await db.getTable('partner_leads');
  const lead = leads.find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const oldStatus = lead.status || 'NEW';
  
  lead.status = status;
  if (status === 'REJECTED') {
    lead.reason = reason.trim();
  } else if (status === 'NEW' && reason === 'Reconsidered') {
    lead.reason = null;
  }
  
  await db.saveTable('partner_leads', leads);
  
  const auditDetails = { status };
  if (status === 'REJECTED') {
    auditDetails.reason = reason.trim();
  }
  
  await appendAudit(req, 'UPDATE_LEAD_STATUS', 'partner_lead', id, { status: oldStatus }, auditDetails);
  return res.json({ success: true, lead });
});

app.post('/api/admin/partner-leads/:id/notes', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Note text is required' });
  const leads = await db.getTable('partner_leads');
  const lead = leads.find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!lead.notes) lead.notes = [];
  const noteObj = {
    id: 'n-' + generateId(),
    text: text.trim(),
    admin_id: req.user.userId,
    created_at: new Date().toISOString()
  };
  lead.notes.push(noteObj);
  await db.saveTable('partner_leads', leads);
  await appendAudit(req, 'ADD_LEAD_NOTE', 'partner_lead', id, null, { note: text.trim() });
  return res.json({ success: true, lead });
});

app.delete('/api/admin/partner-leads/:id', async (req, res) => {
  const { id } = req.params;
  const leads = await db.getTable('partner_leads');
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  const oldLead = leads[idx];
  leads.splice(idx, 1);
  await db.saveTable('partner_leads', leads);
  await appendAudit(req, 'DELETE_LEAD', 'partner_lead', id, oldLead, null);
  return res.json({ success: true, message: 'Partner lead deleted' });
});

// Admin Audit Log GET
app.get('/api/admin/audit-log', async (req, res) => {
  let log = await db.getTable('admin_audit_log');
  const { admin_id, entity_type, action, start_date, end_date } = req.query;
  if (admin_id) log = log.filter(l => l.admin_user_id === admin_id);
  if (entity_type) log = log.filter(l => l.entity_type === entity_type);
  if (action) log = log.filter(l => l.action === action);
  if (start_date) log = log.filter(l => new Date(l.created_at) >= new Date(start_date));
  if (end_date) log = log.filter(l => new Date(l.created_at) <= new Date(end_date));
  return res.json(log.slice().reverse());
});

// Customer Fraud Report Submission

// Admin GET Fraud Reports
app.get('/api/admin/payout-changes', async (req, res) => {
  const log = await db.getTable('admin_audit_log');
  const notices = log.filter(l => l.action === 'PAYOUT_DETAILS_CHANGED').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(notices);
});

app.post('/api/admin/payout-changes/:id/review', async (req, res) => {
  const { id } = req.params;
  const log = await db.getTable('admin_audit_log');
  const notice = log.find(l => l.id === id && l.action === 'PAYOUT_DETAILS_CHANGED');
  if (!notice) return res.status(404).json({ error: 'Notice not found' });
  
  notice.reviewed_by = req.user.userId;
  notice.reviewed_at = new Date().toISOString();
  await db.saveTable('admin_audit_log', log);
  res.json({ success: true });
});

app.get('/api/admin/fraud-reports', async (req, res) => {
  let reports = await db.getTable('fraud_reports');
  const users = await db.getTable('users');
  const { status, region_id } = req.query;
  if (status) {
    reports = reports.filter(r => r.status === status);
  }
  if (region_id) {
    reports = reports.filter(r => {
      const reporter = users.find(u => u.id === r.reporter_customer_id);
      return reporter && reporter.region_id === region_id;
    });
  }
  const enriched = reports.map(r => {
    const reporter = users.find(u => u.id === r.reporter_customer_id);
    return {
      ...r,
      reporter_name: reporter ? reporter.name : 'Unknown',
      reporter_phone: reporter ? reporter.phone : '',
      reporter_region_id: reporter ? reporter.region_id : null
    };
  }).reverse();
  return res.json(enriched);
});

// Admin Update Fraud Report Status
app.post('/api/admin/fraud-reports/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, adminNotes } = req.body;
  const validStatuses = ['NEW', 'TRIAGING', 'RESOLVED', 'DISMISSED'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (['RESOLVED', 'DISMISSED'].includes(status)) {
    if (!adminNotes || adminNotes.trim().length < 10) {
      return res.status(400).json({ error: 'Admin notes of at least 10 characters required when resolving or dismissing' });
    }
  }
  const reports = await db.getTable('fraud_reports');
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Fraud report not found' });
  const oldStatus = report.status;
  report.status = status;
  if (adminNotes) report.admin_notes = adminNotes.trim();
  if (['RESOLVED', 'DISMISSED'].includes(status)) {
    report.resolved_at = new Date().toISOString();
  }
  await db.saveTable('fraud_reports', reports);
  await appendAudit(req, 'UPDATE_FRAUD_REPORT_STATUS', 'fraud_report', id, { status: oldStatus }, { status, admin_notes: report.admin_notes }, adminNotes);
  return res.json({ success: true, report });
});

// Admin Customers Endpoints
app.get('/api/admin/customers', async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true';
  const users = (await db.getTable('users')).filter(u => u.role === 'CUSTOMER');
  const pointsLedger = await db.getTable('points_ledger');
  const orders = await db.getTable('orders');
  
  const filteredUsers = includeInactive ? users : users.filter(u => u.is_active !== false);
  const result = filteredUsers.map(u => {
    const custLedger = pointsLedger.filter(l => l.customer_id === u.id);
    const balance = custLedger.filter(l => l.type !== 'EARN_HELD').reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
    const custOrders = orders.filter(o => o.customer_id === u.id);
    return {
      id: u.id,
      name: u.name,
      phone: u.phone,
      email: u.email || '',
      region_id: u.region_id,
      is_active: u.is_active !== false,
      points_balance: balance,
      total_orders: custOrders.length,
      created_at: u.created_at,
      role: u.role,
      address: u.address || ''
    };
  });
  return res.json(result);
});

app.get('/api/admin/customers/:id', async (req, res) => {
  const { id } = req.params;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  
  const pointsLedger = (await db.getTable('points_ledger')).filter(l => l.customer_id === id);
  const balance = pointsLedger.filter(l => l.type !== 'EARN_HELD').reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  const rawOrders1 = (await db.getTable('orders')).filter(o => o.customer_id === id);
  const orders = await Promise.all(rawOrders1.map(o => enrichOrder(o, req)));
  const fraudReports = (await db.getTable('fraud_reports')).filter(f => f.reporter_customer_id === id);
  
  return res.json({
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    region_id: user.region_id,
    address: user.address,
    kyc_status: user.kyc_status,
    referral_code: user.referral_code,
    created_at: user.created_at,
    is_active: user.is_active !== false,
    points_balance: balance,
    customer: { ...sanitizeUser(user), is_active: user.is_active !== false, points_balance: balance },
    orders,
    ledger: pointsLedger.slice().reverse(),
    fraud_reports: fraudReports.slice().reverse()
  });
});

app.post('/api/admin/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email } = req.body;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  const before = { name: user.name, email: user.email || '' };
  if (name) user.name = name.trim();
  if (email !== undefined) user.email = email.trim();
  await db.saveTable('users', users);
  await appendAudit(req, 'EDIT_CUSTOMER', 'customer', id, before, { name: user.name, email: user.email });
  return res.json({ success: true, customer: sanitizeUser(user) });
});


app.post('/api/admin/customers/:id/phone-change/send-current', async (req, res) => {
  const { id } = req.params;
  const { via, phone } = req.body;
  
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  
  if (via === 'phone') {
    if (!phone) return res.status(400).json({ error: 'Does not match the registered number' });
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone !== user.phone) return res.status(400).json({ error: 'Does not match the registered number' });
  } else if (via === 'email') {
    if (!user.email) return res.status(400).json({ error: 'No email on file' });
  } else {
    return res.status(400).json({ error: 'Invalid via method' });
  }

  if (checkSendRateLimit(sendCurrentRateLimits, id, res)) return;
  
  const marker = getPhoneChangeMarker(id);
  marker.currentMethod = via;

  const purposeKey = 'admin-phone-change-current:' + id;
  const currentCode = issueOtp(purposeKey);
  
  if (via === 'phone') {
    const sms = require('./lib/sms');
    await sms.sendSms(user.phone, `Your Beniffy admin change code is ${currentCode}.`);
  } else if (via === 'email') {
    const emailHelper = require('./lib/email');
    await emailHelper.sendEmail(user.email, 'Beniffy Admin Change Code', `Your code is ${currentCode}.`, `Your code is ${currentCode}.`);
  }
  
  return res.json({ success: true });
});

app.post('/api/admin/customers/:id/phone-change/verify-current', async (req, res) => {
  const { id } = req.params;
  const { otp } = req.body;
  if (!otp || !/^\d{6}$/.test(String(otp).trim())) return res.status(400).json({ error: 'Invalid OTP for current phone' });
  const vC = verifyOtp('admin-phone-change-current:' + id, otp);
  if (!vC.ok) return res.status(400).json({ error: 'Invalid OTP for current phone' });
  
  const marker = getPhoneChangeMarker(id);
  marker.currentVerified = true;
  marker.currentExpires = Date.now() + 600000;
  
  return res.json({ success: true });
});

app.post('/api/admin/customers/:id/phone-change/send-new', async (req, res) => {
  const { id } = req.params;
  const { newPhone } = req.body;
  
  const marker = getPhoneChangeMarker(id);
  if (!marker.currentVerified || Date.now() > marker.currentExpires) {
    return res.status(400).json({ error: 'Current step not verified' });
  }
  
  if (!newPhone || !newPhone.trim()) return res.status(400).json({ error: 'New phone is required' });
  const validPhone = checkPhone(newPhone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;

  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  
  if (cleanPhone === user.phone) return res.status(400).json({ error: 'Phone already registered' });
  const exists = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone);
  if (exists) return res.status(400).json({ error: 'Phone already registered' });
  
  if (checkSendRateLimit(sendNewRateLimits, id, res)) return;

  const purposeKey = 'admin-phone-change-new:' + id;
  const newCode = issueOtp(purposeKey);
  
  const sms = require('./lib/sms');
  await sms.sendSms(cleanPhone, `Your Beniffy admin change code is ${newCode}.`);
  
  return res.json({ success: true });
});

app.post('/api/admin/customers/:id/phone-change/verify-new', async (req, res) => {
  const { id } = req.params;
  const { otp, newPhone } = req.body;
  
  if (!newPhone || !newPhone.trim()) return res.status(400).json({ error: 'New phone is required' });
  const validPhone = checkPhone(newPhone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;

  if (!otp || !/^\d{6}$/.test(String(otp).trim())) return res.status(400).json({ error: 'Invalid OTP' });
  const vN = verifyOtp('admin-phone-change-new:' + id, otp);
  if (!vN.ok) return res.status(400).json({ error: 'Invalid OTP' });
  
  const marker = getPhoneChangeMarker(id);
  marker.newVerified = true;
  marker.newPhone = cleanPhone;
  marker.newExpires = Date.now() + 600000;
  
  return res.json({ success: true });
});

app.post('/api/admin/customers/:id/phone-change', async (req, res) => {
  const { id } = req.params;
  const { newPhone } = req.body;
  
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  
  if (!newPhone || !newPhone.trim()) return res.status(400).json({ error: 'New phone is required' });
  const validPhone = checkPhone(newPhone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;

  const marker = getPhoneChangeMarker(id);
  if (!marker.currentVerified || Date.now() > marker.currentExpires) {
    return res.status(400).json({ error: 'Current step not verified' });
  }
  if (!marker.newVerified || Date.now() > marker.newExpires || marker.newPhone !== cleanPhone) {
    return res.status(400).json({ error: 'New step not verified for this number' });
  }

  if (cleanPhone === user.phone) return res.status(400).json({ error: 'Phone already registered' });
  const exists = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone);
  if (exists) return res.status(400).json({ error: 'Phone already registered' });
  
  const oldPhone = user.phone;
  user.phone = cleanPhone;
  await db.saveTable('users', users);
  
  const auditDetails = { phone: user.phone, method: marker.currentMethod || 'unknown' };
  await appendAudit(req, 'CHANGE_PHONE', 'customer', id, { phone: oldPhone }, auditDetails);
  
  phoneChangeMarkers.delete(id);
  sendCurrentRateLimits.delete(id);
  sendNewRateLimits.delete(id);
  
  return res.json({ success: true, user: sanitizeUser(user) });
});

app.post('/api/admin/customers/:id/points-credit', async (req, res) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > cfg.MANUAL_CREDIT_MAX_POINTS) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid amount', fields: { amount: `must be > 0 and <= ${cfg.MANUAL_CREDIT_MAX_POINTS}` } });
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length < 5) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid reason', fields: { reason: 'must be at least 5 characters' } });
  }
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  
  const ledger = await db.getTable('points_ledger');
  const entry = {
    id: 'l-' + generateId(),
    tenant_id: user.tenant_id || 't1',
    region_id: user.region_id || null,
    customer_id: id,
    amount: numAmount,
    type: 'MANUAL_CREDIT',
    source: 'ADMIN',
    admin_id: req.user.userId,
    reason: reason.trim(),
    order_id: null,
    description: `Manual admin credit: ${reason.trim()}`,
    created_at: new Date().toISOString()
  };
  await db.insertRow('points_ledger', entry);
  
  await appendAudit(req, 'MANUAL_POINTS_CREDIT', 'customer', id, null, { amount: numAmount, reason: reason.trim() }, reason.trim());
  
  const updatedLedger = ledger.filter(l => l.customer_id === id);
  const newBalance = updatedLedger.filter(l => l.type !== 'EARN_HELD').reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  return res.json({ success: true, new_balance: newBalance, entry });
});

app.post('/api/admin/customers/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  user.is_active = false;
  await db.saveTable('users', users);
  await appendAudit(req, 'DEACTIVATE_CUSTOMER', 'customer', id, { is_active: true }, { is_active: false });
  return res.json({ success: true, user: sanitizeUser(user) });
});

app.post('/api/admin/customers/:id/reactivate', async (req, res) => {
  const { id } = req.params;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });
  user.is_active = true;
  await db.saveTable('users', users);
  await appendAudit(req, 'REACTIVATE_CUSTOMER', 'customer', id, { is_active: false }, { is_active: true });
  return res.json({ success: true, user: sanitizeUser(user) });
});

// Admin Stockists Endpoints
app.get('/api/admin/stockists', async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true';
  const includePending = req.query.include_pending === 'true';
  const stockists = await db.getTable('stockists');
  const orders = await db.getTable('orders');
  const rates = await db.getTable('stockist_commission_rates');
  const users = await db.getTable('users');
  const products = await db.getTable('products');

  const ACTIVE_LIST_STATUSES = ['APPROVED'];
  const INACTIVE_LIST_STATUSES = ['DEACTIVATED'];

  let visibleStatuses = includeInactive
    ? [...ACTIVE_LIST_STATUSES, ...INACTIVE_LIST_STATUSES]
    : ACTIVE_LIST_STATUSES;
  if (includePending) {
    visibleStatuses = [...visibleStatuses, 'PENDING'];
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const result = [];
  for (const s of stockists) {
    const user = findStockistOwner(s, users);
    let kycStatus = user ? user.kyc_status : (s.is_active !== false ? 'APPROVED' : 'DEACTIVATED');
    if (s.is_active === false && kycStatus === 'APPROVED') {
      kycStatus = 'DEACTIVATED';
    }

    if (!visibleStatuses.includes(kycStatus)) {
      continue;
    }

    const stkOrders = orders.filter(o => o.stockist_id === s.id);
    const delivered30d = stkOrders.filter(o => o.status === 'DELIVERED' && new Date(o.created_at).getTime() >= thirtyDaysAgo);
    const gmv30d = delivered30d.reduce((sum, o) => sum + (parseFloat(o.total) || parseFloat(o.subtotal) || 0), 0);
    const pendingCount = stkOrders.filter(o => ['CONFIRMING', 'PENDING', 'ACCEPTED', 'PREPARING'].includes(o.status)).length;
    const stkRates = rates.filter(r => r.stockist_id === s.id);
    const latestRate = stkRates.length > 0 ? stkRates[stkRates.length - 1].rate_percent : 10.0;
    const visibility = getCustomerVisibility(s, users, products);

    result.push({
      ...s,
      is_active: kycStatus === 'APPROVED',
      kyc_status: kycStatus,
      user_name: user ? user.name : s.name,
      user_phone: user ? user.phone : (s.phone || s.contact_phone || ''),
      gmv_30d: gmv30d,
      pending_orders_count: pendingCount,
      commission_rate: latestRate,
      customer_visible: visibility.visible,
      customer_visibility_reason: visibility.reason
    });
  }
  return res.json(result);
});
app.get('/api/admin/stockists/lookup-by-id', async (req, res) => {
  const { kyc_id } = req.query;
  if (!kyc_id || kyc_id.length !== 12) return res.status(400).json({ error: 'Invalid KYC ID' });

  await appendAudit(req, 'SEARCH_KYC_ID', 'admin', 'lookup', { query: kyc_id }, {});

  const users = await db.getTable('users');
  const user = users.find(u => {
    if (!u.kyc_details) return false;
    let kyc;
    try { kyc = typeof u.kyc_details === 'string' ? JSON.parse(u.kyc_details) : u.kyc_details; } catch(e) { return false; }
    return kyc.id_number === kyc_id || u.kyc_id_number === kyc_id;
  });

  if (!user) return res.status(404).json({ error: 'Not found' });

  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.user_id === user.id || s.phone === user.phone || s.contact_phone === user.phone);
  
  if (!stockist) return res.status(404).json({ error: 'Not found' });

  const orders = await db.getTable('orders');
  const rates = await db.getTable('stockist_commission_rates');
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const stkOrders = orders.filter(o => o.stockist_id === stockist.id);
  const delivered30d = stkOrders.filter(o => o.status === 'DELIVERED' && new Date(o.created_at).getTime() >= thirtyDaysAgo);
  const gmv30d = delivered30d.reduce((sum, o) => sum + (parseFloat(o.total) || parseFloat(o.subtotal) || 0), 0);
  const pendingCount = stkOrders.filter(o => ['CONFIRMING', 'PENDING', 'ACCEPTED', 'PREPARING'].includes(o.status)).length;
  const stkRates = rates.filter(r => r.stockist_id === stockist.id);
  const latestRate = stkRates.length > 0 ? stkRates[stkRates.length - 1].rate_percent : 10.0;
  
  let kycStatus = user.kyc_status || (stockist.is_active !== false ? 'APPROVED' : 'DEACTIVATED');
  if (stockist.is_active === false && kycStatus === 'APPROVED') {
    kycStatus = 'DEACTIVATED';
  }

  return res.json({
    ...stockist,
    is_active: kycStatus === 'APPROVED',
    kyc_status: kycStatus,
    user_name: user.name,
    user_phone: user.phone,
    gmv_30d: gmv30d,
    pending_orders_count: pendingCount,
    commission_rate: latestRate
  });
});

app.get('/api/admin/stockists/:id', async (req, res) => {
  const { id } = req.params;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });

  const users = await db.getTable('users');
  const user = users.find(u => u.id === stockist.user_id || (u.phone && (u.phone === stockist.phone || u.phone === stockist.contact_phone)));
  let kycStatus = user ? user.kyc_status : (stockist.is_active !== false ? 'APPROVED' : 'DEACTIVATED');
  if (stockist.is_active === false && kycStatus === 'APPROVED') {
    kycStatus = 'DEACTIVATED';
  }

  const rawOrders2 = (await db.getTable('orders')).filter(o => o.stockist_id === id);
  const orders = await Promise.all(rawOrders2.map(o => enrichOrder(o, req)));
  const rates = (await db.getTable('stockist_commission_rates')).filter(r => r.stockist_id === id);
  const latestRate = rates.length > 0 ? rates[rates.length - 1].rate_percent : 10.0;

  const deliveredOrders = orders.filter(o => o.status === 'DELIVERED');
  const totalCommissionEarned = deliveredOrders.reduce((sum, o) => sum + ((parseFloat(o.subtotal) || 0) * (latestRate / 100)), 0);

  const inventory = (await db.getTable('stockist_inventory')).filter(si => si.stockist_id === id);

  return res.json({
    ...stockist,
    is_active: kycStatus === 'APPROVED',
    kyc_status: kycStatus,
    user_name: user ? user.name : stockist.name,
    user_phone: user ? user.phone : (stockist.phone || stockist.contact_phone || ''),
    stockist: { ...stockist, is_active: kycStatus === 'APPROVED', kyc_status: kycStatus, commission_rate: latestRate },
    user: user ? {
      ...user,
      name: user.name,
      phone: user.phone,
      kyc_status: kycStatus,
      kyc_details: user.kyc_details,
      address: user.address,
      is_active: kycStatus === 'APPROVED'
    } : null,
    orders,
    total_commission_earned: totalCommissionEarned,
    inventory
  });
});

app.post('/api/admin/stockists', async (req, res) => {
  let { name, region_id, vendor_id, phone, delivery_radius_km, opening_time, closing_time, prep_eta_minutes, commission_rate, linked_account_id } = req.body;
  if (!name || !region_id || !phone) {
    return res.status(400).json({ error: 'Name, region_id, and phone are required', message: 'Choose a region.' });
  }
  const regions = await db.getTable('regions');
  if (!regions.some(r => r.id === region_id)) {
    return res.status(400).json({ error: 'Choose a region.', message: 'Region does not exist.' });
  }
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;

  if (integrations.getPaymentsMode() === 'live' && (!linked_account_id || !linked_account_id.trim())) {
    return res.status(400).json({ error: 'Linked account ID (Razorpay Route) is required in live payments mode' });
  }

  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (opening_time && (opening_time === '24:00' || !timeRegex.test(opening_time))) {
    return res.status(400).json({ error: 'Opening time must be between 00:00 and 23:59' });
  }
  if (closing_time && (closing_time === '24:00' || !timeRegex.test(closing_time))) {
    return res.status(400).json({ error: 'Closing time must be between 00:00 and 23:59' });
  }

  const stockists = await db.getTable('stockists');
  const users = await db.getTable('users');
  const cleanPhone = phone.trim();
  const clash = stockists.find(s => s.phone === cleanPhone || s.contact_phone === cleanPhone);
  const userClash = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone && u.role === 'STOCKIST');
  if (clash || userClash) return res.status(409).json({ error: 'Stockist already exists for this phone' });

  if (!vendor_id) {
    return res.status(400).json({ error: 'Wholesaler is required' });
  }
  const vendors = await db.getTable('vendors');
  const vendor = vendors.find(v => v.id === vendor_id);
  if (!vendor) {
    return res.status(400).json({ error: 'Selected wholesaler does not exist' });
  }
  if (vendor.region_id !== region_id) {
    return res.status(400).json({ error: 'Selected wholesaler is in a different region' });
  }

  const newUserId = 'u-stk-' + generateId();
  const newUser = {
    id: newUserId,
    tenant_id: 't1',
    region_id,
    phone: cleanPhone,
    name: name.trim(),
    role: 'STOCKIST',
    kyc_status: 'APPROVED',
    no_show_count: 0,
    is_active: true,
    created_at: new Date().toISOString()
  };
  users.push(newUser);
  await db.saveTable('users', users);
  
  const newStockistId = 's-' + generateId();
  const newStockist = {
    id: newStockistId,
    tenant_id: 't1',
    region_id,
    user_id: newUserId,
    name: name.trim(),
    phone: cleanPhone,
    contact_phone: cleanPhone,
    contact_name: name.trim(),
    vendor_id,
    delivery_radius_km: parseFloat(delivery_radius_km) || 3.0,
    min_order_value: 0,
    is_active: true,
    opening_time: opening_time || '08:00',
    closing_time: closing_time || '20:00',
    prep_eta_minutes: parseInt(prep_eta_minutes) || 15,
    linked_account_id: linked_account_id ? linked_account_id.trim() : null,
    created_at: new Date().toISOString()
  };
  stockists.push(newStockist);
  await db.saveTable('stockists', stockists);
  
  const rateVal = parseFloat(commission_rate) || 10.0;
  const rates = await db.getTable('stockist_commission_rates');
  rates.push({ id: 'scr-' + generateId(), stockist_id: newStockistId, rate_percent: rateVal, created_at: new Date().toISOString() });
  await db.saveTable('stockist_commission_rates', rates);
  
  await setMainWholesaler(newStockistId, vendor_id);
  
  await appendAudit(req, 'CREATE_STOCKIST', 'stockist', newStockistId, null, newStockist);
  return res.json({ success: true, stockist: newStockist, user: sanitizeUser(newUser) });
});

app.post('/api/admin/stockists/:id', async (req, res) => {
  const { id } = req.params;
  const { name, address, opening_time, closing_time, prep_eta_minutes, delivery_radius_km, region_id, vendor_id, min_order_value, kyc_id_type, kyc_id_number, user_name, user_phone, linked_account_id } = req.body;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });

  if (integrations.getPaymentsMode() === 'live' && linked_account_id !== undefined && (!linked_account_id || !linked_account_id.trim())) {
    return res.status(400).json({ error: 'Linked account ID (Razorpay Route) is required in live payments mode' });
  }

  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (opening_time && (opening_time === '24:00' || !timeRegex.test(opening_time))) {
    return res.status(400).json({ error: 'Opening time must be between 00:00 and 23:59' });
  }
  if (closing_time && (closing_time === '24:00' || !timeRegex.test(closing_time))) {
    return res.status(400).json({ error: 'Closing time must be between 00:00 and 23:59' });
  }

  if (region_id) {
    const regions = await db.getTable('regions');
    if (!regions.find(r => r.id === region_id)) return res.status(400).json({ error: 'Invalid region_id' });
  }
  if (vendor_id) {
    const vendors = await db.getTable('vendors');
    const vendor = vendors.find(v => v.id === vendor_id);
    if (!vendor) return res.status(400).json({ error: 'Invalid vendor_id' });
    if (region_id && vendor.region_id !== region_id) return res.status(400).json({ error: 'Vendor does not belong to the selected region' });
  }

  const beforeStockist = { name: stockist.name, opening_time: stockist.opening_time, closing_time: stockist.closing_time, prep_eta_minutes: stockist.prep_eta_minutes, delivery_radius_km: stockist.delivery_radius_km, region_id: stockist.region_id, vendor_id: stockist.vendor_id, min_order_value: stockist.min_order_value, linked_account_id: stockist.linked_account_id };
  
  let updatedProductsCount = 0;
  const regionChanged = region_id !== undefined && region_id !== beforeStockist.region_id;
  const beforeVendorId = stockist.vendor_id;
  const vendorChanged = vendor_id !== undefined && vendor_id !== beforeVendorId;

  if (name) stockist.name = name.trim();
  if (opening_time) stockist.opening_time = opening_time;
  if (closing_time) stockist.closing_time = closing_time;
  if (prep_eta_minutes !== undefined) stockist.prep_eta_minutes = parseInt(prep_eta_minutes);
  if (delivery_radius_km !== undefined) stockist.delivery_radius_km = parseFloat(delivery_radius_km);
  if (region_id !== undefined) stockist.region_id = region_id;
  if (vendor_id !== undefined) stockist.vendor_id = vendor_id;
  if (min_order_value !== undefined) stockist.min_order_value = parseFloat(min_order_value);
  if (linked_account_id !== undefined) stockist.linked_account_id = linked_account_id ? linked_account_id.trim() : null;
  await db.saveTable('stockists', stockists);

  if (vendorChanged) {
    const keepOld = req.body.keep_old_vendor === true || req.body.keepOldVendor === true;
    await setMainWholesaler(id, vendor_id);

    if (beforeVendorId && beforeVendorId !== vendor_id) {
      if (keepOld) {
        await appendAudit(req, 'KEEP_EXTRA_SUPPLIER', 'stockist_vendors', id, { vendor_id: beforeVendorId }, { vendor_id: beforeVendorId }, 'Kept old wholesaler as extra supplier');
      } else {
        const stockistVendors = await db.getTable('stockist_vendors');
        const filtered = stockistVendors.filter(sv => !(sv.stockist_id === id && sv.vendor_id === beforeVendorId));
        if (filtered.length !== stockistVendors.length) {
          await db.saveTable('stockist_vendors', filtered);
          await appendAudit(req, 'REMOVE_STOCKIST_VENDOR', 'stockist_vendors', id, { vendor_id: beforeVendorId }, null, 'Removed old wholesaler link on main wholesaler change');
        }
      }
      await appendAudit(req, 'CHANGE_MAIN_WHOLESALER', 'stockist', id, { vendor_id: beforeVendorId }, { vendor_id }, 'Changed main wholesaler');
    }
  } else if (vendor_id) {
    await setMainWholesaler(id, vendor_id);
  }
  
  if (regionChanged) {
    const products = await db.getTable('products');
    let productsModified = false;
    for (const p of products) {
      if (p.stockist_id === id) {
        p.region_id = region_id;
        updatedProductsCount++;
        productsModified = true;
      }
    }
    if (productsModified) {
      await db.saveTable('products', products);
    }
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === stockist.user_id);
  
  if (user) { 
    let userUpdated = false;
    let kycChanged = false;
    const beforeUser = { address: user.address, name: user.name, phone: user.phone, kyc_id_type: user.kyc_id_type, kyc_id_number: user.kyc_id_number, kyc_details: user.kyc_details };
    
    if (address) { user.address = address.trim(); userUpdated = true; }
    
    let kyc = user.kyc_details;
    if (typeof kyc === 'string') { try { kyc = JSON.parse(kyc) } catch(e){ kyc = {} } }
    kyc = kyc || {};

    const oldIdType = kyc.id_type || user.kyc_id_type;
    const oldIdNumber = kyc.id_number || user.kyc_id_number;

    if (kyc_id_type && kyc_id_type !== oldIdType) { kyc.id_type = kyc_id_type; user.kyc_id_type = kyc_id_type; kycChanged = true; }
    if (kyc_id_number && kyc_id_number !== oldIdNumber) {
      const effectiveType = String(kyc_id_type || oldIdType || '').toUpperCase();
      let cleanId = String(kyc_id_number || '').trim();
      if (effectiveType.includes('AADHAAR') || effectiveType.includes('AADHAR')) {
        const digits = cleanId.replace(/\D/g, '');
        if (digits.length !== 12) return res.status(400).json({ error: 'Aadhaar must be 12 digits' });
      } else if (effectiveType.includes('PAN')) {
        cleanId = cleanId.toUpperCase();
        if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanId)) return res.status(400).json({ error: 'Enter a valid 10-character PAN (e.g. ABCDE1234F)' });
      } else if (effectiveType.includes('VOTER')) {
        cleanId = cleanId.toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(cleanId)) return res.status(400).json({ error: 'Voter ID must be 10 letters and digits' });
      } else if (effectiveType.includes('DRIV')) {
        cleanId = cleanId.toUpperCase();
        if (!/^[A-Z0-9]{1,16}$/.test(cleanId)) return res.status(400).json({ error: 'Driving licence must be up to 16 letters and digits' });
      } else if (cleanId.length > 20) {
        return res.status(400).json({ error: 'Document ID must be up to 20 characters' });
      }
      kyc.id_number = cleanId; user.kyc_id_number = cleanId; kycChanged = true;
    }
    if (user_name && user_name !== user.name) { user.name = user_name.trim(); kycChanged = true; }
    if (user_phone && user_phone !== user.phone) {
      const validPhone = checkPhone(user_phone, res);
      if (!validPhone) return;
      const users = await db.getTable('users');
      const existing = users.find(u => u.phone === validPhone && u.id !== user.id);
      if (existing) {
        return res.status(400).json({ error: 'Phone already registered' });
      }
      user.phone = validPhone;
      kycChanged = true;
    }
    
    if (kycChanged) {
      user.kyc_status = 'PENDING';
      user.kyc_details = JSON.stringify(kyc);
      userUpdated = true;
      
      const auditBefore = { name: beforeUser.name, phone: beforeUser.phone, id_type: oldIdType, id_number: oldIdNumber ? maskIdNumber(oldIdNumber) : '' };
      const auditAfter = { name: user.name, phone: user.phone, id_type: kyc_id_type, id_number: kyc_id_number ? maskIdNumber(kyc_id_number) : '' };
      await appendAudit(req, 'EDIT_STOCKIST_KYC', 'user', user.id, auditBefore, auditAfter);
    }

    if (userUpdated) {
      await db.saveTable('users', users);
    }
  }
  
  const auditReason = regionChanged ? `Updated products count: ${updatedProductsCount}` : '';
  await appendAudit(req, 'EDIT_STOCKIST', 'stockist', id, beforeStockist, stockist, auditReason);
  return res.json({ success: true, stockist });
});

app.post('/api/admin/stockists/:id/commission-rate', async (req, res) => {
  const { id } = req.params;
  const { rate_percent, confirmationText } = req.body;
  const numRate = parseFloat(rate_percent);
  if (isNaN(numRate) || numRate < 0 || numRate > 100) {
    return res.status(400).json({ error: 'Valid commission rate percent required (0-100)' });
  }
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });
  
  const rates = await db.getTable('stockist_commission_rates');
  const stkRates = rates.filter(r => r.stockist_id === id);
  const currentRate = stkRates.length > 0 ? stkRates[stkRates.length - 1].rate_percent : 10.0;
  
  const orders = await db.getTable('orders');
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const delivered30d = orders.filter(o => o.stockist_id === id && o.status === 'DELIVERED' && new Date(o.created_at).getTime() >= thirtyDaysAgo);
  
  const gross_gmv = delivered30d.reduce((sum, o) => sum + (parseFloat(o.subtotal) || 0), 0);
  const currentEarnings = gross_gmv * (currentRate / 100);
  const newEarnings = gross_gmv * (numRate / 100);
  
  if (confirmationText !== 'CONFIRM') {
    return res.json({
      preview: true,
      orders_count: delivered30d.length,
      gross_gmv: gross_gmv,
      current_rate: currentRate,
      new_rate: numRate,
      current_earnings_30d: currentEarnings,
      new_earnings_30d: newEarnings,
      diff: newEarnings - currentEarnings
    });
  }
  
  rates.push({ id: 'scr-' + generateId(), stockist_id: id, rate_percent: numRate, created_at: new Date().toISOString() });
  await db.saveTable('stockist_commission_rates', rates);
  
  await appendAudit(req, 'CHANGE_COMMISSION_RATE', 'stockist', id, { rate_percent: currentRate }, { rate_percent: numRate });
  return res.json({
    success: true,
    current_rate: currentRate,
    new_rate: numRate,
    current_earnings_30d: currentEarnings,
    new_earnings_30d: newEarnings
  });
});

app.post('/api/admin/stockists/:id/region', async (req, res) => {
  const { id } = req.params;
  const { region_id } = req.body;
  if (!region_id) return res.status(400).json({ error: 'region_id is required' });
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });
  
  const orders = (await db.getTable('orders')).filter(o => o.stockist_id === id);
  const activeBindingsCount = new Set(orders.map(o => o.customer_id)).size;
  
  const oldRegion = stockist.region_id;
  stockist.region_id = region_id;
  await db.saveTable('stockists', stockists);
  
  const users = await db.getTable('users');
  const user = users.find(u => u.id === stockist.user_id);
  if (user) { user.region_id = region_id; await db.saveTable('users', users); }
  
  const products = await db.getTable('products');
  let updatedProductsCount = 0;
  let productsModified = false;
  for (const p of products) {
    if (p.stockist_id === id) {
      p.region_id = region_id;
      updatedProductsCount++;
      productsModified = true;
    }
  }
  if (productsModified) {
    await db.saveTable('products', products);
  }

  await appendAudit(req, 'CHANGE_STOCKIST_REGION', 'stockist', id, { region_id: oldRegion }, { region_id }, `Bound active customers count: ${activeBindingsCount}; Updated products count: ${updatedProductsCount}`);
  return res.json({ success: true, active_customer_bindings_count: activeBindingsCount, updated_products_count: updatedProductsCount, stockist });
});

app.post('/api/admin/stockists/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });
  stockist.is_active = false;
  await db.saveTable('stockists', stockists);
  await appendAudit(req, 'DEACTIVATE_STOCKIST', 'stockist', id, { is_active: true }, { is_active: false });
  return res.json({ success: true, stockist });
});

app.post('/api/admin/stockists/:id/reactivate', async (req, res) => {
  const { id } = req.params;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });
  stockist.is_active = true;
  await db.saveTable('stockists', stockists);
  await appendAudit(req, 'REACTIVATE_STOCKIST', 'stockist', id, { is_active: false }, { is_active: true });
  return res.json({ success: true, stockist });
});

app.delete('/api/admin/stockists/:id', async (req, res) => {
  const { id } = req.params;
  const orders = await db.getTable('orders');
  const hasOrders = orders.some(o => o.stockist_id === id);
  if (hasOrders) {
    return res.status(400).json({ error: 'Cannot delete: stockist has order history. Deactivate instead.' });
  }
  const stockists = await db.getTable('stockists');
  const idx = stockists.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Stockist not found' });
  const oldStockist = stockists[idx];
  stockists.splice(idx, 1);
  await db.saveTable('stockists', stockists);
  
  if (oldStockist.user_id) {
    const users = await db.getTable('users');
    const uIdx = users.findIndex(u => u.id === oldStockist.user_id);
    if (uIdx !== -1) { users.splice(uIdx, 1); await db.saveTable('users', users); }
  }
  
  await appendAudit(req, 'DELETE_STOCKIST', 'stockist', id, oldStockist, null);
  return res.json({ success: true, message: 'Stockist deleted successfully' });
});



// Test helper endpoints for Mock Email Outbox

// 4.1 POST /api/admin/partners
app.post('/api/admin/partners', async (req, res) => {
  let { legal_name, display_name, contact_phone, contact_email, address, service_types, gst_number } = req.body;
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request
  if (!legal_name || !display_name || !contact_phone || !service_types || !Array.isArray(service_types) || service_types.length === 0) {
    return res.status(400).json({ error: 'Missing required partner fields' });
  }
  const validPhone = checkPhone(contact_phone, res);
  if (!validPhone) return;
  contact_phone = validPhone;
  if (!service_types.every(st => ALLOWED_SERVICE_TYPES.includes(st))) {
    return res.status(400).json({ error: 'Invalid service_types enum' });
  }

  const validEmail = await checkEmail(contact_email, res);
  if (!validEmail) return;
  contact_email = validEmail;

  const users = await db.getTable('users');
  if (users.some(u => u.phone === contact_phone)) {
    return res.status(409).json({ error: 'Phone number already registered' });
  }

  const now = new Date().toISOString();
  const userId = 'u-' + generateId();
  const partnerId = 'ptr-' + generateId();
  const partnerUserId = 'pu-' + generateId();

  const newUser = {
    id: userId,
    tenant_id: 't1',
    region_id: null,
    phone: contact_phone,
    email: contact_email || null,
    password_hash: req.body.password ? bcrypt.hashSync(req.body.password, 10) : null,
    name: display_name,
    role: 'PARTNER_ADMIN',
    kyc_status: 'PENDING',
    no_show_count: 0,
    address: address || '',
    created_at: now
  };
  users.push(newUser);
  await db.saveTable('users', users);

  const partners = await db.getTable('partners');
  const newPartner = {
    id: partnerId,
    tenant_id: 't1',
    legal_name,
    display_name,
    contact_phone,
    contact_email: contact_email || null,
    address: address || '',
    gst_number: gst_number || null,
    service_types,
    is_active: true,
    onboarded_at: now,
    onboarded_by_admin_id: admin_id,
    promoted_from_lead_id: null,
    created_at: now,
    updated_at: now
  };
  partners.push(newPartner);
  await db.saveTable('partners', partners);

  const partnerUsers = await db.getTable('partner_users');
  const newPU = {
    id: partnerUserId,
    partner_id: partnerId,
    user_id: userId,
    role: 'OWNER',
    created_at: now
  };
  partnerUsers.push(newPU);
  await db.saveTable('partner_users', partnerUsers);

  await appendAudit(req, 'PARTNER_CREATE', 'partner', partnerId, null, newPartner);
  return res.json({ partner: newPartner, user: sanitizeUser(newUser) });
});

// 4.2 POST /api/admin/partner-leads/:id/promote
app.post('/api/admin/partner-leads/:id/promote', async (req, res) => {
  const { id } = req.params;
  const { legal_name, display_name, service_types, region_id } = req.body;
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  const leads = await db.getTable('partner_leads');
  const lead = leads.find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.promoted_partner_id || lead.status === 'ONBOARDED') {
    return res.status(409).json({ error: 'Lead has already been promoted' });
  }

  let effectiveServiceTypes = service_types;
  if (!effectiveServiceTypes || !Array.isArray(effectiveServiceTypes) || effectiveServiceTypes.length === 0) {
    if (Array.isArray(lead.service_types) && lead.service_types.length > 0) {
      effectiveServiceTypes = lead.service_types;
    } else if (lead.service_type === 'BOTH') {
      effectiveServiceTypes = ['CABLE', 'BROADBAND'];
    } else if (lead.service_type === 'BROADBAND') {
      effectiveServiceTypes = ['BROADBAND'];
    } else if (lead.service_type === 'CABLE') {
      effectiveServiceTypes = ['CABLE'];
    } else if (Array.isArray(lead.service_type)) {
      effectiveServiceTypes = lead.service_type;
    } else if (typeof lead.service_type === 'string') {
      effectiveServiceTypes = [lead.service_type];
    } else {
      effectiveServiceTypes = ['CABLE'];
    }
  }

  if (!effectiveServiceTypes.every(st => ALLOWED_SERVICE_TYPES.includes(st))) {
    return res.status(400).json({ error: 'Valid service_types array is required' });
  }

  const contact_phone = lead.phone;
  const contact_email = lead.email || null;
  const address = lead.address || '';
  const finalLegalName = legal_name || lead.business_name || lead.name;
  const finalDisplayName = display_name || lead.business_name || lead.name;

  const users = await db.getTable('users');
  if (contact_phone && users.some(u => u.phone === contact_phone)) {
    return res.status(409).json({ error: 'Phone number already registered' });
  }
  if (contact_email && users.some(u => u.email && u.email.trim().toLowerCase() === contact_email.trim().toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const now = new Date().toISOString();
  const userId = 'u-' + generateId();
  const partnerId = 'ptr-' + generateId();
  const partnerUserId = 'pu-' + generateId();

  const newUser = {
    id: userId,
    tenant_id: 't1',
    region_id: null,
    phone: contact_phone,
    email: contact_email,
    password_hash: null,
    name: finalDisplayName,
    role: 'PARTNER_ADMIN',
    kyc_status: 'PENDING',
    no_show_count: 0,
    address: address,
    created_at: now
  };
  users.push(newUser);
  await db.saveTable('users', users);

  const partners = await db.getTable('partners');
  const newPartner = {
    id: partnerId,
    tenant_id: 't1',
    legal_name: finalLegalName,
    display_name: finalDisplayName,
    contact_phone,
    contact_email,
    address,
    gst_number: null,
    service_types: effectiveServiceTypes,
    is_active: true,
    onboarded_at: now,
    onboarded_by_admin_id: admin_id,
    promoted_from_lead_id: lead.id,
    created_at: now,
    updated_at: now
  };
  partners.push(newPartner);
  await db.saveTable('partners', partners);

  const partnerUsers = await db.getTable('partner_users');
  const newPU = {
    id: partnerUserId,
    partner_id: partnerId,
    user_id: userId,
    role: 'OWNER',
    created_at: now
  };
  partnerUsers.push(newPU);
  await db.saveTable('partner_users', partnerUsers);

  const targetRegionId = region_id || lead.region_id;
  if (targetRegionId) {
    const partnerRegions = await db.getTable('partner_regions');
    for (const st of effectiveServiceTypes) {
      if (!partnerRegions.some(pr => pr.partner_id === partnerId && pr.region_id === targetRegionId && pr.service_type === st)) {
        partnerRegions.push({
          id: 'prg-' + generateId(),
          partner_id: partnerId,
          region_id: targetRegionId,
          service_type: st,
          is_active: true,
          created_at: now
        });
      }
    }
    await db.saveTable('partner_regions', partnerRegions);
  }

  const beforeLead = { status: lead.status, promoted_partner_id: lead.promoted_partner_id };
  lead.status = 'ONBOARDED';
  lead.promoted_partner_id = partnerId;
  lead.promoted_by_admin_id = admin_id;
  lead.promoted_at = now;
  await db.saveTable('partner_leads', leads);

  await appendAudit(req, 'LEAD_PROMOTED', 'partner_lead', lead.id, beforeLead, lead);
  await appendAudit(req, 'PARTNER_CREATE', 'partner', partnerId, null, newPartner);

  return res.json({ partner: newPartner, user: sanitizeUser(newUser), lead });
});

app.post('/api/admin/partner-leads/:id/disapprove', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Reason is required' });
  }

  const partnerLeads = await db.getTable('partner_leads');
  const lead = partnerLeads.find(l => l.id === id);
  if (!lead) {
    return res.status(404).json({ error: 'Partner lead not found' });
  }

  const oldStatus = lead.status;
  lead.status = 'REJECTED';
  lead.rejection_reason = reason;
  lead.rejected_at = new Date().toISOString();

  await db.saveTable('partner_leads', partnerLeads);

  if (lead.phone && smsHelper.isSmsConfigured()) {
    try {
      await smsHelper.sendSms(lead.phone, `Partner Lead Application Disapproved: ${reason}`);
    } catch (e) {
      console.error('Failed to send lead rejection SMS:', e);
    }
  }

  await appendAudit(req, 'DISAPPROVE_PARTNER_LEAD', 'partner_lead', id,
    { status: oldStatus },
    { status: 'REJECTED', rejection_reason: reason }
  );

  return res.json({ success: true, message: 'Partner lead rejected', lead });
});

// 4.3 GET /api/admin/partners
app.get('/api/admin/partners', async (req, res) => {
  const { is_active, region_id, service_type } = req.query;
  let partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');
  const partnerPackages = await db.getTable('partner_packages');
  const customerBindings = await db.getTable('customer_partner_bindings');

  if (is_active !== undefined) {
    const activeBool = is_active === 'true';
    partners = partners.filter(p => p.is_active === activeBool);
  }

  if (region_id) {
    partners = partners.filter(p => partnerRegions.some(pr => pr.partner_id === p.id && pr.region_id === region_id && pr.is_active !== false));
  }

  if (service_type) {
    partners = partners.filter(p => Array.isArray(p.service_types) && p.service_types.includes(service_type));
  }

  const result = partners.map(p => {
    const prRows = partnerRegions.filter(pr => pr.partner_id === p.id && pr.is_active !== false);
    const distinctRegionIds = [...new Set(prRows.map(pr => pr.region_id))];
    const active_package_count = partnerPackages.filter(pp => pp.partner_id === p.id && pp.is_active !== false).length;
    const bound_customer_count = customerBindings.filter(cb => cb.cable_partner_id === p.id || cb.broadband_partner_id === p.id).length;
    return {
      ...p,
      regions: prRows,
      region_count: distinctRegionIds.length,
      region_ids: distinctRegionIds,
      active_package_count,
      bound_customer_count
    };
  });

  return res.json(result);
});

// 4.4 GET /api/admin/partners/:id
app.get('/api/admin/partners/:id', async (req, res) => {
  const { id } = req.params;
  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const partnerRegions = (await db.getTable('partner_regions')).filter(pr => pr.partner_id === id);
  const partnerPackages = (await db.getTable('partner_packages')).filter(pp => pp.partner_id === id);
  const partnerUsers = (await db.getTable('partner_users')).filter(pu => pu.partner_id === id);
  const users = await db.getTable('users');

  const joinedUsers = partnerUsers.map(pu => {
    const u = users.find(usr => usr.id === pu.user_id);
    return {
      ...pu,
      user: sanitizeUser(u)
    };
  });

  const customerBindings = await db.getTable('customer_partner_bindings');
  const bound_customer_count = customerBindings.filter(cb => cb.cable_partner_id === id || cb.broadband_partner_id === id).length;

  return res.json({
    ...partner,
    partner,
    regions: partnerRegions,
    service_regions: partnerRegions.map(r => ({
      region_id: r.region_id,
      service_type: r.service_type,
      is_active: r.is_active !== false
    })),
    packages: partnerPackages,
    users: joinedUsers,
    bound_customer_count
  });
});

// 4.5 PATCH /api/admin/partners/:id
app.patch('/api/admin/partners/:id', async (req, res) => {
  const { id } = req.params;
  if (req.body.service_types !== undefined || req.body.promoted_from_lead_id !== undefined || req.body.id !== undefined) {
    return res.status(400).json({ error: 'Cannot update service_types or system fields directly via this endpoint' });
  }

  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  let validPhone = partner.contact_phone;
  if (req.body.contact_phone && req.body.contact_phone !== partner.contact_phone) {
    validPhone = checkPhone(req.body.contact_phone, res);
    if (!validPhone) return;
    const users = await db.getTable('users');
    const partnerUsers = (await db.getTable('partner_users')).filter(pu => pu.partner_id === id);
    const partnerUserIds = partnerUsers.map(pu => pu.user_id);
    const existing = users.find(u => u.phone === validPhone && !partnerUserIds.includes(u.id));
    if (existing) {
      return res.status(400).json({ error: 'Phone already registered' });
    }
  }

  let validEmail = partner.contact_email;
  if (req.body.contact_email !== undefined && req.body.contact_email !== partner.contact_email) {
    if (req.body.contact_email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(req.body.contact_email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      validEmail = req.body.contact_email.trim().toLowerCase();
    } else {
      validEmail = '';
    }
  }

  const mutableFields = ['legal_name', 'display_name', 'address', 'gst_number'];
  const before = { ...partner };

  mutableFields.forEach(field => {
    if (req.body[field] !== undefined) {
      partner[field] = req.body[field];
    }
  });
  if (req.body.contact_phone) partner.contact_phone = validPhone;
  if (req.body.contact_email !== undefined) partner.contact_email = validEmail;

  partner.updated_at = new Date().toISOString();

  const partnerUsers = (await db.getTable('partner_users')).filter(pu => pu.partner_id === id);
  const users = await db.getTable('users');
  partnerUsers.forEach(pu => {
    const u = users.find(usr => usr.id === pu.user_id);
    if (u) {
      if (req.body.contact_phone) u.phone = validPhone;
      if (req.body.contact_email !== undefined) u.email = validEmail;
      if (req.body.display_name) u.name = req.body.display_name;
    }
  });

  await db.saveTable('partners', partners);
  await db.saveTable('users', users);

  await appendAudit(req, 'EDIT_PARTNER', 'partner', id, before, partner);
  return res.json(partner);
});

// 4.6 POST /api/admin/partners/:id/deactivate and /reactivate
app.post('/api/admin/partners/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const before = { is_active: partner.is_active };
  partner.is_active = false;
  partner.updated_at = new Date().toISOString();
  await db.saveTable('partners', partners);

  const packages = await db.getTable('partner_packages');
  packages.forEach(pkg => {
    if (pkg.partner_id === id) {
      pkg.is_active = false;
      pkg.updated_at = new Date().toISOString();
    }
  });
  await db.saveTable('partner_packages', packages);

  await appendAudit(req, 'DEACTIVATE_PARTNER', 'partner', id, before, { is_active: false });
  return res.json(partner);
});

app.post('/api/admin/partners/:id/reactivate', async (req, res) => {
  const { id } = req.params;
  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const before = { is_active: partner.is_active };
  partner.is_active = true;
  partner.updated_at = new Date().toISOString();
  await db.saveTable('partners', partners);

  await appendAudit(req, 'REACTIVATE_PARTNER', 'partner', id, before, { is_active: true });
  return res.json(partner);
});

// 4.7 POST /api/admin/partners/:id/service-types
app.post('/api/admin/partners/:id/service-types', async (req, res) => {
  const { id } = req.params;
  const { service_types, confirm } = req.body;

  if (!service_types || !Array.isArray(service_types) || !service_types.every(st => ALLOWED_SERVICE_TYPES.includes(st))) {
    return res.status(400).json({ error: 'Invalid service_types enum' });
  }

  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const currentTypes = partner.service_types || [];
  const removedTypes = currentTypes.filter(st => !service_types.includes(st));

  if (removedTypes.length > 0) {
    const regions = (await db.getTable('partner_regions')).filter(pr => pr.partner_id === id && removedTypes.includes(pr.service_type));
    const packages = (await db.getTable('partner_packages')).filter(pp => pp.partner_id === id && removedTypes.includes(pp.service_type));

    if ((regions.length > 0 || packages.length > 0) && confirm !== true) {
      return res.json({
        requires_confirmation: true,
        warning: 'Removing service types will affect existing regions or packages.',
        affected_regions: regions,
        affected_packages: packages
      });
    }
  }

  const before = { service_types: partner.service_types };
  partner.service_types = service_types;
  partner.updated_at = new Date().toISOString();
  await db.saveTable('partners', partners);

  await appendAudit(req, 'UPDATE_PARTNER_SERVICE_TYPES', 'partner', id, before, { service_types });
  return res.json(partner);
});

// 4.8 Partner-regions CRUD
app.post('/api/admin/partners/:id/regions', async (req, res) => {
  const { id } = req.params;
  const { region_id, service_type } = req.body;

  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const regions = await db.getTable('regions');
  if (!regions.some(r => r.id === region_id)) {
    return res.status(400).json({ error: 'Region does not exist' });
  }

  if (!partner.service_types || !partner.service_types.includes(service_type)) {
    return res.status(400).json({ error: 'Partner does not support this service_type' });
  }

  const partnerRegions = await db.getTable('partner_regions');
  if (partnerRegions.some(pr => pr.partner_id === id && pr.region_id === region_id && pr.service_type === service_type)) {
    return res.status(409).json({ error: 'Duplicate region mapping for this partner and service_type' });
  }

  const newPR = {
    id: 'prg-' + generateId(),
    partner_id: id,
    region_id,
    service_type,
    is_active: true,
    created_at: new Date().toISOString()
  };
  partnerRegions.push(newPR);
  await db.saveTable('partner_regions', partnerRegions);

  await appendAudit(req, 'ADD_PARTNER_REGION', 'partner_region', newPR.id, null, newPR);
  return res.json(newPR);
});

app.post('/api/admin/partners/:id/regions/:regionRowId/deactivate', async (req, res) => {
  const { id, regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const pr = partnerRegions.find(p => p.id === regionRowId && p.partner_id === id);
  if (!pr) return res.status(404).json({ error: 'Partner region mapping not found' });

  const before = { is_active: pr.is_active };
  pr.is_active = false;
  await db.saveTable('partner_regions', partnerRegions);

  await appendAudit(req, 'DEACTIVATE_PARTNER_REGION', 'partner_region', pr.id, before, { is_active: false });
  return res.json(pr);
});

app.post('/api/admin/partners/:id/regions/:regionRowId/reactivate', async (req, res) => {
  const { id, regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const pr = partnerRegions.find(p => p.id === regionRowId && p.partner_id === id);
  if (!pr) return res.status(404).json({ error: 'Partner region mapping not found' });

  const before = { is_active: pr.is_active };
  pr.is_active = true;
  await db.saveTable('partner_regions', partnerRegions);

  await appendAudit(req, 'REACTIVATE_PARTNER_REGION', 'partner_region', pr.id, before, { is_active: true });
  return res.json(pr);
});

app.delete('/api/admin/partners/:id/regions/:regionRowId', async (req, res) => {
  const { id, regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const idx = partnerRegions.findIndex(p => p.id === regionRowId && p.partner_id === id);
  if (idx === -1) return res.status(404).json({ error: 'Partner region mapping not found' });

  const targetPR = partnerRegions[idx];
  const packages = (await db.getTable('partner_packages')).filter(pp => pp.partner_id === id && pp.service_type === targetPR.service_type);
  if (packages.some(pkg => pkg.active_regions && pkg.active_regions.includes(targetPR.region_id))) {
    return res.status(400).json({ error: 'Cannot delete region referenced by active packages' });
  }

  partnerRegions.splice(idx, 1);
  await db.saveTable('partner_regions', partnerRegions);

  await appendAudit(req, 'DELETE_PARTNER_REGION', 'partner_region', regionRowId, targetPR, null);
  return res.json({ success: true, message: 'Partner region mapping deleted.' });
});

// 4.9 Partner-packages CRUD (Admin set)
app.post('/api/admin/partners/:id/packages', async (req, res) => {
  const { id } = req.params;
  const { service_type, name, description, face_value_rupees, cost_to_partner_rupees, point_cost, active_regions } = req.body;

  const partners = await db.getTable('partners');
  const partner = partners.find(p => p.id === id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  if (!service_type || !partner.service_types || !partner.service_types.includes(service_type)) {
    return res.status(400).json({ error: 'Service type must match one of partner service_types' });
  }

  if (!name || face_value_rupees === undefined || !active_regions || !Array.isArray(active_regions) || active_regions.length === 0) {
    return res.status(400).json({ error: 'At least one active region is required for this package' });
  }

  const partnerRegions = (await db.getTable('partner_regions')).filter(pr => pr.partner_id === id && pr.service_type === service_type && pr.is_active !== false);
  const partnerRegionIds = partnerRegions.map(pr => pr.region_id);

  if (!active_regions.every(rId => partnerRegionIds.includes(rId))) {
    return res.status(400).json({ error: 'Every active_region must be an active region served by partner for this service_type' });
  }

  const face = Number(face_value_rupees);
  const cost = Number(cost_to_partner_rupees !== undefined ? cost_to_partner_rupees : face_value_rupees);
  if (cost >= face) {
    return res.status(400).json({ 
      error: 'Cost to Partner must be less than Face Value',
      received: { cost_to_partner_rupees: cost, face_value_rupees: face }
    });
  }

  const pType = req.body.package_type || (req.body.is_timed ? 'PAID' : (req.body.duration_days ? 'PAID' : 'FREE'));
  let durDays = req.body.duration_days !== undefined && req.body.duration_days !== null ? Number(req.body.duration_days) : null;
  if (pType !== 'FREE' && (!durDays || durDays <= 0)) {
    return res.status(400).json({ error: 'Duration required for paid/promotional packages' });
  }
  if (pType === 'FREE') {
    durDays = null;
  }

  const now = new Date().toISOString();
  const packages = await db.getTable('partner_packages');
  const newPkg = {
    id: 'ppk-' + generateId(),
    partner_id: id,
    service_type,
    name,
    description: description || '',
    face_value_rupees: face,
    cost_to_partner_rupees: cost,
    point_cost: Number(point_cost !== undefined ? point_cost : face_value_rupees),
    active_regions,
    duration_days: durDays,
    is_timed: (pType !== 'FREE'),
    is_active: true,
    created_at: now,
    updated_at: now
  };
  packages.push(newPkg);
  await db.saveTable('partner_packages', packages);

  await appendAudit(req, 'CREATE_PARTNER_PACKAGE', 'partner_package', newPkg.id, null, newPkg);
  return res.json(newPkg);
});

app.patch('/api/admin/partners/:id/packages/:packageId', async (req, res) => {
  const { id, packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId && p.partner_id === id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  const before = { ...pkg };
  const targetFace = req.body.face_value_rupees !== undefined ? Number(req.body.face_value_rupees) : pkg.face_value_rupees;
  const targetCost = req.body.cost_to_partner_rupees !== undefined ? Number(req.body.cost_to_partner_rupees) : pkg.cost_to_partner_rupees;
  if (targetCost !== undefined && targetFace !== undefined && targetCost >= targetFace) {
    return res.status(400).json({ 
      error: 'Cost to Partner must be less than Face Value',
      received: { cost_to_partner_rupees: targetCost, face_value_rupees: targetFace }
    });
  }

  const mutableFields = ['name', 'description', 'face_value_rupees', 'cost_to_partner_rupees', 'point_cost', 'active_regions', 'duration_days', 'is_timed'];
  mutableFields.forEach(f => {
    if (req.body[f] !== undefined) {
      if (f === 'face_value_rupees' || f === 'cost_to_partner_rupees' || f === 'point_cost' || f === 'duration_days') {
        pkg[f] = req.body[f] !== null ? Number(req.body[f]) : null;
      } else {
        pkg[f] = req.body[f];
      }
    }
  });
  if (req.body.package_type !== undefined) {
    pkg.is_timed = (req.body.package_type !== 'FREE');
    if (req.body.package_type === 'FREE') pkg.duration_days = null;
  }
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  await appendAudit(req, 'EDIT_PARTNER_PACKAGE', 'partner_package', packageId, before, pkg);
  return res.json(pkg);
});

app.post('/api/admin/partners/:id/packages/:packageId/deactivate', async (req, res) => {
  const { id, packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId && p.partner_id === id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  const before = { is_active: pkg.is_active };
  pkg.is_active = false;
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  await appendAudit(req, 'DEACTIVATE_PARTNER_PACKAGE', 'partner_package', packageId, before, { is_active: false });
  return res.json(pkg);
});

app.post('/api/admin/partners/:id/packages/:packageId/reactivate', async (req, res) => {
  const { id, packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId && p.partner_id === id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  const before = { is_active: pkg.is_active };
  pkg.is_active = true;
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  await appendAudit(req, 'REACTIVATE_PARTNER_PACKAGE', 'partner_package', packageId, before, { is_active: true });
  return res.json(pkg);
});

// Partner-self Package Endpoints (/api/partner/packages)

app.get('/api/admin/generic-rewards', async (req, res) => {
  const rewards = await db.getTable('generic_rewards');
  return res.json(rewards);
});

app.post('/api/admin/generic-rewards', async (req, res) => {
  const { name, description, point_cost, value_rupees, cooldown_type, cooldown_days, valid_until, min_order_value } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length < 1 || name.trim().length > cfg.REWARD_NAME_MAX_LENGTH) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid name', fields: { name: 'required and max length' } });
  }
  if (description && typeof description === 'string' && description.length > cfg.REWARD_DESCRIPTION_MAX_LENGTH) {
    return res.status(400).json({ error: 'validation_failed', message: 'Description too long', fields: { description: 'max length' } });
  }
  const ptCost = Number(point_cost);
  if (!Number.isFinite(ptCost) || !Number.isInteger(ptCost) || ptCost < 1 || ptCost > cfg.REWARD_POINT_COST_MAX || (typeof point_cost !== 'number' && !/^\d+$/.test(String(point_cost).trim()))) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid point cost', fields: { point_cost: 'integer >= 1' } });
  }
  const valRs = Number(value_rupees);
  if (!Number.isFinite(valRs) || valRs < 0 || valRs > cfg.REWARD_VALUE_MAX_RUPEES) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid value', fields: { value_rupees: 'number >= 0' } });
  }
  if (!['NONE', 'DAYS', 'ONCE'].includes(cooldown_type)) return res.status(400).json({ error: 'Invalid cooldown_type' });
  
  let finalCooldownDays = null;
  if (cooldown_type === 'DAYS') {
    finalCooldownDays = parseInt(cooldown_days, 10);
    if (isNaN(finalCooldownDays) || finalCooldownDays < 1 || finalCooldownDays > 3650) {
      return res.status(400).json({ error: 'Invalid cooldown_days' });
    }
  }

  let finalValidUntil = null;
  if (valid_until) {
    const datePart = valid_until.split('T')[0];
    const isoString = `${datePart}T23:59:59.999+05:30`;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid valid_until date' });
    if (d < new Date()) return res.status(400).json({ error: 'valid_until cannot be in the past on create' });
    finalValidUntil = isoString;
  }

  let finalMinOrderValue = null;
  if (min_order_value !== undefined && min_order_value !== null && min_order_value !== '') {
    finalMinOrderValue = parseFloat(min_order_value);
    if (isNaN(finalMinOrderValue) || finalMinOrderValue < 0) return res.status(400).json({ error: 'Invalid min_order_value' });
  }

  const rewards = await db.getTable('generic_rewards');
  const newReward = {
    id: 'gr-' + generateId(),
    name,
    description: description || null,
    point_cost: parseInt(point_cost, 10),
    value_rupees: parseFloat(value_rupees) || 0,
    is_active: true,
    cooldown_type,
    cooldown_days: finalCooldownDays,
    valid_until: finalValidUntil,
    min_order_value: finalMinOrderValue,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  rewards.push(newReward);
  await db.saveTable('generic_rewards', rewards);
  return res.json(newReward);
});

app.patch('/api/admin/generic-rewards/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, point_cost, value_rupees, is_active, cooldown_type, cooldown_days, valid_until, min_order_value } = req.body;
  const rewards = await db.getTable('generic_rewards');
  const reward = rewards.find(r => r.id === id);
  if (!reward) return res.status(404).json({ error: 'Not found' });

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length < 1 || name.trim().length > cfg.REWARD_NAME_MAX_LENGTH) return res.status(400).json({ error: 'validation_failed', message: 'Invalid name', fields: { name: 'required and max length' } });
    reward.name = name.trim();
  }
  if (description !== undefined) {
    if (description && typeof description === 'string' && description.length > cfg.REWARD_DESCRIPTION_MAX_LENGTH) return res.status(400).json({ error: 'validation_failed', message: 'Description too long', fields: { description: 'max length' } });
    reward.description = description;
  }
  if (point_cost !== undefined) {
    const ptCost = Number(point_cost);
    if (!Number.isFinite(ptCost) || !Number.isInteger(ptCost) || ptCost < 1 || ptCost > cfg.REWARD_POINT_COST_MAX || (typeof point_cost !== 'number' && !/^\d+$/.test(String(point_cost).trim()))) {
      return res.status(400).json({ error: 'validation_failed', message: 'Invalid point cost', fields: { point_cost: 'integer >= 1' } });
    }
    reward.point_cost = ptCost;
  }
  if (value_rupees !== undefined) {
    const valRs = Number(value_rupees);
    if (!Number.isFinite(valRs) || valRs < 0 || valRs > cfg.REWARD_VALUE_MAX_RUPEES) {
      return res.status(400).json({ error: 'validation_failed', message: 'Invalid value', fields: { value_rupees: 'number >= 0' } });
    }
    reward.value_rupees = valRs;
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'validation_failed', message: 'Invalid is_active', fields: { is_active: 'must be boolean' } });
    reward.is_active = is_active;
  }
  
  if (cooldown_type !== undefined) {
    if (!['NONE', 'DAYS', 'ONCE'].includes(cooldown_type)) return res.status(400).json({ error: 'Invalid cooldown_type' });
    reward.cooldown_type = cooldown_type;
    if (cooldown_type === 'DAYS') {
      const cd = parseInt(cooldown_days !== undefined ? cooldown_days : reward.cooldown_days, 10);
      if (isNaN(cd) || cd < 1 || cd > 3650) return res.status(400).json({ error: 'Invalid cooldown_days' });
      reward.cooldown_days = cd;
    } else {
      reward.cooldown_days = null;
    }
  } else if (cooldown_days !== undefined && reward.cooldown_type === 'DAYS') {
    const cd = parseInt(cooldown_days, 10);
    if (isNaN(cd) || cd < 1 || cd > 3650) return res.status(400).json({ error: 'Invalid cooldown_days' });
    reward.cooldown_days = cd;
  }

  if (valid_until !== undefined) {
    if (valid_until === null || valid_until === '') {
      reward.valid_until = null;
    } else {
      const datePart = valid_until.split('T')[0];
      const isoString = `${datePart}T23:59:59.999+05:30`;
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid valid_until date' });
      reward.valid_until = isoString;
    }
  }

  if (min_order_value !== undefined) {
    if (min_order_value === null || min_order_value === '') {
      reward.min_order_value = null;
    } else {
      const parsed = parseFloat(min_order_value);
      if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'Invalid min_order_value' });
      reward.min_order_value = parsed;
    }
  }

  reward.updated_at = new Date().toISOString();

  await db.saveTable('generic_rewards', rewards);
  return res.json(reward);
});

// ==========================================
// ROUND P2 — REDEMPTION APPROVAL & HEALTH ENDPOINTS
// ==========================================

// 1.3 Admin Redemption Approvals Endpoints
app.get('/api/admin/redemption-approvals', async (req, res) => {
  const { status, partner_id, customer_user_id, date_from, date_to } = req.query;
  let approvals = await db.getTable('redemption_approvals');

  if (status) approvals = approvals.filter(a => a.status === status);
  if (partner_id) approvals = approvals.filter(a => a.partner_id === partner_id);
  if (customer_user_id) approvals = approvals.filter(a => a.customer_user_id === customer_user_id);
  if (date_from) approvals = approvals.filter(a => new Date(a.created_at) >= new Date(date_from));
  if (date_to) approvals = approvals.filter(a => new Date(a.created_at) <= new Date(date_to));

  const users = await db.getTable('users');
  const partners = await db.getTable('partners');
  const packages = await db.getTable('partner_packages');

  const result = approvals.map(a => {
    const cust = users.find(u => u.id === a.customer_user_id);
    const ptr = partners.find(p => p.id === a.partner_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      customer_name: cust ? cust.name : 'Unknown Customer',
      customer_phone: cust ? cust.phone : '',
      partner_name: ptr ? ptr.display_name : 'Unknown Partner',
      package_name: pkg ? pkg.name : 'Unknown Package'
    };
  });

  return res.json(result);
});

app.get('/api/admin/redemption-approvals/:id', async (req, res) => {
  const { id } = req.params;
  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  const users = await db.getTable('users');
  const partners = await db.getTable('partners');
  const packages = await db.getTable('partner_packages');
  const ledger = await db.getTable('points_ledger');

  const customer = users.find(u => u.id === approval.customer_user_id) || null;
  const partner = partners.find(p => p.id === approval.partner_id) || null;
  const pkg = packages.find(p => p.id === approval.partner_package_id) || null;
  const ledgerRow = ledger.find(l => l.id === approval.ledger_id) || null;

  return res.json({
    ...approval,
    customer_name: customer ? customer.name : 'Unknown Customer',
    customer_phone: customer ? customer.phone : '',
    partner_name: partner ? partner.display_name : 'Unknown Partner',
    package_name: pkg ? pkg.name : 'Unknown Package',
    customer,
    partner,
    package: pkg,
    ledger_row: ledgerRow
  });
});

app.post('/api/admin/redemption-approvals/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.status !== 'PENDING_ADMIN_APPROVAL') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  approval.status = approval.partner_id === 'GENERIC' ? 'FULFILLED' : 'APPROVED_AWAITING_PARTNER';
  approval.admin_id = admin_id;
  if (notes) approval.admin_notes = notes;
  approval.approved_at = new Date().toISOString();
  if (approval.partner_id === 'GENERIC') {
    approval.fulfilled_at = new Date().toISOString();
  }
  approval.updated_at = new Date().toISOString();

  await db.saveTable('redemption_approvals', approvals);
  await appendAudit(req, 'APPROVE_REDEMPTION', 'redemption_approval', id, { status: 'PENDING_ADMIN_APPROVAL' }, { status: approval.status }, notes);

  if (approval.partner_id === 'GENERIC') {
    return res.json({ success: true, message: 'Reward approved and automatically marked fulfilled', approval });
  }

  // Send email to partner (non-blocking)
  const partners = await db.getTable('partners');
  const targetPartner = partners.find(p => p.id === approval.partner_id);
  const users = await db.getTable('users');
  const cust = users.find(u => u.id === approval.customer_user_id);
  const custName = cust ? cust.name : (approval.customer_name || 'Customer');
  const custPhone = cust ? cust.phone : (approval.customer_phone || '');
  const pkgName = approval.package_name || 'Package';

  if (targetPartner && targetPartner.contact_email) {
    try {
      await emailHelper.sendEmail(
        targetPartner.contact_email,
        `New redemption ready for you: ${pkgName}`,
        `<p>Customer ${escapeHtml(custName)} (phone: ${escapeHtml(custPhone)}) has redeemed &quot;${escapeHtml(pkgName)}&quot;. Please verify and mark fulfilled in your partner app. Approval ID: ${escapeHtml(approval.id)}</p>`,
        `Customer ${custName} (phone: ${custPhone}) has redeemed "${pkgName}". Please verify and mark fulfilled in your partner app. Approval ID: ${approval.id}`
      );
    } catch (err) {
      console.warn('Partner notification email sync error:', err);
    }
  }

  // Add in-app notification for partner
  const notifications = await db.getTable('partner_notifications');
  notifications.push({
    id: 'pnt-' + generateId(),
    partner_id: approval.partner_id,
    kind: 'REDEMPTION_APPROVED',
    title: 'New redemption to fulfill',
    body: `Customer ${custName} (phone: ${custPhone}) has redeemed "${pkgName}". Please verify and mark fulfilled in your partner app. Approval ID: ${approval.id}`,
    linked_id: approval.id,
    is_read: false,
    created_at: new Date().toISOString()
  });
  await db.saveTable('partner_notifications', notifications);

  return res.json(approval);
});

app.post('/api/admin/redemption-approvals/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({ error: 'Reason must be at least 10 characters long' });
  }

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.status !== 'PENDING_ADMIN_APPROVAL' && approval.status !== 'DISPUTED') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  const oldStatus = approval.status;
  approval.status = 'REJECTED';
  approval.admin_id = admin_id;
  approval.rejected_reason = reason.trim();
  approval.rejected_at = new Date().toISOString();
  approval.updated_at = new Date().toISOString();

  // Append NEW points_ledger credit row
  const ledger = await db.getTable('points_ledger');
  const users = await db.getTable('users');
  const cust = users.find(u => u.id === approval.customer_user_id);
  const refundLedgerId = 'l-' + generateId();
  await db.insertRow('points_ledger', {
      id: refundLedgerId,
      tenant_id: cust ? cust.tenant_id : 't1',
      region_id: cust ? cust.region_id : null,
      customer_id: approval.customer_user_id,
      amount: Math.abs(parseFloat(approval.points_deducted)),
      type: 'REDEEM_REFUND',
      order_id: null,
      description: `Refund for rejected redemption approval ${approval.id}`,
      created_at: new Date().toISOString()
    });

  approval.refund_ledger_id = refundLedgerId;
  await db.saveTable('redemption_approvals', approvals);

  await appendAudit(req, 'REJECT_REDEMPTION', 'redemption_approval', id, { status: oldStatus }, { status: approval.status, refund_ledger_id: refundLedgerId }, reason);

  return res.json(approval);
});

app.post('/api/admin/redemption-approvals/:id/resolve-dispute', async (req, res) => {
  const { id } = req.params;
  const { outcome, notes } = req.body;
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  if (!outcome || !['fulfill', 'reject'].includes(outcome)) {
    return res.status(400).json({ error: 'outcome must be fulfill or reject' });
  }

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.status !== 'DISPUTED') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  approval.admin_id = admin_id;
  if (notes) approval.admin_notes = notes;
  approval.updated_at = new Date().toISOString();

  // In-app notification for partner on dispute resolution
  const notifications = await db.getTable('partner_notifications');
  notifications.push({
    id: 'pnt-' + generateId(),
    partner_id: approval.partner_id,
    kind: 'DISPUTE_RESOLVED',
    title: 'Dispute resolved',
    body: `Redemption dispute resolved to ${outcome}`,
    linked_id: approval.id,
    is_read: false,
    created_at: new Date().toISOString()
  });
  await db.saveTable('partner_notifications', notifications);

  if (outcome === 'fulfill') {
    approval.status = 'FULFILLED';
    approval.fulfilled_at = new Date().toISOString();
    await db.saveTable('redemption_approvals', approvals);
    await appendAudit(req, 'RESOLVE_DISPUTE_FULFILL', 'redemption_approval', id, { status: 'DISPUTED' }, { status: 'FULFILLED' }, notes);
    return res.json(approval);
  } else {
    approval.status = 'REJECTED';
    approval.rejected_at = new Date().toISOString();

    // Append NEW points_ledger credit row
    const ledger = await db.getTable('points_ledger');
    const users = await db.getTable('users');
    const cust = users.find(u => u.id === approval.customer_user_id);
    const refundLedgerId = 'l-' + generateId();
    await db.insertRow('points_ledger', {
      id: refundLedgerId,
      tenant_id: cust ? cust.tenant_id : 't1',
      region_id: cust ? cust.region_id : 'r1',
      customer_id: approval.customer_user_id,
      amount: Math.abs(parseFloat(approval.points_deducted)),
      type: 'REDEEM_REFUND',
      order_id: null,
      description: `Refund for rejected redemption approval ${approval.id}`,
      created_at: new Date().toISOString()
    });

    approval.refund_ledger_id = refundLedgerId;
    await db.saveTable('redemption_approvals', approvals);
    await appendAudit(req, 'RESOLVE_DISPUTE_REJECT', 'redemption_approval', id, { status: 'DISPUTED' }, { status: 'REJECTED', refund_ledger_id: refundLedgerId }, notes);
    return res.json(approval);
  }
});

// 1.4 Partner Endpoints (Session-authed)

// Part 4 — Admin Health Dashboard API
app.get('/api/admin/health', async (req, res) => {
  const now = Date.now();
  const approvals = await db.getTable('redemption_approvals');
  const stockists = await db.getTable('stockists');
  const partners = await db.getTable('partners');
  const orders = await db.getTable('orders');
  const fraudReports = await db.getTable('fraud_reports');
  const users = await db.getTable('users');
  const ledger = await db.getTable('points_ledger');

  // 4.1 Redemption pipeline health
  const pending_over_24h_count = approvals.filter(a =>
    a.status === 'PENDING_ADMIN_APPROVAL' &&
    (now - new Date(a.created_at).getTime()) > 24 * 3600 * 1000
  ).length;

  const approved_over_48h_count = approvals.filter(a =>
    a.status === 'APPROVED_AWAITING_PARTNER' &&
    a.approved_at &&
    (now - new Date(a.approved_at).getTime()) > 48 * 3600 * 1000
  ).length;

  // 4.2 Partner fulfillment speed (last 30 days, slowest-first top 10)
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;
  const fulfilledLast30 = approvals.filter(a =>
    a.status === 'FULFILLED' &&
    a.approved_at &&
    a.fulfilled_at &&
    new Date(a.fulfilled_at).getTime() >= thirtyDaysAgo
  );

  const partnerTimes = {};
  fulfilledLast30.forEach(a => {
    const hours = (new Date(a.fulfilled_at).getTime() - new Date(a.approved_at).getTime()) / (3600 * 1000);
    if (!partnerTimes[a.partner_id]) partnerTimes[a.partner_id] = [];
    partnerTimes[a.partner_id].push(hours);
  });

  const partner_fulfillment_speed = Object.keys(partnerTimes).map(partner_id => {
    const times = partnerTimes[partner_id].sort((x, y) => x - y);
    const mid = Math.floor(times.length / 2);
    const median_hours = times.length % 2 !== 0 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
    const partnerObj = partners.find(p => p.id === partner_id);
    return {
      partner_id,
      partner_name: partnerObj ? partnerObj.display_name : partner_id,
      median_hours: Math.round(median_hours * 10) / 10
    };
  }).sort((a, b) => b.median_hours - a.median_hours).slice(0, 10);

  // 4.3 Stockist volume leaderboard (30d GMV descending)
  const ordersLast30 = orders.filter(o => o.status !== 'CANCELLED' && new Date(o.createdAt || o.created_at || now).getTime() >= thirtyDaysAgo);
  const stockistGmvMap = {};
  ordersLast30.forEach(o => {
    if (o.stockistId) {
      stockistGmvMap[o.stockistId] = (stockistGmvMap[o.stockistId] || 0) + (o.subtotal || 0);
    }
  });

  const stockist_volume_leaderboard = stockists.map(s => {
    return {
      stockist_id: s.id,
      stockist_name: s.name,
      region_id: s.region_id,
      gmv_30d: stockistGmvMap[s.id] || 0
    };
  }).sort((a, b) => b.gmv_30d - a.gmv_30d).slice(0, 10);

  // 4.4 New arrivals (last 30 days)
  const new_stockists_30d = stockists.filter(s => new Date(s.created_at || now).getTime() >= thirtyDaysAgo).length;
  const new_partners_30d = partners.filter(p => new Date(p.onboarded_at || p.created_at || now).getTime() >= thirtyDaysAgo).length;

  // 4.5 Fraud signals (NEW or TRIAGING fraud reports by entity)
  const activeFrauds = fraudReports.filter(f => ['NEW', 'TRIAGING'].includes(f.status));
  const entityMap = {};
  activeFrauds.forEach(f => {
    const key = (f.linked_entity_type || 'general') + ':' + (f.linked_entity_id || 'unknown');
    if (!entityMap[key]) {
      entityMap[key] = {
        entity_id: f.linked_entity_id || key,
        entity_type: f.linked_entity_type || 'general',
        entity_name: f.subject || f.linked_entity_id || 'Unknown',
        active_reports_count: 0
      };
    }
    entityMap[key].active_reports_count += 1;
  });
  const fraud_signals = Object.values(entityMap);

  // 4.6 System stats
  const system_stats = {
    total_customers: users.filter(u => u.role === 'CUSTOMER').length,
    total_stockists: stockists.length,
    total_onboarded_partners: partners.filter(p => p.is_active !== false).length,
    total_redemption_approvals: approvals.length,
    total_ledger_entries: ledger.length
  };

  return res.json({
    redemption_pipeline: {
      pending_over_24h_count,
      approved_over_48h_count
    },
    partner_fulfillment_speed,
    stockist_volume_leaderboard,
    new_arrivals: {
      new_stockists_30d,
      new_partners_30d
    },
    fraud_signals,
    system_stats
  });
});

// --- Round P4a: Partner App Backend ---

// Part 1: Partner Dashboard Summary

// Admin Regions Management (BF5b)
app.get('/api/admin/regions', async (req, res) => {
  const regions = await db.getTable('regions');
  const users = await db.getTable('users');
  const stockists = await db.getTable('stockists');
  const partnerRegions = await db.getTable('partner_regions');
  const products = await db.getTable('products');
  const vendors = await db.getTable('vendors');
  const partners = await db.getTable('partners');

  const result = regions.map(r => ({
    id: r.id,
    name: r.name,
    code: r.code,
    delivery_fee: r.delivery_fee,
    tenant_id: r.tenant_id || 't1',
    created_at: r.created_at || null,
    counts: {
      users: users.filter(u => u.region_id === r.id && u.role === 'CUSTOMER').length,
      stockists: stockists.filter(s => s.region_id === r.id && s.is_active !== false && users.find(u => u.id === s.user_id)?.kyc_status === 'APPROVED').length,
      partners: new Set(partnerRegions.filter(pr => pr.region_id === r.id && pr.is_active !== false).filter(pr => {
        const p = partners.find(pt => pt.id === pr.partner_id);
        return p && p.is_active !== false && p.onboarded_at;
      }).map(pr => pr.partner_id)).size,
      products: products.filter(p => p.region_id === r.id && !p.deleted_at).length,
      vendors: vendors.filter(v => v.region_id === r.id && v.is_active !== false).length
    },
    counts_total: {
      users: users.filter(u => u.region_id === r.id).length,
      stockists: stockists.filter(s => s.region_id === r.id).length,
      partners: partnerRegions.filter(pr => pr.region_id === r.id).length,
      products: products.filter(p => p.region_id === r.id).length,
      vendors: vendors.filter(v => v.region_id === r.id).length
    }
  }));

  res.json(result);
});

app.post('/api/admin/regions', async (req, res) => {
  const { name, code, delivery_fee } = req.body || {};
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    return res.status(400).json({ error: 'Name is required and must be between 1 and 120 characters.' });
  }

  const cleanCode = code ? String(code).trim() : '';
  if (!cleanCode || cleanCode.length > 40 || !/^[a-z0-9-]+$/.test(cleanCode)) {
    return res.status(400).json({ error: 'Code is required and must contain only lowercase letters, numbers, and hyphens (max 40 chars).' });
  }

  let finalDeliveryFee = null;
  if (delivery_fee !== undefined && delivery_fee !== null && delivery_fee !== '') {
    const feeVal = parseFloat(delivery_fee);
    if (isNaN(feeVal) || !isFinite(feeVal) || feeVal < 0 || feeVal > cfg.DELIVERY_FEE_MAX_RUPEES) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Invalid delivery fee',
        fields: { delivery_fee: `Must be a number between 0 and ${cfg.DELIVERY_FEE_MAX_RUPEES}` }
      });
    }
    finalDeliveryFee = Math.round(feeVal * 100) / 100;
  }

  const regions = await db.getTable('regions');
  if (regions.some(r => r.code === cleanCode)) {
    return res.status(409).json({ error: 'Region code already exists.' });
  }

  const newRegion = {
    id: 'r-' + generateId(),
    tenant_id: 't1',
    name: name.trim(),
    code: cleanCode,
    delivery_fee: finalDeliveryFee,
    created_at: new Date().toISOString()
  };

  regions.push(newRegion);
  await db.saveTable('regions', regions);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'REGION_CREATE',
    entity_type: 'region',
    entity_id: newRegion.id,
    user_id: admin_id || 'u-admin1',
    before: null,
    after: { id: newRegion.id, name: newRegion.name, code: newRegion.code, delivery_fee: newRegion.delivery_fee },
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json(newRegion);
});

app.patch('/api/admin/regions/:id', async (req, res) => {
  const { id } = req.params;
  const { name, code, delivery_fee } = req.body || {};
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  const regions = await db.getTable('regions');
  const region = regions.find(r => r.id === id);
  if (!region) {
    return res.status(404).json({ error: 'Region not found.' });
  }

  const beforeObj = { name: region.name, code: region.code, delivery_fee: region.delivery_fee };

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: 'Name must be between 1 and 120 characters.' });
    }
    region.name = name.trim();
  }

  if (code !== undefined) {
    const cleanCode = String(code).trim();
    if (!cleanCode || cleanCode.length > 40 || !/^[a-z0-9-]+$/.test(cleanCode)) {
      return res.status(400).json({ error: 'Code must contain only lowercase letters, numbers, and hyphens (max 40 chars).' });
    }
    if (regions.some(r => r.id !== id && r.code === cleanCode)) {
      return res.status(409).json({ error: 'Region code already exists.' });
    }
    region.code = cleanCode;
  }

  if (delivery_fee !== undefined) {
    if (delivery_fee === null || delivery_fee === '') {
      region.delivery_fee = null;
    } else {
      const feeVal = parseFloat(delivery_fee);
      if (isNaN(feeVal) || !isFinite(feeVal) || feeVal < 0 || feeVal > cfg.DELIVERY_FEE_MAX_RUPEES) {
        return res.status(400).json({
          error: 'validation_failed',
          message: 'Invalid delivery fee',
          fields: { delivery_fee: `Must be a number between 0 and ${cfg.DELIVERY_FEE_MAX_RUPEES}` }
        });
      }
      region.delivery_fee = Math.round(feeVal * 100) / 100;
    }
  }

  await db.saveTable('regions', regions);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'REGION_UPDATE',
    entity_type: 'region',
    entity_id: region.id,
    user_id: admin_id || 'u-admin1',
    before: beforeObj,
    after: { name: region.name, code: region.code, delivery_fee: region.delivery_fee },
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json(region);
});

app.delete('/api/admin/regions/:id', async (req, res) => {
  const { id } = req.params;

  const users = await db.getTable('users');
  const userCount = users.filter(u => u.region_id === id).length;
  if (userCount > 0) {
    return res.status(409).json({ error: `Cannot delete: ${userCount} users still assigned to this region.` });
  }

  const stockists = await db.getTable('stockists');
  const stockistCount = stockists.filter(s => s.region_id === id).length;
  if (stockistCount > 0) {
    return res.status(409).json({ error: `Cannot delete: ${stockistCount} stockists still assigned to this region.` });
  }

  const partnerRegions = await db.getTable('partner_regions');
  const partnerRegionCount = partnerRegions.filter(pr => pr.region_id === id).length;
  if (partnerRegionCount > 0) {
    return res.status(409).json({ error: `Cannot delete: ${partnerRegionCount} partners still assigned to this region.` });
  }

  const products = await db.getTable('products');
  const productCount = products.filter(p => p.region_id === id).length;
  if (productCount > 0) {
    return res.status(409).json({ error: `Cannot delete: ${productCount} products still assigned to this region.` });
  }

  const vendors = await db.getTable('vendors');
  const vendorCount = vendors.filter(v => v.region_id === id).length;
  if (vendorCount > 0) {
    return res.status(409).json({ error: `Cannot delete: ${vendorCount} vendors still assigned to this region.` });
  }

  const regions = await db.getTable('regions');
  const idx = regions.findIndex(r => r.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Region not found.' });
  }

  const [deleted] = regions.splice(idx, 1);
  await db.saveTable('regions', regions);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'REGION_DELETE',
    entity_type: 'region',
    entity_id: id,
    user_id: req.user.userId,
    before: { name: deleted.name, code: deleted.code },
    after: null,
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json({ message: 'Region deleted successfully' });
});

// Public Region List (BF3 Fix)

app.get('/api/admin/partner-feedback', async (req, res) => {
  const { status, partner_id, category } = req.query;
  let feedbackList = await db.getTable('partner_feedback');
  const partners = await db.getTable('partners');
  const approvals = await db.getTable('redemption_approvals');

  if (status) feedbackList = feedbackList.filter(f => f.status === status);
  if (partner_id) feedbackList = feedbackList.filter(f => f.partner_id === partner_id);
  if (category) feedbackList = feedbackList.filter(f => f.category === category);

  const result = feedbackList
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(f => {
      const partner = partners.find(p => p.id === f.partner_id);
      const approval = f.linked_redemption_approval_id ? approvals.find(a => a.id === f.linked_redemption_approval_id) : null;
      return {
        ...f,
        partner_name: partner ? partner.display_name : '',
        linked_redemption: approval ? { id: approval.id, customer_name: approval.customer_name, package_name: approval.package_name, status: approval.status } : null
      };
    });

  return res.json(result);
});

app.post('/api/admin/partner-feedback/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body;
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  const validStatuses = ['NEW', 'REVIEWING', 'RESOLVED', 'DISMISSED'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Valid status required (NEW, REVIEWING, RESOLVED, DISMISSED)' });
  }

  if (['RESOLVED', 'DISMISSED'].includes(status)) {
    if (!admin_notes || admin_notes.trim().length < 10) {
      return res.status(400).json({ error: 'admin_notes (at least 10 chars) are required for RESOLVED or DISMISSED status' });
    }
  }

  const feedbackList = await db.getTable('partner_feedback');
  const feedback = feedbackList.find(f => f.id === id);
  if (!feedback) return res.status(404).json({ error: 'Partner feedback not found' });

  const oldStatus = feedback.status;
  feedback.status = status;
  if (admin_notes) feedback.admin_notes = admin_notes.trim();
  if (['RESOLVED', 'DISMISSED'].includes(status)) {
    feedback.resolved_at = new Date().toISOString();
  }

  await db.saveTable('partner_feedback', feedbackList);
  await appendAudit(req, 'UPDATE_PARTNER_FEEDBACK', 'partner_feedback', id, { status: oldStatus }, { status, admin_notes: feedback.admin_notes });

  // Trigger in-app notification for partner
  const notifications = await db.getTable('partner_notifications');
  notifications.push({
    id: 'pnt-' + generateId(),
    partner_id: feedback.partner_id,
    kind: 'FEEDBACK_UPDATE',
    title: 'Feedback status updated',
    body: `Your feedback status changed to ${status}`,
    linked_id: feedback.id,
    is_read: false,
    created_at: new Date().toISOString()
  });
  await db.saveTable('partner_notifications', notifications);

  return res.json(feedback);
});

// Part 5: Partner Notifications

// Reset DB
app.post('/api/admin/reset-db', async (req, res) => {
  const actingUserId = req.user?.userId || req.user?.id || null;
  const actingRole = req.user?.role || null;
  const isDevMode = process.env.NODE_ENV !== 'production' && req.headers['x-node-env'] !== 'production';
  const isAllowReset = process.env.ALLOW_DB_RESET === 'true';
  const isAdmin = actingRole === 'ADMIN';
  const envMod = require('./lib/env');
  const isTestEnv = envMod.isTestEnv();
  const isDevLauncher = process.env.DEV_LAUNCHER === 'true';
  const hasRealDb = Boolean(process.env.DATABASE_URL);
  const isInMemoryTestDb = isTestEnv && !isDevLauncher && !hasRealDb;

  if (!isAdmin || !isDevMode || !isAllowReset || !isInMemoryTestDb) {
    let reason = '';
    if (!actingUserId) {
      reason = 'Unauthenticated caller';
    } else if (!isAdmin) {
      reason = `Caller role is ${actingRole}, required ADMIN`;
    } else if (!isDevMode) {
      reason = 'Server is in production mode';
    } else if (!isAllowReset) {
      reason = 'ALLOW_DB_RESET is not enabled';
    } else if (!isInMemoryTestDb) {
      reason = 'Not running on the in-memory test database';
    }

    await appendAudit(
      req,
      'RESET_DB_REFUSED',
      'system',
      'database',
      null,
      { result: 'REFUSED', reason, user_id: actingUserId, role: actingRole },
      reason
    );

    return res.status(403).json({
      error: 'Forbidden',
      message: 'Database reset is disabled or caller is not authorized.'
    });
  }

  await db.resetForTest();
  emailHelper.clearMockOutbox();
  smsHelper.clearMockOutbox();
  loginPasswordFailedAttempts.clear();
  otpRequestAttempts.clear();
  resetTokens.clear();
  apiRateLimitMap.clear();
  loginRateLimitMap.clear();
  otpRateLimitMap.clear();
  otpHourlyLimitMap.clear();

  await appendAudit(
    req,
    'RESET_DB_ALLOWED',
    'system',
    'database',
    null,
    { result: 'ALLOWED', user_id: actingUserId, role: actingRole },
    'Database reset executed successfully'
  );

  return res.json({ success: true, message: 'Database reset successfully.' });
});

// Clear Rate Limits Endpoint (Dev Only)
app.post('/api/admin/clear-rate-limits', (req, res) => {
  if (process.env.NODE_ENV === 'production' || req.headers['x-node-env'] === 'production') {
    return res.status(403).json({ error: 'Not allowed in production' });
  }
  apiRateLimitMap.clear();
  loginRateLimitMap.clear();
  otpRateLimitMap.clear();
  otpHourlyLimitMap.clear();
  loginPasswordFailedAttempts.clear();
  otpRequestAttempts.clear();
  resetTokens.clear();
  return res.json({ success: true, message: 'Rate limits cleared' });
});

app.post('/api/admin/override-table', async (req, res) => {
  const { table, id, patch } = req.body;
  if (!table || !id || !patch) return res.status(400).json({ error: 'Missing table, id, or patch' });
  const updated = await db.updateRow(table, id, patch);
  if (table === 'orders' && patch.status === 'DELIVERED') {
    await _processReferralBonusOnDelivery(updated);
  }
  return res.json({ success: true, row: updated });
});

app.post('/api/admin/insert-table', async (req, res) => {
  const { table, row } = req.body;
  if (!table || !row) return res.status(400).json({ error: 'Missing table or row' });
  const rows = await db.getTable(table);
  const newRow = { id: row.id || require('crypto').randomUUID(), created_at: new Date().toISOString(), ...row };
  rows.push(newRow);
  await db.saveTable(table, rows);
  return res.json({ success: true, row: newRow });
});


async function handleGetSupportSettings(req, res) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const list = await db.getTable('support_settings').catch(() => []) || [];
  const settings = list.find(s => s.id === 'default') || {};
  return res.json({
    support_phone: settings.support_phone || '',
    support_whatsapp: settings.support_whatsapp || '',
    support_email: settings.support_email || '',
    support_hours: settings.support_hours || '',
    updated_at: settings.updated_at || null,
    updated_by: settings.updated_by || null
  });
}

async function handleUpdateSupportSettings(req, res) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { support_phone, support_whatsapp, support_email, support_hours } = req.body || {};

  let normalizedPhone = null;
  if (support_phone && typeof support_phone === 'string' && support_phone.trim()) {
    const phoneVal = validateSupportPhone(support_phone);
    if (!phoneVal.valid) {
      return res.status(400).json({ error: 'invalid_phone', message: phoneVal.message });
    }
    normalizedPhone = support_phone.trim();
  }

  const waVal = validateSupportWhatsapp(support_whatsapp);
  if (!waVal.valid) {
    return res.status(400).json({ error: 'invalid_whatsapp', message: waVal.message });
  }

  const emailVal = validateSupportEmail(support_email);
  if (!emailVal.valid) {
    return res.status(400).json({ error: 'invalid_email', message: emailVal.message });
  }

  const hoursVal = (support_hours && typeof support_hours === 'string' && support_hours.trim()) 
    ? support_hours.trim().slice(0, 100) 
    : null;

  const list = await db.getTable('support_settings').catch(() => []) || [];
  const existing = list.find(s => s.id === 'default');

  const newRow = {
    id: 'default',
    support_phone: normalizedPhone,
    support_whatsapp: (support_whatsapp && typeof support_whatsapp === 'string' && support_whatsapp.trim()) ? support_whatsapp.trim() : null,
    support_email: emailVal.normalized,
    support_hours: hoursVal,
    updated_at: new Date().toISOString(),
    updated_by: req.user.id || req.user.userId || 'admin'
  };

  if (existing) {
    await db.updateRow('support_settings', 'default', newRow);
  } else {
    await db.insertRow('support_settings', newRow);
  }

  try {
    await db.insertRow('admin_audit_log', {
      id: 'audit-' + generateId(),
      action: 'UPDATE_SUPPORT_SETTINGS',
      admin_id: req.user.id || req.user.userId || 'admin',
      target_type: 'support_settings',
      target_id: 'default',
      details: {
        support_phone: newRow.support_phone,
        support_whatsapp: newRow.support_whatsapp,
        support_email: newRow.support_email,
        support_hours: newRow.support_hours
      },
      created_at: new Date().toISOString()
    });
  } catch (auditErr) {
    // ignore
  }

  return res.json({
    success: true,
    message: 'Support contact settings saved successfully.',
    settings: newRow
  });
}

app.get('/api/admin/support-settings', requireAuth, handleGetSupportSettings);
app.post('/api/admin/support-settings', requireAuth, handleUpdateSupportSettings);
app.put('/api/admin/support-settings', requireAuth, handleUpdateSupportSettings);


app.all(['/api/inspector', '/api/inspector/*', '/api/admin/inspector', '/api/admin/inspector/*'], async (req, res) => {
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';
  if (!isDevAllowed) {
    return res.status(403).json({ error: 'Forbidden', message: 'Inspector endpoint disabled in production' });
  }
  const tables = ['users', 'orders', 'products', 'stockists', 'vendors', 'regions', 'points_ledger'];
  const summary = {};
  for (const t of tables) {
    try {
      const data = await db.getTable(t);
      summary[t] = Array.isArray(data) ? data.length : 0;
    } catch {
      summary[t] = 0;
    }
  }
  return res.json({ status: 'ok', tables: summary });
});

// Admin Analytics Dashboard Endpoint
app.get('/api/admin/analytics', async (req, res) => {
  try {
    const users = await db.getTable('users');


    await appendAudit(req, 'VIEW_ANALYTICS', 'system', 'analytics');

    const now = new Date();
    const nowMs = now.getTime();
    const oneDayAgo = nowMs - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = nowMs - 30 * 24 * 60 * 60 * 1000;

    const orders = await db.getTable('orders');
    const pointsLedger = await db.getTable('points_ledger');
    const bindings = await db.getTable('customer_partner_bindings');
    const partners = await db.getTable('partners');
    const packages = await db.getTable('partner_packages');
    const redemptions = await db.getTable('redemption_approvals');
    const stockists = await db.getTable('stockists');
    const regions = await db.getTable('regions');
    const fraudReports = await db.getTable('fraud_reports');

    // Users metrics
    const customerUsers = users.filter(u => u.role === 'CUSTOMER');
    const approvedStockists = users.filter(u => u.role === 'STOCKIST' && u.kyc_status === 'APPROVED');
    const activePartners = partners.filter(p => p.is_active !== false && p.status !== 'INACTIVE');

    const customerOrderTimes = new Map();
    orders.forEach(o => {
      if (o.customer_id && o.created_at) {
        const time = new Date(o.created_at).getTime();
        const existing = customerOrderTimes.get(o.customer_id) || 0;
        if (time > existing) customerOrderTimes.set(o.customer_id, time);
      }
    });

    let dau_customers = 0;
    let wau_customers = 0;
    let mau_customers = 0;
    let new_customers_this_week = 0;
    let new_customers_this_month = 0;

    customerUsers.forEach(u => {
      const createdTime = u.created_at ? new Date(u.created_at).getTime() : 0;
      const lastActiveTime = Math.max(createdTime, customerOrderTimes.get(u.id) || 0);

      if (lastActiveTime >= oneDayAgo) dau_customers++;
      if (lastActiveTime >= sevenDaysAgo) wau_customers++;
      if (lastActiveTime >= thirtyDaysAgo) mau_customers++;

      if (createdTime >= sevenDaysAgo) new_customers_this_week++;
      if (createdTime >= thirtyDaysAgo) new_customers_this_month++;
    });

    const boundCustomerIds = new Set(
      bindings
        .filter(b => b.cable_partner_id || b.broadband_partner_id)
        .map(b => b.customer_user_id || b.customer_id)
        .filter(Boolean)
    );
    const customers_with_bindings = customerUsers.filter(u => boundCustomerIds.has(u.id)).length;

    // Orders metrics
    const total_all_time = orders.filter(o => o.status !== 'CANCELLED').length;
    let total_today = 0;
    let total_this_week = 0;
    let total_this_month = 0;
    let revenue_today_rupees = 0;
    let revenue_this_week_rupees = 0;
    let revenue_this_month_rupees = 0;
    let orders_pending = 0;
    let orders_confirming = 0;
    let orders_ready = 0;
    let orders_delivered_this_week = 0;

    const todayStr = getISTDateString(now);

    orders.forEach(o => {
      if (o.status === 'CANCELLED') return;
      const createdTime = o.created_at ? new Date(o.created_at).getTime() : 0;
      const amount = parseFloat(o.subtotal || o.total_amount || 0);
      const istDate = o.created_at ? getISTDateString(new Date(o.created_at)) : '';

      if (istDate === todayStr || createdTime >= oneDayAgo) {
        total_today++;
        revenue_today_rupees += amount;
      }
      if (createdTime >= sevenDaysAgo) {
        total_this_week++;
        revenue_this_week_rupees += amount;
        if (o.status === 'DELIVERED') orders_delivered_this_week++;
      }
      if (createdTime >= thirtyDaysAgo) {
        total_this_month++;
        revenue_this_month_rupees += amount;
      }

      if (o.status === 'PENDING') orders_pending++;
      if (o.status === 'CONFIRMING') orders_confirming++;
      if (['READY_FOR_PICKUP', 'READY'].includes(o.status)) orders_ready++;
    });

    const average_order_value_this_month = total_this_month > 0
      ? Math.round((revenue_this_month_rupees / total_this_month) * 100) / 100
      : 0;

    // Redemptions metrics
    const total_approvals_all_time = redemptions.length;
    let pending_approvals = 0;
    let approved_awaiting_partner = 0;
    let fulfilled_this_month = 0;
    let rejected_this_month = 0;
    let disputed_open = 0;
    let total_points_redeemed_this_month = 0;
    let total_partner_payout_owed_this_month = 0;

    redemptions.forEach(r => {
      const time = new Date(r.fulfilled_at || r.created_at).getTime();
      const status = r.status || '';

      if (status.includes('PENDING')) pending_approvals++;
      if (status === 'APPROVED_BY_ADMIN' || status === 'APPROVED') approved_awaiting_partner++;
      if (status === 'DISPUTED') disputed_open++;

      if (time >= thirtyDaysAgo) {
        if (status === 'FULFILLED') {
          fulfilled_this_month++;
          const pts = parseInt(r.points_deducted || r.points_redeemed || 0, 10);
          const faceVal = parseFloat(r.face_value_rupees || 0);
          total_points_redeemed_this_month += pts;
          total_partner_payout_owed_this_month += faceVal * 0.88;
        }
        if (status === 'REJECTED') rejected_this_month++;
      }
    });

    total_partner_payout_owed_this_month = Math.round(total_partner_payout_owed_this_month * 100) / 100;

    // Points metrics
    let total_points_issued_all_time = 0;
    let total_points_redeemed_all_time = 0;
    let total_referral_bonuses_paid = 0;

    pointsLedger.forEach(l => {
      const amt = parseFloat(l.amount || 0);
      const type = l.type || '';
      if (type === 'EARN' || amt > 0) {
        total_points_issued_all_time += Math.abs(amt);
      }
      if (type === 'REDEEM' || amt < 0) {
        total_points_redeemed_all_time += Math.abs(amt);
      }
      if (type === 'REFERRAL_BONUS' || type === 'REFERRAL_WELCOME') {
        total_referral_bonuses_paid += Math.abs(amt);
      }
    });

    const total_points_outstanding = total_points_issued_all_time - total_points_redeemed_all_time;

    // Stockists metrics
    const stockistGmvMap = new Map();
    const stockistsWithOrdersThisWeek = new Set();

    orders.forEach(o => {
      if (!o.stockist_id || o.status === 'CANCELLED') return;
      const createdTime = o.created_at ? new Date(o.created_at).getTime() : 0;
      const amount = parseFloat(o.subtotal || o.total_amount || 0);

      if (createdTime >= thirtyDaysAgo && o.status === 'DELIVERED') {
        stockistGmvMap.set(o.stockist_id, (stockistGmvMap.get(o.stockist_id) || 0) + amount);
      }
      if (createdTime >= sevenDaysAgo) {
        stockistsWithOrdersThisWeek.add(o.stockist_id);
      }
    });

    const top_5_by_gmv_this_month = Array.from(stockistGmvMap.entries())
      .map(([stkId, gmv]) => {
        const stk = stockists.find(s => s.id === stkId);
        const reg = regions.find(r => r.id === (stk ? stk.region_id : ''));
        return {
          stockist_id: stkId,
          name: stk ? stk.name : 'Unknown Stockist',
          region: reg ? reg.name : 'Region 1',
          gmv: Math.round(gmv * 100) / 100
        };
      })
      .sort((a, b) => b.gmv - a.gmv)
      .slice(0, 5);

    const active_stockists_this_week = stockistsWithOrdersThisWeek.size;
    const kyc_pending_count = users.filter(u => u.role === 'STOCKIST' && u.kyc_status === 'PENDING').length;

    // Partners metrics
    const partnerRedemptionsMap = new Map();
    const partnerFulfillTimes = new Map();

    redemptions.forEach(r => {
      if (!r.partner_id) return;
      const time = new Date(r.fulfilled_at || r.created_at).getTime();

      if (time >= thirtyDaysAgo && r.status === 'FULFILLED') {
        partnerRedemptionsMap.set(r.partner_id, (partnerRedemptionsMap.get(r.partner_id) || 0) + 1);
      }

      if (r.approved_at && r.fulfilled_at) {
        const appTime = new Date(r.approved_at).getTime();
        const fulTime = new Date(r.fulfilled_at).getTime();
        if (fulTime >= appTime) {
          const hours = (fulTime - appTime) / (1000 * 60 * 60);
          if (!partnerFulfillTimes.has(r.partner_id)) partnerFulfillTimes.set(r.partner_id, []);
          partnerFulfillTimes.get(r.partner_id).push(hours);
        }
      }
    });

    const top_5_by_redemptions_this_month = Array.from(partnerRedemptionsMap.entries())
      .map(([pId, count]) => {
        const ptr = partners.find(p => p.id === pId);
        return {
          partner_id: pId,
          name: ptr ? ptr.display_name : 'Unknown Partner',
          count
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const slowest_fulfillment = Array.from(partnerFulfillTimes.entries())
      .map(([pId, times]) => {
        times.sort((a, b) => a - b);
        const mid = Math.floor(times.length / 2);
        const median = times.length % 2 !== 0 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
        const ptr = partners.find(p => p.id === pId);
        return {
          partner_id: pId,
          name: ptr ? ptr.display_name : 'Unknown Partner',
          median_hours: Math.round(median * 10) / 10
        };
      })
      .sort((a, b) => b.median_hours - a.median_hours)
      .slice(0, 3);

    const total_packages_active = packages.filter(pkg => pkg.is_active !== false && pkg.status !== 'INACTIVE').length;

    // Fraud reports metrics
    let new_count = 0;
    let triaging_count = 0;
    let resolved_this_month = 0;

    fraudReports.forEach(f => {
      const st = (f.status || f.flag_status || '').toUpperCase();
      const time = new Date(f.resolved_at || f.created_at || Date.now()).getTime();

      if (st === 'NEW' || st === 'PENDING') new_count++;
      if (st === 'TRIAGING' || st === 'INVESTIGATING') triaging_count++;
      if (st === 'RESOLVED' && time >= thirtyDaysAgo) resolved_this_month++;
    });

    return res.json({
      users: {
        total_customers: customerUsers.length,
        total_stockists_approved: approvedStockists.length,
        total_partners_active: activePartners.length,
        dau_customers,
        wau_customers,
        mau_customers,
        new_customers_this_week,
        new_customers_this_month,
        customers_with_bindings
      },
      orders: {
        total_all_time,
        total_today,
        total_this_week,
        total_this_month,
        revenue_today_rupees,
        revenue_this_week_rupees,
        revenue_this_month_rupees,
        average_order_value_this_month,
        orders_pending,
        orders_confirming,
        orders_ready,
        orders_delivered_this_week
      },
      redemptions: {
        total_approvals_all_time,
        pending_approvals,
        approved_awaiting_partner,
        fulfilled_this_month,
        rejected_this_month,
        disputed_open,
        total_points_redeemed_this_month,
        total_partner_payout_owed_this_month
      },
      points: {
        total_points_issued_all_time,
        total_points_redeemed_all_time,
        total_points_outstanding,
        total_referral_bonuses_paid
      },
      stockists: {
        top_5_by_gmv_this_month,
        active_stockists_this_week,
        kyc_pending_count
      },
      partners: {
        top_5_by_redemptions_this_month,
        slowest_fulfillment,
        total_packages_active
      },
      fraud_reports: {
        new_count,
        triaging_count,
        resolved_this_month
      },
      generated_at: now.toISOString()
    });
  } catch (err) {
    console.error('Error computing analytics:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});




app.use(errorHandler);

process.on('unhandledRejection', (reason, p) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

registerPostErrorConfigRoutes(app);


// Start Server
const PORT = process.env.PORT || 3001;
let serverInstance = null;
const readyPromise = db.init().then(async () => {
  assertProductionConfig();
  checkConfigWarnings();
  assertNoDuplicateRoutes(app);
  reportMalformedPhones();

  if (process.env.SEED_MODE === 'test') {
    if (!process.env.TEST_SUITE) {
      console.warn('\n[WARNING] SEED_MODE=test was set by accident outside the test suite. This will load preset data!\n');
    }
    const users = await db.getTable('users');
    if (!users || users.length === 0) {
      console.error('\n[FATAL ERROR] SEED_MODE=test is set but the database is empty! The app must not run empty in test mode.\n');
      process.exit(1);
    }
  }

  if (process.env.NODE_ENV === 'production' && integrations.getPaymentsMode() === 'live') {
    const missingKeys = integrations.getMissingPaymentsKeys();
    if (missingKeys.length > 0) {
      console.error(`\n[FATAL ERROR] Production cannot start with PAYMENTS_MODE=live. Missing keys: ${missingKeys.join(', ')}\n`);
      process.exit(1);
    }
  }

  if (!serverInstance) {
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Backend Server] ISP-Commerce Loyalty API listening on port ${PORT} (0.0.0.0)`);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Backend Server] Port ${PORT} already in use. Reusing active server instance.`);
      } else {
        console.error('Server listen error:', err);
      }
    });
  }
}).catch(err => {
  console.error('Failed to initialize DB server:', err);
});

module.exports = { 
  app, 
  calculateSettlement, 
  calculatePartnerPayout, 
  getCommissionConfig, 
  readyPromise, 
  assertNoDuplicateRoutes,
  clearOtpRateLimit,
  checkOtpRateLimit,
  otpRateLimitMap,
  otpHourlyLimitMap,
  getCustomerVisibleProducts,
  findStockistOwner,
  getCustomerVisibility,
  isCustomerVisible,
  setMainWholesaler,
  escapeHtml,
  unescapeHtml,
  sanitizePlainText
};



// TESTER-48: Layer 3 SMS Escalation (Stub)
setInterval(async () => {
  try {
    const orders = await db.getTable('orders');
    const stockists = await db.getTable('stockists');
    const users = await db.getTable('users');
    const now = new Date();
    
    // 5 minutes timeout
    const TIMEOUT_MS = 5 * 60 * 1000;
    
    for (const order of orders) {
      if (!order.acknowledged_at && (order.status === 'CONFIRMING' || order.status === 'PREPARING')) {
        const createdMs = new Date(order.created_at).getTime();
        if (now.getTime() - createdMs > TIMEOUT_MS) {
          // Check if we already sent SMS (prevent spam)
          // We'll use a hidden property for pg-mem or just rely on a new field.
          // Since we can't alter schema here without migration, let's assume we log it and mark it escalated.
          if (!order.sms_escalated) {
            order.sms_escalated = true;
            await db.saveTable('orders', orders);
            
            const stockist = stockists.find(s => s.id === order.stockist_id);
            if (stockist) {
              const stockistUser = users.find(u => u.id === stockist.user_id);
              const phone = stockist.phone || stockist.contact_phone || (stockistUser ? stockistUser.phone : null);
              if (phone) {
                await smsHelper.sendSms(phone, `Beniffy: new order #${order.id.substring(2).toUpperCase()} at your shop. Open the app to accept.`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    // silently fail in background
  }
}, 60000); // Check every minute


// TESTER-48: Layer 3 SMS Escalation (Stub)
setInterval(async () => {
  try {
    const orders = await db.getTable('orders');
    const stockists = await db.getTable('stockists');
    const users = await db.getTable('users');
    const now = new Date();
    
    // 5 minutes timeout
    const TIMEOUT_MS = 5 * 60 * 1000;
    
    for (const order of orders) {
      if (!order.acknowledged_at && (order.status === 'CONFIRMING' || order.status === 'PREPARING')) {
        const createdMs = new Date(order.created_at).getTime();
        if (now.getTime() - createdMs > TIMEOUT_MS) {
          // Check if we already sent SMS (prevent spam)
          // We'll use a hidden property for pg-mem or just rely on a new field.
          // Since we can't alter schema here without migration, let's assume we log it and mark it escalated.
          if (!order.sms_escalated) {
            order.sms_escalated = true;
            await db.saveTable('orders', orders);
            
            const stockist = stockists.find(s => s.id === order.stockist_id);
            if (stockist) {
              const stockistUser = users.find(u => u.id === stockist.user_id);
              const phone = stockist.phone || stockist.contact_phone || (stockistUser ? stockistUser.phone : null);
              if (phone) {
                await smsHelper.sendSms(phone, `Beniffy: new order #${order.id.substring(2).toUpperCase()} at your shop. Open the app to accept.`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    // silently fail in background
  }
}, 60000); // Check every minute
