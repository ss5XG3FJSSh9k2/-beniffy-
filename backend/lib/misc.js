
const db = require('../db');
const sessionHelper = require('./session');

async function isDNDRegistered(phone) {
  if (!phone) return false;
  // DND Registry check simulation/mock
  const dndList = ['9000000000', '9111111111'];
  const cleanPhone = String(phone).replace(/\D/g, '');
  return dndList.includes(cleanPhone);
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

const generateId = () => Math.random().toString(36).substr(2, 9);

function getISTDateString(date = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function getSetupProgressCounts() {
  const regions = (await db.getTable('regions')) || [];
  const stockists = (await db.getTable('stockists')) || [];
  const vendors = (await db.getTable('vendors')) || [];
  const users = (await db.getTable('users')) || [];
  return {
    regions: regions.filter(r => !r.deleted_at && r.is_active !== false).length,
    wholesalers: vendors.filter(v => !v.deleted_at && v.is_active !== false).length,
    stockists: stockists.filter(s => !s.deleted_at && s.is_active !== false).length,
    customers: users.filter(u => u.role === 'CUSTOMER' && !u.deleted_at && u.is_active !== false && u.kyc_status !== 'RELEASED').length
  };
}

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

module.exports = {
  isDNDRegistered,
  sanitizeUser,
  generateId,
  getISTDateString,
  getSetupProgressCounts,
  ALLOWED_SERVICE_TYPES,
  getPartnerSession
};
