
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const sessionHelper = require('../lib/session');
const emailHelper = require('../lib/email');
const { issueOtp, verifyOtp } = require('../lib/otp');
const { loginPasswordFailedAttempts, resetTokens, clearOtpRateLimit , otpRequestAttempts } = require('../lib/rate-limits');
const { getPartnerSession , sanitizeUser } = require('../lib/misc');
const { appendAudit } = require('../lib/audit');

const jwt = require('jsonwebtoken');
const { checkPhone } = require('../lib/validation');

function registerPartnerAuthRoutes(app) {
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
      await require('../lib/sms.js').sendSms(phone, `Your Beniffy OTP is ${code}`);
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
}

module.exports = { registerPartnerAuthRoutes };
