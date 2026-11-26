
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { generateId, getPartnerSession } = require('../lib/misc');
const { appendAudit } = require('../lib/audit');
const { calculatePartnerPayout } = require('../services/orders');

function registerPartnerRoutes(app) {
app.post('/api/partner/packages', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  if (req.body.partner_id && req.body.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Cannot create package for a different partner' });
  }

  const { service_type, name, description, face_value_rupees, cost_to_partner_rupees, point_cost, active_regions } = req.body;
  const partner = session.partner;
  const partnerId = partner.id;

  if (!service_type || !partner.service_types || !partner.service_types.includes(service_type)) {
    return res.status(400).json({ error: 'Service type must match one of partner service_types' });
  }

  if (!name || face_value_rupees === undefined || !active_regions || !Array.isArray(active_regions) || active_regions.length === 0) {
    return res.status(400).json({ error: 'At least one active region is required for this package' });
  }

  const partnerRegions = (await db.getTable('partner_regions')).filter(pr => pr.partner_id === partnerId && pr.service_type === service_type && pr.is_active !== false);
  const partnerRegionIds = partnerRegions.map(pr => pr.region_id);

  if (!active_regions.every(rId => partnerRegionIds.includes(rId))) {
    return res.status(400).json({ error: 'Every active_region must be an active region served by partner for this service_type' });
  }

  const face = Number(face_value_rupees);
  const cost = Number(cost_to_partner_rupees !== undefined ? cost_to_partner_rupees : face_value_rupees);
  if (cost >= face) {
    return res.status(400).json({ 
      error: 'Cost to Partner must be less than Face Value',
      received: { cost_to_partner_rupees: cost, face_value_rupees: face }
    });
  }

  const pType = req.body.package_type || (req.body.is_timed ? 'PAID' : (req.body.duration_days ? 'PAID' : 'FREE'));
  let durDays = req.body.duration_days !== undefined && req.body.duration_days !== null ? Number(req.body.duration_days) : null;
  if (pType !== 'FREE' && (!durDays || durDays <= 0)) {
    return res.status(400).json({ error: 'Duration required for paid/promotional packages' });
  }
  if (pType === 'FREE') {
    durDays = null;
  }

  const now = new Date().toISOString();
  const packages = await db.getTable('partner_packages');
  const newPkg = {
    id: 'ppk-' + generateId(),
    partner_id: partnerId,
    service_type,
    name,
    description: description || '',
    face_value_rupees: face,
    cost_to_partner_rupees: cost,
    point_cost: Number(point_cost !== undefined ? point_cost : face_value_rupees),
    active_regions,
    duration_days: durDays,
    is_timed: (pType !== 'FREE'),
    is_active: true,
    created_at: now,
    updated_at: now
  };
  packages.push(newPkg);
  await db.saveTable('partner_packages', packages);

  return res.json(newPkg);
});

app.patch('/api/partner/packages/:packageId', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const targetFace = req.body.face_value_rupees !== undefined ? Number(req.body.face_value_rupees) : pkg.face_value_rupees;
  const targetCost = req.body.cost_to_partner_rupees !== undefined ? Number(req.body.cost_to_partner_rupees) : pkg.cost_to_partner_rupees;
  if (targetCost !== undefined && targetFace !== undefined && targetCost >= targetFace) {
    return res.status(400).json({ 
      error: 'Cost to Partner must be less than Face Value',
      received: { cost_to_partner_rupees: targetCost, face_value_rupees: targetFace }
    });
  }

  const mutableFields = ['name', 'description', 'face_value_rupees', 'cost_to_partner_rupees', 'point_cost', 'active_regions', 'duration_days', 'is_timed'];
  mutableFields.forEach(f => {
    if (req.body[f] !== undefined) {
      if (f === 'face_value_rupees' || f === 'cost_to_partner_rupees' || f === 'point_cost' || f === 'duration_days') {
        pkg[f] = req.body[f] !== null ? Number(req.body[f]) : null;
      } else {
        pkg[f] = req.body[f];
      }
    }
  });
  if (req.body.package_type !== undefined) {
    pkg.is_timed = (req.body.package_type !== 'FREE');
    if (req.body.package_type === 'FREE') pkg.duration_days = null;
  }
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  return res.json(pkg);
});

app.post('/api/partner/packages/:packageId/deactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  pkg.is_active = false;
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  return res.json(pkg);
});

app.post('/api/partner/packages/:packageId/reactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { packageId } = req.params;
  const packages = await db.getTable('partner_packages');
  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  pkg.is_active = true;
  pkg.updated_at = new Date().toISOString();
  await db.saveTable('partner_packages', packages);

  return res.json(pkg);
});

app.get('/api/partner/redemption-queue', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const approvals = await db.getTable('redemption_approvals');
  const partnerApprovals = approvals.filter(a =>
    a.partner_id === session.partnerId &&
    ['APPROVED_AWAITING_PARTNER', 'DISPUTED'].includes(a.status)
  );

  const users = await db.getTable('users');
  const packages = await db.getTable('partner_packages');

  const result = partnerApprovals.map(a => {
    const cust = users.find(u => u.id === a.customer_user_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      customer_name: cust ? cust.name : 'Unknown Customer',
      customer_phone: cust ? cust.phone : '',
      package_name: pkg ? pkg.name : 'Unknown Package'
    };
  });

  return res.json(result);
});

app.get('/api/partner/redemption-history', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { status, date_from, date_to } = req.query;
  let approvals = (await db.getTable('redemption_approvals')).filter(a => a.partner_id === session.partnerId);

  if (status) approvals = approvals.filter(a => a.status === status);
  if (date_from) approvals = approvals.filter(a => new Date(a.created_at) >= new Date(date_from));
  if (date_to) approvals = approvals.filter(a => new Date(a.created_at) <= new Date(date_to));

  const users = await db.getTable('users');
  const packages = await db.getTable('partner_packages');

  const result = approvals.map(a => {
    const cust = users.find(u => u.id === a.customer_user_id);
    const pkg = packages.find(p => p.id === a.partner_package_id);
    return {
      ...a,
      customer_name: cust ? cust.name : 'Unknown Customer',
      customer_phone: cust ? cust.phone : '',
      package_name: pkg ? pkg.name : 'Unknown Package'
    };
  });

  return res.json(result);
});

app.post('/api/partner/redemption-approvals/:id/fulfill', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const { partner_notes } = req.body;

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (approval.status !== 'APPROVED_AWAITING_PARTNER' && approval.status !== 'DISPUTED') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  const oldStatus = approval.status;
  approval.status = 'FULFILLED';
  if (partner_notes) approval.partner_notes = partner_notes;
  approval.fulfilled_at = new Date().toISOString();
  approval.updated_at = new Date().toISOString();

  await db.saveTable('redemption_approvals', approvals);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'PARTNER_FULFILLED',
    entity_type: 'redemption_approval',
    entity_id: id,
    user_id: session.userId,
    before: { status: oldStatus },
    after: { status: 'FULFILLED' },
    notes: partner_notes || 'Partner fulfilled redemption',
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json(approval);
});

app.post('/api/partner/redemption-approvals/:id/dispute', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({ error: 'Reason must be at least 10 characters long' });
  }

  const approvals = await db.getTable('redemption_approvals');
  const approval = approvals.find(a => a.id === id);
  if (!approval) return res.status(404).json({ error: 'Redemption approval not found' });

  if (approval.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (approval.status !== 'APPROVED_AWAITING_PARTNER') {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  approval.status = 'DISPUTED';
  approval.disputed_reason = reason.trim();
  approval.disputed_at = new Date().toISOString();
  approval.updated_at = new Date().toISOString();

  await db.saveTable('redemption_approvals', approvals);

  const auditLogs = await db.getTable('admin_audit_log');
  auditLogs.push({
    id: 'aud-' + generateId(),
    action: 'PARTNER_DISPUTED',
    entity_type: 'redemption_approval',
    entity_id: id,
    user_id: session.userId,
    before: { status: 'APPROVED_AWAITING_PARTNER' },
    after: { status: 'DISPUTED', disputed_reason: reason.trim() },
    notes: reason.trim(),
    created_at: new Date().toISOString()
  });
  await db.saveTable('admin_audit_log', auditLogs);

  return res.json(approval);
});

app.get('/api/partner/dashboard', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const partnerId = session.partnerId;
  const approvals = await db.getTable('redemption_approvals');
  const partnerApprovals = approvals.filter(a => a.partner_id === partnerId);

  // IST date math
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const year = istNow.getUTCFullYear();
  const month = istNow.getUTCMonth();
  const date = istNow.getUTCDate();

  const startOfTodayIST = new Date(Date.UTC(year, month, date) - istOffsetMs).toISOString();
  const startOfMonthIST = new Date(Date.UTC(year, month, 1) - istOffsetMs).toISOString();

  const todayRedemptions = partnerApprovals.filter(a =>
    ['APPROVED_AWAITING_PARTNER', 'FULFILLED'].includes(a.status) && a.created_at >= startOfTodayIST
  );
  const todayFulfilled = partnerApprovals.filter(a =>
    a.status === 'FULFILLED' && ((a.fulfilled_at || a.updated_at || a.created_at) >= startOfTodayIST)
  );
  const todayPending = partnerApprovals.filter(a => a.status === 'APPROVED_AWAITING_PARTNER');

  const monthRedemptions = partnerApprovals.filter(a =>
    a.created_at >= startOfMonthIST && a.status !== 'REJECTED'
  );
  const monthFulfilled = partnerApprovals.filter(a =>
    a.status === 'FULFILLED' && ((a.fulfilled_at || a.updated_at || a.created_at) >= startOfMonthIST)
  );

  let faceValueTotalRupees = 0;
  let expectedPayoutRupees = 0;

  for (const row of monthFulfilled) {
    const faceVal = parseFloat(row.face_value_rupees || 0);
    faceValueTotalRupees += faceVal;
    const payoutInfo = await calculatePartnerPayout(faceVal, row.stockist_id || null);
    expectedPayoutRupees += payoutInfo.partnerPayout;
  }

  const openDisputes = partnerApprovals.filter(a => a.status === 'DISPUTED');

  return res.json({
    today: {
      redemptions_count: todayRedemptions.length,
      fulfilled_count: todayFulfilled.length,
      pending_count: todayPending.length
    },
    month: {
      redemptions_count: monthRedemptions.length,
      fulfilled_count: monthFulfilled.length,
      face_value_total_rupees: Math.round(faceValueTotalRupees * 100) / 100,
      expected_payout_rupees: Math.round(expectedPayoutRupees * 100) / 100
    },
    disputes: {
      open_count: openDisputes.length
    }
  });
});

app.get('/api/partner/regions', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const partnerRegions = (await db.getTable('partner_regions')).filter(r => r.partner_id === session.partnerId);
  const regions = await db.getTable('regions');

  const result = partnerRegions.map(pr => {
    const reg = regions.find(r => r.id === pr.region_id);
    return {
      ...pr,
      region_name: reg ? reg.name : '',
      region_code: reg ? reg.code : ''
    };
  });

  return res.json(result);
});

app.post('/api/partner/regions', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { region_id, service_type, service_types } = req.body;
  
  const typesToProcess = service_types ? service_types : (service_type ? [service_type] : []);

  if (!region_id || typesToProcess.length === 0) {
    return res.status(400).json({ error: 'region_id and service_types are required' });
  }

  const partnerServiceTypes = session.partner.service_types || [];
  for (const st of typesToProcess) {
    if (!partnerServiceTypes.includes(st)) {
      return res.status(400).json({ error: 'One or more service_types not supported by partner' });
    }
  }

  const regions = await db.getTable('regions');
  const regionExists = regions.some(r => r.id === region_id);
  if (!regionExists) {
    return res.status(400).json({ error: 'region_id does not exist' });
  }

  const partnerRegions = await db.getTable('partner_regions');
  
  const createdRows = [];
  const skippedTypes = [];

  for (const st of typesToProcess) {
    const duplicate = partnerRegions.some(pr =>
      pr.partner_id === session.partnerId && pr.region_id === region_id && pr.service_type === st
    );
    if (duplicate) {
      skippedTypes.push(st);
      continue;
    }
    
    const newRow = {
      id: 'prg-' + generateId(),
      partner_id: session.partnerId,
      region_id,
      service_type: st,
      is_active: true,
      created_at: new Date().toISOString()
    };
    createdRows.push(newRow);
  }

  if (createdRows.length === 0 && skippedTypes.length > 0) {
    return res.status(409).json({ error: 'Region mapping already exists for all provided service_types' });
  }

  if (createdRows.length > 0) {
    for (const newRow of createdRows) {
      partnerRegions.push(newRow);
    }
    await db.saveTable('partner_regions', partnerRegions);

    for (const newRow of createdRows) {
      await appendAudit(req, 'PARTNER_REGION_ADD', 'partner_region', newRow.id, null, newRow, session.userId);
    }
  }

  if (!req.body.service_types && createdRows.length === 1) {
    return res.json(createdRows[0]);
  }

  return res.json({
    created: createdRows,
    skipped: skippedTypes
  });
});

app.post('/api/partner/regions/:regionRowId/deactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { regionRowId } = req.params;
  const { confirm } = req.body || {};

  const partnerRegions = await db.getTable('partner_regions');
  const row = partnerRegions.find(pr => pr.id === regionRowId);
  if (!row) return res.status(404).json({ error: 'Region mapping not found' });

  if (row.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden: region mapping does not belong to your partner account' });
  }

  const partnerPackages = await db.getTable('partner_packages');
  const referencingPackages = partnerPackages.filter(p =>
    p.partner_id === session.partnerId &&
    p.is_active !== false &&
    Array.isArray(p.active_regions) &&
    p.active_regions.includes(row.region_id)
  );

  if (referencingPackages.length > 0 && !confirm) {
    return res.status(400).json({
      warning: `Region is referenced by ${referencingPackages.length} active package(s)`,
      requires_confirmation: true,
      referencing_packages: referencingPackages.map(p => ({ id: p.id, name: p.name }))
    });
  }

  row.is_active = false;
  await db.saveTable('partner_regions', partnerRegions);
  await appendAudit(req, 'PARTNER_REGION_DEACTIVATE', 'partner_region', regionRowId, { is_active: true }, { is_active: false }, session.userId);

  return res.json(row);
});

app.post('/api/partner/regions/:regionRowId/reactivate', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const row = partnerRegions.find(pr => pr.id === regionRowId);
  if (!row) return res.status(404).json({ error: 'Region mapping not found' });

  if (row.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden: region mapping does not belong to your partner account' });
  }

  row.is_active = true;
  await db.saveTable('partner_regions', partnerRegions);
  await appendAudit(req, 'PARTNER_REGION_REACTIVATE', 'partner_region', regionRowId, { is_active: false }, { is_active: true }, session.userId);

  return res.json(row);
});

app.delete('/api/partner/regions/:regionRowId', requireAuth, async (req, res) => {
  const session = await getPartnerSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized or invalid session' });

  const { regionRowId } = req.params;
  const partnerRegions = await db.getTable('partner_regions');
  const idx = partnerRegions.findIndex(pr => pr.id === regionRowId);
  if (idx === -1) return res.status(404).json({ error: 'Region mapping not found' });

  const row = partnerRegions[idx];
  if (row.partner_id !== session.partnerId) {
    return res.status(403).json({ error: 'Forbidden: region mapping does not belong to your partner account' });
  }

  const partnerPackages = await db.getTable('partner_packages');
  const referencingPackages = partnerPackages.filter(p =>
    p.partner_id === session.partnerId &&
    Array.isArray(p.active_regions) &&
    p.active_regions.includes(row.region_id)
  );

  if (referencingPackages.length > 0) {
    return res.status(400).json({ error: 'Cannot delete region referenced by packages' });
  }

  partnerRegions.splice(idx, 1);
  await db.saveTable('partner_regions', partnerRegions);
  await appendAudit(req, 'PARTNER_REGION_DELETE', 'partner_region', regionRowId, row, null, session.userId);

  return res.json({ success: true, deleted_id: regionRowId });
});

// Part 3: Partner Profile
}

module.exports = { registerPartnerRoutes };
