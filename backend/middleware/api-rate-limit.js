const db = require('../db');
const { isLocalDev } = require('../lib/env');
const { apiRateLimitMap } = require('../lib/rate-limits');

module.exports = async (req, res, next) => {
  const isResetDb = req.path === '/admin/reset-db' || req.path.startsWith('/admin/reset-db');
  if (isResetDb) {
    if (require('../lib/env').isTestEnv()) return next();
  } else if (isLocalDev() || req.path.includes('/api/setup') || req.path.includes('/api/admin/setup-complete') || req.path.startsWith('/setup/') || req.path === '/setup' || req.path.startsWith('/admin/clear-rate-limits')) {
    return next();
  }

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
};
