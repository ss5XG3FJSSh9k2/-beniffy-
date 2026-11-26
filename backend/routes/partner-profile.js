
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { generateId, getPartnerSession , sanitizeUser } = require('../lib/misc');
const { checkPhone } = require('../lib/validation');
const { validatePayoutFields } = require('../lib/payout');
const { appendAudit, capturePayoutEvent } = require('../lib/audit');

function registerPartnerProfileRoutes(app) {
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
}

module.exports = { registerPartnerProfileRoutes };
