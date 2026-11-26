
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { assertSelfOrAdmin } = require('../lib/access');
const { generateId , sanitizeUser } = require('../lib/misc');
const { checkPhone , sanitizePlainText } = require('../lib/validation');
const { issueOtp, verifyOtp } = require('../lib/otp');
const { appendAudit } = require('../lib/audit');
const { getAvailablePartnersForRegion } = require('../services/stockists');

function registerCustomerRoutes(app) {
app.post('/api/customer/phone-change/request', requireAuth, async (req, res) => {
  let { user_id, new_phone } = req.body;
  if (!user_id || !new_phone) {
  if (!assertSelfOrAdmin(req, res, user_id)) return;
    return res.status(400).json({ error: 'User ID and new phone number are required' });
  }
  const validPhone = checkPhone(new_phone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;
  const users = await db.getTable('users');
  const existing = users.find(u => u.kyc_status !== 'RELEASED' && u.phone === cleanPhone);
  if (existing) {
    return res.status(409).json({ error: 'Phone number already registered' });
  }
  const currentCode = issueOtp('customer-phone-change-current:' + user_id);
  const newCode = issueOtp('customer-phone-change-new:' + user_id);
  const user = users.find(u => u.id === user_id);
  const smsHelper = require('../lib/sms.js');
  try {
    if (user && user.phone) await smsHelper.sendSms(user.phone, `Your Beniffy code for changing phone number is ${currentCode}.`);
    await smsHelper.sendSms(cleanPhone, `Your Beniffy code to confirm new phone number is ${newCode}.`);
    return res.json({ success: true, message: 'OTP sent to both phone numbers' });
  } catch (err) {
    if (err.code === 'SMS_NOT_CONFIGURED') return res.status(503).json({ error: 'sms_unavailable' });
    return res.status(500).json({ error: 'sms_error' });
  }
});

app.post('/api/customer/phone-change/verify', requireAuth, async (req, res) => {
  let { user_id, new_phone, current_otp, new_otp, otp } = req.body;
  if (!user_id || !new_phone) {
  if (!assertSelfOrAdmin(req, res, user_id)) return;
    return res.status(400).json({ error: 'User ID and new phone are required' });
  }
  const checkCurrent = current_otp || otp;
  const checkNew = new_otp || otp;
  if (!checkCurrent || !checkNew) return res.status(400).json({ error: 'Both OTPs are required' });
  if (!/^\d{6}$/.test(String(checkCurrent).trim()) || !/^\d{6}$/.test(String(checkNew).trim())) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  const vCurrent = verifyOtp('customer-phone-change-current:' + user_id, checkCurrent);
  const vNew = verifyOtp('customer-phone-change-new:' + user_id, checkNew);
  if (!vCurrent.ok || !vNew.ok) {
    if (vCurrent.reason === 'locked' || vNew.reason === 'locked') return res.status(429).json({ error: 'Too many attempts.' });
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  const validPhone = checkPhone(new_phone, res);
  if (!validPhone) return;
  const cleanPhone = validPhone;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === user_id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const oldPhone = user.phone;
  user.phone = cleanPhone;
  await db.saveTable('users', users);
  await appendAudit(req, 'PHONE_CHANGE_VERIFIED', 'user', user_id, { phone: oldPhone }, { phone: cleanPhone });
  return res.json({ success: true, message: 'Phone number updated successfully', user });
});

// Self-service Customer Region Change
app.post('/api/customer/region-change', requireAuth, async (req, res) => {
  const { user_id, new_region_id } = req.body;
  if (!assertSelfOrAdmin(req, res, user_id)) return;
  if (!user_id || !new_region_id) {
    return res.status(400).json({ error: 'User ID and new region ID are required' });
  }
  const users = await db.getTable('users');
  const user = users.find(u => u.id === user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const oldRegionId = user.region_id;
  user.region_id = new_region_id;
  await db.saveTable('users', users);

  // Check customer_partner_bindings
  const bindings = await db.getTable('customer_partner_bindings');
  const partnerRegions = await db.getTable('partner_regions');
  const partners = await db.getTable('partners');

  let clearedPartnerNames = [];
  const updatedBindings = [];
  for (const binding of bindings) {
    const bCustId = binding.customer_user_id || binding.customer_id || binding.user_id;
    if (bCustId === user_id) {
      const partnerId = binding.partner_id || binding.cable_partner_id || binding.broadband_partner_id;
      const servesNewRegion = partnerRegions.some(pr => pr.partner_id === partnerId && pr.region_id === new_region_id && pr.is_active !== false);
      if (!servesNewRegion) {
        const partner = partners.find(p => p.id === partnerId);
        const pName = partner ? (partner.display_name || partner.name || partner.legal_name) : 'Selected Partner';
        if (!clearedPartnerNames.includes(pName)) clearedPartnerNames.push(pName);
        continue;
      }
    }
    updatedBindings.push(binding);
  }

  if (updatedBindings.length !== bindings.length) {
    await db.saveTable('customer_partner_bindings', updatedBindings);
  }

  const clearedPartnerName = clearedPartnerNames.join(', ') || null;

  await appendAudit(req, 'REGION_CHANGE', 'user', user_id, { region_id: oldRegionId }, { region_id: new_region_id, cleared_partner: clearedPartnerName });
  return res.json({
    success: true,
    user,
    cleared_partner_name: clearedPartnerName,
    message: clearedPartnerName
      ? `Region updated. Your binding with ${clearedPartnerName} was cleared as they do not serve the new area.`
      : 'Region updated successfully.'
  });
});

app.post('/api/customer/partner-bindings', requireAuth, async (req, res) => {
  const { customer_user_id, cable_partner_id, broadband_partner_id } = req.body;
  if (!assertSelfOrAdmin(req, res, customer_user_id)) return;
  if (!customer_user_id) return res.status(400).json({ error: 'customer_user_id is required' });

  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customer_user_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  if (cable_partner_id) {
    const cp = partners.find(p => p.id === cable_partner_id && p.is_active !== false);
    if (!cp || !cp.service_types || !cp.service_types.includes('CABLE')) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Invalid cable partner' });
    }
    const servesRegion = partnerRegions.some(pr => pr.partner_id === cable_partner_id && pr.region_id === customer.region_id && pr.service_type === 'CABLE' && pr.is_active !== false);
    if (!servesRegion) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Cable partner does not serve customer region' });
    }
  }

  if (broadband_partner_id) {
    const bp = partners.find(p => p.id === broadband_partner_id && p.is_active !== false);
    if (!bp || !bp.service_types || !bp.service_types.includes('BROADBAND')) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Invalid broadband partner' });
    }
    const servesRegion = partnerRegions.some(pr => pr.partner_id === broadband_partner_id && pr.region_id === customer.region_id && pr.service_type === 'BROADBAND' && pr.is_active !== false);
    if (!servesRegion) {
      return res.status(400).json({ error: 'invalid_partner_binding', message: 'Broadband partner does not serve customer region' });
    }
  }

  const bindings = await db.getTable('customer_partner_bindings');
  let binding = bindings.find(b => b.customer_user_id === customer_user_id);
  const now = new Date().toISOString();

  if (binding) {
    const before = { cable_partner_id: binding.cable_partner_id, broadband_partner_id: binding.broadband_partner_id };
    binding.cable_partner_id = cable_partner_id !== undefined ? cable_partner_id : binding.cable_partner_id;
    binding.broadband_partner_id = broadband_partner_id !== undefined ? broadband_partner_id : binding.broadband_partner_id;
    binding.updated_at = now;
    await db.saveTable('customer_partner_bindings', bindings);
    await appendAudit(req, 'UPDATE_PARTNER_BINDING', 'customer_partner_binding', customer_user_id, before, binding);
  } else {
    binding = { id: 'cpb-' + generateId(), customer_user_id,
      cable_partner_id: cable_partner_id || null,
      broadband_partner_id: broadband_partner_id || null,
      updated_at: now
    };
    bindings.push(binding);
    await db.saveTable('customer_partner_bindings', bindings);
  }

  return res.json(binding);
});

app.get('/api/customer/partner-bindings/:customer_user_id', requireAuth, async (req, res) => {
  const { customer_user_id } = req.params;
  if (customer_user_id && !assertSelfOrAdmin(req, res, customer_user_id)) return;
  const bindings = await db.getTable('customer_partner_bindings');
  const binding = bindings.find(b => b.customer_user_id === customer_user_id);
  return res.json(binding || null);
});


app.get('/api/customer/available-partners', async (req, res) => {
  const { region_id } = req.query;
  if (!region_id) {
    return res.status(400).json({ error: 'region_id is required' });
  }
  return res.json(await getAvailablePartnersForRegion(region_id));
});

app.get('/api/customer/:id/profile', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!assertSelfOrAdmin(req, res, id)) return;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });

  const bindings = await db.getTable('customer_partner_bindings');
  const binding = bindings.find(b => b.customer_user_id === id) || null;

  const available_partners = await getAvailablePartnersForRegion(user.region_id);

  return res.json({
    user: sanitizeUser(user),
    bindings: binding,
    available_partners
  });
});

app.post('/api/customer/:id/profile', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!assertSelfOrAdmin(req, res, id)) return;
  const { name, address } = req.body;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id && u.role === 'CUSTOMER');
  if (!user) return res.status(404).json({ error: 'Customer not found' });

  const before = { name: user.name, address: user.address || '' };
  if (name && typeof name === 'string' && name.trim()) user.name = sanitizePlainText(name, 50);
  if (address !== undefined) user.address = typeof address === 'string' ? sanitizePlainText(address, 255) : '';
  if (req.body.whatsapp_opt_in !== undefined) {
    const optIn = !!req.body.whatsapp_opt_in;
    if (optIn && !user.whatsapp_opt_in) {
      user.whatsapp_opt_in_at = new Date().toISOString();
    } else if (!optIn) {
      user.whatsapp_opt_in_at = null;
    }
    user.whatsapp_opt_in = optIn;
  }

  await db.saveTable('users', users);
  await appendAudit(req, 'EDIT_CUSTOMER_PROFILE', 'customer', id, before, { name: user.name, address: user.address });

  return res.json({ success: true, user: sanitizeUser(user) });
});

app.get('/api/customer/partner-bindings/:customer_user_id/available', requireAuth, async (req, res) => {
  const { customer_user_id } = req.params;
  if (!assertSelfOrAdmin(req, res, customer_user_id)) return;
  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customer_user_id);
  if (!customer || !customer.region_id) {
    return res.json({ cable: [], broadband: [] });
  }

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  const cablePartnerIds = partnerRegions
    .filter(pr => pr.region_id === customer.region_id && pr.service_type === 'CABLE' && pr.is_active !== false)
    .map(pr => pr.partner_id);

  const broadbandPartnerIds = partnerRegions
    .filter(pr => pr.region_id === customer.region_id && pr.service_type === 'BROADBAND' && pr.is_active !== false)
    .map(pr => pr.partner_id);

  const cablePartners = partners.filter(p => p.is_active !== false && cablePartnerIds.includes(p.id));
  const broadbandPartners = partners.filter(p => p.is_active !== false && broadbandPartnerIds.includes(p.id));

  return res.json({
    cable: cablePartners,
    broadband: broadbandPartners
  });
});

app.get('/api/customer/redemption-status/:approval_id', requireAuth, async (req, res) => {
  const { approval_id } = req.params;
  const { customer_user_id } = req.query;

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === approval_id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });
  if (!assertSelfOrAdmin(req, res, approval.customer_user_id)) return;

  if (customer_user_id && approval.customer_user_id !== customer_user_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return res.json({
    status: approval.status,
    approval,
    timeline: {
      created_at: approval.created_at,
      approved_at: approval.approved_at,
      fulfilled_at: approval.fulfilled_at,
      rejected_at: approval.rejected_at,
      disputed_at: approval.disputed_at
    }
  });
});

app.get('/api/customer/redemptions/:customerUserId', requireAuth, async (req, res) => {
  const { customerUserId } = req.params;
  if (!assertSelfOrAdmin(req, res, customerUserId)) return;
  const approvals = await db.getTable('redemption_approvals');
  const partners = await db.getTable('partners');
  const packages = await db.getTable('partner_packages');

  const customerApprovals = approvals
    .filter(a => a.customer_user_id === customerUserId)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 20);

  const result = customerApprovals.map(a => {
    const partner = partners.find(p => p.id === a.partner_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      package_name: pkg ? pkg.name : (a.package_name || 'Unknown Package'),
      package_duration_days: pkg ? pkg.duration_days : null,
      partner_display_name: partner ? partner.display_name : (a.partner_display_name || partner?.name || 'Partner'),
      partner_name: partner ? partner.display_name : (a.partner_display_name || partner?.name || 'Partner')
    };
  });

  return res.json(result);
});
}

module.exports = { registerCustomerRoutes };
