
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { generateId } = require('../lib/misc');

const { assertSelfOrAdmin } = require('../lib/access');

function registerFeedbackRoutes(app) {
app.post('/api/feedback', requireAuth, async (req, res) => {
  const { orderId, rating, reason, reportFlag } = req.body;
  const targetOrderId = orderId || req.body.order_id;
  if (!targetOrderId || rating === undefined) {
    return res.status(400).json({ error: 'Order ID and rating are required.' });
  }

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === targetOrderId);

  let reporter_id = req.user.userId;
  let reporter_role = req.user.role;
  let reporter_stockist_id = null;
  let target_id = null;
  let target_role = null;

  if (reporter_role === 'STOCKIST') {
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const stockists = await db.getTable('stockists');
    const shop = stockists.find(s => s.user_id === reporter_id);
    if (!shop) {
      return res.status(403).json({ error: 'Shop not found for stockist' });
    }
    if (order.stockist_id !== shop.id) {
      return res.status(403).json({ error: 'Forbidden: order does not belong to your shop' });
    }
    reporter_stockist_id = shop.id;
    target_id = order.customer_id;
    target_role = 'CUSTOMER';
  } else if (reporter_role === 'CUSTOMER') {
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.customer_id !== reporter_id) {
      return res.status(403).json({ error: 'Forbidden: order does not belong to you' });
    }
    target_id = order.stockist_id;
    target_role = 'STOCKIST';
  } else if (reporter_role === 'ADMIN') {
    if (req.body.reporterRole === 'STOCKIST') {
      reporter_role = 'STOCKIST';
      const stockists = await db.getTable('stockists');
      const shop = stockists.find(s => s.id === req.body.reporterId || s.user_id === req.body.reporterId) || (order ? stockists.find(s => s.id === order.stockist_id) : null);
      if (shop) {
        reporter_stockist_id = shop.id;
        reporter_id = shop.user_id;
      } else {
        reporter_id = req.body.reporterId || req.user.userId;
      }
      target_id = order ? order.customer_id : req.body.targetId;
      if (!target_id) {
        return res.status(400).json({ error: 'Target customer ID is required' });
      }
      target_role = 'CUSTOMER';
    } else if (req.body.reporterRole === 'CUSTOMER') {
      reporter_role = 'CUSTOMER';
      reporter_id = req.body.reporterId || (order ? order.customer_id : null);
      if (!reporter_id) {
        return res.status(400).json({ error: 'Reporter customer ID is required' });
      }
      target_id = order ? order.stockist_id : req.body.targetId;
      if (!target_id) {
        return res.status(400).json({ error: 'Target stockist ID is required' });
      }
      target_role = 'STOCKIST';
    } else {
      target_id = order ? (order.customer_id || order.stockist_id) : req.body.targetId;
      if (!target_id) {
        return res.status(400).json({ error: 'Target ID is required' });
      }
      target_role = req.body.targetRole || 'CUSTOMER';
    }
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (target_role === 'CUSTOMER') {
    const usersTable = await db.getTable('users');
    if (!usersTable.some(u => u.id === target_id)) {
      return res.status(400).json({ error: 'Customer not found' });
    }
  } else if (target_role === 'STOCKIST') {
    const stockistsTable = await db.getTable('stockists');
    if (!stockistsTable.some(s => s.id === target_id)) {
      return res.status(400).json({ error: 'Stockist not found' });
    }
  }

  const feedback = await db.getTable('feedback_reports');
  const existingIndex = feedback.findIndex(fb => 
    fb.order_id === targetOrderId && 
    (fb.reporter_role === reporter_role || fb.reporter_id === reporter_id || (reporter_stockist_id && fb.reporter_stockist_id === reporter_stockist_id))
  );

  if (existingIndex !== -1) {
    feedback[existingIndex] = {
      ...feedback[existingIndex],
      reporter_id,
      reporter_role,
      reporter_stockist_id: reporter_stockist_id || feedback[existingIndex].reporter_stockist_id || null,
      target_id: target_id || feedback[existingIndex].target_id,
      target_role: target_role || feedback[existingIndex].target_role,
      rating: parseInt(rating, 10),
      reason: reason || '',
      report_flag: !!reportFlag
    };
    await db.saveTable('feedback_reports', feedback);
    return res.json({ success: true, feedback: feedback[existingIndex], updated: true });
  }

  const newFeedback = {
    id: 'fb-' + generateId(),
    reporter_id,
    reporter_role,
    reporter_stockist_id: reporter_stockist_id || null,
    target_id,
    target_role,
    order_id: targetOrderId,
    rating: parseInt(rating, 10),
    reason: reason || '',
    report_flag: !!reportFlag,
    created_at: new Date().toISOString()
  };

  feedback.push(newFeedback);
  await db.saveTable('feedback_reports', feedback);
  return res.json({ success: true, feedback: newFeedback });
});

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
}

module.exports = { registerFeedbackRoutes };
