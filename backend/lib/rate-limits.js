
const cfg = require('../config');
const db = require('../db');

const apiRateLimitMap = new Map();
const loginRateLimitMap = new Map();
const otpRateLimitMap = new Map();
const otpHourlyLimitMap = new Map();

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
    const _remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
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

const loginPasswordFailedAttempts = new Map();
const otpRequestAttempts = new Map();
const resetTokens = new Map();

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

module.exports = {
  apiRateLimitMap,
  loginRateLimitMap,
  otpRateLimitMap,
  otpHourlyLimitMap,
  checkLoginRateLimit,
  checkOtpRateLimit,
  clearOtpRateLimit,
  loginPasswordFailedAttempts,
  otpRequestAttempts,
  resetTokens,
  phoneChangeMarkers,
  sendCurrentRateLimits,
  sendNewRateLimits,
  getPhoneChangeMarker,
  checkSendRateLimit
};
