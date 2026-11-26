
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { assertSelfOrAdmin } = require('../lib/access');
const { generateId } = require('../lib/misc');
const { getRedemptionDescription } = require('../services/orders');

function registerLedgerRoutes(app) {
app.get('/api/ledger/balance/:customerId', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  const ledger = await db.getTable('points_ledger');
  const customerLedger = ledger.filter(l => l.customer_id === customerId);
  
  const activeBalance = customerLedger
    .filter(l => l.type !== 'EARN_HELD')
    .reduce((sum, item) => sum + parseFloat(item.amount), 0);
    
  const heldBalance = customerLedger
    .filter(l => l.type === 'EARN_HELD' && l.billing_sync_status === 'HELD')
    .reduce((sum, item) => sum + parseFloat(item.amount), 0);

  return res.json({ 
    balance: Math.round(activeBalance * 100) / 100,
    held_balance: Math.round(heldBalance * 100) / 100
  });
});

app.get('/api/ledger/history/:customerId', requireAuth, async (req, res) => {
  const { customerId } = req.params;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  const ledger = await db.getTable('points_ledger');
  const customerLedger = ledger.filter(l => l.customer_id === customerId).reverse();
  return res.json(customerLedger);
});


app.post('/api/ledger/redeem', requireAuth, async (req, res) => {
  const customerId = req.body.customerId || req.body.customer_user_id;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
  const { redemptionType, partner_package_id, generic_reward_id } = req.body;
  // Number("abc") is NaN, which slips past a plain "<= 0" check.
  const amount = (typeof req.body.amount === 'number' || (typeof req.body.amount === 'string' && req.body.amount.trim() !== ''))
    ? Number(req.body.amount)
    : NaN;
  if (!customerId || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid redemption parameters' });
  }

  const users = await db.getTable('users');
  const customer = users.find(u => u.id === customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const partnerPackages = await db.getTable('partner_packages');
  let pkg = null;

  if (generic_reward_id) {
    return res.status(400).json({ error: 'use_checkout_coupon', message: 'Generic rewards are applied as coupons at checkout.' });
  } else if (partner_package_id) {
    pkg = partnerPackages.find(p => p.id === partner_package_id);
    if (!pkg || pkg.status === 'INACTIVE' || pkg.is_active === false) {
      return res.status(404).json({ error: 'Package missing or inactive' });
    }

    // Customer binding check
    const bindings = await db.getTable('customer_partner_bindings');
    const customerBindings = bindings.filter(b => b.customer_user_id === customerId || b.customer_id === customerId);
    let isBound = false;
    const pkgStLower = (pkg.service_type || '').toLowerCase();
    for (const b of customerBindings) {
      if (pkgStLower === 'cable' && (b.cable_partner_id === pkg.partner_id || (b.service_type?.toLowerCase() === 'cable' && b.partner_id === pkg.partner_id))) {
        isBound = true;
      }
      if (pkgStLower === 'broadband' && (b.broadband_partner_id === pkg.partner_id || (b.service_type?.toLowerCase() === 'broadband' && b.partner_id === pkg.partner_id))) {
        isBound = true;
      }
      if (b.partner_id === pkg.partner_id && (!b.service_type || b.service_type.toLowerCase() === pkgStLower)) {
        isBound = true;
      }
    }
    if (!isBound) {
      return res.status(400).json({ error: 'binding_mismatch', code: 'binding_mismatch' });
    }

    // Amount match check
    if (amount && parseFloat(amount) !== parseFloat(pkg.point_cost)) {
      return res.status(400).json({ error: 'amount_mismatch' });
    }

    // Duration lock check for all packages (fallback to 30 days if untimed)
    const effectiveDuration = (pkg.duration_days && Number(pkg.duration_days) > 0) ? Number(pkg.duration_days) : 30;
    if (true) {
      const activeStatuses = ['PENDING_ADMIN_APPROVAL', 'APPROVED', 'APPROVED_AWAITING_PARTNER', 'DISPUTED', 'FULFILLED'];
      const redemptions = await db.getTable('redemption_approvals');
      const lastRedemption = redemptions
        .filter(r => (r.customer_user_id === customerId || r.customer_id === customerId) && r.partner_package_id === partner_package_id)
        .filter(r => activeStatuses.includes(r.status))
        .sort((a, b) => new Date(b.redeemed_at || b.created_at) - new Date(a.redeemed_at || a.created_at))[0];

      if (lastRedemption) {
        const nextAllowedIso = lastRedemption.next_redemption_allowed_at ||
          (lastRedemption.redeemed_at ? new Date(new Date(lastRedemption.redeemed_at).getTime() + (effectiveDuration * 24 * 60 * 60 * 1000)).toISOString() : null);

        if (nextAllowedIso) {
          const now = new Date();
          if (now < new Date(nextAllowedIso)) {
            const daysLeft = Math.ceil((new Date(nextAllowedIso) - now) / (1000 * 60 * 60 * 24));
            return res.status(400).json({
              error: 'Already redeemed',
              message: `Available again in ${daysLeft} days`,
              available_at: nextAllowedIso
            });
          }
        }
      }
    }
  } else {
    // Legacy generic path validation
    const ALLOWED_REDEMPTION_TYPES = ['BROADBAND_DISCOUNT', 'BROADBAND_DISCOUNT_50', 'BROADBAND_DISCOUNT_100', 'WIFI_TOPUP', 'DATA_TOPUP', 'CABLE_RECHARGE'];
    if (!redemptionType || !ALLOWED_REDEMPTION_TYPES.includes(redemptionType)) {
      return res.status(400).json({ error: 'Invalid redemption type.' });
    }
    // Fixed-value rewards cost exactly their value (1 point = ₹1); only the
    // plain BROADBAND_DISCOUNT lets the customer choose the amount.
    const FIXED_REDEMPTION_COSTS = {
      BROADBAND_DISCOUNT_50: [50],
      BROADBAND_DISCOUNT_100: [100],
      CABLE_RECHARGE: [100, 120, 250]
    };
    const fixedCosts = FIXED_REDEMPTION_COSTS[redemptionType];
    if (fixedCosts && !fixedCosts.includes(amount)) {
      return res.status(400).json({ error: 'amount_mismatch', message: `This reward costs ${fixedCosts.join(' or ')} points.` });
    }
  }

  const ledger = await db.getTable('points_ledger');
  const customerLedger = ledger.filter(l => l.customer_id === customerId);
  const currentBalance = customerLedger.filter(l => l.type !== 'EARN_HELD').reduce((sum, item) => sum + parseFloat(item.amount), 0);

  const reqAmount = pkg ? parseFloat(pkg.point_cost) : parseFloat(amount);

  if (currentBalance < reqAmount) {
    return res.status(400).json({ error: 'Insufficient points balance', code: 'INSUFFICIENT_POINTS' });
  }

  const redeemAmount = -Math.abs(reqAmount);
  const ledgerId = 'l-' + generateId();
  const pts = reqAmount;
  const pkgStUpper = pkg ? (pkg.service_type || '').toUpperCase() : '';
  const finalRedemptionType = pkg ? (pkgStUpper === 'GENERIC' ? 'GENERIC_REWARD' : (pkgStUpper === 'CABLE' ? 'CABLE_RECHARGE' : 'BROADBAND_DISCOUNT')) : redemptionType;
  const description = pkg ? `Reward Redemption: ${pkg.name}` : getRedemptionDescription(finalRedemptionType, pts);

  await db.insertRow('points_ledger', {
    id: ledgerId,
    tenant_id: customer.tenant_id,
    region_id: customer.region_id,
    customer_id: customer.id,
    amount: redeemAmount,
    type: 'REDEEM',
    redemption_type: finalRedemptionType,
    order_id: null,
    description,
    created_at: new Date().toISOString(),
    billing_sync_status: 'PENDING'
  });

  let approvalId = null;
  let approvalRow = null;
  if (pkg) {
    const redemptionApprovals = await db.getTable('redemption_approvals');
    approvalId = 'ra-' + generateId();
    const nowTime = new Date();
    const nowIso = nowTime.toISOString();
    let nextAllowedAt = null;
    if (pkg.service_type === 'generic') {
      if (pkg.cooldown_type === 'DAYS' && parseInt(pkg.cooldown_days, 10) > 0) {
        nextAllowedAt = new Date(nowTime.getTime() + (parseInt(pkg.cooldown_days, 10) * 24 * 60 * 60 * 1000)).toISOString();
      }
    } else {
      const effectiveDuration = (pkg.duration_days && Number(pkg.duration_days) > 0) ? Number(pkg.duration_days) : 30;
      nextAllowedAt = new Date(nowTime.getTime() + (effectiveDuration * 24 * 60 * 60 * 1000)).toISOString();
    }

    approvalRow = {
      id: approvalId,
      ledger_id: ledgerId,
      customer_user_id: customer.id,
      customer_id: customer.id,
      customer_name: customer.name || customer.phone || 'Customer',
      partner_id: pkg.partner_id,
      partner_package_id: pkg.id,
      package_id: pkg.id,
      package_name: pkg.name,
      face_value_rupees: pkg.face_value_rupees,
      rupees_value: pkg.face_value_rupees,
      points_deducted: pkg.point_cost,
      points_redeemed: pkg.point_cost,
      status: 'PENDING_ADMIN_APPROVAL',
      admin_notes: null,
      partner_notes: null,
      rejected_reason: null,
      disputed_reason: null,
      admin_id: null,
      approved_at: null,
      rejected_at: null,
      fulfilled_at: null,
      disputed_at: null,
      refund_ledger_id: null,
      redeemed_at: nowIso,
      next_redemption_allowed_at: nextAllowedAt,
      created_at: nowIso,
      updated_at: nowIso
    };
    redemptionApprovals.push(approvalRow);
    await db.saveTable('redemption_approvals', redemptionApprovals);
  }

  const responseObj = {
    success: true,
    ledgerId,
    remaining_balance: currentBalance + redeemAmount,
    message: 'Points successfully queued for redemption.'
  };
  if (approvalId) {
    responseObj.approval_id = approvalId;
    responseObj.redemption_approval = approvalRow;
  }
  return res.json(responseObj);
});

app.get(['/api/customer/rewards/available/:customerUserId', '/api/customer/available-rewards'], requireAuth, async (req, res) => {
  try {
    const customerId = req.params.customerUserId || req.query.customerId;
  if (!assertSelfOrAdmin(req, res, customerId)) return;
    if (!customerId) {
      return res.status(400).json({ error: 'customerId parameter or query is required' });
    }
    const users = await db.getTable('users');
    const customer = users.find(u => u.id === customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerRegion = customer.region_id;
    const bindingsList = await db.getTable('customer_partner_bindings');
    const customerBindings = bindingsList.filter(b => b.customer_id === customerId || b.customer_user_id === customerId);

    let cablePartnerId = null;
    let broadbandPartnerId = null;

    for (const b of customerBindings) {
      if (b.cable_partner_id) cablePartnerId = b.cable_partner_id;
      if (b.broadband_partner_id) broadbandPartnerId = b.broadband_partner_id;
      const st = (b.service_type || '').toLowerCase();
      if (st === 'cable' && b.partner_id) cablePartnerId = b.partner_id;
      if (st === 'broadband' && b.partner_id) broadbandPartnerId = b.partner_id;
    }

    const partners = await db.getTable('partners');
    const partnerPackages = await db.getTable('partner_packages');

    const resolveAvailable = (partnerId, serviceType) => {
      let isPartnerless = false;
      let targetPartnerIds = [];

      if (partnerId) {
        const partner = partners.find(p => p.id === partnerId);
        if (!partner || partner.status === 'INACTIVE' || partner.is_active === false) {
          return { reason: 'partner_inactive', list: [] };
        }
        if (partner.region_id && customerRegion && partner.region_id !== customerRegion) {
          return { reason: 'partner_inactive', list: [] };
        }
        targetPartnerIds.push(partnerId);
      } else {
        isPartnerless = true;
        const activePartners = partners.filter(p => p.status !== 'INACTIVE' && p.is_active !== false && (!p.region_id || !customerRegion || p.region_id === customerRegion));
        targetPartnerIds = activePartners.map(p => p.id);
      }

      const stLower = serviceType.toLowerCase();
      const matching = partnerPackages.filter(pkg => {
        if (!targetPartnerIds.includes(pkg.partner_id)) return false;
        const pkgSt = (pkg.service_type || '').toLowerCase();
        if (pkgSt !== stLower) return false;
        if (pkg.status === 'INACTIVE' || pkg.is_active === false) return false;

        let regions = pkg.active_regions || [];
        if (typeof regions === 'string') {
          try { regions = JSON.parse(regions); } catch (e) { regions = []; }
        }
        if (Array.isArray(regions) && regions.length > 0 && customerRegion && !regions.includes(customerRegion)) return false;
        return true;
      });

      if (matching.length === 0) {
        return { reason: isPartnerless ? 'no_binding' : 'no_packages', list: [] };
      }

      matching.sort((a, b) => (a.point_cost || 0) - (b.point_cost || 0));

      const list = matching.map(pkg => {
        const partner = partners.find(p => p.id === pkg.partner_id) || {};
        return {
          package: {
            id: pkg.id,
            name: pkg.name,
            description: pkg.description,
            service_type: pkg.service_type,
            face_value_rupees: parseFloat(pkg.face_value_rupees),
            point_cost: parseInt(pkg.point_cost, 10)
          },
          partner: {
            id: partner.id,
            display_name: partner.display_name
          }
        };
      });

      return { reason: isPartnerless ? 'no_binding' : null, list };
    };

    const cableRes = resolveAvailable(cablePartnerId, 'cable');
    const broadbandRes = resolveAvailable(broadbandPartnerId, 'broadband');

    const genericRewardsTable = await db.getTable('generic_rewards');
    const genericRewards = genericRewardsTable.filter(r => {
      if (r.is_active === false) return false;
      if (r.valid_until && new Date() > new Date(r.valid_until)) return false;
      return true;
    });

    return res.json({
      cable: cableRes.list,
      broadband: broadbandRes.list,
      generic: genericRewards.map(r => ({
        package: {
          id: r.id,
          name: r.name,
          description: r.description,
          service_type: 'generic',
          face_value_rupees: parseFloat(r.value_rupees) || 0,
          point_cost: parseInt(r.point_cost, 10),
          cooldown_type: r.cooldown_type || 'NONE',
          cooldown_days: r.cooldown_days || null,
          valid_until: r.valid_until || null
        },
        partner: {
          id: 'GENERIC',
          display_name: 'Beniffy (Generic)'
        }
      })),
      bindings: {
        cable_partner_id: cablePartnerId || null,
        broadband_partner_id: broadbandPartnerId || null
      },
      empty_reasons: {
        cable: cableRes.reason,
        broadband: broadbandRes.reason
      }
    });
  } catch (err) {
    console.error('Error in GET /api/customer/rewards/available:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
}

module.exports = { registerLedgerRoutes };
