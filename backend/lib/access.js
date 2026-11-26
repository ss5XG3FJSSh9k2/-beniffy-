
const db = require('../db');

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
    if (order.payment_method === 'ONLINE' && order.payment_status !== 'PAID_ONLINE') {
      res.status(403).json({ error: 'Order not sent to shop' });
      return false;
    }
    const callerStockist = await getCallerStockist(req);
    if (callerStockist && callerStockist.id === order.stockist_id) return true;
  }
  res.status(403).json({ error: 'Forbidden' });
  return false;
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

module.exports = {
  assertSelfOrAdmin,
  getCallerStockist,
  assertOwnsStockist,
  assertOrderAccess,
  stockistKycGate
};
