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
  'mailto:support@fastnet.example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);



require('express-async-errors');
const cors = require('cors');
const db = require('./db');
const { validatePayoutFields } = require('./lib/payout');
const { withLock } = require('./lib/mutex.js');

// BF-SEC-3 Helpers
function assertSelfOrAdmin(req, res, userId) {
  if (!req.user || !req.user.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (req.user.role === 'ADMIN' || req.user.userId === userId) {
    return true;
  }
  res.status(403).json({ error: 'Forbidden' });
  return false;
}

async function getCallerStockist(req) {
  if (!req.user || !req.user.userId) return null;
  const stockists = await db.getTable('stockists');
  return stockists.find(s => s.user_id === req.user.userId) || null;
}

async function assertOwnsStockist(req, res, stockistId) {
  if (!req.user || !req.user.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (req.user.role === 'ADMIN') return true;
  const callerStockist = await getCallerStockist(req);
  if (callerStockist && (callerStockist.id === stockistId || callerStockist.user_id === stockistId)) return true;
  res.status(403).json({ error: 'Forbidden' });
  return false;
}

async function assertOrderAccess(req, res, order) {
  if (!req.user || !req.user.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (req.user.role === 'ADMIN') return true;
  if (req.user.role === 'CUSTOMER' && req.user.userId === order.customer_id) return true;
  if (req.user.role === 'STOCKIST') {
    const callerStockist = await getCallerStockist(req);
    if (callerStockist && callerStockist.id === order.stockist_id) return true;
  }
  res.status(403).json({ error: 'Forbidden' });
  return false;
}

const cfg = require('./config');
const jwt = require('jsonwebtoken');


const fs = require('fs');
const path = require('path');
const multer = require('multer');
const r2 = require('./lib/r2');
const { evaluateRegistrationFlags } = require('./lib/kyc-flags');
const { issueOtp, verifyOtp } = require('./lib/otp');

const app = express();
if (process.env.NODE_ENV === 'production') {
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim());
  app.use(cors({ origin: (origin, cb) => {
    if (!origin || allowed.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }}));
} else {
  app.use(cors());
}
app.use(express.json());
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '0', 10));

// Security Headers & HTTPS Redirect Middleware (Item 20)
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    return res.redirect(301, `https://${req.header('host')}${req.url}`);
  }
  next();
});

// HTML escaping helper (Item 17)
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return m;
    }
  });
}

function normalizePhone(phone) {
  if (!phone) return phone;
  let cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
    cleanPhone = cleanPhone.slice(2);
  }
  return cleanPhone;
}

function checkTermsAgreed(req, res, isTest) {
  if (!req.body.termsAgreed && !isTest) {
    res.status(400).json({ error: 'You must agree to Terms and Privacy Policy' });
    return false;
  }
  return true;
}

function checkPhone(phone, res) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    if (res) {
      res.status(400).json({ error: 'invalid_phone', message: 'Enter a valid 10-digit mobile number.' });
    }
    return null;
  }
  return cleanPhone;
}

// Input validation helper (Item 16)
function validateUserInput({ phone, email, name }) {
  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
      return 'invalid_phone';
    }
  }
  if (email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return 'Invalid email format';
    }
  }
  if (name) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
      return 'Name must be 2-50 letters';
    }
  }
  return null;
}

async function checkEmail(email, res, expectNew = true) {
  if (!email || typeof email !== 'string' || !email.trim()) {
    res.status(400).json({ error: 'Email is required' });
    return null;
  }
  const clean = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(clean)) {
    res.status(400).json({ error: 'Invalid email format' });
    return null;
  }
  if (expectNew) {
    const users = await db.getTable('users');
    const partners = await db.getTable('partners');
    const uDup = users.some(u => u.kyc_status !== 'RELEASED' && u.email && u.email.trim().toLowerCase() === clean);
    const pDup = partners.some(p => p.contact_email && p.contact_email.trim().toLowerCase() === clean);
    if (uDup || pDup) {
      res.status(400).json({ error: 'This email is already registered.' });
      return null;
    }
  }
  return clean;
}

// Rate limiting state (Items 11, 13, 14)
const apiRateLimitMap = new Map();
const loginRateLimitMap = new Map();
const otpRateLimitMap = new Map();
const otpHourlyLimitMap = new Map();

// Rate limits and CAPTCHA are relaxed for local development only (see lib/env.js).
const { isLocalDev } = require('./lib/env');

// General API Rate Limiting Middleware (Item 14) - 100 req/min per IP
app.use('/api/', async (req, res, next) => {
  if (isLocalDev() || req.path.includes('/api/setup') || req.path.startsWith('/setup/') || req.path === '/setup' || req.path.startsWith('/admin/reset-db') || req.path.startsWith('/admin/clear-rate-limits')) return next();

  if (req.path.includes('/auth/send-otp') || req.path.endsWith('/send-otp') || req.path.includes('login-otp-request')) {
    try {
      const users = await db.getTable('users');
      if (Array.isArray(users) && users.length === 0) return next();
    } catch (e) {}
  }

  const key = req.ip || 'ip-client';
  const now = Date.now();
  const record = apiRateLimitMap.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + 60000;
  } else {
    record.count += 1;
  }
  apiRateLimitMap.set(key, record);
  if (record.count > 100) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
});

// Login Rate Limit Middleware (Item 11) - 5 attempts / 15 mins by phone
async function checkLoginRateLimit(phone) {
  if (process.env.SKIP_RATE_LIMIT === 'true' || !phone) return true;
  try {
    const users = await db.getTable('users');
    if (Array.isArray(users) && users.length === 0) return true;
  } catch (e) {}
  const now = Date.now();
  const record = loginRateLimitMap.get(phone) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + 15 * 60 * 1000;
  } else {
    record.count += 1;
  }
  loginRateLimitMap.set(phone, record);
  return record.count <= 5;
}

// OTP Rate Limit Middleware (Item 13, BF20) - 5 requests / 15 mins by phone, 20 / hour absolute cap
async function checkOtpRateLimit(phone) {
  if (process.env.SKIP_RATE_LIMIT === 'true' || !phone) return { allowed: true };
  try {
    const users = await db.getTable('users');
    if (Array.isArray(users) && users.length === 0) return { allowed: true };
  } catch (e) {}

  const now = Date.now();
  const hourlyWindow = cfg.OTP_RATE_LIMIT_HOURLY_WINDOW_MS || 60 * 60 * 1000;
  const hourlyMax = cfg.OTP_RATE_LIMIT_HOURLY_MAX || 20;
  const shortWindow = cfg.OTP_RATE_LIMIT_SHORT_WINDOW_MS || 15 * 60 * 1000;
  const shortMax = cfg.OTP_RATE_LIMIT_SHORT_MAX || 5;

  // 1. Absolute hourly cap (20 per hour) - not cleared on successful verification
  const hourlyRecord = otpHourlyLimitMap.get(phone) || { count: 0, resetAt: now + hourlyWindow };
  if (now > hourlyRecord.resetAt) {
    hourlyRecord.count = 1;
    hourlyRecord.resetAt = now + hourlyWindow;
  } else {
    hourlyRecord.count += 1;
  }
  otpHourlyLimitMap.set(phone, hourlyRecord);

  if (hourlyRecord.count > hourlyMax) {
    const remainingMs = Math.max(0, hourlyRecord.resetAt - now);
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    return {
      allowed: false,
      reason: 'hourly',
      retry_after: hourlyRecord.resetAt,
      error: `Too many OTP requests. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`
    };
  }

  // 2. Short window (5 per 15 mins) - cleared on successful verification
  const shortRecord = otpRateLimitMap.get(phone) || { count: 0, resetAt: now + shortWindow };
  if (now > shortRecord.resetAt) {
    shortRecord.count = 1;
    shortRecord.resetAt = now + shortWindow;
  } else {
    shortRecord.count += 1;
  }
  otpRateLimitMap.set(phone, shortRecord);

  if (shortRecord.count > shortMax) {
    const remainingMs = Math.max(0, shortRecord.resetAt - now);
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    return {
      allowed: false,
      reason: 'short',
      retry_after: shortRecord.resetAt,
      error: 'Too many OTP requests. Try again in 15 minutes.'
    };
  }

  return { allowed: true };
}

function clearOtpRateLimit(phone) {
  if (!phone) return;
  otpRateLimitMap.delete(phone);
  loginRateLimitMap.delete(phone);
  otpRequestAttempts.delete(phone);
}

// DND Check Helper (Part 3 Item 6)
async function isDNDRegistered(phone) {
  if (!phone) return false;
  // DND Registry check simulation/mock
  const dndList = ['9000000000', '9111111111'];
  const cleanPhone = String(phone).replace(/\D/g, '');
  return dndList.includes(cleanPhone);
}

function stockistKycGate(user) {
  if (!user || user.kyc_status === 'RELEASED') return { blocked: true, code: 404, body: { error: 'No account found' } };
  if (user.kyc_status === 'APPROVED') return { blocked: false };

  const messages = {
    PENDING:     'Your KYC is pending admin approval. Please check back later.',
    REJECTED:    'Your KYC application was rejected. Contact support to reapply.',
    BLACKLISTED: 'This account is blocked. Contact support.'
  };
  return {
    blocked: true,
    code: 403,
    body: {
      error: 'KYC_NOT_APPROVED',
      kyc_status: user.kyc_status || 'PENDING',
      message: messages[user.kyc_status] || messages.PENDING
    }
  };
}

// Server-Side Auth Verification Middleware (Item 6, Issue 1 KYC Gate)
app.use(async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token) {
    try {
      let decoded = null;
      try {
        decoded = jwt.verify(token, sessionHelper.getSecret());
      } catch (e) {
        decoded = sessionHelper.verifySession(token);
      }
      if (decoded) {
        req.user = {
          userId: decoded.sub || decoded.userId || decoded.user_id || decoded.id,
          role: decoded.role
        };
        const userId = req.user.userId;
        const users = await db.getTable('users');
        const user = users.find(u => u.id === userId);
        if (user && user.role === 'STOCKIST' && user.kyc_status !== 'APPROVED') {
          const rawPath = req.path || req.originalUrl?.split('?')[0] || req.url?.split('?')[0];
          if (!rawPath.startsWith('/api/auth') && !rawPath.startsWith('/api/stockist/auth') && !rawPath.startsWith('/api/health') && !rawPath.startsWith('/api/admin')) {
            const gate = stockistKycGate(user);
            return res.status(gate.code).json(gate.body);
          }
        }
      }
    } catch (err) {
      // Invalid token, req.user remains undefined
    }
  }
  next();
});

// HTTP Request Logging Middleware (Part 3.3)
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
app.get('/api/health', async (req, res) => {
  let dbStatus = 'connected';
  try {
    const alive = await db.query('SELECT 1 as alive').catch(() => null);
    if (!alive) {
      const users = await db.getTable('users');
      if (!Array.isArray(users)) dbStatus = 'error';
    }
  } catch (e) {
    dbStatus = 'error';
  }
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';
  res.json({
    status: 'ok',
    db: dbStatus,
    uptime_seconds: Math.floor(process.uptime()),
    version: process.env.APP_VERSION || 'unknown',
    dev_tools_enabled: isDevAllowed
  });
});

app.get('/api/config', (req, res) => {
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';
  res.json({
    status: 'ok',
    version: process.env.APP_VERSION || 'unknown',
    dev_tools_enabled: isDevAllowed
  });
});

// Boot-Time Missing-Config Warnings (Part 3.1)
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const uploadBillMiddleware = (req, res, next) => {
  upload.fields([
    { name: 'bill_photo', maxCount: 1 },
    { name: 'billFile', maxCount: 1 },
    { name: 'imageFile', maxCount: 1 },
    { name: 'image', maxCount: 1 },
    { name: 'image_file', maxCount: 1 },
    { name: 'documentPhoto', maxCount: 1 },
    { name: 'document_photo', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large', message: 'File exceeds size limit.' });
      }
      return res.status(400).json({ error: 'upload_error', message: err.message });
    }
    if (req.files) {
      const bFile = (req.files['bill_photo'] && req.files['bill_photo'][0]) ||
                    (req.files['billFile'] && req.files['billFile'][0]) ||
                    (req.files['documentPhoto'] && req.files['documentPhoto'][0]) ||
                    (req.files['document_photo'] && req.files['document_photo'][0]) ||
                    (req.files['imageFile'] && req.files['imageFile'][0]) ||
                    (req.files['image'] && req.files['image'][0]) ||
                    (req.files['image_file'] && req.files['image_file'][0]);
      if (bFile) req.file = bFile;
    }
    next();
  });
};

const crypto = require('crypto');
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
const loginPasswordFailedAttempts = new Map();
const otpRequestAttempts = new Map();
const resetTokens = new Map();

// Helper: sanitize user object (remove password_hash)
function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

// In-memory OTP storage


// Helper to generate IDs
const generateId = () => Math.random().toString(36).substr(2, 9);

// Helper for IST Day Boundary
function getISTDateString(date = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// Helper: append a payment ledger event (append-only audit)
async function appendPaymentEvent(orderId, eventType, amount, metadata = {}) {
  const ledger = await db.getTable('payment_ledger');
  ledger.push({
    id: 'pl-' + generateId(),
    order_id: orderId,
    event_type: eventType,
    amount,
    metadata,
    created_at: new Date().toISOString()
  });
  await db.saveTable('payment_ledger', ledger);
}

// Helper: append an admin audit log entry

async function capturePayoutEvent(req, entityType, entityId, before, finalEntity, userId) {
  const fields = [];
  if ((before.payout_upi_id || '') !== (finalEntity.payout_upi_id || '')) fields.push('UPI');
  const ifscKey = entityType === 'partner' ? 'payout_bank_ifsc' : 'payout_ifsc';
  if ((before[ifscKey] || '') !== (finalEntity[ifscKey] || '')) fields.push('IFSC');
  if ((before.payout_bank_account || '') !== (finalEntity.payout_bank_account || '')) fields.push('Bank Account');
  if ((before.payout_account_name || '') !== (finalEntity.payout_account_name || '')) fields.push('Account Name');

  if (fields.length > 0) {
    const mask = (acc) => acc && acc.length > 4 ? '...' + acc.slice(-4) : acc;
    const beforeMasked = { ...before, payout_bank_account: mask(before.payout_bank_account) };
    const finalMasked = { ...finalEntity, payout_bank_account: mask(finalEntity.payout_bank_account) };
    await appendAudit(req, 'PAYOUT_DETAILS_CHANGED', entityType, entityId, beforeMasked, finalMasked, 'Fields changed: ' + fields.join(', '));
  }
}

async function appendAudit(req, action, entity_type, entity_id, before = null, after = null, reason = '') {
  const admin_user_id = (req && req.user && req.user.userId) || 'u-admin';
  const log = await db.getTable('admin_audit_log');
  const entry = {
    id: 'audit-' + generateId(),
    admin_user_id,
    action,
    entity_type,
    entity_id,
    before: before !== undefined ? before : null,
    after: after !== undefined ? after : null,
    reason: reason || '',
    created_at: new Date().toISOString()
  };
  log.push(entry);
  await db.saveTable('admin_audit_log', log);
  return entry;
}

// ----------------------------------------------------
// AUTH & SETUP ENDPOINTS
// ----------------------------------------------------

// POST /api/auth/verify-captcha (Item 12)
app.post('/api/auth/verify-captcha', async (req, res) => {
  const { captchaToken } = req.body || {};
  if (!captchaToken) {
    return res.status(400).json({ error: 'invalid_captcha', message: 'CAPTCHA token is missing.' });
  }
  if (isLocalDev()) {
    return res.json({ success: true, score: 0.9 });
  }
  if (process.env.CAPTCHA_SECRET) {
    try {
      const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: process.env.CAPTCHA_SECRET, response: captchaToken })
      });
      const data = await resp.json();
      if (data.success && data.score >= cfg.CAPTCHA_MIN_SCORE) {
        return res.json({ success: true, score: data.score });
      }
      return res.status(400).json({ error: 'invalid_captcha', message: 'CAPTCHA verification failed or score too low.' });
    } catch (e) {
      return res.status(503).json({ error: 'captcha_unavailable' });
    }
  }
  return res.status(503).json({ error: 'captcha_unavailable' });
});

// POST /api/auth/send-otp & /api/stockist/auth/send-otp (Item 11, Item 13, BF16 KYC Gate)
const handleSendOtpRoute = async (req, res) => {
  const { phone: identifier } = req.body || {};
  if (!identifier || typeof identifier !== 'string') {
    return res.status(400).json({ error: 'Phone or email is required' });
  }

  const isEmail = identifier.includes('@');
  let user = null;
  const users = await db.getTable('users');

  if (isEmail) {
    const cleanEmail = identifier.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) return res.status(400).json({ error: 'Invalid email format' });
    user = users.find(u => u.kyc_status !== 'RELEASED' && u.email && u.email.trim().toLowerCase() === cleanEmail && u.role === 'STOCKIST') ||
           users.find(u => u.kyc_status !== 'RELEASED' && u.email && u.email.trim().toLowerCase() === cleanEmail);
  } else {
    const cleanPhone = checkPhone(identifier, res);
    if (!cleanPhone) return;
    user = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone && u.role === 'STOCKIST') ||
           users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone);
  }



  if (req.path.includes('/stockist/auth')) {
    const stockistUser = (user && user.role === 'STOCKIST') ? user : null;
    const gate = stockistKycGate(stockistUser);
    if (gate.blocked) return res.status(gate.code).json(gate.body);
  } else if (user && user.role === 'STOCKIST') {
    const gate = stockistKycGate(user);
    if (gate.blocked) return res.status(gate.code).json(gate.body);
  }

  const otpLimit = await checkOtpRateLimit(identifier);
  if (!otpLimit.allowed) {
    return res.status(429).json({ error: otpLimit.error, retry_after: otpLimit.retry_after });
  }
  if (!(await checkLoginRateLimit(identifier))) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  const code = issueOtp('login:' + identifier);
  try {
    await smsHelper.sendSms(user ? user.phone : identifier, `Your Beniffy OTP is ${code}`);
    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    if (err.code === 'SMS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'sms_unavailable' });
    }
    return res.status(500).json({ error: 'sms_error' });
  }
};

app.post('/api/auth/send-otp', handleSendOtpRoute);
app.post('/api/stockist/auth/send-otp', handleSendOtpRoute);

// POST /api/auth/register-customer (Item 16, Item 12, Item 15)
app.post('/api/auth/register-customer', async (req, res) => {
  let { phone, email, name, regionId, region_id, address, cable_partner_id, broadband_partner_id, captchaToken, termsAgreed } = req.body || {};

  const isTest = require('./lib/env').isTestEnv();

  if (!checkTermsAgreed(req, res, isTest)) return;

  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;

  const validationErr = validateUserInput({ email, name });
  if (validationErr) return res.status(400).json({ error: validationErr });

  const targetRegionId = regionId || region_id || 'r1';
  const cleanName = escapeHtml(name);
  const validEmail = await checkEmail(email, res);
  if (!validEmail) return;
  const cleanAddress = address ? escapeHtml(address) : '';

  const users = await db.getTable('users');
  const existing = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === phone);
  if (existing) {
    return res.status(400).json({ error: 'Phone already registered' });
  }

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  if (cable_partner_id) {
    const cp = partners.find(p => p.id === cable_partner_id && p.is_active !== false);
    if (!cp || !cp.service_types || !cp.service_types.includes('CABLE')) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Invalid cable partner' });
    }
    const servesRegion = partnerRegions.some(pr => pr.partner_id === cable_partner_id && pr.region_id === targetRegionId && pr.service_type === 'CABLE' && pr.is_active !== false);
    if (!servesRegion) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Cable partner does not serve customer region' });
    }
  }

  if (broadband_partner_id) {
    const bp = partners.find(p => p.id === broadband_partner_id && p.is_active !== false);
    if (!bp || !bp.service_types || !bp.service_types.includes('BROADBAND')) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Invalid broadband partner' });
    }
    const servesRegion = partnerRegions.some(pr => pr.partner_id === broadband_partner_id && pr.region_id === targetRegionId && pr.service_type === 'BROADBAND' && pr.is_active !== false);
    if (!servesRegion) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Broadband partner does not serve customer region' });
    }
  }

  const userId = 'u-' + generateId();
  const newUser = await db.insertRow('users', {
    id: userId,
    tenant_id: 't1',
    region_id: targetRegionId,
    phone,
    name: cleanName,
    email: validEmail,
    address: cleanAddress,
    role: 'CUSTOMER',
    kyc_status: 'PENDING',
    sms_marketing: false,
    email_marketing: false,
    terms_accepted_at: req.body.termsAgreed ? new Date().toISOString() : null,
    terms_version: req.body.termsAgreed ? '2026-10-draft' : null,
    created_at: new Date().toISOString()
  });

  let binding = null;
  if (cable_partner_id || broadband_partner_id) {
    const bindings = await db.getTable('customer_partner_bindings');
    binding = {
      id: 'cpb-' + generateId(),
      customer_user_id: userId,
      cable_partner_id: cable_partner_id || null,
      broadband_partner_id: broadband_partner_id || null,
      updated_at: new Date().toISOString()
    };
    bindings.push(binding);
    await db.saveTable('customer_partner_bindings', bindings);
    await appendAudit(req, 'CREATE_PARTNER_BINDING', 'customer_partner_binding', userId, null, binding);
  }

  await appendAudit(req, 'REGISTER_CUSTOMER', 'user', userId, null, { phone, name: cleanName, role: 'CUSTOMER', terms_accepted_at: newUser.terms_accepted_at, terms_version: newUser.terms_version });

  const sessionHelper = require('./lib/session');
  const token = sessionHelper.signSession(newUser.id, newUser.role);

  res.status(200).json({
    success: true,
    token,
    user: sanitizeUser(newUser),
    bindings: binding
  });
});

// GET /api/users/:id (Item 7, Item 19)
app.get('/api/users/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (req.user.role !== 'ADMIN' && req.user.userId !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(sanitizeUser(user));
});

// PATCH /api/users/:id (Item 8)
app.patch('/api/users/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const isAdmin = req.user.role === 'ADMIN';
  if (!isAdmin && req.user.userId !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const allowedFields = ['name', 'email', 'address', 'phone', 'sms_marketing', 'email_marketing'];
  const protectedFields = ['kyc_status', 'points', 'is_active', 'role', 'id'];

  if (!isAdmin) {
    const requestedFields = Object.keys(req.body || {});
    const hasProtected = requestedFields.filter(f => protectedFields.includes(f));
    if (hasProtected.length > 0) {
      return res.status(400).json({
        error: 'Cannot modify protected fields',
        protected: hasProtected
      });
    }
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (req.user && req.user.role !== 'ADMIN' && req.user.userId !== id && !isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const patch = {};
  const updateKeys = isAdmin ? Object.keys(req.body) : allowedFields;

  if (req.body.email && req.body.email !== user.email) {
    const validEmail = await checkEmail(req.body.email, res);
    if (!validEmail) return;
    patch.email = validEmail;
  }

  updateKeys.forEach(f => {
    if (f in req.body && f !== 'email') patch[f] = escapeHtml(req.body[f]);
  });

  const updated = await db.updateRow('users', id, patch);
  res.json(sanitizeUser(updated));
});

// GET /api/setup/status
app.get('/api/setup/status', async (req, res) => {
  try {
    const users = await db.getTable('users');
    const user_count = users.length;
    res.json({ needs_setup: user_count === 0, user_count });
  } catch (err) {
    console.error('Error checking setup status:', err);
    res.status(500).json({ error: 'Failed to check setup status' });
  }
});

// POST /api/setup/create-admin
app.post('/api/setup/create-admin', async (req, res) => {
  try {
    const users = await db.getTable('users');
    if (users.length > 0) {
      return res.status(403).json({ error: 'Setup has already been completed.' });
    }

    let { name, phone, email } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: 'Name is required (max 120 chars).' });
    }
    const validPhone = checkPhone(phone, res);
    if (!validPhone) return;
    phone = validPhone;
    const validEmail = await checkEmail(email, res);
    if (!validEmail) return;

    const cleanName = name.trim();
    const cleanPhone = phone.trim();

    // Ensure tenant t1 exists
    const tenants = await db.getTable('tenants');
    if (!tenants.some(t => t.id === 't1')) {
      await db.insertRow('tenants', {
        id: 't1',
        name: 'Beniffy Cable & Broadband',
        code: 'fastnet',
        created_at: new Date().toISOString()
      });
    }

    // Ensure global commission config exists
    const commConfigs = await db.getTable('commission_config');
    if (!commConfigs.some(c => c.scope === 'GLOBAL')) {
      await db.insertRow('commission_config', {
        id: `ccfg-global-${Date.now()}`,
        scope: 'GLOBAL',
        stockist_id: null,
        stockist_reinvest_pct: 40.00,
        points_from_pot_pct: 12.00,
        partner_redemption_cut_pct: 50.00,
        created_at: new Date().toISOString()
      });
    }

    const adminUser = {
      id: `u-${generateId()}`,
      tenant_id: 't1',
      region_id: null,
      phone: cleanPhone,
      email: validEmail,
      name: cleanName,
      role: 'ADMIN',
      kyc_status: 'APPROVED',
      no_show_count: 0,
      address: '',
      created_at: new Date().toISOString(),
      is_active: true
    };

    await db.insertRow('users', adminUser);
    await appendAudit(req, 'SETUP_CREATE_ADMIN', 'users', adminUser.id, null, sanitizeUser(adminUser), 'Initial administrator setup');

    res.status(200).json(sanitizeUser(adminUser));
  } catch (err) {
    console.error('Error creating admin in setup:', err);
    res.status(500).json({ error: 'Failed to create administrator account.' });
  }
});

// Verify OTP & Login
const handleVerifyOtpRoute = async (req, res) => {
  const { phone: identifier, otp, expected_role } = req.body;
  if (!identifier || !otp) {
    return res.status(400).json({ error: 'Phone/Email and OTP are required' });
  }

  if (!/^\d{6}$/.test(String(otp).trim())) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  const ALLOWED_ROLES = ['CUSTOMER', 'STOCKIST', 'PARTNER_ADMIN', 'ADMIN'];
  if (expected_role && !ALLOWED_ROLES.includes(expected_role)) {
    return res.status(400).json({ error: 'Invalid expected_role parameter' });
  }

  const vRes = verifyOtp('login:' + identifier, otp);
  if (!vRes.ok) {
    if (vRes.reason === 'locked') return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  const isEmail = identifier.includes('@');
  let user = null;
  const users = await db.getTable('users');

  if (isEmail) {
    const cleanEmail = identifier.trim().toLowerCase();
    user = users.find(u => u.kyc_status !== 'RELEASED' && u.email && u.email.trim().toLowerCase() === cleanEmail && u.role === 'STOCKIST') ||
           users.find(u => u.kyc_status !== 'RELEASED' && u.email && u.email.trim().toLowerCase() === cleanEmail);
  } else {
    const cleanPhone = checkPhone(identifier, res);
    if (!cleanPhone) return;
    user = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone && u.role === 'STOCKIST') ||
           users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone);
  }

  if (!user) {
    if (expected_role === 'ADMIN') {
      return res.status(403).json({ error: 'This account is not registered as an administrator.' });
    }
    return res.status(404).json({ error: 'No account found' });
  }

  if (req.path.includes('/stockist/auth')) {
    const stockistUser = user.role === 'STOCKIST' ? user : null;
    const gate = stockistKycGate(stockistUser);
    if (gate.blocked) return res.status(gate.code).json(gate.body);
  }

  if (user.role === 'STOCKIST' || expected_role === 'STOCKIST') {
    const gate = stockistKycGate(user);
    if (gate.blocked) return res.status(gate.code).json(gate.body);
  }

  if (expected_role && user.role !== expected_role) {
    let errorMsg = '';
    if (expected_role === 'ADMIN' || user.role === 'ADMIN') {
      errorMsg = 'This account is not registered as an administrator.';
    } else if (user.role === 'CUSTOMER') {
      errorMsg = 'This account is registered as a customer. Please use the Customer App.';
    } else if (user.role === 'STOCKIST') {
      errorMsg = 'This account is registered as a shopkeeper. Please use the Stockist App.';
    } else if (user.role === 'PARTNER_ADMIN') {
      errorMsg = 'This account is registered as a partner. Please use the Partner App.';
    } else {
      errorMsg = 'Access denied for this role.';
    }
    return res.status(403).json({ error: errorMsg });
  }

  if (user.is_active === false) {
    return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });
  }

  clearOtpRateLimit(identifier);
  const token = sessionHelper.signSession(user.id, user.role);
  return res.json({ success: true, token, user: sanitizeUser(user) });
};

app.post('/api/auth/verify-otp', handleVerifyOtpRoute);
app.post('/api/stockist/auth/verify-otp', handleVerifyOtpRoute);

app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Empty token' });

  let decoded;
  try {
    decoded = sessionHelper.verifySession(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === decoded.userId);

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (user.is_active === false) {
    return res.status(401).json({ error: 'Account is deactivated' });
  }

  if (user.role === 'STOCKIST') {
    const gate = stockistKycGate(user);
    if (gate.blocked) {
      return res.status(401).json({ error: gate.body.error || 'Stockist not approved' });
    }
  }

  const newToken = sessionHelper.signSession(user.id, user.role);
  return res.json({ success: true, token: newToken, user: sanitizeUser(user) });
});




// Register new Customer with Referral Code
app.post('/api/customer/register-with-referral', async (req, res) => {
  let { phone, email, name, address, cable_partner_id, broadband_partner_id, referral_code } = req.body;
  const regionId = req.body.region_id || req.body.regionId;

  if (!phone || !name || !regionId) {
    return res.status(400).json({ error: 'Name, phone, and region are required' });
  }

  const isTest = require('./lib/env').isTestEnv();
  if (!checkTermsAgreed(req, res, isTest)) return;
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;
  
  const validEmail = await checkEmail(email, res);
  if (!validEmail) return;

  const users = await db.getTable('users');
  if (users.some(u => u.kyc_status !== 'RELEASED' && u.phone === phone)) {
    return res.status(400).json({ error: 'An account with this phone number already exists' });
  }

  let referrerId = null;
  if (referral_code && referral_code.trim()) {
    const trimmedCode = referral_code.trim().toUpperCase();
    const referrer = users.find(u => u.referral_code && u.referral_code.toUpperCase() === trimmedCode);
    if (!referrer) {
      return res.status(400).json({ error: 'invalid_referral_code', message: 'Invalid referral code' });
    }
    referrerId = referrer.id;
  }

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  if (cable_partner_id) {
    const cp = partners.find(p => p.id === cable_partner_id && p.is_active !== false);
    const cpServes = cp && partnerRegions.some(pr => pr.partner_id === cable_partner_id && pr.region_id === regionId && pr.service_type === 'CABLE' && pr.is_active !== false);
    if (!cp || !cpServes) {
      return res.status(400).json({ error: 'invalid_partner_binding', field: 'cable_partner_id', message: 'Cable partner invalid or does not serve region' });
    }
  }

  if (broadband_partner_id) {
    const bp = partners.find(p => p.id === broadband_partner_id && p.is_active !== false);
    const bpServes = bp && partnerRegions.some(pr => pr.partner_id === broadband_partner_id && pr.region_id === regionId && pr.service_type === 'BROADBAND' && pr.is_active !== false);
    if (!bp || !bpServes) {
      return res.status(400).json({ error: 'invalid_partner_binding', field: 'broadband_partner_id', message: 'Broadband partner invalid or does not serve region' });
    }
  }

  const newUserData = {
    id: 'u-' + generateId(),
    tenant_id: 't1',
    region_id: regionId,
    phone,
    email: validEmail,
    name,
    role: 'CUSTOMER',
    kyc_status: 'APPROVED',
    no_show_count: 0,
    address: address || '',
    referred_by_user_id: referrerId,
    referral_bonus_paid: false,
    terms_accepted_at: req.body.termsAgreed ? new Date().toISOString() : null,
    terms_version: req.body.termsAgreed ? '2026-10-draft' : null,
    created_at: new Date().toISOString()
  };

  const user = await db.insertRow('users', newUserData);

  let bindings = null;
  if (cable_partner_id || broadband_partner_id) {
    const now = new Date().toISOString();
    bindings = await db.insertRow('customer_partner_bindings', {
      id: 'cpb-' + generateId(),
      customer_user_id: user.id,
      cable_partner_id: cable_partner_id || null,
      broadband_partner_id: broadband_partner_id || null,
      created_at: now,
      updated_at: now
    });
    await appendAudit(req, 'CREATE_PARTNER_BINDING', 'customer_partner_binding', user.id, null, bindings);
  }

  await appendAudit(req, 'REGISTER_CUSTOMER', 'user', user.id, null, { phone: user.phone, name: user.name, role: 'CUSTOMER', terms_accepted_at: user.terms_accepted_at, terms_version: user.terms_version });

  const sessionHelper = require('./lib/session');
  const token = sessionHelper.signSession(user.id, user.role);

  const resObj = { success: true, token, user: sanitizeUser(user), referral_code: user.referral_code };
  if (bindings) resObj.bindings = bindings;
  return res.json(resObj);
});

function hasValidKycSignature(req) {
  const { expires, sig } = req.query;
  if (!expires || !sig) return false;
  if (!/^\d+$/.test(expires)) return false;
  if (!/^[a-f0-9]{64}$/.test(sig)) return false;
  if (Date.now() > Number(expires)) return false;
  const crypto = require('crypto');
  const sessionHelper = require('./lib/session');
  const expected = crypto.createHmac('sha256', sessionHelper.getSecret()).update(req.path + ':' + expires).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(sig, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// Serve KYC document photo
app.get('/api/kyc/documents/:filename', async (req, res, next) => {
  if (hasValidKycSignature(req)) {
    req.kycSigned = true;
    return next();
  }
  requireAuth(req, res, next);
}, async (req, res) => {
  const filename = req.params.filename;
  
  // Verify ownership
  if (!req.kycSigned) {
    let ownerId = null;
    const match = filename.match(/^kyc_([^_]+)_/);
    if (match) {
      ownerId = match[1];
    } else {
      const users = await db.getTable('users');
      const owner = users.find(u => {
        if (u.kyc_details && typeof u.kyc_details === 'string') {
          return u.kyc_details.includes(filename);
        } else if (u.kyc_details && u.kyc_details.document_photo_url) {
          return u.kyc_details.document_photo_url.includes(filename);
        } else if (u.document_photo_url) {
          return u.document_photo_url.includes(filename);
        }
        return false;
      });
      if (owner) ownerId = owner.id;
    }

    if (req.user.role !== 'ADMIN' && req.user.userId !== ownerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ext === '.pdf' ? 'application/pdf' : 'image/jpeg';
  const filepath = path.join(__dirname, 'uploads', 'kyc', filename);
  if (fs.existsSync(filepath)) {
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(filepath);
  }
  const tmpPath = path.join('/tmp/kyc-uploads', filename);
  if (fs.existsSync(tmpPath)) {
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(tmpPath);
  }
  return res.status(404).json({ error: 'KYC document photo not found' });
});

// Register new Stockist (PENDING KYC)
app.post('/api/auth/register-stockist', uploadBillMiddleware, async (req, res) => {
  let phone = req.body.phone;
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;

  const name = req.body.name;
  const email = req.body.email;
  const shopName = req.body.shopName || req.body.shop_name;
  const regionId = req.body.regionId || req.body.region_id;
  const idType = req.body.idType || req.body.id_type || req.body.kyc_id_type;
  const idNumber = req.body.idNumber || req.body.id_number || req.body.kyc_id_number;
  const address = req.body.address || req.body.shop_address;
  if (!phone || !name || !shopName || !regionId || !idType || !idNumber || !address) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const validEmail = await checkEmail(email, res);
  if (!validEmail) return;

  // 1. Prepare ID number format
  const normIdType = String(idType || '').toUpperCase();
  let cleanIdNumber = idNumber;
  if (normIdType.includes('AADHAAR') || normIdType.includes('AADHAR')) {
    cleanIdNumber = String(idNumber || '').replace(/\D/g, '');
    if (cleanIdNumber.length !== 12) {
      return res.status(400).json({ error: 'Aadhaar must be 12 digits' });
    }
  } else if (normIdType.includes('PAN')) {
    cleanIdNumber = String(idNumber || '').trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanIdNumber)) {
      return res.status(400).json({ error: 'Enter a valid 10-character PAN (e.g. ABCDE1234F)' });
    }
  } else if (normIdType.includes('VOTER')) {
    cleanIdNumber = String(idNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(cleanIdNumber)) {
      return res.status(400).json({ error: 'Voter ID must be 10 letters and digits' });
    }
  } else if (normIdType.includes('DRIV')) {
    cleanIdNumber = String(idNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,16}$/.test(cleanIdNumber)) {
      return res.status(400).json({ error: 'Driving licence must be up to 16 letters and digits' });
    }
  } else {
    cleanIdNumber = String(idNumber || '').trim();
    if (!cleanIdNumber || cleanIdNumber.length > 20) {
      return res.status(400).json({ error: 'Document ID must be up to 20 characters' });
    }
  }

  const users = await db.getTable('users');
  const existingUser = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === phone);
  if (existingUser && existingUser.role === 'STOCKIST') {
    return res.status(400).json({ error: 'This phone number is already registered as a stockist. Use a different number.' });
  }

  const userId = 'u-' + generateId();
  let documentPhotoUrl = req.body.documentPhotoUrl || req.body.document_photo_url || null;

  const docFile = req.file || (req.files && (
    (req.files['documentPhoto'] && req.files['documentPhoto'][0]) ||
    (req.files['document_photo'] && req.files['document_photo'][0])
  ));

  if (docFile) {
    const timestamp = Math.floor(Date.now() / 1000);
    const filename = `${userId}_${idType}_${timestamp}.jpg`;
    const kycDir = path.join(__dirname, 'uploads', 'kyc');
    try {
      if (!fs.existsSync(kycDir)) {
        fs.mkdirSync(kycDir, { recursive: true });
      }
      fs.writeFileSync(path.join(kycDir, filename), docFile.buffer);
      documentPhotoUrl = `/api/kyc/documents/${filename}`;
    } catch (e) {
      console.error('Failed to save KYC upload file locally:', e);
    }
    try {
      if (r2.isR2Configured()) {
        const uploadRes = await r2.uploadBillPhoto(docFile.buffer, docFile.mimetype || 'image/jpeg', `kyc-docs/${userId}`);
        if (uploadRes && uploadRes.publicUrl) {
          if (r2.isR2Configured() && !r2.isMockMode()) {
            documentPhotoUrl = uploadRes.publicUrl;
          }
        }
      }
    } catch (e) {
      // fallback to local path
    }
  }

  const user = {
    id: userId,
    tenant_id: 't1',
    region_id: regionId,
    phone,
    email: validEmail,
    name,
    role: 'STOCKIST',
    kyc_status: 'PENDING',
    no_show_count: 0,
    kyc_details: {
      id_type: idType,
      id_number: cleanIdNumber,
      shop_name: shopName,
      shop_address: address,
      document_photo_url: documentPhotoUrl
    },
    address,
    created_at: new Date().toISOString(),
    registration_ip: req.ip || req.connection.remoteAddress
  };

  let flags = [];
  try {
    flags = await evaluateRegistrationFlags(user, user.registration_ip);
  } catch (err) {
    if (err.message === 'BLACKLIST_BLOCK') {
      return res.status(403).json({ error: 'This application cannot be processed. Contact support.' });
    }
    console.error('Flag evaluation error:', err);
  }

  users.push(user);
  await db.saveTable('users', users);

  if (flags.length > 0) {
    const regFlags = (await db.getTable('registration_flags')) || [];
    for (const f of flags) {
      f.created_at = new Date().toISOString();
      regFlags.push(f);
    }
    await db.saveTable('registration_flags', regFlags);
  }

  // Also seed a stockist record for this user so admin stockist lists work seamlessly
  const stockists = await db.getTable('stockists');
  if (!stockists.some(s => s.user_id === userId || (s.contact_phone && s.contact_phone === phone) || (s.phone && s.phone === phone))) {
    const stockistId = 's-' + generateId();
    stockists.push({
      id: stockistId,
      user_id: userId,
      name: shopName,
      region_id: regionId,
      contact_name: name,
      contact_phone: phone,
      phone: phone,
      is_active: true,
      opening_time: '09:00',
      closing_time: '21:00',
      created_at: new Date().toISOString()
    });
    await db.saveTable('stockists', stockists);
  }

  return res.json({
    success: true,
    message: 'Registration submitted. Awaiting admin approval.',
    user: sanitizeUser(user)
  });
});

// ----------------------------------------------------
// PRODUCT & INVENTORY ENDPOINTS
// ----------------------------------------------------

function getCustomerVisibleProducts(stockist, products) {
  if (!stockist || !Array.isArray(products)) return [];
  const stockistId = typeof stockist === 'object' && stockist !== null ? stockist.id : stockist;
  return products.filter(p =>
    p.stockist_id === stockistId &&
    !p.deleted_at &&
    p.is_active !== false &&
    p.is_sellable !== false
  );
}

app.get('/api/products', async (req, res) => {
  const { regionId, stockistId } = req.query;
  const products = await db.getTable('products');
  const inventory = await db.getTable('stockist_inventory');

  let filtered;
  if (req.query.customer === 'true' && stockistId) {
    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === stockistId);
    if (regionId && (!stockist || stockist.region_id !== regionId)) {
      filtered = [];
    } else {
      filtered = getCustomerVisibleProducts(stockist || stockistId, products);
    }
  } else {
    filtered = products.filter(p => !p.deleted_at);
    if (req.query.customer === 'true') {
      filtered = filtered.filter(p => p.is_sellable !== false);
    }
    if (regionId) {
      filtered = filtered.filter(p => p.region_id === regionId);
    }
    if (stockistId) {
      filtered = filtered.filter(p => p.stockist_id === stockistId);
    }
  }

  if (stockistId) {
    const billPhotos = await db.getTable('product_bill_photos');
    filtered = filtered.map(p => {
      const inv = inventory.find(i => i.stockist_id === stockistId && i.product_id === p.id);
      let rejectionReason = null;
      if (p.is_sellable === false) {
        const rejectedBill = billPhotos.find(b => b.product_id === p.id && b.bill_status === 'REJECTED');
        if (rejectedBill) rejectionReason = rejectedBill.rejection_reason;
      }
      return {
        ...p,
        stock_qty: inv ? inv.stock_qty : 0,
        is_available: inv ? inv.is_available : false,
        rejection_reason: rejectionReason
      };
    });
  }

  filtered = await Promise.all(filtered.map(async p => {
    let estimated_points = null;
    if (p.cost_price !== undefined && p.cost_price !== null) {
      const margin = Math.max(0, p.price - p.cost_price);
      if (margin > 0) {
        const cfg = await getCommissionConfig(p.stockist_id);
        const reinvestPct = parseFloat(cfg?.stockist_reinvest_pct) || 50;
        const pointsPct = parseFloat(cfg?.points_from_pot_pct) || 40;
        const platformPot = margin - (margin * reinvestPct / 100);
        estimated_points = Math.round(platformPot * (pointsPct / 100) * 100) / 100;
      } else {
        estimated_points = 0;
      }
    }
    return {
      ...p,
      estimated_points
    };
  }));

  return res.json(filtered);
});

const handleCreateProductRoute = async (req, res) => {
  if (req.headers['x-r2-mock'] === 'false' || !r2.isR2Configured()) {
    return res.status(503).json({ error: 'r2_not_configured', message: 'Bill upload service unavailable' });
  }

  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > cfg.PRODUCT_NAME_MAX_LENGTH) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid name', fields: { name: `non-empty max ${cfg.PRODUCT_NAME_MAX_LENGTH}` } });
  }

  const billUrl = req.body.bill_invoice_url || req.body.bill_photo_url || req.body.billPhotoUrl || req.body.bill_photo;

  // If content-type is JSON or no req.file present and no billUrl:
  if (!req.file && !billUrl) {
    return res.status(400).json({
      error: 'bill_photo_required',
      message: "New SKUs require a bill photo. Send as multipart/form-data with a 'bill_photo' file field."
    });
  }

  // Validate file MIME if file present
  if (req.file) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: 'invalid_file_type',
        message: 'Only JPG, PNG, and WebP bill photos are allowed.'
      });
    }

    // Validate file size (8MB)
    if (req.file.size > 8 * 1024 * 1024) {
      return res.status(400).json({
        error: 'file_too_large',
        message: 'Bill photo exceeds 8 MB limit.'
      });
    }
  }

  const price = req.body.price !== undefined ? req.body.price : req.body.selling_price;
  const costPrice = req.body.costPrice !== undefined ? req.body.costPrice : req.body.cost_price;
  const category = req.body.category || 'groceries';
  const initialStock = req.body.initialStock !== undefined ? req.body.initialStock : (req.body.stock_qty !== undefined ? req.body.stock_qty : req.body.initial_stock);
  const callerStockist = await getCallerStockist(req);
  const stockistId = (callerStockist && callerStockist.id) || req.body.stockistId || req.body.stockist_id || (req.user && req.user.id) || 's1';
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  const regionId = req.body.regionId || req.body.region_id || (req.user && req.user.region_id) || 'r1';
  const description = req.body.description;
  const imageUrl = req.body.image_url;

  if (price === undefined || initialStock === undefined || !stockistId || !regionId) {
    return res.status(400).json({ error: 'Missing product fields' });
  }

  const parsedPrice = Number(price);
  const parsedCostPrice = costPrice !== undefined ? Number(costPrice) : parsedPrice * 0.75;
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice > cfg.PRODUCT_PRICE_MAX_RUPEES) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid price', fields: { price: `must be > 0 and <= ${cfg.PRODUCT_PRICE_MAX_RUPEES}` } });
  }
  if (!Number.isFinite(parsedCostPrice) || parsedCostPrice < 0 || parsedCostPrice > parsedPrice) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid cost price', fields: { costPrice: 'must be >= 0 and <= price' } });
  }
  const initialStockNum = parseInt(initialStock, 10);
  if (!Number.isInteger(initialStockNum) || initialStockNum < 0 || initialStockNum > cfg.PRODUCT_STOCK_MAX) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid stock', fields: { stock: `integer >= 0 and <= ${cfg.PRODUCT_STOCK_MAX}` } });
  }

  // Upload bill to R2
  let uploadRes = { key: 'mock-bill-key', publicUrl: billUrl || 'http://localhost/mock-bill.jpg' };
  if (req.file) {
    try {
      uploadRes = await r2.uploadBillPhoto(req.file.buffer, req.file.mimetype, `bills/${stockistId}`);
    } catch (uploadErr) {
      return res.status(500).json({ error: 'upload_failed', message: uploadErr.message });
    }
  }

  const commissionRates = await db.getTable('commission_rates');
  const catConfig = commissionRates.find(c => c.category === category);
  const marginThreshold = catConfig && catConfig.margin_threshold_percent !== undefined ? parseFloat(catConfig.margin_threshold_percent) : 50.00;
  const marginPct = parsedPrice > 0 ? ((parsedPrice - parsedCostPrice) / parsedPrice) * 100 : 0;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === stockistId);
  const streak = stockist ? (stockist.verified_bill_streak || 0) : 0;
  let billStatus = (streak >= 5 && marginPct <= marginThreshold) ? 'VERIFIED' : 'PENDING';

  const billPhotos = await db.getTable('product_bill_photos');
  const billPhotoId = 'pbp-' + generateId();
  const productId = 'p-' + generateId();

  const billPhotoRow = {
    id: billPhotoId,
    product_id: productId,
    stockist_id: stockistId,
    r2_key: uploadRes.key,
    public_url: (r2.isR2Configured() && !r2.isMockMode()) ? uploadRes.publicUrl : `/api/bills/${uploadRes.key}`,
    selling_price_at_upload: parsedPrice,
    cost_price_at_upload: parsedCostPrice,
    file_size_bytes: req.file ? req.file.size : 0,
    content_type: req.file ? req.file.mimetype : 'image/jpeg',
    bill_status: billStatus,
    uploaded_at: new Date().toISOString(),
    uploaded_by_stockist_admin_id: req.body.uploaded_by || stockistId
  };

  billPhotos.push(billPhotoRow);
  await db.saveTable('product_bill_photos', billPhotos);

  let finalImageUrl = imageUrl;
  if (req.files) {
    const imgFile = (req.files['imageFile'] && req.files['imageFile'][0]) ||
                    (req.files['image'] && req.files['image'][0]) ||
                    (req.files['image_file'] && req.files['image_file'][0]);
    if (imgFile) {
      try {
        const imgUploadRes = await r2.uploadBillPhoto(imgFile.buffer, imgFile.mimetype, `product-images/${stockistId}`);
        finalImageUrl = `/api/images/${imgUploadRes.key}`;
      } catch (uploadErr) {
        console.error('Failed to upload product image file:', uploadErr);
      }
    }
  }

  const products = await db.getTable('products');
  const newProduct = {
    id: productId,
    tenant_id: 't1',
    region_id: stockist ? stockist.region_id : regionId,
    stockist_id: stockistId,
    name,
    category,
    price: parsedPrice,
    cost_price: parsedCostPrice,
    description: description !== undefined ? description : (name + ' added by local stockist'),
    image_url: finalImageUrl || null,
    latest_bill_photo_id: billPhotoId,
    created_at: new Date().toISOString()
  };

  products.push(newProduct);
  await db.saveTable('products', products);

  const inventory = await db.getTable('stockist_inventory');
  inventory.push({
    id: 'sinv-' + generateId(),
    stockist_id: stockistId,
    product_id: productId,
    stock_qty: parseInt(initialStock, 10),
    stock_quantity: parseInt(initialStock, 10),
    is_available: parseInt(initialStock, 10) > 0,
    created_at: new Date().toISOString()
  });
  await db.saveTable('stockist_inventory', inventory);
  
  newProduct.stock_qty = parseInt(initialStock, 10);
  newProduct.is_available = parseInt(initialStock, 10) > 0;

  return res.json({ success: true, product_id: productId, product: newProduct, bill_photo: billPhotoRow });
};

app.post('/api/products', requireAuth, uploadBillMiddleware, handleCreateProductRoute);
app.post('/api/stockist/products', requireAuth, uploadBillMiddleware, handleCreateProductRoute);

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const products = await db.getTable('products');
  const user = req.user;
  
  const product = products.find(p => p.id === id);
  if (!product) {
    return res.status(404).json({ error: 'product_not_found', message: 'Product not found' });
  }

  let isOwner = false;
  let isAdmin = user.role === 'ADMIN';

  if (user.role === 'STOCKIST') {
    const stockists = await db.getTable('stockists');
    const myShop = stockists.find(s => (s.phone === user.phone || s.user_id === user.id));
    if (myShop && myShop.id === product.stockist_id) {
      isOwner = true;
    }
  }

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not own this product' });
  }

  if (product.deleted_at) {
    return res.status(200).json({ message: 'Already deleted' });
  }

  const inventory = await db.getTable('stockist_inventory');
  const inv = inventory.find(i => i.product_id === product.id && i.stockist_id === product.stockist_id);
  const stockQty = inv ? inv.stock_qty : 0;

  await db.updateRow('products', product.id, { deleted_at: new Date().toISOString(), is_sellable: false });
  if (inv) {
    await db.updateRow('stockist_inventory', inv.id, { is_available: false });
  }

  await writeAdminAudit(user.id, 'DELETE_PRODUCT', {
    product_id: product.id,
    product_name: product.name,
    shop_id: product.stockist_id,
    stock_qty: stockQty
  });

  return res.status(200).json({ message: 'Product deleted successfully' });
});

app.patch('/api/products/:id', requireAuth, uploadBillMiddleware, async (req, res) => {
  const { id } = req.params;
  const stockistId = req.body.stockistId || req.body.stockist_id;
  if (stockistId && !await assertOwnsStockist(req, res, stockistId)) return;

  if (!stockistId) {
    return res.status(400).json({ error: 'Missing stockistId' });
  }
  if (!await assertOwnsStockist(req, res, stockistId)) return;

  // Ownership check
  const inventory = await db.getTable('stockist_inventory');
  const inv = inventory.find(i => i.product_id === id && i.stockist_id === stockistId);
  if (!inv) {
    return res.status(403).json({ error: 'Not the owning stockist' });
  }

  const products = await db.getTable('products');
  const product = products.find(p => p.id === id);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const reqPrice = req.body.price;
  const reqCostPrice = req.body.costPrice !== undefined ? req.body.costPrice : req.body.cost_price;

  const newPrice = reqPrice !== undefined ? parseFloat(reqPrice) : product.price;
  const newCostPrice = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : product.cost_price;

  if (newPrice <= 0) {
    return res.status(400).json({ error: 'Price must be greater than 0' });
  }
  if (newCostPrice < 0 || newCostPrice > newPrice) {
    return res.status(400).json({ error: 'Cost price must be between 0 and selling price' });
  }

  const priceChanged = Math.abs(newPrice - product.price) > 0.001 || Math.abs(newCostPrice - product.cost_price) > 0.001;

  if (priceChanged && !req.file) {
    return res.status(400).json({
      error: 'bill_required_for_price_change',
      message: 'Price change detected. A new bill photo is required.'
    });
  }

  let billPhotoRow = null;
  if (req.file) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: 'invalid_file_type',
        message: 'Only JPG, PNG, and WebP bill photos are allowed.'
      });
    }
    if (req.file.size > 8 * 1024 * 1024) {
      return res.status(400).json({
        error: 'file_too_large',
        message: 'Bill photo exceeds 8 MB limit.'
      });
    }

    if (!r2.isR2Configured()) {
      return res.status(503).json({ error: 'r2_not_configured', message: 'Bill upload service unavailable' });
    }

    let uploadRes;
    try {
      uploadRes = await r2.uploadBillPhoto(req.file.buffer, req.file.mimetype, `bills/${stockistId}`);
    } catch (uploadErr) {
      return res.status(500).json({ error: 'upload_failed', message: uploadErr.message });
    }

    const prodCategory = req.body.category !== undefined ? req.body.category : product.category;
    const commissionRates = await db.getTable('commission_rates');
    const catConfig = commissionRates.find(c => c.category === prodCategory);
    const marginThreshold = catConfig && catConfig.margin_threshold_percent !== undefined ? parseFloat(catConfig.margin_threshold_percent) : 50.00;
    const marginPct = newPrice > 0 ? ((newPrice - newCostPrice) / newPrice) * 100 : 0;

    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === stockistId);
    const streak = stockist ? (stockist.verified_bill_streak || 0) : 0;
    let billStatus = (streak >= 5 && marginPct <= marginThreshold) ? 'VERIFIED' : 'PENDING';

    const billPhotos = await db.getTable('product_bill_photos');
    billPhotoRow = {
      id: 'pbp-' + generateId(),
      product_id: id,
      stockist_id: stockistId,
      r2_key: uploadRes.key,
      public_url: (r2.isR2Configured() && !r2.isMockMode()) ? uploadRes.publicUrl : `/api/bills/${uploadRes.key}`,
      selling_price_at_upload: newPrice,
      cost_price_at_upload: newCostPrice,
      file_size_bytes: req.file.size,
      content_type: req.file.mimetype,
      bill_status: billStatus,
      uploaded_at: new Date().toISOString(),
      uploaded_by_stockist_admin_id: req.body.uploaded_by || stockistId
    };

    billPhotos.push(billPhotoRow);
    await db.saveTable('product_bill_photos', billPhotos);

    product.latest_bill_photo_id = billPhotoRow.id;
    product.is_sellable = true; // Restores sellability when new bill is uploaded
  }

  if (req.body.name !== undefined) product.name = req.body.name;
  if (req.body.description !== undefined) product.description = req.body.description;
  if (req.body.category !== undefined) product.category = req.body.category;
  if (req.body.image_url !== undefined) product.image_url = req.body.image_url;
  if (req.files) {
    const imgFile = (req.files['imageFile'] && req.files['imageFile'][0]) ||
                    (req.files['image'] && req.files['image'][0]) ||
                    (req.files['image_file'] && req.files['image_file'][0]);
    if (imgFile) {
      try {
        const imgUploadRes = await r2.uploadBillPhoto(imgFile.buffer, imgFile.mimetype, `product-images/${stockistId}`);
        product.image_url = `/api/images/${imgUploadRes.key}`;
      } catch (uploadErr) {
        console.error('Failed to upload product image file on edit:', uploadErr);
      }
    }
  }

  product.price = newPrice;
  product.cost_price = newCostPrice;

  await db.saveTable('products', products);

  return res.json({ success: true, product, bill_photo: billPhotoRow });
});

// GET /api/products/:id/bill-history
app.get('/api/products/:id/bill-history', requireAuth, async (req, res) => {
  const { id } = req.params;
  const products = await db.getTable('products');
  const product = products.find(p => p.id === id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!await assertOwnsStockist(req, res, product.stockist_id)) return;
  const billPhotos = await db.getTable('product_bill_photos');
  const history = billPhotos
    .filter(b => b.product_id === id)
    .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
  return res.json(history);
});

// --- ADMIN GATE ---
app.use('/api/admin', (req, res, next) => {
  const p = req.path;
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';

  // reset-db and override-table exist only in explicit test mode.
  if (p === '/reset-db' || p === '/override-table') {
    if (!require('./lib/env').isTestEnv()) return res.status(404).json({ error: 'Not found' });
    return next();
  }

  // Developer and Inspector endpoints gated in production
  if (p === '/insert-table' || p === '/inspector' || p.startsWith('/inspector/') || p.startsWith('/db-inspector')) {
    if (!isDevAllowed) return res.status(403).json({ error: 'Forbidden', message: 'Endpoint disabled in production' });
    if (require('./lib/env').isTestEnv()) return next();
  }

  if (p === '/clear-rate-limits' && require('./lib/env').isTestEnv()) {
    return next();
  }

  // Apply authentication
  requireAuth(req, res, (err) => {
    if (err) return next(err);

    // Partner admins may work the partner-leads queue. Everything else under
    // /api/admin (KYC documents, platform analytics, vendors, user accounts)
    // is admin-only.
    if (p.startsWith('/partner-leads')) {
      return requireRole('ADMIN', 'PARTNER_ADMIN')(req, res, next);
    }

    return requireRole('ADMIN')(req, res, next);
  });
});

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
    data: paginated
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

  return res.json({ success: true, bill, product });
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

  return res.json({ success: true, bill, product });
});

// POST /api/admin/bill-photos/:id/signed-url
app.post('/api/admin/bill-photos/:id/signed-url', async (req, res) => {
  const { id } = req.params;
  const billPhotos = await db.getTable('product_bill_photos');
  const bill = billPhotos.find(b => b.id === id);
  if (!bill) return res.status(404).json({ error: 'Bill photo not found' });

  try {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const signedUrl = await r2.getSignedReadUrl(bill.r2_key, 3600);
    return res.json({ signed_url: signedUrl, expires_at: expiresAt });
  } catch (err) {
    return res.status(500).json({ error: 'failed_signed_url', message: err.message });
  }
});

// GET /api/bills/* — serve mock bill image or redirect to signed URL
app.get('/api/bills/*', async (req, res) => {
  const rawKey = req.params[0];
  if (!rawKey) return res.status(404).json({ error: 'Bill photo key required' });
  const key = decodeURIComponent(rawKey);

  const isMock = process.env.R2_MOCK === 'true' || !process.env.R2_ACCOUNT_ID;
  if (isMock) {
    const item = r2.mockGet(key) || r2.mockGet(rawKey);
    if (!item) {
      return res.status(404).json({ error: 'Bill photo not found' });
    }
    res.setHeader('Content-Type', item.contentType || 'image/jpeg');
    return res.send(item.buffer);
  }

  try {
    const signedUrl = await r2.getSignedReadUrl(key, 3600);
    return res.redirect(signedUrl);
  } catch (err) {
    return res.status(404).json({ error: 'Bill photo not found', message: err.message });
  }
});

// GET /api/images/* — serve mock product image or redirect to signed URL
app.get('/api/images/*', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const defaultPlaceholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1e293b"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="16">Product Image</text></svg>`;

  const rawKey = req.params[0];
  if (!rawKey) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(200).send(defaultPlaceholderSvg);
  }
  const key = decodeURIComponent(rawKey);

  const isMock = process.env.R2_MOCK === 'true' || !process.env.R2_ACCOUNT_ID;
  if (isMock) {
    const item = r2.mockGet(key) || r2.mockGet(rawKey);
    if (!item) {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.status(200).send(defaultPlaceholderSvg);
    }
    res.setHeader('Content-Type', item.contentType || 'image/jpeg');
    return res.send(item.buffer);
  }

  try {
    const signedUrl = await r2.getSignedReadUrl(key, 3600);
    return res.redirect(signedUrl);
  } catch (err) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(200).send(defaultPlaceholderSvg);
  }
});

app.get('/api/products/search-alternatives', async (req, res) => {
  const { name, regionId, excludeStockistId } = req.query;
  if (!name || !regionId) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const products = await db.getTable('products');
  const inventory = await db.getTable('stockist_inventory');
  const stockists = await db.getTable('stockists');

  const similarProducts = products.filter(p => !p.deleted_at && p.region_id === regionId && p.name.toLowerCase().includes(name.toLowerCase()));

  const alternatives = [];
  similarProducts.forEach(p => {
    const invList = inventory.filter(i => i.product_id === p.id && i.stock_qty > 0 && i.stockist_id !== excludeStockistId);
    invList.forEach(inv => {
      const stockist = stockists.find(s => s.id === inv.stockist_id && s.is_active);
      if (stockist) {
        alternatives.push({ shopId: stockist.id, shopName: stockist.name, stockQty: inv.stock_qty, price: p.price });
      }
    });
  });

  return res.json(alternatives);
});

// ----------------------------------------------------
// STOCKIST ENDPOINTS
// ----------------------------------------------------

// OPEN/CLOSED RULE (Issue 6):
// If closing <= opening, the shop is treated as closing after midnight (overnight shop).
// An overnight shop (e.g. 22:00 to 02:00) is open if currentTime >= opening OR currentTime < closing.
// A daytime shop (e.g. 09:00 to 21:00) is open if currentTime >= opening AND currentTime < closing.
function calculateIsShopOpen(stockist, currentTimeStr) {
  if (stockist.manual_closed) {
    if (!stockist.closed_until || new Date() < new Date(stockist.closed_until)) {
      return false; // Manually closed and either indefinitely or until a future time
    }
  }

  if (!stockist.opening_time || !stockist.closing_time) return true;
  let closing = stockist.closing_time;
  if (closing === '24:00') closing = '23:59';
  const opening = stockist.opening_time;

  let currentTime = currentTimeStr;
  if (!currentTime) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    currentTime = istNow.getUTCHours().toString().padStart(2, '0') + ':' + 
                  istNow.getUTCMinutes().toString().padStart(2, '0');
  }

  if (closing <= opening) {
    return currentTime >= opening || currentTime < closing;
  }
  return currentTime >= opening && currentTime < closing;
}

function findStockistOwner(stockist, users) {
  if (!stockist || !Array.isArray(users)) return null;
  if (stockist.user_id) {
    return users.find(u => u.id === stockist.user_id && u.kyc_status !== 'RELEASED') || null;
  }
  const sPhone = (stockist.contact_phone || stockist.phone || '').trim();
  if (!sPhone) return null;
  return users.find(u => u.role === 'STOCKIST' && u.kyc_status !== 'RELEASED' && typeof u.phone === 'string' && u.phone.trim() !== '' && u.phone.trim() === sPhone) || null;
}

function getCustomerVisibility(stockist, users, products) {
  if (!stockist || stockist.is_active === false) {
    return { visible: false, reason: 'inactive' };
  }
  const owner = findStockistOwner(stockist, users);
  if (!owner) {
    return { visible: false, reason: 'KYC pending' };
  }
  if (owner.is_active === false) {
    return { visible: false, reason: 'owner deactivated' };
  }
  if (owner.kyc_status !== 'APPROVED') {
    return { visible: false, reason: 'KYC pending' };
  }
  if (products && Array.isArray(products)) {
    const shopProducts = getCustomerVisibleProducts(stockist, products);
    if (shopProducts.length === 0) {
      return { visible: false, reason: 'no products' };
    }
  }
  return { visible: true, reason: null };
}

const isCustomerVisible = (stockist, users, products) => {
  return getCustomerVisibility(stockist, users, products).visible;
};

async function setMainWholesaler(stockistId, vendorId) {
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === stockistId);
  if (!stockist) return null;

  stockist.vendor_id = vendorId;
  await db.saveTable('stockists', stockists);

  if (vendorId) {
    const stockistVendors = await db.getTable('stockist_vendors');
    if (!stockistVendors.some(sv => sv.stockist_id === stockistId && sv.vendor_id === vendorId)) {
      stockistVendors.push({
        id: 'sv-' + generateId(),
        stockist_id: stockistId,
        vendor_id: vendorId,
        approved_at: new Date().toISOString()
      });
      await db.saveTable('stockist_vendors', stockistVendors);
    }
  }

  return stockist;
}

function getRegionDeliveryFee(regionRow) {
  if (!regionRow || regionRow.delivery_fee === null || regionRow.delivery_fee === undefined) return null;
  const val = parseFloat(regionRow.delivery_fee);
  if (isNaN(val) || !isFinite(val) || val < 0) return null;
  return val;
}


// PATCH /api/stockist/profile - Stockist self-editable settings (TESTER-47)
async function resolveStockistRate(stockistId) {
  const rates = await db.getTable('stockist_commission_rates');
  const stkRates = rates.filter(r => r.stockist_id === stockistId);
  return stkRates.length > 0 ? stkRates[stkRates.length - 1].rate_percent : 10.0;
}

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

    return { ...s, reliabilityBadge, product_count: shopProducts.length, is_shop_open: calculateIsShopOpen(s) };
  });

  return res.json(enriched);
});

app.get('/api/stockists/by-user/:userId', async (req, res) => {
  const { userId } = req.params;
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
  if (!await assertOwnsStockist(req, res, id)) return;
  const stockists = await db.getTable('stockists');
  const users = await db.getTable('users');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist || !isCustomerVisible(stockist, users)) return res.status(404).json({ error: 'Stockist not found' });
  return res.json({
    ...stockist,
    is_shop_open: calculateIsShopOpen(stockist)
  });
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

// ----------------------------------------------------
// ORDER & PAYMENT SPLIT ENDPOINTS
// ----------------------------------------------------

// Helper: Settlement Engine
// Helper: Get Commission Config (STORE first, GLOBAL fallback)
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
async function calculateSettlement(subtotal, totalProfitMargin, stockistId, regionId) {
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
  let changed = false;

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
      changed = true;
    }
  }

  const existingCoupon = ledger.find(l => l.order_id === orderId && l.type === 'REDEEM' && l.redemption_type === 'COUPON');
  if (existingCoupon) {
    const alreadyCouponReversed = ledger.some(l => l.order_id === orderId && l.type === 'COUPON_REVERSAL');
    if (!alreadyCouponReversed) {
      await db.insertRow('points_ledger', {
        id: 'l-' + generateId(),
        tenant_id: existingCoupon.tenant_id || 't1',
        region_id: existingCoupon.region_id || 'r1',
        customer_id: existingCoupon.customer_id,
        amount: Math.abs(existingCoupon.amount),
        type: 'COUPON_REVERSAL',
        order_id: orderId,
        description: `Coupon points returned: cancelled order #${orderId.substring(2).toUpperCase()}`,
        created_at: new Date().toISOString(),
        billing_sync_status: 'PENDING'
      });
      changed = true;
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

  if (order.payment_status === 'HELD') {
    const splitPayouts = await db.getTable('split_payouts');
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

  return {
    ...o,
    pickup_pin: strippedPin,
    commission_model: o.commission_model || 'gross_v1',
    items,
    pointsCredited: o.points_credited !== undefined ? o.points_credited : 0,
    points_credited: o.points_credited !== undefined ? o.points_credited : 0,
    platform_commission: platformCommission,
    stockist_payout: stockistPayout,
    earnRatePercent: o.earn_rate_used !== undefined ? o.earn_rate_used : 40,
    earn_rate_used: o.earn_rate_used !== undefined ? o.earn_rate_used : 40,
    margin: o.margin !== undefined ? o.margin : (o.subtotal * 0.25),
    customer_name: customer ? customer.name : 'Unknown Subscriber',
    customer_phone: customer ? customer.phone : '',
    stockist_amount: stockistPayout,
    platform_amount: platformPayout,
    stockist_reviewed: !!stockistFeedback,
    stockist_upi_id: stockist ? (stockist.upi_id || stockist.payout_upi_id || null) : null,
    payment_received_method: o.payment_received_method || null,
    paid_at: o.paid_at || null,
    amount_paid: o.amount_paid !== undefined && o.amount_paid !== null ? o.amount_paid : o.total_price,
    points_status: (await db.getTable('points_ledger')).some(l => l.order_id === o.id && l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD') ? 'HELD' : 'CREDITED'
  };
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

// POST /api/orders & /api/orders/create — multi-store aware, slot-required, HELD payment, CONFIRMING state
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
    // Default PAY_AT_HANDOVER → UNPAID. COD → COD. Online gateway → HELD.
    const effectivePaymentMethod = reqPaymentMethod;
    const paymentStatus = effectivePaymentMethod === 'PAY_AT_HANDOVER'
      ? 'UNPAID'
      : (effectivePaymentMethod?.includes('COD') ? 'COD' : 'HELD');

    // Stock deduction removed here. It now happens when the order is marked READY.

    const orderId = 'o-' + generateId();
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
      razorpay_order_id: (effectivePaymentMethod === 'PAY_AT_HANDOVER' || effectivePaymentMethod?.includes('COD')) ? null : ('rzp_order_' + generateId()),
      razorpay_payment_id: (effectivePaymentMethod === 'PAY_AT_HANDOVER' || effectivePaymentMethod?.includes('COD')) ? null : ('rzp_pay_' + generateId()),
      split_released: false,
      coupon_reward_id: couponRewardId || null,
      coupon_name: reward ? reward.name : null,
      coupon_discount: couponDiscount,
      coupon_points_spent: couponPointsSpent,
      amount_paid: amountPaid,
      created_at: now.toISOString()
    };

    preparedOrders.push({ order, orderItems, stockistPayout, platformPayout, settlement, effectivePaymentMethod, paymentStatus, couponDiscount, couponPointsSpent });
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
        status: paymentStatus === 'HELD' ? 'HELD' : 'PENDING_COD',
        coupon_cost: couponDiscount,
        created_at: now.toISOString()
      });
    }

    // Payment ledger event
    appendPaymentEvent(orderId, effectivePaymentMethod === 'PAY_AT_HANDOVER' ? 'PAY_AT_HANDOVER_ORDER_CREATED' : (paymentStatus === 'COD' ? 'COD_ORDER_CREATED' : 'HELD'), order.amount_paid, {
      method: effectivePaymentMethod,
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
  }

  try {
    const allSubs = await db.getTable('stockist_push_subscriptions');
    let subsUpdated = false;
    for (const order of createdOrders) {
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

  return res.json({
    success: true,
    cart_id: cartId,
    orders: createdOrders,
    // Backwards compat: expose first order's id/points for single-store clients
    orderId: createdOrders[0].id,
    pointsCredited: createdOrders.reduce((sum, o) => sum + (o.points_credited || 0), 0),
    totalPointsCredited: createdOrders.reduce((sum, o) => sum + (o.points_credited || 0), 0),
    margin: createdOrders[0].margin,
    earnRatePercent: createdOrders[0].earn_rate_used,
    order: createdOrders[0]
  });
};
app.post('/api/orders', requireAuth, handleCreateOrderRoute);
app.post('/api/orders/create', requireAuth, handleCreateOrderRoute);

// Cancel an order — enforces cancel window
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
  const { pin } = req.body;

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

  return res.json({ success: true, order: await enrichOrder(order, req) });
});

// Internal: process referral bonus on first delivered order
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
        region_id: referrer.region_id || customer.region_id || 'r1',
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
        region_id: customer.region_id || 'r1',
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
    const itemCount = orderItems.reduce((sum, item) => sum + (item.quantity || 1), 0) || (order.items ? order.items.length : 1);
    const total = order.total_amount || order.subtotal || 0;
    const etaTime = order.pickup_slot || 'scheduled time';

    const body = `Beniffy: Order ${order.id} confirmed at ${stockistName}, ${itemCount} items, ₹${total}. Ready by ${etaTime}. Track in app.`;
    await smsHelper.sendSms(phone, body);

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

    const body = `Beniffy: Your order ${order.id} is ready for pickup at ${stockistName}. PIN: ${pickupPin}. Please collect within 24h.`;
    await smsHelper.sendSms(phone, body);

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

// Get orders

// Web Push VAPID Key
app.get('/api/config/vapid', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Save Push Subscription
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

// Acknowledge Order
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

  // For stockist view: transition CONFIRMING→PENDING in DB if window has closed
  if (stockistId && !customerId) {
    const now = new Date();
    // Transition CONFIRMING→PENDING in DB if window has closed
    const allOrders = await db.getTable('orders');
    let changed = false;
    allOrders.forEach(o => {
      if (o.status === 'CONFIRMING' && o.stockist_id === stockistId && new Date(o.cancel_deadline) <= now) {
        o.status = 'PENDING';
        changed = true;
      }
    });
    if (changed) await db.saveTable('orders', allOrders);
  }

  const enriched = (await Promise.all(filtered.map(o => enrichOrder(o, req)))).reverse();
  return res.json(enriched);
});

// Update Order Status (also used for each entry of the offline sync)
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
    return res.status(400).json({ error: `Order is already ${order.status.toLowerCase()}.`, code: 'ORDER_FINAL' });
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
            inv.stock_qty -= parseInt(oi.quantity, 10);
            inv.stock_quantity = inv.stock_qty;
            inv.is_available = inv.stock_qty > 0;
            await db.updateRow('stockist_inventory', inv.id, inv);
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

    // Release split if HELD
    if (order.payment_status === 'HELD' && !order.split_released) {
      // Auto-release on delivery (can also be done manually by admin)
    }
  }

  return res.json({ success: true, order: await enrichOrder(order, req) });
};
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

// Offline sync
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

  if (order.payment_status !== 'HELD') {
    return res.status(400).json({ error: 'Order is not in HELD state. Cannot release.' });
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

  order.payment_status = 'REFUNDED';
  await db.saveTable('orders', orders);

  appendPaymentEvent(id, 'REFUNDED', refundAmount, { net_refund: refundAmount });

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
  
  const payouts = [];
  
  for (const sp of splitPayouts) {
    if (sp.is_cod) continue;
    payouts.push({
      id: sp.id,
      source: 'split_payouts',
      direction: 'OUTGOING',
      order_id: sp.order_id,
      stockist_id: sp.stockist_id,
      stockist_name: stockists.find(s => s.id === sp.stockist_id)?.name || 'Unknown',
      amount: parseFloat(sp.stockist_amount),
      type: 'ORDER_SPLIT',
      status: sp.status,
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

  for (const p of payouts) {
    if (p.source === 'split_payouts') {
      const sp = splitPayouts.find(s => s.id === p.id);
      if (sp && !sp.is_paid) {
        sp.is_paid = true;
        sp.paid_at = now;
        sp.paid_by_admin_id = user.id;
        sp.payment_reference = payment_reference;
        modifiedSplit = true;
        modifiedAudit = true;
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

  return res.json({ success: true });
});

// ----------------------------------------------------
// POINTS LEDGER & REDEMPTION ENDPOINTS
// ----------------------------------------------------

app.get('/api/ledger/balance/:customerId', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  const ledger = await db.getTable('points_ledger');
  const customerLedger = ledger.filter(l => l.customer_id === customerId);
  
  const activeBalance = customerLedger
    .filter(l => l.type !== 'EARN_HELD')
    .reduce((sum, item) => sum + parseFloat(item.amount), 0);
    
  const heldBalance = customerLedger
    .filter(l => l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD')
    .reduce((sum, item) => sum + parseFloat(item.amount), 0);

  return res.json({ 
    balance: Math.round(activeBalance * 100) / 100,
    held_balance: Math.round(heldBalance * 100) / 100
  });
});

app.get('/api/ledger/history/:customerId', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  const ledger = await db.getTable('points_ledger');
  const customerLedger = ledger.filter(l => l.customer_id === customerId).reverse();
  return res.json(customerLedger);
});

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

app.post('/api/ledger/redeem', requireAuth, async (req, res) => {
  const customerId = req.body.customerId || req.body.customer_user_id;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  const { redemptionType, partner_package_id, generic_reward_id } = req.body;
  // Number("abc") is NaN, which slips past a plain "<= 0" check.
  const amount = (typeof req.body.amount === 'number' || (typeof req.body.amount === 'string' && req.body.amount.trim() !== ''))
    ? Number(req.body.amount)
    : NaN;
  if (!customerId || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid redemption parameters' });
  }

  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const partnerPackages = await db.getTable('partner_packages');
  let pkg = null;

  if (generic_reward_id) {
    return res.status(400).json({ error: 'use_checkout_coupon', message: 'Generic rewards are applied as coupons at checkout.' });
  } else if (partner_package_id) {
    pkg = partnerPackages.find(p => p.id === partner_package_id);
    if (!pkg || pkg.status === 'INACTIVE' || pkg.is_active === false) {
      return res.status(404).json({ error: 'Package missing or inactive' });
    }

    // Customer binding check
    const bindings = await db.getTable('customer_partner_bindings');
    const customerBindings = bindings.filter(b => b.customer_user_id === customerId || b.customer_id === customerId);
    let isBound = false;
    const pkgStLower = (pkg.service_type || '').toLowerCase();
    for (const b of customerBindings) {
      if (pkgStLower === 'cable' && (b.cable_partner_id === pkg.partner_id || (b.service_type?.toLowerCase() === 'cable' && b.partner_id === pkg.partner_id))) {
        isBound = true;
      }
      if (pkgStLower === 'broadband' && (b.broadband_partner_id === pkg.partner_id || (b.service_type?.toLowerCase() === 'broadband' && b.partner_id === pkg.partner_id))) {
        isBound = true;
      }
      if (b.partner_id === pkg.partner_id && (!b.service_type || b.service_type.toLowerCase() === pkgStLower)) {
        isBound = true;
      }
    }
    if (!isBound) {
      return res.status(400).json({ error: 'binding_mismatch', code: 'binding_mismatch' });
    }

    // Amount match check
    if (amount && parseFloat(amount) !== parseFloat(pkg.point_cost)) {
      return res.status(400).json({ error: 'amount_mismatch' });
    }

    // Duration lock check for all packages (fallback to 30 days if untimed)
    const effectiveDuration = (pkg.duration_days && Number(pkg.duration_days) > 0) ? Number(pkg.duration_days) : 30;
    if (true) {
      const activeStatuses = ['PENDING_ADMIN_APPROVAL', 'APPROVED', 'APPROVED_AWAITING_PARTNER', 'DISPUTED', 'FULFILLED'];
      const redemptions = await db.getTable('redemption_approvals');
      const lastRedemption = redemptions
        .filter(r => (r.customer_user_id === customerId || r.customer_id === customerId) && r.partner_package_id === partner_package_id)
        .filter(r => activeStatuses.includes(r.status))
        .sort((a, b) => new Date(b.redeemed_at || b.created_at) - new Date(a.redeemed_at || a.created_at))[0];

      if (lastRedemption) {
        const nextAllowedIso = lastRedemption.next_redemption_allowed_at ||
          (lastRedemption.redeemed_at ? new Date(new Date(lastRedemption.redeemed_at).getTime() + (effectiveDuration * 24 * 60 * 60 * 1000)).toISOString() : null);

        if (nextAllowedIso) {
          const now = new Date();
          if (now < new Date(nextAllowedIso)) {
            const daysLeft = Math.ceil((new Date(nextAllowedIso) - now) / (1000 * 60 * 60 * 24));
            return res.status(400).json({
              error: 'Already redeemed',
              message: `Available again in ${daysLeft} days`,
              available_at: nextAllowedIso
            });
          }
        }
      }
    }
  } else {
    // Legacy generic path validation
    const ALLOWED_REDEMPTION_TYPES = ['BROADBAND_DISCOUNT', 'BROADBAND_DISCOUNT_50', 'BROADBAND_DISCOUNT_100', 'WIFI_TOPUP', 'DATA_TOPUP', 'CABLE_RECHARGE'];
    if (!redemptionType || !ALLOWED_REDEMPTION_TYPES.includes(redemptionType)) {
      return res.status(400).json({ error: 'Invalid redemption type.' });
    }
    // Fixed-value rewards cost exactly their value (1 point = ₹1); only the
    // plain BROADBAND_DISCOUNT lets the customer choose the amount.
    const FIXED_REDEMPTION_COSTS = {
      BROADBAND_DISCOUNT_50: [50],
      BROADBAND_DISCOUNT_100: [100],
      CABLE_RECHARGE: [100, 120, 250]
    };
    const fixedCosts = FIXED_REDEMPTION_COSTS[redemptionType];
    if (fixedCosts && !fixedCosts.includes(amount)) {
      return res.status(400).json({ error: 'amount_mismatch', message: `This reward costs ${fixedCosts.join(' or ')} points.` });
    }
  }

  const ledger = await db.getTable('points_ledger');
  const customerLedger = ledger.filter(l => l.customer_id === customerId);
  const currentBalance = customerLedger.filter(l => l.type !== 'EARN_HELD').reduce((sum, item) => sum + parseFloat(item.amount), 0);

  const reqAmount = pkg ? parseFloat(pkg.point_cost) : parseFloat(amount);

  if (currentBalance < reqAmount) {
    return res.status(400).json({ error: 'Insufficient points balance', code: 'INSUFFICIENT_POINTS' });
  }

  const redeemAmount = -Math.abs(reqAmount);
  const ledgerId = 'l-' + generateId();
  const pts = reqAmount;
  const pkgStUpper = pkg ? (pkg.service_type || '').toUpperCase() : '';
  const finalRedemptionType = pkg ? (pkgStUpper === 'GENERIC' ? 'GENERIC_REWARD' : (pkgStUpper === 'CABLE' ? 'CABLE_RECHARGE' : 'BROADBAND_DISCOUNT')) : redemptionType;
  const description = pkg ? `Reward Redemption: ${pkg.name}` : getRedemptionDescription(finalRedemptionType, pts);

  await db.insertRow('points_ledger', {
    id: ledgerId,
    tenant_id: customer.tenant_id,
    region_id: customer.region_id,
    customer_id: customer.id,
    amount: redeemAmount,
    type: 'REDEEM',
    redemption_type: finalRedemptionType,
    order_id: null,
    description,
    created_at: new Date().toISOString(),
    billing_sync_status: 'PENDING'
  });

  let approvalId = null;
  let approvalRow = null;
  if (pkg) {
    const redemptionApprovals = await db.getTable('redemption_approvals');
    approvalId = 'ra-' + generateId();
    const nowTime = new Date();
    const nowIso = nowTime.toISOString();
    let nextAllowedAt = null;
    if (pkg.service_type === 'generic') {
      if (pkg.cooldown_type === 'DAYS' && parseInt(pkg.cooldown_days, 10) > 0) {
        nextAllowedAt = new Date(nowTime.getTime() + (parseInt(pkg.cooldown_days, 10) * 24 * 60 * 60 * 1000)).toISOString();
      }
    } else {
      const effectiveDuration = (pkg.duration_days && Number(pkg.duration_days) > 0) ? Number(pkg.duration_days) : 30;
      nextAllowedAt = new Date(nowTime.getTime() + (effectiveDuration * 24 * 60 * 60 * 1000)).toISOString();
    }

    approvalRow = {
      id: approvalId,
      ledger_id: ledgerId,
      customer_user_id: customer.id,
      customer_id: customer.id,
      customer_name: customer.name || customer.phone || 'Customer',
      partner_id: pkg.partner_id,
      partner_package_id: pkg.id,
      package_id: pkg.id,
      package_name: pkg.name,
      face_value_rupees: pkg.face_value_rupees,
      rupees_value: pkg.face_value_rupees,
      points_deducted: pkg.point_cost,
      points_redeemed: pkg.point_cost,
      status: 'PENDING_ADMIN_APPROVAL',
      admin_notes: null,
      partner_notes: null,
      rejected_reason: null,
      disputed_reason: null,
      admin_id: null,
      approved_at: null,
      rejected_at: null,
      fulfilled_at: null,
      disputed_at: null,
      refund_ledger_id: null,
      redeemed_at: nowIso,
      next_redemption_allowed_at: nextAllowedAt,
      created_at: nowIso,
      updated_at: nowIso
    };
    redemptionApprovals.push(approvalRow);
    await db.saveTable('redemption_approvals', redemptionApprovals);
  }

  const responseObj = {
    success: true,
    ledgerId,
    remaining_balance: currentBalance + redeemAmount,
    message: 'Points successfully queued for redemption.'
  };
  if (approvalId) {
    responseObj.approval_id = approvalId;
    responseObj.redemption_approval = approvalRow;
  }
  return res.json(responseObj);
});

app.get(['/api/customer/rewards/available/:customerUserId', '/api/customer/available-rewards'], requireAuth, async (req, res) => {
  try {
    const customerId = req.params.customerUserId || req.query.customerId;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
    if (!customerId) {
      return res.status(400).json({ error: 'customerId parameter or query is required' });
    }
    const users = await db.getTable('users');
    const customer = users.find(u => u.id === customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerRegion = customer.region_id;
    const bindingsList = await db.getTable('customer_partner_bindings');
    const customerBindings = bindingsList.filter(b => b.customer_id === customerId || b.customer_user_id === customerId);

    let cablePartnerId = null;
    let broadbandPartnerId = null;

    for (const b of customerBindings) {
      if (b.cable_partner_id) cablePartnerId = b.cable_partner_id;
      if (b.broadband_partner_id) broadbandPartnerId = b.broadband_partner_id;
      const st = (b.service_type || '').toLowerCase();
      if (st === 'cable' && b.partner_id) cablePartnerId = b.partner_id;
      if (st === 'broadband' && b.partner_id) broadbandPartnerId = b.partner_id;
    }

    const partners = await db.getTable('partners');
    const partnerPackages = await db.getTable('partner_packages');

    const resolveAvailable = (partnerId, serviceType) => {
      let isPartnerless = false;
      let targetPartnerIds = [];

      if (partnerId) {
        const partner = partners.find(p => p.id === partnerId);
        if (!partner || partner.status === 'INACTIVE' || partner.is_active === false) {
          return { reason: 'partner_inactive', list: [] };
        }
        if (partner.region_id && customerRegion && partner.region_id !== customerRegion) {
          return { reason: 'partner_inactive', list: [] };
        }
        targetPartnerIds.push(partnerId);
      } else {
        isPartnerless = true;
        const activePartners = partners.filter(p => p.status !== 'INACTIVE' && p.is_active !== false && (!p.region_id || !customerRegion || p.region_id === customerRegion));
        targetPartnerIds = activePartners.map(p => p.id);
      }

      const stLower = serviceType.toLowerCase();
      const matching = partnerPackages.filter(pkg => {
        if (!targetPartnerIds.includes(pkg.partner_id)) return false;
        const pkgSt = (pkg.service_type || '').toLowerCase();
        if (pkgSt !== stLower) return false;
        if (pkg.status === 'INACTIVE' || pkg.is_active === false) return false;

        let regions = pkg.active_regions || [];
        if (typeof regions === 'string') {
          try { regions = JSON.parse(regions); } catch (e) { regions = []; }
        }
        if (Array.isArray(regions) && regions.length > 0 && customerRegion && !regions.includes(customerRegion)) return false;
        return true;
      });

      if (matching.length === 0) {
        return { reason: isPartnerless ? 'no_binding' : 'no_packages', list: [] };
      }

      matching.sort((a, b) => (a.point_cost || 0) - (b.point_cost || 0));

      const list = matching.map(pkg => {
        const partner = partners.find(p => p.id === pkg.partner_id) || {};
        return {
          package: {
            id: pkg.id,
            name: pkg.name,
            description: pkg.description,
            service_type: pkg.service_type,
            face_value_rupees: parseFloat(pkg.face_value_rupees),
            point_cost: parseInt(pkg.point_cost, 10)
          },
          partner: {
            id: partner.id,
            display_name: partner.display_name
          }
        };
      });

      return { reason: isPartnerless ? 'no_binding' : null, list };
    };

    const cableRes = resolveAvailable(cablePartnerId, 'cable');
    const broadbandRes = resolveAvailable(broadbandPartnerId, 'broadband');

    const genericRewardsTable = await db.getTable('generic_rewards');
    const genericRewards = genericRewardsTable.filter(r => {
      if (r.is_active === false) return false;
      if (r.valid_until && new Date() > new Date(r.valid_until)) return false;
      return true;
    });

    return res.json({
      cable: cableRes.list,
      broadband: broadbandRes.list,
      generic: genericRewards.map(r => ({
        package: {
          id: r.id,
          name: r.name,
          description: r.description,
          service_type: 'generic',
          face_value_rupees: parseFloat(r.value_rupees) || 0,
          point_cost: parseInt(r.point_cost, 10),
          cooldown_type: r.cooldown_type || 'NONE',
          cooldown_days: r.cooldown_days || null,
          valid_until: r.valid_until || null
        },
        partner: {
          id: 'GENERIC',
          display_name: 'Beniffy (Generic)'
        }
      })),
      bindings: {
        cable_partner_id: cablePartnerId || null,
        broadband_partner_id: broadbandPartnerId || null
      },
      empty_reasons: {
        cable: cableRes.reason,
        broadband: broadbandRes.reason
      }
    });
  } catch (err) {
    console.error('Error in GET /api/customer/rewards/available:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------
// FEEDBACK & REPORT ENDPOINTS
// ----------------------------------------------------

app.post('/api/feedback', requireAuth, async (req, res) => {
  const { reporterId, reporterRole, targetId, targetRole, orderId, rating, reason, reportFlag } = req.body;
  if (!assertSelfOrAdmin(req, res, reporterId)) return;
  if (!reporterId || !reporterRole || !targetId || !targetRole || !orderId || rating === undefined) {
    return res.status(400).json({ error: 'Reporter, target, order ID, and rating are required.' });
  }

  const feedback = await db.getTable('feedback_reports');
  const newFeedback = {
    id: 'fb-' + generateId(),
    reporter_id: reporterId,
    reporter_role: reporterRole,
    target_id: targetId,
    target_role: targetRole,
    order_id: orderId,
    rating: parseInt(rating, 10),
    reason: reason || '',
    report_flag: !!reportFlag,
    created_at: new Date().toISOString()
  };

  feedback.push(newFeedback);
  await db.saveTable('feedback_reports', feedback);
  return res.json({ success: true, feedback: newFeedback });
});

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
      const s = stockists.find(x => x.id === fb.reporter_id);
      reporterName = s ? s.name : 'Unknown Shopkeeper';
    }

    if (fb.target_role === 'CUSTOMER') {
      const u = users.find(x => x.id === fb.target_id);
      targetName = u ? u.name : 'Unknown Customer';
    } else {
      const s = stockists.find(x => x.id === fb.target_id);
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

function maskIdNumber(idNum) {
  if (!idNum) return 'XXXX-XXXX-XXXX';
  const clean = String(idNum).replace(/\D/g, '');
  if (clean.length === 12) {
    return 'XXXX-XXXX-' + clean.slice(8);
  }
  if (String(idNum).length > 4) {
    return 'X'.repeat(String(idNum).length - 4) + String(idNum).slice(-4);
  }
  return 'XXXX-XXXX-XXXX';
}

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
    'partner_users', 'partner_notifications', 'partner_feedback',
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
    'partner_users', 'partner_notifications', 'partner_feedback',
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
app.post('/api/customer/phone-change/request', requireAuth, async (req, res) => {
  let { user_id, new_phone } = req.body;
  if (!user_id || !new_phone) {
  if (!assertSelfOrAdmin(req, res, user_id)) return;
    return res.status(400).json({ error: 'User ID and new phone number are required' });
  }
  const validPhone = checkPhone(new_phone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;
  const users = await db.getTable('users');
  const existing = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone);
  if (existing) {
    return res.status(409).json({ error: 'Phone number already registered' });
  }
  const currentCode = issueOtp('customer-phone-change-current:' + user_id);
  const newCode = issueOtp('customer-phone-change-new:' + user_id);
  const user = users.find(u => u.id === user_id);
  const smsHelper = require('./lib/sms.js');
  try {
    if (user && user.phone) await smsHelper.sendSms(user.phone, `Your Beniffy code for changing phone number is ${currentCode}.`);
    await smsHelper.sendSms(cleanPhone, `Your Beniffy code to confirm new phone number is ${newCode}.`);
    return res.json({ success: true, message: 'OTP sent to both phone numbers' });
  } catch (err) {
    if (err.code === 'SMS_NOT_CONFIGURED') return res.status(503).json({ error: 'sms_unavailable' });
    return res.status(500).json({ error: 'sms_error' });
  }
});

app.post('/api/customer/phone-change/verify', requireAuth, async (req, res) => {
  let { user_id, new_phone, current_otp, new_otp, otp } = req.body;
  if (!user_id || !new_phone) {
  if (!assertSelfOrAdmin(req, res, user_id)) return;
    return res.status(400).json({ error: 'User ID and new phone are required' });
  }
  const checkCurrent = current_otp || otp;
  const checkNew = new_otp || otp;
  if (!checkCurrent || !checkNew) return res.status(400).json({ error: 'Both OTPs are required' });
  if (!/^\d{6}$/.test(String(checkCurrent).trim()) || !/^\d{6}$/.test(String(checkNew).trim())) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  const vCurrent = verifyOtp('customer-phone-change-current:' + user_id, checkCurrent);
  const vNew = verifyOtp('customer-phone-change-new:' + user_id, checkNew);
  if (!vCurrent.ok || !vNew.ok) {
    if (vCurrent.reason === 'locked' || vNew.reason === 'locked') return res.status(429).json({ error: 'Too many attempts.' });
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  const validPhone = checkPhone(new_phone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === user_id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const oldPhone = user.phone;
  user.phone = cleanPhone;
  await db.saveTable('users', users);
  await appendAudit(req, 'PHONE_CHANGE_VERIFIED', 'user', user_id, { phone: oldPhone }, { phone: cleanPhone });
  return res.json({ success: true, message: 'Phone number updated successfully', user });
});

// Self-service Customer Region Change
app.post('/api/customer/region-change', requireAuth, async (req, res) => {
  const { user_id, new_region_id } = req.body;
  if (!assertSelfOrAdmin(req, res, user_id)) return;
  if (!user_id || !new_region_id) {
    return res.status(400).json({ error: 'User ID and new region ID are required' });
  }
  const users = await db.getTable('users');
  const user = users.find(u => u.id === user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const oldRegionId = user.region_id;
  user.region_id = new_region_id;
  await db.saveTable('users', users);

  // Check customer_partner_bindings
  const bindings = await db.getTable('customer_partner_bindings');
  const partnerRegions = await db.getTable('partner_regions');
  const partners = await db.getTable('partners');

  let clearedPartnerNames = [];
  const updatedBindings = [];
  for (const binding of bindings) {
    const bCustId = binding.customer_user_id || binding.customer_id || binding.user_id;
    if (bCustId === user_id) {
      const partnerId = binding.partner_id || binding.cable_partner_id || binding.broadband_partner_id;
      const servesNewRegion = partnerRegions.some(pr => pr.partner_id === partnerId && pr.region_id === new_region_id && pr.is_active !== false);
      if (!servesNewRegion) {
        const partner = partners.find(p => p.id === partnerId);
        const pName = partner ? (partner.display_name || partner.name || partner.legal_name) : 'Selected Partner';
        if (!clearedPartnerNames.includes(pName)) clearedPartnerNames.push(pName);
        continue;
      }
    }
    updatedBindings.push(binding);
  }

  if (updatedBindings.length !== bindings.length) {
    await db.saveTable('customer_partner_bindings', updatedBindings);
  }

  const clearedPartnerName = clearedPartnerNames.join(', ') || null;

  await appendAudit(req, 'REGION_CHANGE', 'user', user_id, { region_id: oldRegionId }, { region_id: new_region_id, cleared_partner: clearedPartnerName });
  return res.json({
    success: true,
    user,
    cleared_partner_name: clearedPartnerName,
    message: clearedPartnerName
      ? `Region updated. Your binding with ${clearedPartnerName} was cleared as they do not serve the new area.`
      : 'Region updated successfully.'
  });
});

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
app.post('/api/partner-leads', async (req, res) => {
  let { name, contact_name, phone, email, service_type, service_types, region_id } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;
  let finalServiceTypes = service_types;
  if (!finalServiceTypes || !Array.isArray(finalServiceTypes) || finalServiceTypes.length === 0) {
    if (service_type === 'BOTH') {
      finalServiceTypes = ['CABLE', 'BROADBAND'];
    } else if (service_type) {
      finalServiceTypes = [service_type];
    } else {
      finalServiceTypes = ['CABLE'];
    }
  }
  const leads = await db.getTable('partner_leads');
  const newLead = {
    id: 'lead-' + generateId(),
    name: name.trim(),
    contact_name: contact_name ? contact_name.trim() : null,
    phone: phone.trim(),
    email: email ? email.trim() : null,
    service_type: finalServiceTypes[0] || service_type || 'CABLE',
    service_types: finalServiceTypes,
    region_id: region_id || null,
    created_at: new Date().toISOString(),
    status: 'NEW',
    notes: []
  };
  leads.push(newLead);
  await db.saveTable('partner_leads', leads);
  return res.json({ success: true, lead: newLead });
});

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
app.post('/api/customer/fraud-reports', requireAuth, async (req, res) => {
  const { customerId, subject, description, linkedEntityType, linkedEntityId } = req.body;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: 'Subject is required' });
  }
  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters long' });
  }
  const reports = await db.getTable('fraud_reports');
  const report = {
    id: 'fr-' + generateId(),
    reporter_customer_id: customerId,
    subject: subject.trim(),
    description: description.trim(),
    linked_entity_type: linkedEntityType || null,
    linked_entity_id: linkedEntityId || null,
    status: 'NEW',
    admin_notes: '',
    created_at: new Date().toISOString(),
    resolved_at: null
  };
  reports.push(report);
  await db.saveTable('fraud_reports', reports);
  return res.json({ success: true, report });
});

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

const phoneChangeMarkers = new Map();
const sendCurrentRateLimits = new Map();
const sendNewRateLimits = new Map();

function getPhoneChangeMarker(id) {
  let m = phoneChangeMarkers.get(id);
  if (!m) { m = {}; phoneChangeMarkers.set(id, m); }
  return m;
}

function checkSendRateLimit(map, id, res) {
  const lastSent = map.get(id);
  if (lastSent && Date.now() - lastSent < 60000) {
    const sec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
    res.status(429).json({ error: `Too many requests, try again in ${sec}s` });
    return true;
  }
  map.set(id, Date.now());
  return false;
}

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
    region_id: user.region_id || 'r1',
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
  let { name, region_id, vendor_id, phone, delivery_radius_km, opening_time, closing_time, prep_eta_minutes, commission_rate } = req.body;
  if (!name || !region_id || !phone) {
    return res.status(400).json({ error: 'Name, region_id, and phone are required' });
  }
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;

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
  const { name, address, opening_time, closing_time, prep_eta_minutes, delivery_radius_km, region_id, vendor_id, min_order_value, kyc_id_type, kyc_id_number, user_name, user_phone } = req.body;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === id);
  if (!stockist) return res.status(404).json({ error: 'Stockist not found' });

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

  const beforeStockist = { name: stockist.name, opening_time: stockist.opening_time, closing_time: stockist.closing_time, prep_eta_minutes: stockist.prep_eta_minutes, delivery_radius_km: stockist.delivery_radius_km, region_id: stockist.region_id, vendor_id: stockist.vendor_id, min_order_value: stockist.min_order_value };
  
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
app.get('/api/test/mock-outbox', async (req, res) => {
  if (!require('./lib/env').isTestEnv()) return res.status(404).json({ error: 'Not found' });
  return res.json(emailHelper.getMockOutbox());
});

app.post('/api/test/clear-mock-outbox', async (req, res) => {
  if (!require('./lib/env').isTestEnv()) return res.status(404).json({ error: 'Not found' });
  emailHelper.clearMockOutbox();
  return res.json({ success: true });
});

// ==========================================
// ROUND P1 — PARTNER MODEL & AUTH ENDPOINTS
// ==========================================

const ALLOWED_SERVICE_TYPES = ['CABLE', 'BROADBAND', 'DTH', 'OTT_BUNDLE'];

async function getPartnerSession(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  try {
    const { userId, role } = sessionHelper.verifySession(token);
    if (role !== 'PARTNER_ADMIN') return null;
    const users = await db.getTable('users');
    const user = users.find(u => u.id === userId && u.is_active !== false);
    if (!user) return null;
    const partnerUsers = await db.getTable('partner_users');
    const pu = partnerUsers.find(p => p.user_id === userId);
    if (!pu) return null;
    const partners = await db.getTable('partners');
    const partner = partners.find(p => p.id === pu.partner_id);
    if (!partner) return null;
    return { user, partner, userId: user.id, partnerId: partner.id };
  } catch (err) {
    return null;
  }
}

// 3.1 POST /api/partner/auth/set-password
app.post('/api/partner/auth/set-password', async (req, res) => {
  const { user_id, current_password, new_password } = req.body;
  if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  let targetUserId = user_id;
  let authSuccess = false;

  const session = await getPartnerSession(req);
  if (session) {
    targetUserId = session.userId;
    authSuccess = true;
  } else if (current_password && targetUserId) {
    const users = await db.getTable('users');
    const user = users.find(u => u.id === targetUserId);
    if (user && user.password_hash && bcrypt.compareSync(current_password, user.password_hash)) {
      authSuccess = true;
    }
  }

  if (!authSuccess || !targetUserId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === targetUserId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.password_hash = bcrypt.hashSync(new_password, 10);
  await db.saveTable('users', users);

  await appendAudit(req, 'PARTNER_SET_PASSWORD', 'users', user.id, null, { password_updated: true });
  return res.json({ success: true, message: 'Password set successfully.' });
});

// 3.2 POST /api/partner/auth/login-password
app.post('/api/partner/auth/login-password', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();
  let attempts = loginPasswordFailedAttempts.get(normalizedEmail) || [];
  attempts = attempts.filter(ts => now - ts < 15 * 60 * 1000);
  loginPasswordFailedAttempts.set(normalizedEmail, attempts);

  if (attempts.length >= 5) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.role === 'PARTNER_ADMIN' && u.email && u.email.trim().toLowerCase() === normalizedEmail && u.is_active !== false);

  if (user && user.password_hash && bcrypt.compareSync(password, user.password_hash)) {
    loginPasswordFailedAttempts.delete(normalizedEmail);

    const partnerUsers = await db.getTable('partner_users');
    const pu = partnerUsers.find(p => p.user_id === user.id);
    const partners = await db.getTable('partners');
    const partner = pu ? partners.find(p => p.id === pu.partner_id) : null;

    const token = sessionHelper.signSession(user.id, user.role);
    return res.json({
      session_token: token,
      token: token,
      user: sanitizeUser(user),
      partner: partner || null
    });
  }

  attempts.push(now);
  loginPasswordFailedAttempts.set(normalizedEmail, attempts);
  return res.status(401).json({ error: 'Invalid credentials' });
});

// 3.3 POST /api/partner/auth/login-otp-request
app.post('/api/partner/auth/login-otp-request', async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;

  const now = Date.now();
  let attempts = otpRequestAttempts.get(phone) || [];
  attempts = attempts.filter(ts => now - ts < 5 * 60 * 1000);
  otpRequestAttempts.set(phone, attempts);

  if (attempts.length >= 3) {
    return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
  }
  attempts.push(now);
  otpRequestAttempts.set(phone, attempts);

  const users = await db.getTable('users');
  const user = users.find(u => u.role === 'PARTNER_ADMIN' && u.phone === phone && u.is_active !== false && u.kyc_status !== 'RELEASED');

  if (user) {
    const code = issueOtp('login:' + phone);
    try {
      await require('./lib/sms.js').sendSms(phone, `Your Beniffy OTP is ${code}`);
    } catch (e) {
      if (e.code === 'SMS_NOT_CONFIGURED') return res.status(503).json({ error: 'sms_unavailable' });
      return res.status(500).json({ error: 'sms_error' });
    }
  }

  return res.json({ success: true, message: 'OTP sent successfully if phone is registered.' });
});

// 3.4 POST /api/partner/auth/login-otp-verify & /api/partner/auth/verify-otp
const handlePartnerOtpVerify = async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  if (!/^\d{6}$/.test(String(otp).trim())) return res.status(400).json({ error: 'Invalid OTP' });

  const users = await db.getTable('users');
  const user = users.find(u => u.role === 'PARTNER_ADMIN' && u.phone === phone && u.is_active !== false && u.kyc_status !== 'RELEASED');

  if (!user) return res.status(404).json({ error: 'No account found' });
  const vRes = verifyOtp('login:' + phone, otp);
  if (!vRes.ok) {
    if (vRes.reason === 'locked') return res.status(429).json({ error: 'Too many failed attempts.' });
    return res.status(401).json({ error: 'Invalid credentials or OTP' });
  }

  clearOtpRateLimit(phone);

  if (!user.email || !user.password_hash) {
    const setupToken = jwt.sign(
      { user_id: user.id, setup_mode: true },
      sessionHelper.getSecret(),
      { expiresIn: '30m' }
    );
    return res.json({
      success: true,
      setup_required: true,
      setup_token: setupToken,
      message: 'Complete setup to continue'
    });
  }

  const partnerUsers = await db.getTable('partner_users');
  const pu = partnerUsers.find(p => p.user_id === user.id);
  const partners = await db.getTable('partners');
  const partner = pu ? partners.find(p => p.id === pu.partner_id) : null;

  const token = sessionHelper.signSession(user.id, user.role);
  return res.json({
    success: true,
    token: token,
    session_token: token,
    user: sanitizeUser(user),
    partner: partner || null
  });
};

app.post('/api/partner/auth/login-otp-verify', handlePartnerOtpVerify);
app.post('/api/partner/auth/verify-otp', handlePartnerOtpVerify);

// 3.4.1 POST /api/partner/auth/setup-complete
app.post('/api/partner/auth/setup-complete', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization setup token required' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, sessionHelper.getSecret());
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired setup token' });
  }

  if (!decoded || !decoded.setup_mode) {
    return res.status(401).json({ error: 'Invalid setup token' });
  }

  const userId = decoded.user_id || decoded.userId || decoded.sub;
  const { email, password } = req.body;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === userId && u.role === 'PARTNER_ADMIN');
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = users.find(u => u.id !== userId && u.email && u.email.trim().toLowerCase() === normalizedEmail);
  if (existingUser) {
    return res.status(400).json({ error: 'Email is already registered' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  await db.updateRow('users', user.id, {
    email: normalizedEmail,
    password_hash: hashedPassword,
    setup_completed_at: new Date().toISOString()
  });

  user.email = normalizedEmail;
  user.password_hash = hashedPassword;

  const partnerUsers = await db.getTable('partner_users');
  const pu = partnerUsers.find(p => p.user_id === user.id);
  const partners = await db.getTable('partners');
  const partner = pu ? partners.find(p => p.id === pu.partner_id) : null;

  const finalToken = sessionHelper.signSession(user.id, user.role);

  return res.json({
    success: true,
    token: finalToken,
    session_token: finalToken,
    user: sanitizeUser(user),
    partner: partner || null
  });
});


// 3.5 POST /api/partner/auth/forgot-password
app.post('/api/partner/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  if (!emailHelper.isEmailConfigured()) {
    return res.status(503).json({ error: 'Email service unavailable' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const users = await db.getTable('users');
  const user = users.find(u => u.role === 'PARTNER_ADMIN' && u.email && u.email.trim().toLowerCase() === normalizedEmail && u.is_active !== false);

  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });

    const baseUrl = process.env.APP_BASE_URL || 'localhost:3000';
    const resetUrl = `https://${baseUrl}/partner/reset-password?token=${token}`;

    emailHelper.sendEmail(
      user.email,
      'Partner Account Password Reset',
      `<p>Click here to reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`,
      `Reset your password: ${resetUrl}`
    ).catch(err => console.error('Failed to send reset email:', err));
  }

  return res.json({ success: true, message: 'If email exists, a password reset link has been sent.' });
});

// 3.6 POST /api/partner/auth/reset-password
app.post('/api/partner/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password || typeof new_password !== 'string' || new_password.length < 8) {
    return res.status(400).json({ error: 'Invalid token or password too short (min 8 characters).' });
  }

  const tokenRecord = resetTokens.get(token);
  if (!tokenRecord || Date.now() > tokenRecord.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === tokenRecord.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.password_hash = bcrypt.hashSync(new_password, 10);
  await db.saveTable('users', users);
  resetTokens.delete(token);

  await appendAudit(req, 'PARTNER_RESET_PASSWORD', 'users', user.id, null, { password_reset: true });
  return res.json({ success: true, message: 'Password reset successfully.' });
});

// 3.7 GET /api/partner/auth/session
app.get('/api/partner/auth/session', async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized or invalid session' });
  }
  return res.json({
    user: sanitizeUser(session.user),
    partner: session.partner
  });
});

// 4.1 POST /api/admin/partners
app.post('/api/admin/partners', async (req, res) => {
  let { legal_name, display_name, contact_phone, contact_email, address, service_types, gst_number } = req.body;
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
    onboarded_by_admin_id: admin_id || 'u-admin',
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
    onboarded_by_admin_id: admin_id || 'u-admin',
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
  lead.promoted_by_admin_id = admin_id || 'u-admin';
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
app.post('/api/partner/packages', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  if (req.body.partner_id && req.body.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Cannot create package for a different partner' });
  }

  const { service_type, name, description, face_value_rupees, cost_to_partner_rupees, point_cost, active_regions } = req.body;
  const partner = session.partner;
  const partnerId = partner.id;

  if (!service_type || !partner.service_types || !partner.service_types.includes(service_type)) {
    return res.status(400).json({ error: 'Service type must match one of partner service_types' });
  }

  if (!name || face_value_rupees === undefined || !active_regions || !Array.isArray(active_regions) || active_regions.length === 0) {
    return res.status(400).json({ error: 'At least one active region is required for this package' });
  }

  const partnerRegions = (await db.getTable('partner_regions')).filter(pr => pr.partner_id === partnerId && pr.service_type === service_type && pr.is_active !== false);
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
    partner_id: partnerId,
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

  return res.json(newPkg);
});

app.patch('/api/partner/packages/:packageId', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

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

  return res.json(pkg);
});

app.post('/api/partner/packages/:packageId/deactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  pkg.is_active = false;
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  return res.json(pkg);
});

app.post('/api/partner/packages/:packageId/reactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  pkg.is_active = true;
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  return res.json(pkg);
});

// Part 5 — Customer Partner Bindings
app.post('/api/customer/partner-bindings', requireAuth, async (req, res) => {
  const { customer_user_id, cable_partner_id, broadband_partner_id } = req.body;
  if (!assertSelfOrAdmin(req, res, customer_user_id)) return;
  if (!customer_user_id) return res.status(400).json({ error: 'customer_user_id is required' });

  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customer_user_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  if (cable_partner_id) {
    const cp = partners.find(p => p.id === cable_partner_id && p.is_active !== false);
    if (!cp || !cp.service_types || !cp.service_types.includes('CABLE')) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Invalid cable partner' });
    }
    const servesRegion = partnerRegions.some(pr => pr.partner_id === cable_partner_id && pr.region_id === customer.region_id && pr.service_type === 'CABLE' && pr.is_active !== false);
    if (!servesRegion) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Cable partner does not serve customer region' });
    }
  }

  if (broadband_partner_id) {
    const bp = partners.find(p => p.id === broadband_partner_id && p.is_active !== false);
    if (!bp || !bp.service_types || !bp.service_types.includes('BROADBAND')) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Invalid broadband partner' });
    }
    const servesRegion = partnerRegions.some(pr => pr.partner_id === broadband_partner_id && pr.region_id === customer.region_id && pr.service_type === 'BROADBAND' && pr.is_active !== false);
    if (!servesRegion) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Broadband partner does not serve customer region' });
    }
  }

  const bindings = await db.getTable('customer_partner_bindings');
  let binding = bindings.find(b => b.customer_user_id === customer_user_id);
  const now = new Date().toISOString();

  if (binding) {
    const before = { cable_partner_id: binding.cable_partner_id, broadband_partner_id: binding.broadband_partner_id };
    binding.cable_partner_id = cable_partner_id !== undefined ? cable_partner_id : binding.cable_partner_id;
    binding.broadband_partner_id = broadband_partner_id !== undefined ? broadband_partner_id : binding.broadband_partner_id;
    binding.updated_at = now;
    await db.saveTable('customer_partner_bindings', bindings);
    await appendAudit(req, 'UPDATE_PARTNER_BINDING', 'customer_partner_binding', customer_user_id, before, binding);
  } else {
    binding = { id: 'cpb-' + generateId(), customer_user_id,
      cable_partner_id: cable_partner_id || null,
      broadband_partner_id: broadband_partner_id || null,
      updated_at: now
    };
    bindings.push(binding);
    await db.saveTable('customer_partner_bindings', bindings);
  }

  return res.json(binding);
});

app.get('/api/customer/partner-bindings/:customer_user_id', requireAuth, async (req, res) => {
  const { customer_user_id } = req.params;
  if (customer_user_id && !assertSelfOrAdmin(req, res, customer_user_id)) return;
  const bindings = await db.getTable('customer_partner_bindings');
  const binding = bindings.find(b => b.customer_user_id === customer_user_id);
  return res.json(binding || null);
});

async function getAvailablePartnersForRegion(regionId) {
  if (!regionId) return { cable: [], broadband: [] };

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  const activePartnersMap = new Map(
    partners.filter(p => p.is_active !== false).map(p => [p.id, p])
  );

  const cableSet = new Map();
  const broadbandSet = new Map();

  const matchingRegions = partnerRegions.filter(
    pr => pr.region_id === regionId && pr.is_active !== false && activePartnersMap.has(pr.partner_id)
  );

  for (const pr of matchingRegions) {
    const ptr = activePartnersMap.get(pr.partner_id);
    if (!ptr) continue;
    const sanitized = {
      id: ptr.id,
      display_name: ptr.display_name,
      service_types: ptr.service_types || []
    };

    if (pr.service_type === 'CABLE' && !cableSet.has(ptr.id)) {
      cableSet.set(ptr.id, sanitized);
    } else if (pr.service_type === 'BROADBAND' && !broadbandSet.has(ptr.id)) {
      broadbandSet.set(ptr.id, sanitized);
    }
  }

  return {
    cable: Array.from(cableSet.values()),
    broadband: Array.from(broadbandSet.values())
  };
}

app.get('/api/customer/available-partners', async (req, res) => {
  const { region_id } = req.query;
  if (!region_id) {
    return res.status(400).json({ error: 'region_id is required' });
  }
  return res.json(await getAvailablePartnersForRegion(region_id));
});

app.get('/api/customer/:id/profile', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!assertSelfOrAdmin(req, res, id)) return;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });

  const bindings = await db.getTable('customer_partner_bindings');
  const binding = bindings.find(b => b.customer_user_id === id) || null;

  const available_partners = await getAvailablePartnersForRegion(user.region_id);

  return res.json({
    user: sanitizeUser(user),
    bindings: binding,
    available_partners
  });
});

app.post('/api/customer/:id/profile', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!assertSelfOrAdmin(req, res, id)) return;
  const { name, address } = req.body;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });

  const before = { name: user.name, address: user.address || '' };
  if (name && name.trim()) user.name = name.trim();
  if (address !== undefined) user.address = address.trim();

  await db.saveTable('users', users);
  await appendAudit(req, 'EDIT_CUSTOMER_PROFILE', 'customer', id, before, { name: user.name, address: user.address });

  return res.json({ success: true, user: sanitizeUser(user) });
});

app.get('/api/customer/partner-bindings/:customer_user_id/available', requireAuth, async (req, res) => {
  const { customer_user_id } = req.params;
  if (!assertSelfOrAdmin(req, res, customer_user_id)) return;
  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customer_user_id);
  if (!customer || !customer.region_id) {
    return res.json({ cable: [], broadband: [] });
  }

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  const cablePartnerIds = partnerRegions
    .filter(pr => pr.region_id === customer.region_id && pr.service_type === 'CABLE' && pr.is_active !== false)
    .map(pr => pr.partner_id);

  const broadbandPartnerIds = partnerRegions
    .filter(pr => pr.region_id === customer.region_id && pr.service_type === 'BROADBAND' && pr.is_active !== false)
    .map(pr => pr.partner_id);

  const cablePartners = partners.filter(p => p.is_active !== false && cablePartnerIds.includes(p.id));
  const broadbandPartners = partners.filter(p => p.is_active !== false && broadbandPartnerIds.includes(p.id));

  return res.json({
    cable: cablePartners,
    broadband: broadbandPartners
  });
});

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
  const admin_id = req.user.userId; // the signed-in admin, never a value from the request

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.status !== 'PENDING_ADMIN_APPROVAL') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  approval.status = approval.partner_id === 'GENERIC' ? 'FULFILLED' : 'APPROVED_AWAITING_PARTNER';
  approval.admin_id = admin_id || 'u-admin';
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
        `<p>Customer ${custName} (phone: ${custPhone}) has redeemed "${pkgName}". Please verify and mark fulfilled in your partner app. Approval ID: ${approval.id}</p>`,
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
  approval.admin_id = admin_id || 'u-admin';
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

  await appendAudit(req, 'REJECT_REDEMPTION', 'redemption_approval', id, { status: oldStatus }, { status: approval.status, refund_ledger_id: refundLedgerId }, reason);

  return res.json(approval);
});

app.post('/api/admin/redemption-approvals/:id/resolve-dispute', async (req, res) => {
  const { id } = req.params;
  const { outcome, notes } = req.body;
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

  approval.admin_id = admin_id || 'u-admin';
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
app.get('/api/partner/redemption-queue', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const approvals = await db.getTable('redemption_approvals');
  const partnerApprovals = approvals.filter(a =>
    a.partner_id === session.partnerId &&
    ['APPROVED_AWAITING_PARTNER', 'DISPUTED'].includes(a.status)
  );

  const users = await db.getTable('users');
  const packages = await db.getTable('partner_packages');

  const result = partnerApprovals.map(a => {
    const cust = users.find(u => u.id === a.customer_user_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      customer_name: cust ? cust.name : 'Unknown Customer',
      customer_phone: cust ? cust.phone : '',
      package_name: pkg ? pkg.name : 'Unknown Package'
    };
  });

  return res.json(result);
});

app.get('/api/partner/redemption-history', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { status, date_from, date_to } = req.query;
  let approvals = (await db.getTable('redemption_approvals')).filter(a => a.partner_id === session.partnerId);

  if (status) approvals = approvals.filter(a => a.status === status);
  if (date_from) approvals = approvals.filter(a => new Date(a.created_at) >= new Date(date_from));
  if (date_to) approvals = approvals.filter(a => new Date(a.created_at) <= new Date(date_to));

  const users = await db.getTable('users');
  const packages = await db.getTable('partner_packages');

  const result = approvals.map(a => {
    const cust = users.find(u => u.id === a.customer_user_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      customer_name: cust ? cust.name : 'Unknown Customer',
      customer_phone: cust ? cust.phone : '',
      package_name: pkg ? pkg.name : 'Unknown Package'
    };
  });

  return res.json(result);
});

app.post('/api/partner/redemption-approvals/:id/fulfill', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const { partner_notes } = req.body;

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (approval.status !== 'APPROVED_AWAITING_PARTNER' && approval.status !== 'DISPUTED') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  const oldStatus = approval.status;
  approval.status = 'FULFILLED';
  if (partner_notes) approval.partner_notes = partner_notes;
  approval.fulfilled_at = new Date().toISOString();
  approval.updated_at = new Date().toISOString();

  await db.saveTable('redemption_approvals', approvals);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'PARTNER_FULFILLED',
    entity_type: 'redemption_approval',
    entity_id: id,
    user_id: session.userId,
    before: { status: oldStatus },
    after: { status: 'FULFILLED' },
    notes: partner_notes || 'Partner fulfilled redemption',
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json(approval);
});

app.post('/api/partner/redemption-approvals/:id/dispute', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({ error: 'Reason must be at least 10 characters long' });
  }

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (approval.status !== 'APPROVED_AWAITING_PARTNER') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  approval.status = 'DISPUTED';
  approval.disputed_reason = reason.trim();
  approval.disputed_at = new Date().toISOString();
  approval.updated_at = new Date().toISOString();

  await db.saveTable('redemption_approvals', approvals);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'PARTNER_DISPUTED',
    entity_type: 'redemption_approval',
    entity_id: id,
    user_id: session.userId,
    before: { status: 'APPROVED_AWAITING_PARTNER' },
    after: { status: 'DISPUTED', disputed_reason: reason.trim() },
    notes: reason.trim(),
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json(approval);
});

// 1.5 Customer Status Endpoint
app.get('/api/customer/redemption-status/:approval_id', requireAuth, async (req, res) => {
  const { approval_id } = req.params;
  const { customer_user_id } = req.query;

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === approval_id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });
  if (!assertSelfOrAdmin(req, res, approval.customer_user_id)) return;

  if (customer_user_id && approval.customer_user_id !== customer_user_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return res.json({
    status: approval.status,
    approval,
    timeline: {
      created_at: approval.created_at,
      approved_at: approval.approved_at,
      fulfilled_at: approval.fulfilled_at,
      rejected_at: approval.rejected_at,
      disputed_at: approval.disputed_at
    }
  });
});

app.get('/api/customer/redemptions/:customerUserId', requireAuth, async (req, res) => {
  const { customerUserId } = req.params;
  if (!assertSelfOrAdmin(req, res, customerUserId)) return;
  const approvals = await db.getTable('redemption_approvals');
  const partners = await db.getTable('partners');
  const packages = await db.getTable('partner_packages');

  const customerApprovals = approvals
    .filter(a => a.customer_user_id === customerUserId)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 20);

  const result = customerApprovals.map(a => {
    const partner = partners.find(p => p.id === a.partner_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      package_name: pkg ? pkg.name : (a.package_name || 'Unknown Package'),
      package_duration_days: pkg ? pkg.duration_days : null,
      partner_display_name: partner ? partner.display_name : (a.partner_display_name || partner?.name || 'Partner'),
      partner_name: partner ? partner.display_name : (a.partner_display_name || partner?.name || 'Partner')
    };
  });

  return res.json(result);
});

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
app.get('/api/partner/dashboard', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const partnerId = session.partnerId;
  const approvals = await db.getTable('redemption_approvals');
  const partnerApprovals = approvals.filter(a => a.partner_id === partnerId);

  // IST date math
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const year = istNow.getUTCFullYear();
  const month = istNow.getUTCMonth();
  const date = istNow.getUTCDate();

  const startOfTodayIST = new Date(Date.UTC(year, month, date) - istOffsetMs).toISOString();
  const startOfMonthIST = new Date(Date.UTC(year, month, 1) - istOffsetMs).toISOString();

  const todayRedemptions = partnerApprovals.filter(a =>
    ['APPROVED_AWAITING_PARTNER', 'FULFILLED'].includes(a.status) && a.created_at >= startOfTodayIST
  );
  const todayFulfilled = partnerApprovals.filter(a =>
    a.status === 'FULFILLED' && ((a.fulfilled_at || a.updated_at || a.created_at) >= startOfTodayIST)
  );
  const todayPending = partnerApprovals.filter(a => a.status === 'APPROVED_AWAITING_PARTNER');

  const monthRedemptions = partnerApprovals.filter(a =>
    a.created_at >= startOfMonthIST && a.status !== 'REJECTED'
  );
  const monthFulfilled = partnerApprovals.filter(a =>
    a.status === 'FULFILLED' && ((a.fulfilled_at || a.updated_at || a.created_at) >= startOfMonthIST)
  );

  let faceValueTotalRupees = 0;
  let expectedPayoutRupees = 0;

  for (const row of monthFulfilled) {
    const faceVal = parseFloat(row.face_value_rupees || 0);
    faceValueTotalRupees += faceVal;
    const payoutInfo = await calculatePartnerPayout(faceVal, row.stockist_id || null);
    expectedPayoutRupees += payoutInfo.partnerPayout;
  }

  const openDisputes = partnerApprovals.filter(a => a.status === 'DISPUTED');

  return res.json({
    today: {
      redemptions_count: todayRedemptions.length,
      fulfilled_count: todayFulfilled.length,
      pending_count: todayPending.length
    },
    month: {
      redemptions_count: monthRedemptions.length,
      fulfilled_count: monthFulfilled.length,
      face_value_total_rupees: Math.round(faceValueTotalRupees * 100) / 100,
      expected_payout_rupees: Math.round(expectedPayoutRupees * 100) / 100
    },
    disputes: {
      open_count: openDisputes.length
    }
  });
});

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
app.get('/api/regions', async (req, res) => {
  const regions = await db.getTable('regions');
  const clean = regions
    .filter(r => !r.tenant_id || r.tenant_id === 't1')
    .map(r => ({ id: r.id, name: r.name, code: r.code, delivery_fee: r.delivery_fee }));
  res.json(clean);
});

// Part 2: Partner Region Self-Management
app.get('/api/partner/regions', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const partnerRegions = (await db.getTable('partner_regions')).filter(r => r.partner_id === session.partnerId);
  const regions = await db.getTable('regions');

  const result = partnerRegions.map(pr => {
    const reg = regions.find(r => r.id === pr.region_id);
    return {
      ...pr,
      region_name: reg ? reg.name : '',
      region_code: reg ? reg.code : ''
    };
  });

  return res.json(result);
});

app.post('/api/partner/regions', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { region_id, service_type, service_types } = req.body;
  
  const typesToProcess = service_types ? service_types : (service_type ? [service_type] : []);

  if (!region_id || typesToProcess.length === 0) {
    return res.status(400).json({ error: 'region_id and service_types are required' });
  }

  const partnerServiceTypes = session.partner.service_types || [];
  for (const st of typesToProcess) {
    if (!partnerServiceTypes.includes(st)) {
      return res.status(400).json({ error: 'One or more service_types not supported by partner' });
    }
  }

  const regions = await db.getTable('regions');
  const regionExists = regions.some(r => r.id === region_id);
  if (!regionExists) {
    return res.status(400).json({ error: 'region_id does not exist' });
  }

  const partnerRegions = await db.getTable('partner_regions');
  
  const createdRows = [];
  const skippedTypes = [];

  for (const st of typesToProcess) {
    const duplicate = partnerRegions.some(pr =>
      pr.partner_id === session.partnerId && pr.region_id === region_id && pr.service_type === st
    );
    if (duplicate) {
      skippedTypes.push(st);
      continue;
    }
    
    const newRow = {
      id: 'prg-' + generateId(),
      partner_id: session.partnerId,
      region_id,
      service_type: st,
      is_active: true,
      created_at: new Date().toISOString()
    };
    createdRows.push(newRow);
  }

  if (createdRows.length === 0 && skippedTypes.length > 0) {
    return res.status(409).json({ error: 'Region mapping already exists for all provided service_types' });
  }

  if (createdRows.length > 0) {
    for (const newRow of createdRows) {
      partnerRegions.push(newRow);
    }
    await db.saveTable('partner_regions', partnerRegions);

    for (const newRow of createdRows) {
      await appendAudit(req, 'PARTNER_REGION_ADD', 'partner_region', newRow.id, null, newRow, session.userId);
    }
  }

  if (!req.body.service_types && createdRows.length === 1) {
    return res.json(createdRows[0]);
  }

  return res.json({
    created: createdRows,
    skipped: skippedTypes
  });
});

app.post('/api/partner/regions/:regionRowId/deactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { regionRowId } = req.params;
  const { confirm } = req.body || {};

  const partnerRegions = await db.getTable('partner_regions');
  const row = partnerRegions.find(pr => pr.id === regionRowId);
  if (!row) return res.status(404).json({ error: 'Region mapping not found' });

  if (row.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden: region mapping does not belong to your partner account' });
  }

  const partnerPackages = await db.getTable('partner_packages');
  const referencingPackages = partnerPackages.filter(p =>
    p.partner_id === session.partnerId &&
    p.is_active !== false &&
    Array.isArray(p.active_regions) &&
    p.active_regions.includes(row.region_id)
  );

  if (referencingPackages.length > 0 && !confirm) {
    return res.status(400).json({
      warning: `Region is referenced by ${referencingPackages.length} active package(s)`,
      requires_confirmation: true,
      referencing_packages: referencingPackages.map(p => ({ id: p.id, name: p.name }))
    });
  }

  row.is_active = false;
  await db.saveTable('partner_regions', partnerRegions);
  await appendAudit(req, 'PARTNER_REGION_DEACTIVATE', 'partner_region', regionRowId, { is_active: true }, { is_active: false }, session.userId);

  return res.json(row);
});

app.post('/api/partner/regions/:regionRowId/reactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const row = partnerRegions.find(pr => pr.id === regionRowId);
  if (!row) return res.status(404).json({ error: 'Region mapping not found' });

  if (row.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden: region mapping does not belong to your partner account' });
  }

  row.is_active = true;
  await db.saveTable('partner_regions', partnerRegions);
  await appendAudit(req, 'PARTNER_REGION_REACTIVATE', 'partner_region', regionRowId, { is_active: false }, { is_active: true }, session.userId);

  return res.json(row);
});

app.delete('/api/partner/regions/:regionRowId', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const idx = partnerRegions.findIndex(pr => pr.id === regionRowId);
  if (idx === -1) return res.status(404).json({ error: 'Region mapping not found' });

  const row = partnerRegions[idx];
  if (row.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden: region mapping does not belong to your partner account' });
  }

  const partnerPackages = await db.getTable('partner_packages');
  const referencingPackages = partnerPackages.filter(p =>
    p.partner_id === session.partnerId &&
    Array.isArray(p.active_regions) &&
    p.active_regions.includes(row.region_id)
  );

  if (referencingPackages.length > 0) {
    return res.status(400).json({ error: 'Cannot delete region referenced by packages' });
  }

  partnerRegions.splice(idx, 1);
  await db.saveTable('partner_regions', partnerRegions);
  await appendAudit(req, 'PARTNER_REGION_DELETE', 'partner_region', regionRowId, row, null, session.userId);

  return res.json({ success: true, deleted_id: regionRowId });
});

// Part 3: Partner Profile
app.get('/api/partner/me', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const partnerId = session.partnerId;
  const partnerRegions = (await db.getTable('partner_regions')).filter(r => r.partner_id === partnerId);
  const regions = await db.getTable('regions');
  const denormRegions = partnerRegions.map(pr => {
    const reg = regions.find(r => r.id === pr.region_id);
    return {
      ...pr,
      region_name: reg ? reg.name : '',
      region_code: reg ? reg.code : ''
    };
  });

  const packages = (await db.getTable('partner_packages')).filter(p => p.partner_id === partnerId);
  const bindings = (await db.getTable('customer_partner_bindings')).filter(b => b.cable_partner_id === partnerId || b.broadband_partner_id === partnerId);
  const approvals = (await db.getTable('redemption_approvals')).filter(a => a.partner_id === partnerId);
  const disputesOpen = approvals.filter(a => a.status === 'DISPUTED');

  return res.json({
    partner: session.partner,
    user: sanitizeUser(session.user),
    regions: denormRegions,
    packages,
    counts: {
      bound_customers: bindings.length,
      redemptions_all_time: approvals.length,
      disputes_open: disputesOpen.length
    }
  });
});

app.patch('/api/partner/me', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const forbiddenFields = ['legal_name', 'gst_number', 'service_types', 'is_active', 'promoted_from_lead_id'];
  for (const f of forbiddenFields) {
    if (req.body[f] !== undefined) {
      return res.status(400).json({ error: `Forbidden field update: ${f} cannot be modified by partner` });
    }
  }


  const trimField = (val) => typeof val === 'string' ? val.trim() : val;
  let { display_name, contact_phone, contact_email, address, confirm_phone_change, payout_upi_id, payout_bank_account, payout_bank_ifsc, payout_account_name } = req.body;
  
  display_name = trimField(display_name);
  contact_phone = trimField(contact_phone);
  contact_email = trimField(contact_email);
  address = trimField(address);
  payout_upi_id = trimField(payout_upi_id);
  payout_bank_account = trimField(payout_bank_account);
  payout_bank_ifsc = trimField(payout_bank_ifsc);
  payout_account_name = trimField(payout_account_name);

  if (display_name !== undefined && display_name.length > 100) {
    return res.status(400).json({ error: "Display name cannot exceed 100 characters." });
  }
  if (address !== undefined && address.length > 300) {
    return res.status(400).json({ error: "Address cannot exceed 300 characters." });
  }

  const payoutVal = validatePayoutFields({ payout_upi_id, payout_bank_account, payout_bank_ifsc, payout_account_name });
  if (!payoutVal.ok) {
    return res.status(400).json({ error: payoutVal.error });
  }
  if (payoutVal.values.payout_upi_id !== undefined) payout_upi_id = payoutVal.values.payout_upi_id;
  if (payoutVal.values.payout_bank_account !== undefined) payout_bank_account = payoutVal.values.payout_bank_account;
  if (payoutVal.values.payout_bank_ifsc !== undefined) payout_bank_ifsc = payoutVal.values.payout_bank_ifsc;
  if (payoutVal.values.payout_account_name !== undefined) payout_account_name = payoutVal.values.payout_account_name;

  if (contact_phone !== undefined) {
    const validPhone = checkPhone(contact_phone, res);
    if (!validPhone) return;
    contact_phone = validPhone;
  }
  const partners = await db.getTable('partners');
  const users = await db.getTable('users');

  const partnerRow = partners.find(p => p.id === session.partnerId);
  const userRow = users.find(u => u.id === session.userId);
  if (!partnerRow || !userRow) return res.status(404).json({ error: 'Partner or user record not found' });

  if (contact_email && contact_email.toLowerCase() !== (partnerRow.contact_email || '').toLowerCase()) {
    const normalized = contact_email.toLowerCase();
    const emailConflictUser = users.some(u => u.id !== userRow.id && u.email && u.email.trim().toLowerCase() === normalized);
    const emailConflictPartner = partners.some(p => p.id !== partnerRow.id && p.contact_email && p.contact_email.trim().toLowerCase() === normalized);
    if (emailConflictUser || emailConflictPartner) {
      return res.status(409).json({ error: 'Email already registered' });
    }
  }

  if (contact_phone && contact_phone !== partnerRow.contact_phone) {
    const phoneConflictUser = users.some(u => u.id !== userRow.id && u.phone === contact_phone);
    const phoneConflictPartner = partners.some(p => p.id !== partnerRow.id && p.contact_phone === contact_phone);
    if (phoneConflictUser || phoneConflictPartner) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }
    if (!confirm_phone_change) {
      return res.status(400).json({
        warning: 'Changing phone number will change your login phone',
        requires_confirmation: true,
        confirm_field: 'confirm_phone_change'
      });
    }
  }

  const beforePartner = { ...partnerRow };

  const partnerPatch = {};
  const userPatch = {};
  if (display_name !== undefined) {
    partnerPatch.display_name = display_name;
    userPatch.name = display_name;
  }
  if (contact_phone !== undefined) {
    partnerPatch.contact_phone = contact_phone;
    userPatch.phone = contact_phone;
  }
  if (contact_email !== undefined) {
    partnerPatch.contact_email = contact_email;
    userPatch.email = contact_email;
  }
  if (address !== undefined) {
    partnerPatch.address = address;
    userPatch.address = address;
  }

  if (payout_upi_id !== undefined) partnerPatch.payout_upi_id = payout_upi_id;
  if (payout_bank_account !== undefined) partnerPatch.payout_bank_account = payout_bank_account;
  if (payout_bank_ifsc !== undefined) partnerPatch.payout_bank_ifsc = payout_bank_ifsc;
  if (payout_account_name !== undefined) partnerPatch.payout_account_name = payout_account_name;

  if (Object.keys(partnerPatch).length > 0) {
    partnerPatch.updated_at = new Date().toISOString();
  }

  let finalPartner, finalUser;
  try {
    const txRes = await db.transaction(async (tx) => {
      let p = partnerRow;
      let u = userRow;
      if (Object.keys(partnerPatch).length > 0) {
        p = await tx.updateRow('partners', session.partnerId, partnerPatch);
      }
      if (Object.keys(userPatch).length > 0) {
        u = await tx.updateRow('users', session.userId, userPatch);
      }
      return { p, u };
    });
    finalPartner = txRes.p;
    finalUser = txRes.u;
  } catch (err) {
    console.error('[PATCH /api/partner/me] Error saving profile:', err);
    return res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred. Please try again later.' });
  }

  await appendAudit(req, 'EDIT_PARTNER_PROFILE', 'partner', session.partnerId, beforePartner, finalPartner, session.userId);
  await capturePayoutEvent(req, 'partner', session.partnerId, beforePartner, finalPartner, session.userId);

  return res.json({
    partner: finalPartner,
    user: sanitizeUser(finalUser)
  });
});

// Part 4: Partner Feedback
app.post('/api/partner/feedback', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { linked_type, linked_redemption_approval_id, category, subject, description } = req.body;
  if (!subject || !description || description.trim().length < 20) {
    return res.status(400).json({ error: 'description must be at least 20 characters' });
  }

  if (linked_type === 'REDEMPTION') {
    if (!linked_redemption_approval_id) {
      return res.status(400).json({ error: 'linked_redemption_approval_id is required for REDEMPTION linked_type' });
    }
    const approvals = await db.getTable('redemption_approvals');
    const approval = approvals.find(a => a.id === linked_redemption_approval_id);
    if (!approval || approval.partner_id !== session.partnerId) {
      return res.status(403).json({ error: 'Forbidden: linked redemption does not belong to this partner' });
    }
  }

  const feedbackList = await db.getTable('partner_feedback');
  const newFeedback = {
    id: 'pfb-' + generateId(),
    partner_id: session.partnerId,
    submitted_by_user_id: session.userId,
    linked_type: linked_type || 'GENERAL',
    linked_redemption_approval_id: linked_type === 'REDEMPTION' ? linked_redemption_approval_id : null,
    category: category || 'GENERAL',
    subject: subject.trim(),
    description: description.trim(),
    status: 'NEW',
    admin_notes: null,
    created_at: new Date().toISOString(),
    resolved_at: null
  };

  feedbackList.push(newFeedback);
  await db.saveTable('partner_feedback', feedbackList);

  return res.json(newFeedback);
});

app.get('/api/partner/feedback', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const feedbackList = await db.getTable('partner_feedback');
  const result = feedbackList
    .filter(f => f.partner_id === session.partnerId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return res.json(result);
});

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
app.get('/api/partner/notifications', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  let notifications = (await db.getTable('partner_notifications')).filter(n => n.partner_id === session.partnerId);

  if (req.query.unread_only === 'true') {
    notifications = notifications.filter(n => !n.is_read);
  }

  const result = notifications
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);

  return res.json(result);
});

app.post('/api/partner/notifications/mark-read', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { notification_ids, mark_all } = req.body || {};
  const notifications = await db.getTable('partner_notifications');

  if (mark_all === true) {
    notifications.forEach(n => {
      if (n.partner_id === session.partnerId) {
        n.is_read = true;
      }
    });
    await db.saveTable('partner_notifications', notifications);
    return res.json({ success: true });
  }

  if (!notification_ids || !Array.isArray(notification_ids)) {
    return res.status(400).json({ error: 'notification_ids array or mark_all flag required' });
  }

  // Validate ownership for all requested IDs
  for (const nid of notification_ids) {
    const target = notifications.find(n => n.id === nid);
    if (!target) return res.status(404).json({ error: `Notification ${nid} not found` });
    if (target.partner_id !== session.partnerId) {
      return res.status(403).json({ error: 'Forbidden: notification does not belong to your partner account' });
    }
  }

  notifications.forEach(n => {
    if (notification_ids.includes(n.id)) {
      n.is_read = true;
    }
  });

  await db.saveTable('partner_notifications', notifications);
  return res.json({ success: true });
});

// Reset DB
app.post('/api/admin/reset-db', async (req, res) => {
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
    const total_all_time = orders.length;
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
      if (!o.stockist_id) return;
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



function assertNoDuplicateRoutes(appToTest) {
  const targetApp = appToTest || app;
  const router = targetApp._router || targetApp.router;
  if (!router || !router.stack) return;
  const seen = new Map();
  const dupes = [];
  router.stack.forEach(layer => {
    if (!layer.route) return;
    const routePath = layer.route.path;
    const paths = Array.isArray(routePath) ? routePath : [routePath];
    Object.keys(layer.route.methods).forEach(method => {
      paths.forEach(p => {
        const key = `${method.toUpperCase()} ${p}`;
        if (seen.has(key)) dupes.push(key);
        else seen.set(key, true);
      });
    });
  });
  if (dupes.length) {
    throw new Error(`Duplicate route registrations detected:\n  ${dupes.join('\n  ')}`);
  }
}

async function reportMalformedPhones() {
  const users = await db.getTable('users');
  const partnerLeads = await db.getTable('partner_leads');
  
  let adminCount = 0;
  let customerCount = 0;
  let stockistCount = 0;
  let partnerLeadCount = 0;

  for (const u of users) {
    if (u.phone) {
      const norm = normalizePhone(u.phone);
      if (norm.length !== 10) {
        if (u.role === 'ADMIN') adminCount++;
        else if (u.role === 'CUSTOMER') customerCount++;
        else if (u.role === 'STOCKIST') stockistCount++;
      }
    }
  }

  for (const l of partnerLeads) {
    if (l.phone) {
      const norm = normalizePhone(l.phone);
      if (norm.length !== 10) {
        partnerLeadCount++;
      }
    }
  }

  console.log(`[Diagnostic] Malformed phones found: Users(ADMIN: ${adminCount}, CUSTOMER: ${customerCount}, STOCKIST: ${stockistCount}), PartnerLeads(${partnerLeadCount})`);
}

app.use((err, req, res, next) => {
  console.error('[Unhandled]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
});

process.on('unhandledRejection', (reason, p) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.get('/api/config/otp-mode', (req, res) => {
  res.json({ demo: require('./lib/env').isDemoOtpMode() });
});

app.get('/api/config/calculator', async (req, res) => {
  try {
    const configs = await db.getTable('commission_config');
    const globalConfig = (configs || []).find(c => c.scope === 'GLOBAL');
    if (!globalConfig) {
      return res.status(503).json({ error: 'calculator_unavailable' });
    }
    const rPct = Number(globalConfig.stockist_reinvest_pct);
    const pPct = Number(globalConfig.points_from_pot_pct);
    if (!Number.isFinite(rPct) || rPct < 0 || rPct > 100 || !Number.isFinite(pPct) || pPct < 0 || pPct > 100) {
      return res.status(503).json({ error: 'calculator_unavailable' });
    }
    res.json({ stockist_reinvest_pct: rPct, points_from_pot_pct: pPct });
  } catch (err) {
    res.status(503).json({ error: 'calculator_unavailable' });
  }
});

function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const errors = [];
  if (require('./lib/env').isTestEnv() || process.env.SEED_MODE === 'test') errors.push('SEED_MODE is test');
  if (process.env.SMS_MOCK === 'true') errors.push('SMS_MOCK is true');
  if (process.env.DEMO_OTP === 'true') errors.push('DEMO_OTP is true');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) errors.push('JWT_SECRET missing or too short');
  if (!process.env.DATABASE_URL) errors.push('DATABASE_URL missing');
  if (!process.env.MSG91_AUTH_KEY) errors.push('MSG91_AUTH_KEY missing');
  if (!process.env.CAPTCHA_SECRET) errors.push('CAPTCHA_SECRET missing');
  if (!process.env.CORS_ORIGINS) errors.push('CORS_ORIGINS missing');
  
  if (errors.length > 0) {
    errors.forEach(e => console.error(e));
    process.exit(1);
  }
}

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
  setMainWholesaler
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
