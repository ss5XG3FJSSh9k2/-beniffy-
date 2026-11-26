
const db = require('../db');
const { generateId } = require('./misc');

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

// Helper: create a notification
async function createNotification({ userId, type, title, body = '', link = null }) {
  if (!userId) return null;
  const notif = {
    id: 'notif-' + generateId(),
    user_id: userId,
    type,
    title,
    body: body || '',
    link: link || null,
    created_at: new Date().toISOString(),
    read_at: null
  };
  await db.insertRow('notifications', notif);
  return notif;
}

// Helper: append an admin audit log entry

async function capturePayoutEvent(req, entityType, entityId, before, finalEntity, _userId) {
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
  const admin_user_id = (req && req.user && (req.user.userId || req.user.id)) || null;
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

module.exports = {
  appendPaymentEvent,
  createNotification,
  capturePayoutEvent,
  appendAudit
};
