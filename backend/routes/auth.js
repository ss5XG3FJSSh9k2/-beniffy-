
const db = require('../db');
const cfg = require('../config');
const { isLocalDev } = require('../lib/env');
const smsHelper = require('../lib/sms');
const emailHelper = require('../lib/email');
const sessionHelper = require('../lib/session');
const { evaluateRegistrationFlags } = require('../lib/kyc-flags');
const {
  checkTermsAgreed, checkPhone, validateUserInput, checkEmail, sanitizePlainText
} = require('../lib/validation');
const {
  checkLoginRateLimit, checkOtpRateLimit, clearOtpRateLimit
} = require('../lib/rate-limits');
const { sanitizeUser, generateId } = require('../lib/misc');
const { uploadBillMiddleware } = require('../lib/bills');

const messageTemplates = require('../lib/message-templates');
const path = require('path');
const fs = require('fs');
const r2 = require('../lib/r2');
const { stockistKycGate } = require('../lib/access');
const { issueOtp, verifyOtp } = require('../lib/otp');
const { appendAudit } = require('../lib/audit');

function registerAuthRoutes(app) {
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
  const lang = req.body && req.body.lang ? req.body.lang : 'en';
  const sendViaEmail = isEmail || (req.body && req.body.channel === 'email');

  if (sendViaEmail) {
    const targetEmail = isEmail ? identifier.trim().toLowerCase() : (user ? user.email : null);
    if (!targetEmail) {
      return res.status(400).json({ error: 'No email address registered for this account', message: 'This account does not have a registered email address.' });
    }
    try {
      const text = messageTemplates.renderTemplate('LOGIN_OTP', lang, { otp: code });
      await emailHelper.sendEmail(targetEmail, 'Beniffy Verification Code', `<p>${text}</p>`, text);
      return res.json({
        success: true,
        message: 'OTP sent by email',
        channel: 'email',
        destination: targetEmail,
        has_email: true
      });
    } catch (err) {
      return res.status(500).json({ error: 'email_error', message: 'Failed to send verification email' });
    }
  }

  try {
    const cleanPhone = user ? user.phone : checkPhone(identifier, res);
    if (!cleanPhone) return;
    await smsHelper.sendTemplateSms(cleanPhone, 'LOGIN_OTP', { otp: code }, { lang });
    return res.json({
      success: true,
      message: 'OTP sent via SMS',
      channel: 'sms',
      destination: cleanPhone,
      has_email: !!(user && user.email)
    });
  } catch (err) {
    if (err.code === 'SMS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'sms_unavailable' });
    }
    if (err.code === 'DLT_TEMPLATE_MISSING') {
      return res.status(503).json({ error: 'dlt_template_missing', message: 'SMS template not approved on DLT' });
    }
    return res.status(500).json({ error: 'sms_error' });
  }
};

app.post('/api/auth/send-otp', handleSendOtpRoute);
app.post('/api/stockist/auth/send-otp', handleSendOtpRoute);

// POST /api/auth/register-customer (Item 16, Item 12, Item 15)
app.post('/api/auth/register-customer', async (req, res) => {
  let { phone, email, name, regionId, region_id, address, cable_partner_id, broadband_partner_id, captchaToken, termsAgreed, whatsapp_opt_in, whatsappOptIn } = req.body || {};

  const isTest = require('../lib/env').isTestEnv();

  if (!checkTermsAgreed(req, res, isTest)) return;

  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;

  const validationErr = validateUserInput({ email, name });
  if (validationErr) return res.status(400).json({ error: validationErr });

  const targetRegionId = regionId || region_id;
  if (!targetRegionId) {
    return res.status(400).json({ error: 'Choose a region.', message: 'Choose a region.' });
  }
  const regionsList = await db.getTable('regions');
  if (!regionsList.some(r => r.id === targetRegionId)) {
    return res.status(400).json({ error: 'Invalid region', message: 'Region does not exist.' });
  }
  const cleanName = sanitizePlainText(name, 50);
  const validEmail = await checkEmail(email, res);
  if (!validEmail) return;
  const cleanAddress = address ? sanitizePlainText(address, 255) : '';

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
    whatsapp_opt_in: (whatsapp_opt_in === true || whatsappOptIn === true),
    whatsapp_opt_in_at: (whatsapp_opt_in === true || whatsappOptIn === true) ? new Date().toISOString() : null,
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

  const sessionHelper = require('../lib/session');
  const token = sessionHelper.signSession(newUser.id, newUser.role);

  res.status(200).json({
    success: true,
    token,
    user: sanitizeUser(newUser),
    bindings: binding
  });
});

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
  let { phone, email, name, address, cable_partner_id, broadband_partner_id, referral_code, whatsapp_opt_in, whatsappOptIn } = req.body;
  const regionId = req.body.region_id || req.body.regionId;

  if (!phone || !name || !regionId) {
    return res.status(400).json({ error: 'Name, phone, and region are required' });
  }

  const isTest = require('../lib/env').isTestEnv();
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
    name: sanitizePlainText(name, 50),
    role: 'CUSTOMER',
    kyc_status: 'APPROVED',
    no_show_count: 0,
    address: address ? sanitizePlainText(address, 255) : '',
    referred_by_user_id: referrerId,
    referral_bonus_paid: false,
    whatsapp_opt_in: (whatsapp_opt_in === true || whatsappOptIn === true),
    whatsapp_opt_in_at: (whatsapp_opt_in === true || whatsappOptIn === true) ? new Date().toISOString() : null,
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

  const sessionHelper = require('../lib/session');
  const token = sessionHelper.signSession(user.id, user.role);

  const resObj = { success: true, token, user: sanitizeUser(user), referral_code: user.referral_code };
  if (bindings) resObj.bindings = bindings;
  return res.json(resObj);
});

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
    const kycDir = path.join(__dirname, '..', 'uploads', 'kyc');
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
}

module.exports = { registerAuthRoutes };
