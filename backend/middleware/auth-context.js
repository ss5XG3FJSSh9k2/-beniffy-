const jwt = require('jsonwebtoken');
const db = require('../db');
const sessionHelper = require('../lib/session');
const { stockistKycGate } = require('../lib/access');

module.exports = async (req, res, next) => {
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
};
