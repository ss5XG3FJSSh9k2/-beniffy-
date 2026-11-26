const {
  path, post, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // --- 33. Round P2 — Redemption Approval Workflow & Health Dashboard ---
  console.log('\n--- 33. Round P2 — Redemption Approval Workflow & Health Dashboard ---');

  const p2_adhyaDetail = await get('http://localhost:3001/api/admin/partners/ptr-adhya');
  const p2_targetPkg = p2_adhyaDetail.body.packages.find(p => p.is_active);
  const p2_pkgId = p2_targetPkg.id;
  const p2_pkgCost = p2_targetPkg.point_cost;

  // Test 1: Customer redeems partner package with matching binding -> 200, status=PENDING_ADMIN_APPROVAL
  await post('http://localhost:3001/api/admin/customers/u-cust1/points-credit', { amount: 1000, reason: 'Test setup 1' });
  await post('http://localhost:3001/api/admin/customers/u-cust1/points-credit', { amount: 1000, reason: 'Test setup 2' });

  await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: 'u-cust1',
    cable_partner_id: 'ptr-adhya',
    broadband_partner_id: 'ptr-jio'
  });

  const p2_redeemRes = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust1',
    partner_package_id: p2_pkgId,
    amount: p2_pkgCost
  });
  assert(p2_redeemRes.status === 200, 'Customer redeems partner package with matching binding succeeds');
  assert(p2_redeemRes.body.redemption_approval !== undefined, 'Redemption approval created in response');
  assert(p2_redeemRes.body.redemption_approval.status === 'PENDING_ADMIN_APPROVAL', 'Initial approval status is PENDING_ADMIN_APPROVAL');

  const p2_approvalId = p2_redeemRes.body.redemption_approval.id;

  // Test 2: Redemption attempt for unbound partner -> 400 binding_mismatch
  const p2_unboundRes = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust2',
    partner_package_id: p2_pkgId,
    amount: p2_pkgCost
  });
  assert(p2_unboundRes.status === 400, 'Redeem for unbound partner returns 400');
  assert(p2_unboundRes.body.error === 'binding_mismatch', 'Error code is binding_mismatch');

  // Test 3: Redemption attempt with incorrect point amount -> 400 amount_mismatch
  const p2_amountMismatchRes = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust1',
    partner_package_id: p2_pkgId,
    amount: p2_pkgCost - 10
  });
  assert(p2_amountMismatchRes.status === 400, 'Redeem with incorrect point cost returns 400');
  assert(p2_amountMismatchRes.body.error === 'amount_mismatch', 'Error code is amount_mismatch');

  // Test 4: Admin GET /api/admin/redemption-approvals returns list including PENDING_ADMIN_APPROVAL row
  const p2_adminListRes = await get('http://localhost:3001/api/admin/redemption-approvals');
  assert(p2_adminListRes.status === 200, 'GET /api/admin/redemption-approvals succeeds');
  assert(p2_adminListRes.body.some(a => a.id === p2_approvalId), 'List includes created redemption approval');

  // Test 5: Admin GET /api/admin/redemption-approvals/:id returns full detail
  const p2_adminDetailRes = await get(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId}`);
  assert(p2_adminDetailRes.status === 200, 'GET redemption approval detail succeeds');
  assert(p2_adminDetailRes.body.customer_name !== undefined, 'Detail includes customer_name');
  assert(p2_adminDetailRes.body.partner_name !== undefined, 'Detail includes partner_name');

  // Test 6: Customer GET /api/customer/redemption-status/:id returns status
  const p2_custStatusRes = await get(`http://localhost:3001/api/customer/redemption-status/${p2_approvalId}`);
  assert(p2_custStatusRes.status === 200, 'GET customer redemption status succeeds');
  assert(p2_custStatusRes.body.status === 'PENDING_ADMIN_APPROVAL', 'Status matches PENDING_ADMIN_APPROVAL');

  // Test 7: Admin approves pending redemption -> status changes to APPROVED_AWAITING_PARTNER
  const p2_approveRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId}/approve`, {
    admin_id: 'u-admin',
    notes: 'Approved for processing'
  });
  assert(p2_approveRes.status === 200, 'Admin approve redemption succeeds');
  assert(p2_approveRes.body.status === 'APPROVED_AWAITING_PARTNER', 'Status updated to APPROVED_AWAITING_PARTNER');

  // Test 8: Re-approving already approved redemption returns 400 invalid_transition
  const p2_reApproveRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId}/approve`, {
    admin_id: 'u-admin'
  });
  assert(p2_reApproveRes.status === 400, 'Re-approving approved redemption returns 400');
  assert(p2_reApproveRes.body.error === 'invalid_transition', 'Error code is invalid_transition');

  // Test 9: Partner login & GET /api/partner/redemption-queue returns approved item
  const p2_partnerAuthRes = await post('http://localhost:3001/api/partner/auth/login-otp-verify', {
    phone: '9876500000', email: 'test_9876500000@fastnet.test',
    otp: '123456'
  });
  const partnerToken = p2_partnerAuthRes.body.session_token;

  const p2_queueRes = await get('http://localhost:3001/api/partner/redemption-queue', {
    headers: { Authorization: `Bearer ${partnerToken}` }
  });
  assert(p2_queueRes.status === 200, 'Partner GET redemption-queue succeeds');
  assert(p2_queueRes.body.some(a => a.id === p2_approvalId), 'Partner queue contains approved item');

  // Test 10: Partner fulfills redemption -> status=FULFILLED
  const p2_fulfillRes = await post(`http://localhost:3001/api/partner/redemption-approvals/${p2_approvalId}/fulfill`, {
    partner_notes: 'Cable STB bill discounted by ₹350'
  }, { headers: { Authorization: `Bearer ${partnerToken}` } });
  assert(p2_fulfillRes.status === 200, 'Partner fulfill redemption succeeds');
  assert(p2_fulfillRes.body.status === 'FULFILLED', 'Status updated to FULFILLED');

  // Test 11: Fulfilling already fulfilled redemption returns 400 invalid_transition
  const p2_reFulfillRes = await post(`http://localhost:3001/api/partner/redemption-approvals/${p2_approvalId}/fulfill`, {}, {
    headers: { Authorization: `Bearer ${partnerToken}` }
  });
  assert(p2_reFulfillRes.status === 400, 'Fulfilling already fulfilled redemption returns 400');
  assert(p2_reFulfillRes.body.error === 'invalid_transition', 'Error code is invalid_transition');

  // Create a second package to avoid duration lock from the first redemption
  const p2_newPkgRes = await post('http://localhost:3001/api/admin/partners/ptr-adhya/packages', {
    name: 'Test Package 2',
    description: 'Test Desc',
    service_type: 'CABLE',
    face_value_rupees: 500,
    cost_to_partner_rupees: 400,
    point_cost: 500,
    active_regions: ['r1'],
    duration_days: 30,
    is_timed: true
  });
  const p2_pkgId2 = p2_newPkgRes.body.id;
  const p2_pkgCost2 = p2_newPkgRes.body.point_cost;

  await post('http://localhost:3001/api/admin/customers/u-cust1/points-credit', { amount: 1000, reason: 'Test setup 2' });

  // Test 12: Create second redemption for rejection test
  const p2_redeem2Res = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust1',
    partner_package_id: p2_pkgId2,
    amount: p2_pkgCost2
  });
  const p2_approvalId2 = p2_redeem2Res.body.redemption_approval.id;

  // Test 13: Admin rejects pending redemption with <10 char reason -> 400
  const p2_shortRejectRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId2}/reject`, {
    admin_id: 'u-admin',
    reason: 'Too short'
  });
  assert(p2_shortRejectRes.status === 400, 'Reject with reason <10 chars returns 400');

  // Test 14: Admin rejects pending redemption with valid reason -> 200, REDEEM_REFUND points entry created
  const p2_rejectRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId2}/reject`, {
    admin_id: 'u-admin',
    reason: 'Subscriber cable account inactive or not found'
  });
  assert(p2_rejectRes.status === 200, 'Admin reject redemption succeeds');
  assert(p2_rejectRes.body.status === 'REJECTED', 'Status updated to REJECTED');
  assert(p2_rejectRes.body.refund_ledger_id !== undefined, 'Refund ledger ID attached');

  // Test 15: Check ledger contains REDEEM_REFUND row for customer
  const p2_ledgerRes = await get('http://localhost:3001/api/ledger/history/u-cust1');
  assert(p2_ledgerRes.body.some(l => l.type === 'REDEEM_REFUND' && l.amount === p2_pkgCost2), 'Customer ledger contains REDEEM_REFUND credit entry');

  // Create a third package to avoid duration lock
  const p2_newPkgRes3 = await post('http://localhost:3001/api/admin/partners/ptr-adhya/packages', {
    name: 'Test Package 3',
    description: 'Test Desc',
    service_type: 'CABLE',
    face_value_rupees: 500,
    cost_to_partner_rupees: 400,
    point_cost: 500,
    active_regions: ['r1'],
    duration_days: 30,
    is_timed: true
  });
  const p2_pkgId3 = p2_newPkgRes3.body.id;
  const p2_pkgCost3 = p2_newPkgRes3.body.point_cost;

  // Test 16: Create third redemption for dispute workflow
  const p2_redeem3Res = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust1',
    partner_package_id: p2_pkgId3,
    amount: p2_pkgCost3
  });
  const p2_approvalId3 = p2_redeem3Res.body.redemption_approval.id;
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId3}/approve`, { admin_id: 'u-admin' });

  // Test 17: Partner disputes redemption with <10 char reason -> 400
  const p2_shortDisputeRes = await post(`http://localhost:3001/api/partner/redemption-approvals/${p2_approvalId3}/dispute`, {
    reason: 'short'
  }, { headers: { Authorization: `Bearer ${partnerToken}` } });
  assert(p2_shortDisputeRes.status === 400, 'Partner dispute with <10 char reason returns 400');

  // Test 18: Partner disputes redemption with valid reason -> status=DISPUTED
  const p2_disputeRes = await post(`http://localhost:3001/api/partner/redemption-approvals/${p2_approvalId3}/dispute`, {
    reason: 'Customer account ID mismatch on partner side'
  }, { headers: { Authorization: `Bearer ${partnerToken}` } });
  assert(p2_disputeRes.status === 200, 'Partner dispute succeeds');
  assert(p2_disputeRes.body.status === 'DISPUTED', 'Status updated to DISPUTED');

  // Test 19: Admin resolves dispute with outcome=fulfill -> status=FULFILLED
  const p2_resolveFulfillRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId3}/resolve-dispute`, {
    admin_id: 'u-admin',
    outcome: 'fulfill',
    notes: 'Manually verified with partner operator'
  });
  assert(p2_resolveFulfillRes.status === 200, 'Admin resolve dispute with fulfill succeeds');
  assert(p2_resolveFulfillRes.body.status === 'FULFILLED', 'Status resolved to FULFILLED');

  // Create a fourth package to avoid duration lock
  const p2_newPkgRes4 = await post('http://localhost:3001/api/admin/partners/ptr-adhya/packages', {
    name: 'Test Package 4',
    description: 'Test Desc',
    service_type: 'CABLE',
    face_value_rupees: 500,
    cost_to_partner_rupees: 400,
    point_cost: 500,
    active_regions: ['r1'],
    duration_days: 30,
    is_timed: true
  });
  const p2_pkgId4 = p2_newPkgRes4.body.id;
  const p2_pkgCost4 = p2_newPkgRes4.body.point_cost;

  // Test 20: Create fourth redemption for dispute reject resolution
  const p2_redeem4Res = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust1',
    partner_package_id: p2_pkgId4,
    amount: p2_pkgCost4
  });
  const p2_approvalId4 = p2_redeem4Res.body.redemption_approval.id;
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId4}/approve`, { admin_id: 'u-admin' });
  await post(`http://localhost:3001/api/partner/redemption-approvals/${p2_approvalId4}/dispute`, {
    reason: 'Customer account cancelled on partner side'
  }, { headers: { Authorization: `Bearer ${partnerToken}` } });

  // Test 21: Admin resolves dispute with outcome=reject -> status=REJECTED and refund credited
  const p2_resolveRejectRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId4}/resolve-dispute`, {
    admin_id: 'u-admin',
    outcome: 'reject',
    notes: 'Upheld dispute, refunding customer points'
  });
  assert(p2_resolveRejectRes.status === 200, 'Admin resolve dispute with reject succeeds');
  assert(p2_resolveRejectRes.body.status === 'REJECTED', 'Status resolved to REJECTED');
  assert(p2_resolveRejectRes.body.refund_ledger_id !== undefined, 'Refund ledger ID set on dispute rejection');

  // Test 22: Partner GET /api/partner/redemption-history returns all partner redemptions
  const p2_historyRes = await get('http://localhost:3001/api/partner/redemption-history', {
    headers: { Authorization: `Bearer ${partnerToken}` }
  });
  assert(p2_historyRes.status === 200, 'GET partner redemption-history succeeds');
  assert(Array.isArray(p2_historyRes.body), 'Returns array of redemption history');

  // Test 23: GET /api/admin/health returns complete health dashboard structure
  const p2_healthRes = await get('http://localhost:3001/api/admin/health');
  assert(p2_healthRes.status === 200, 'GET /api/admin/health succeeds');
  assert(p2_healthRes.body.redemption_pipeline !== undefined, 'Health response contains redemption_pipeline panel');
  assert(p2_healthRes.body.partner_fulfillment_speed !== undefined, 'Health response contains partner_fulfillment_speed panel');
  assert(p2_healthRes.body.stockist_volume_leaderboard !== undefined, 'Health response contains stockist_volume_leaderboard panel');
  assert(p2_healthRes.body.new_arrivals !== undefined, 'Health response contains new_arrivals panel');
  assert(p2_healthRes.body.fraud_signals !== undefined, 'Health response contains fraud_signals panel');
  assert(p2_healthRes.body.system_stats !== undefined, 'Health response contains system_stats panel');

  // Test 24: App.jsx contains "Redemption Approvals" sidebar entry
  const fsMod = require('fs');
  const appJsx = fsMod.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appJsx.includes('Redemption Approvals'), 'App.jsx contains Redemption Approvals sidebar entry');

  // Test 25: App.jsx contains an Approve-action handler that posts to /api/admin/redemption-approvals
  assert(appJsx.includes('/admin/redemption-approvals/') && appJsx.includes('/approve'), 'App.jsx contains Approve-action handler posting to /api/admin/redemption-approvals');

  // Test 26: App.jsx contains a Health sidebar entry
  assert(appJsx.includes('Health') && appJsx.includes('fetchHealthData'), 'App.jsx contains Health sidebar entry');

  // Test 27: App.jsx contains a Promote to Partner button
  assert(appJsx.includes('Promote to Partner'), 'App.jsx contains Promote to Partner button');

  // Test 28: Rejecting an already rejected approval returns 400 invalid_transition
  const p2_reRejectRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId2}/reject`, {
    admin_id: 'u-admin',
    reason: 'Trying to reject again when already rejected'
  });
  assert(p2_reRejectRes.status === 400, 'Rejecting an already rejected approval returns 400');
  assert(p2_reRejectRes.body.error === 'invalid_transition', 'Error code is invalid_transition');

  // Test 29: Resolving dispute on non-disputed approval returns 400 invalid_transition
  const p2_invalidResolveRes = await post(`http://localhost:3001/api/admin/redemption-approvals/${p2_approvalId}/resolve-dispute`, {
    admin_id: 'u-admin',
    outcome: 'fulfill'
  });
  assert(p2_invalidResolveRes.status === 400, 'Resolving dispute on non-disputed approval returns 400');
  assert(p2_invalidResolveRes.body.error === 'invalid_transition', 'Error code is invalid_transition');

  // === ROUND P3 TESTS ===
  console.log('\n--- Round P3: Customer Signup Partner Selection ---');

  // We need a couple of active partners set up for testing:
  const p3_bbRes = await post('http://localhost:3001/api/admin/partners', {
    display_name: 'Test Broadband Partner R1',
    legal_name: 'Test Broadband Ltd',
    contact_phone: '9876543299',
    contact_email: 'bb@partner.com',
    address: '123 BB St',
    service_types: ['BROADBAND'],
    admin_id: 'u-admin'
  });
  assert(p3_bbRes.status === 200, 'Created test broadband partner for P3');
  const p3_bbPartnerId = p3_bbRes.body.partner.id;

  await post(`http://localhost:3001/api/admin/partners/${p3_bbPartnerId}/regions`, {
    region_id: 'r1',
    service_type: 'BROADBAND',
    admin_id: 'u-admin'
  });

  // Test 1: GET /api/customer/available-partners?region_id=r1 returns cable and broadband arrays without sensitive fields
  const p3_availRes = await get('http://localhost:3001/api/customer/available-partners?region_id=r1');
  assert(p3_availRes.status === 200, 'GET available-partners returns 200');
  assert(Array.isArray(p3_availRes.body.cable) && Array.isArray(p3_availRes.body.broadband), 'Returns cable and broadband arrays');
  const sampleCable = p3_availRes.body.cable[0];
  assert(sampleCable.id && sampleCable.display_name && sampleCable.service_types, 'Exposes id, display_name, service_types');
  assert(!sampleCable.email && !sampleCable.gstin && !sampleCable.users, 'Does not expose sensitive partner fields');

  // Test 2: GET /api/customer/available-partners without region_id returns 400
  const p3_availNoRegion = await get('http://localhost:3001/api/customer/available-partners');
  assert(p3_availNoRegion.status === 400, 'Missing region_id returns 400');

  // Test 3: POST /api/auth/register-customer with valid partner bindings succeeds
  const p3_custPhone1 = '9800000001';
  const p3_regRes1 = await post('http://localhost:3001/api/auth/register-customer', {
    phone: p3_custPhone1, email: 'test_' + p3_custPhone1 + '@fastnet.test',
    name: 'P3 Customer One',
    regionId: 'r1',
    address: '123 Test St',
    cable_partner_id: 'ptr-adhya',
    broadband_partner_id: p3_bbPartnerId
  });
  assert(p3_regRes1.status === 200, 'Customer registration with bindings returns 200');
  assert(p3_regRes1.body.user && p3_regRes1.body.user.id, 'Returns user object');
  assert(p3_regRes1.body.bindings.cable_partner_id === 'ptr-adhya', 'Cable binding saved correctly');
  assert(p3_regRes1.body.bindings.broadband_partner_id === p3_bbPartnerId, 'Broadband binding saved correctly');
  assert(p3_regRes1.body.token, 'Customer registration returns a token');
  
  const p3_custId1 = p3_regRes1.body.user.id;
  const p3_custToken1 = p3_regRes1.body.token;

  // Verify that we can use this token for profile routes
  const p3_profCheck = await get(`http://localhost:3001/api/customer/${p3_custId1}/profile`, { headers: { Authorization: `Bearer ${p3_custToken1}` } });
  assert(p3_profCheck.status === 200, 'Can GET profile using registration token');
  assert(p3_profCheck.body.user.name === 'P3 Customer One', 'Profile data is accessible via token');
  
  const p3_profUpdateCheck = await post(`http://localhost:3001/api/customer/${p3_custId1}/profile`, { name: 'P3 Customer One' }, { headers: { Authorization: `Bearer ${p3_custToken1}` } });
  assert(p3_profUpdateCheck.status === 200, 'Can POST profile using registration token');
  
  const p3_bindingsCheck = await post(`http://localhost:3001/api/customer/partner-bindings`, { customer_user_id: p3_custId1, cable_partner_id: 'ptr-adhya', broadband_partner_id: null }, { headers: { Authorization: `Bearer ${p3_custToken1}` } });
  assert(p3_bindingsCheck.status === 200, 'Can POST partner-bindings using registration token');


  // Test 4: POST /api/auth/register-customer with invalid partner_id returns 400 invalid_partner_binding
  const p3_regResInvalid = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9800000002', email: 'test_9800000002@fastnet.test',
    name: 'P3 Customer Two',
    regionId: 'r1',
    cable_partner_id: 'p-nonexistent'
  });
  assert(p3_regResInvalid.status === 400, 'Register with non-existent partner returns 400');
  assert(p3_regResInvalid.body.error === 'invalid_partner_binding', 'Error code is invalid_partner_binding');

  // Test 5: POST /api/auth/register-customer with wrong service_type binding returns 400
  const p3_regResWrongType = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9800000003', email: 'test_9800000003@fastnet.test',
    name: 'P3 Customer Three',
    regionId: 'r1',
    broadband_partner_id: 'ptr-adhya'
  });
  assert(p3_regResWrongType.status === 400, 'Register with wrong service_type partner returns 400');
  assert(p3_regResWrongType.body.error === 'invalid_partner_binding', 'Error code is invalid_partner_binding');

  // Test 6: POST /api/auth/register-customer with partner not serving customer region returns 400
  const p3_regResWrongRegion = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9800000004', email: 'test_9800000004@fastnet.test',
    name: 'P3 Customer Four',
    regionId: 'r2',
    broadband_partner_id: p3_bbPartnerId
  });
  assert(p3_regResWrongRegion.status === 400, 'Register with partner not covering region returns 400');
  assert(p3_regResWrongRegion.body.error === 'invalid_partner_binding', 'Error code is invalid_partner_binding');

  // Test 7: GET /api/customer/:id/profile returns user details, current bindings, and available partners
  const p3_profRes1 = await get(`http://localhost:3001/api/customer/${p3_custId1}/profile`);
  assert(p3_profRes1.status === 200, 'GET customer profile returns 200');
  assert(p3_profRes1.body.user.name === 'P3 Customer One', 'User name matches');
  assert(p3_profRes1.body.bindings.cable_partner_id === 'ptr-adhya', 'Bindings cable_partner_id matches');
  assert(Array.isArray(p3_profRes1.body.available_partners.cable), 'available_partners cable list present');

  // Test 8: POST /api/customer/:id/profile updates name and address
  const p3_updateProfRes = await post(`http://localhost:3001/api/customer/${p3_custId1}/profile`, {
    name: 'P3 Customer One Updated',
    address: '456 Updated Ave'
  });
  assert(p3_updateProfRes.status === 200, 'POST customer profile returns 200');
  assert(p3_updateProfRes.body.user.name === 'P3 Customer One Updated', 'Profile name updated');
  assert(p3_updateProfRes.body.user.address === '456 Updated Ave', 'Profile address updated');

  // Test 9: POST /api/customer/partner-bindings updates bindings for existing customer
  const p3_bindRes1 = await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: p3_custId1,
    cable_partner_id: 'ptr-adhya',
    broadband_partner_id: null
  });
  assert(p3_bindRes1.status === 200, 'POST partner-bindings returns 200');
  assert(p3_bindRes1.body.cable_partner_id === 'ptr-adhya', 'Cable binding updated');
  assert(p3_bindRes1.body.broadband_partner_id === null, 'Broadband binding set to null');

  // Test 10: Explicit null binding records audit log entry
  const p3_auditLogCheck = await get('http://localhost:3001/api/admin/audit-log');
  const nullBindLog = p3_auditLogCheck.body.find(l => l.action === 'UPDATE_PARTNER_BINDING' && l.entity_id === p3_custId1);
  assert(nullBindLog !== undefined, 'Audit log entry created for customer binding update');

  // Test 11: Binding an inactive partner returns 400 invalid_partner_binding
  await post(`http://localhost:3001/api/admin/partners/${p3_bbPartnerId}/deactivate`, { admin_id: 'u-admin' });
  const p3_bindInactive = await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: p3_custId1,
    broadband_partner_id: p3_bbPartnerId
  });
  assert(p3_bindInactive.status === 400, 'Binding inactive partner returns 400');
  assert(p3_bindInactive.body.error === 'invalid_partner_binding', 'Error code is invalid_partner_binding');

  // Re-activate p3_bbPartnerId
  await post(`http://localhost:3001/api/admin/partners/${p3_bbPartnerId}/reactivate`, { admin_id: 'u-admin' });

  // Test 12: GET /api/customer/:id/profile with non-existent customer_user_id returns 404
  const p3_prof404 = await get('http://localhost:3001/api/customer/u-nonexistent/profile');
  assert(p3_prof404.status === 404, 'Non-existent customer profile returns 404');

  // Test 13: POST /api/customer/partner-bindings with non-existent customer_user_id returns 404
  const p3_bind404 = await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: 'u-nonexistent',
    cable_partner_id: 'ptr-adhya'
  });
  assert(p3_bind404.status === 404, 'Partner-bindings for non-existent customer returns 404');

  // Test 14: App.jsx contains CHOOSE YOUR LOCAL CABLE OPERATOR text or trilingual translations
  assert(appJsx.includes('CHOOSE YOUR LOCAL CABLE OPERATOR'), 'App.jsx contains CHOOSE YOUR LOCAL CABLE OPERATOR label');

  // Test 15: App.jsx contains handling for noCableProvider state variable
  assert(appJsx.includes('noCableProvider'), 'App.jsx contains noCableProvider state handling');

  // Test 16: App.jsx contains Do you have a local internet broadband question
  assert(appJsx.includes('Do you have a local internet'), 'App.jsx contains broadband question');

  // Test 17: App.jsx contains My Profile view with binding change handlers
  assert(appJsx.includes('My Profile') && appJsx.includes('handleSaveProfile'), 'App.jsx contains My Profile view');

  // Test 18: App.jsx contains at least one call to /api/customer/available-partners
  assert(appJsx.includes('/customer/available-partners'), 'App.jsx calls /api/customer/available-partners');

};
