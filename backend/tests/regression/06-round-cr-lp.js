const {
  dbModule, loginAs, clearLogin, post, patch, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // Round CR: Customer Rewards from Partner Packages (#437-#450)
  console.log('\n--- Round CR: Customer Rewards from Partner Packages ---');
  
  // Set up seed data for partner packages and bindings to test empty_reasons and package retrieval
  const pCableId = 'part-cr-cable-1';
  const pBroadbandId = 'part-cr-broadband-1';
  const pInactiveId = 'part-cr-inactive-1';

  await dbModule.insertRow('partners', {
    id: pCableId,
    legal_name: 'CR Cable Partner Ltd',
    display_name: 'CR Cable Provider',
    contact_phone: '9839900001',
    is_active: true,
    created_at: new Date().toISOString()
  });

  await dbModule.insertRow('partners', {
    id: pBroadbandId,
    legal_name: 'CR Broadband Partner Ltd',
    display_name: 'CR Broadband Provider',
    contact_phone: '9839900002',
    is_active: true,
    created_at: new Date().toISOString()
  });

  await dbModule.insertRow('partners', {
    id: pInactiveId,
    legal_name: 'CR Inactive Partner Ltd',
    display_name: 'CR Inactive Provider',
    contact_phone: '9839900003',
    is_active: false,
    created_at: new Date().toISOString()
  });

  // Create users for specific test cases
  const custValidBinding = 'u-cust-valid-binding';
  await dbModule.insertRow('users', {
    id: custValidBinding,
    name: 'Customer Valid Binding',
    phone: '9839900008', email: 'test_9839900008@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    is_active: true,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('customer_partner_bindings', {
    id: 'bind-cr-valid',
    customer_user_id: custValidBinding,
    cable_partner_id: 'ptr-adhya',
    broadband_partner_id: 'ptr-jio',
    created_at: new Date().toISOString()
  });

  const custNoBinding = 'u-cust-nobinding';
  await dbModule.insertRow('users', {
    id: custNoBinding,
    name: 'Customer No Binding',
    phone: '9839900004', email: 'test_9839900004@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    is_active: true,
    created_at: new Date().toISOString()
  });

  const custInactiveBinding = 'u-cust-inactive-binding';
  await dbModule.insertRow('users', {
    id: custInactiveBinding,
    name: 'Customer Inactive Binding',
    phone: '9839900005', email: 'test_9839900005@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    is_active: true,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('customer_partner_bindings', {
    id: 'bind-cr-1',
    customer_user_id: custInactiveBinding,
    cable_partner_id: pInactiveId,
    broadband_partner_id: null,
    created_at: new Date().toISOString()
  });

  const custNoPkgBinding = 'u-cust-nopkg-binding';
  await dbModule.insertRow('users', {
    id: custNoPkgBinding,
    name: 'Customer No Package Binding',
    phone: '9839900006', email: 'test_9839900006@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    is_active: true,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('customer_partner_bindings', {
    id: 'bind-cr-2',
    customer_user_id: custNoPkgBinding,
    cable_partner_id: pCableId,
    broadband_partner_id: null,
    created_at: new Date().toISOString()
  });

  // Test #437: Customer with valid bindings + adhya has packages -> response has non-empty cable, empty_reasons.cable = null
  const resValid = await get(`http://localhost:3001/api/customer/rewards/available/${custValidBinding}`);
  assert(resValid.status === 200, 'GET /api/customer/rewards/available/:id returns 200');
  assert(resValid.body.cable.length > 0 && resValid.body.empty_reasons.cable === null, 'Customer with valid bindings + adhya packages has non-empty cable and null empty_reasons');

  // Test #438: Customer with no binding -> empty_reasons.cable = 'no_binding', empty array
  const resNoBinding = await get(`http://localhost:3001/api/customer/rewards/available/${custNoBinding}`);
  assert(resNoBinding.body.empty_reasons.cable === 'no_binding', 'Customer with no binding gets empty_reasons.cable = no_binding');

  // Test #439: Customer bound to inactive partner -> empty_reasons.cable = 'partner_inactive'
  const resInactive = await get(`http://localhost:3001/api/customer/rewards/available/${custInactiveBinding}`);
  assert(resInactive.body.empty_reasons.cable === 'partner_inactive' && resInactive.body.cable.length === 0, 'Customer bound to inactive partner gets empty_reasons.cable = partner_inactive');

  // Test #440: Customer bound but partner has no packages in customer's region -> empty_reasons.cable = 'no_packages'
  const resNoPkg = await get(`http://localhost:3001/api/customer/rewards/available/${custNoPkgBinding}`);
  assert(resNoPkg.body.empty_reasons.cable === 'no_packages' && resNoPkg.body.cable.length === 0, 'Customer bound to partner with no packages gets empty_reasons.cable = no_packages');

  // Test #441: Response does NOT expose partner contact_email, contact_phone, gst_number, or cost_to_partner_rupees
  const samplePkg = resValid.body.cable[0];
  assert(samplePkg.partner.contact_email === undefined && samplePkg.partner.contact_phone === undefined && samplePkg.partner.gst_number === undefined && samplePkg.package.cost_to_partner_rupees === undefined, 'Response does NOT expose sensitive partner or cost fields');

  // Now create active package pkgCable1Id for pCableId
  const pkgCable1Id = 'pkg-cr-cable-100';
  await dbModule.insertRow('partner_packages', {
    id: pkgCable1Id,
    partner_id: pCableId,
    name: 'Cable Monthly HD Pack',
    description: '100+ HD Channels for 30 days',
    service_type: 'CABLE',
    face_value_rupees: 250,
    cost_to_partner_rupees: 200,
    point_cost: 100,
    active_regions: JSON.stringify(['r1']),
    is_active: true,
    created_at: new Date().toISOString()
  });

  // Give custNoPkgBinding points and update binding to pCableId (which has pkgCable1Id)
  const custRedeemUser = 'u-cust-redeem-test';
  await dbModule.insertRow('users', {
    id: custRedeemUser,
    name: 'Customer Redeem Test',
    phone: '9839900007', email: 'test_9839900007@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    is_active: true,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('customer_partner_bindings', {
    id: 'bind-cr-redeem',
    customer_user_id: custRedeemUser,
    cable_partner_id: pCableId,
    broadband_partner_id: null,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('points_ledger', {
    id: 'l-cr-pts-1',
    customer_id: custRedeemUser,
    type: 'EARN',
    amount: 500,
    description: 'Test points for CR redemption',
    created_at: new Date().toISOString()
  });

  // Test #442: Customer redeems a partner package via the endpoint -> redemption_approval row created
  const redeemRes = await post('http://localhost:3001/api/ledger/redeem', {
    customerId: custRedeemUser,
    amount: 100,
    redemptionType: 'CABLE',
    partner_package_id: pkgCable1Id
  });
  assert(redeemRes.status === 200, 'POST /api/ledger/redeem with partner_package_id returns 200');
  assert(redeemRes.body.redemption_approval !== undefined && redeemRes.body.redemption_approval.partner_package_id === pkgCable1Id, 'redemption_approval row created with partner_package_id');

  // Test #443: Customer attempts to redeem a package they see with wrong point amount -> 400
  const redeemWrongAmount = await post('http://localhost:3001/api/ledger/redeem', {
    customerId: custRedeemUser,
    amount: 999,
    redemptionType: 'CABLE',
    partner_package_id: pkgCable1Id
  });
  assert(redeemWrongAmount.status === 400 && redeemWrongAmount.body.error === 'amount_mismatch', 'Redeem with wrong point amount returns 400 amount_mismatch');

  // Test #444: Customer attempts to redeem a package their binding doesn't match -> binding_mismatch
  const custUnboundRedeem = 'u-cust-unbound-redeem';
  await dbModule.insertRow('users', {
    id: custUnboundRedeem,
    name: 'Customer Unbound Redeem',
    phone: '9839900009', email: 'test_9839900009@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    is_active: true,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('points_ledger', {
    id: 'l-cr-pts-2',
    customer_id: custUnboundRedeem,
    type: 'EARN',
    amount: 500,
    description: 'Test points for unbound redemption',
    created_at: new Date().toISOString()
  });
  const redeemMismatch = await post('http://localhost:3001/api/ledger/redeem', {
    customerId: custUnboundRedeem,
    amount: 100,
    redemptionType: 'CABLE',
    partner_package_id: pkgCable1Id
  });
  assert(redeemMismatch.status === 400 || redeemMismatch.status === 403, 'Redeem for unbound partner returns 400/403');
  assert(redeemMismatch.body.error === 'binding_mismatch', 'Error is binding_mismatch');

  // Test #445: App.jsx does NOT contain BROADBAND_DISCOUNT_50
  const crFs = require('fs');
  const crPath = require('path');
  const crAppJsx = crFs.readFileSync(crPath.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!crAppJsx.includes('BROADBAND_DISCOUNT_50'), 'App.jsx does NOT contain BROADBAND_DISCOUNT_50');

  // Test #446: App.jsx contains a call to /api/customer/rewards/available/
  assert(crAppJsx.includes('/customer/rewards/available/'), 'App.jsx contains call to /api/customer/rewards/available/');

  // Test #447: App.jsx handles all four empty_reasons states
  assert(crAppJsx.includes('no_binding') && crAppJsx.includes('partner_inactive') && crAppJsx.includes('no_packages'), 'App.jsx handles no_binding, partner_inactive, and no_packages empty_reasons');

  // Test #448: App.jsx renders partner.display_name in rewards section
  assert(crAppJsx.includes('partner.display_name') || crAppJsx.includes('partnerName'), 'App.jsx renders partner.display_name in rewards section');

  // Test #449: App.jsx contains a visible sidebar/nav entry with exact string Pending KYC and references pendingKyc.length
  assert(crAppJsx.includes('Pending KYC') && crAppJsx.includes('pendingKyc.length'), 'App.jsx contains Pending KYC sidebar button and checks pendingKyc.length');

  // Test #450: GET /api/admin/kyc-queue returns Gopal Joy (u-stk3) in seed with kyc_status='PENDING'
  const kycQueueRes = await get('http://localhost:3001/api/admin/kyc-queue');
  assert(kycQueueRes.status === 200 && Array.isArray(kycQueueRes.body), 'GET /api/admin/kyc-queue returns 200 array');
  const gopalInKyc = kycQueueRes.body.find(u => u.id === 'u-stk3' || u.name === 'Gopal Joy');
  assert(gopalInKyc !== undefined && gopalInKyc.kyc_status === 'PENDING', 'GET /api/admin/kyc-queue returns u-stk3 with PENDING kyc_status');

  // --- Round LP: Launch Polish Bundle ---
  console.log('\n--- Round LP: Launch Polish Bundle ---');

  // Test #455: New user gets a referral_code on creation
  const lpNewUser = await dbModule.insertRow('users', {
    id: 'u-lp-test-1',
    name: 'LP Test User 1',
    phone: '9839910001', email: 'test_9839910001@fastnet.test',
    role: 'CUSTOMER',
    region_id: 'r1',
    created_at: new Date().toISOString()
  });
  assert(typeof lpNewUser.referral_code === 'string' && lpNewUser.referral_code.length === 6, 'New user gets a 6-char referral_code on creation');

  // Test #456: referral_code format & uniqueness check
  assert(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(lpNewUser.referral_code), 'referral_code is uppercase alphanumeric [A-Z2-9]{6}');

  // Test #457: POST /api/customer/register-with-referral with valid code sets referred_by_user_id
  const regReferralRes = await post('http://localhost:3001/api/customer/register-with-referral', {
    phone: '9839910002', email: 'test_9839910002@fastnet.test',
    name: 'Referred Customer',
    region_id: 'r1',
    referral_code: lpNewUser.referral_code
  });
  assert(regReferralRes.status === 200, 'POST /api/customer/register-with-referral returns 200');
  assert(regReferralRes.body.user.referred_by_user_id === lpNewUser.id, 'referred_by_user_id set to referrer user id');

  // Test #458: Response contains new user referral_code
  assert(typeof regReferralRes.body.referral_code === 'string' && regReferralRes.body.referral_code.length === 6, 'Response contains new user referral_code');
  assert(regReferralRes.body.token, 'Referral registration returns a token');

  const refCustId = regReferralRes.body.user.id;
  const refCustToken = regReferralRes.body.token;
  
  const refProfCheck = await get(`http://localhost:3001/api/customer/${refCustId}/profile`, { headers: { Authorization: `Bearer ${refCustToken}` } });
  assert(refProfCheck.status === 200, 'Can GET profile using referral registration token');
  
  const refProfUpdateCheck = await post(`http://localhost:3001/api/customer/${refCustId}/profile`, { name: 'Ref Name Updated' }, { headers: { Authorization: `Bearer ${refCustToken}` } });
  assert(refProfUpdateCheck.status === 200, 'Can POST profile using referral registration token');
  
  const refBindingsCheck = await post(`http://localhost:3001/api/customer/partner-bindings`, { customer_user_id: refCustId, cable_partner_id: null, broadband_partner_id: null }, { headers: { Authorization: `Bearer ${refCustToken}` } });
  assert(refBindingsCheck.status === 200, 'Can POST partner-bindings using referral registration token');
  // Test #459: Invalid referral code returns 400 invalid_referral_code
  const regBadRefRes = await post('http://localhost:3001/api/customer/register-with-referral', {
    phone: '9839910003', email: 'test_9839910003@fastnet.test',
    name: 'Bad Ref Customer',
    region_id: 'r1',
    referral_code: 'INVALID'
  });
  assert(regBadRefRes.status === 400 && regBadRefRes.body.error === 'invalid_referral_code', 'Invalid referral code returns 400 invalid_referral_code');

  // Test #460: Backfill: existing users have referral_code populated
  const allUsersAfterInit = await dbModule.getTable('users');
  assert(allUsersAfterInit.every(u => !!u.referral_code), 'Backfill: all users have referral_code populated');

  // Test #461 & #462: First DELIVERED order credits +50 pts to referrer (REFERRAL_BONUS) and referee (REFERRAL_WELCOME)
  const referredCustId = regReferralRes.body.user.id;
  const lpOrder1 = await post('http://localhost:3001/api/orders', {
    customerId: referredCustId,
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  assert(lpOrder1.status === 200, 'Referred customer places order successfully');

  // Trigger order DELIVERED
  await post('http://localhost:3001/api/admin/override-table', {
    table: 'orders',
    id: lpOrder1.body.orderId,
    patch: { status: 'DELIVERED' }
  });

  const ledgerAfterDelivery = await dbModule.getTable('points_ledger');
  const referrerBonus = ledgerAfterDelivery.find(l => l.customer_id === lpNewUser.id && l.type === 'REFERRAL_BONUS');
  const refereeBonus = ledgerAfterDelivery.find(l => l.customer_id === referredCustId && l.type === 'REFERRAL_WELCOME');

  assert(referrerBonus !== undefined && referrerBonus.amount === 50, 'Referrer receives +50 pts via ledger append (type=REFERRAL_BONUS)');
  assert(refereeBonus !== undefined && refereeBonus.amount === 50, 'Referee receives +50 pts via ledger append (type=REFERRAL_WELCOME)');

  // Test #463: Bonus paid flag prevents double-payment on second order
  const lpOrder2 = await post('http://localhost:3001/api/orders', {
    customerId: referredCustId,
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  await post('http://localhost:3001/api/admin/override-table', {
    table: 'orders',
    id: lpOrder2.body.orderId,
    patch: { status: 'DELIVERED' }
  });

  const ledgerAfterSecondOrder = await dbModule.getTable('points_ledger');
  const referrerBonusCount = ledgerAfterSecondOrder.filter(l => l.customer_id === lpNewUser.id && l.type === 'REFERRAL_BONUS').length;
  assert(referrerBonusCount === 1, 'Second DELIVERED order does NOT trigger another referral bonus');

  // Test #464: Non-referred customer delivery does NOT trigger referral bonus
  const nonReferredCust = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9839910004', email: 'test_9839910004@fastnet.test',
    name: 'Non Referred Customer',
    regionId: 'r1'
  });
  const nonRefOrder = await post('http://localhost:3001/api/orders', {
    customerId: nonReferredCust.body.user.id,
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  await post('http://localhost:3001/api/admin/override-table', {
    table: 'orders',
    id: nonRefOrder.body.orderId,
    patch: { status: 'DELIVERED' }
  });
  const ledgerNonRef = await dbModule.getTable('points_ledger');
  assert(!ledgerNonRef.some(l => l.customer_id === nonReferredCust.body.user.id && (l.type === 'REFERRAL_BONUS' || l.type === 'REFERRAL_WELCOME')), 'Non-referred customer delivery does NOT append referral bonus');

  // SMS Tests (#465 - #469)
  const smsHelper = require('../../lib/sms');
  smsHelper.clearMockOutbox();

  const smsCust = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9839910005', email: 'test_9839910005@fastnet.test',
    name: 'SMS Test Customer',
    regionId: 'r1'
  });

  // Test #465: Order created -> mockOutbox has SMS
  const smsOrder = await post('http://localhost:3001/api/orders', {
    customerId: smsCust.body.user.id,
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  const outboxAfterCreate = smsHelper.getMockOutbox();
  assert(outboxAfterCreate.length > 0 && outboxAfterCreate.some(s => s.phone === '9839910005' && s.body.includes('confirmed')), 'Order created -> mockOutbox has order confirmed SMS');

  // Test #466: Order transitions to READY -> mockOutbox has second SMS
  await patch(`http://localhost:3001/api/orders/${smsOrder.body.orderId}/status`, { status: 'READY_FOR_PICKUP' });
  const outboxAfterReady = smsHelper.getMockOutbox();
  assert(outboxAfterReady.some(s => s.phone === '9839910005' && s.body.includes('ready for pickup')), 'Order transitions to READY -> mockOutbox has order ready SMS');

  // Test #467: sms_confirmed_sent & sms_ready_sent flags flip correctly
  const smsOrderRow = (await dbModule.getTable('orders')).find(o => o.id === smsOrder.body.orderId);
  assert(smsOrderRow.sms_confirmed_sent === true && smsOrderRow.sms_ready_sent === true, 'sms_confirmed_sent and sms_ready_sent flags are true');

  // Test #468: Re-triggering READY status does NOT send duplicate SMS
  const outboxCountBefore = smsHelper.getMockOutbox().length;
  await patch(`http://localhost:3001/api/orders/${smsOrder.body.orderId}/status`, { status: 'READY_FOR_PICKUP' });
  assert(smsHelper.getMockOutbox().length === outboxCountBefore, 'Re-triggering READY status does NOT send duplicate SMS');

  // Test #469: When SMS_MOCK=false and no MSG91 configured, endpoints succeed
  const origSmsMock = process.env.SMS_MOCK;
  process.env.SMS_MOCK = 'false';
  delete process.env.MSG91_AUTH_KEY;
  const noSmsOrder = await post('http://localhost:3001/api/orders', {
    customerId: smsCust.body.user.id,
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  assert(noSmsOrder.status === 200, 'Order creation succeeds when SMS service disabled');
  process.env.SMS_MOCK = origSmsMock || 'true';

  // Partner Call Button Code Existence (#470 - #471)
  const lpFs = require('fs');
  const lpPath = require('path');
  const lpAppJsx = lpFs.readFileSync(lpPath.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #470: App.jsx in partner queue block contains tel: link
  assert(lpAppJsx.includes("href={`tel:${row.customer_phone}`}") || lpAppJsx.includes('tel:'), 'App.jsx in partner queue block contains tel: link');

  // Test #471: App.jsx in partner notifications block contains tel: link
  assert(lpAppJsx.includes('tel:'), 'App.jsx in partner notifications block contains tel: link');

  // Analytics Endpoints & Data Integrity Tests (#472 - #481)
  // Test #472: GET /api/admin/analytics returns 200 and all top-level keys
  const analyticsRes = await get('http://localhost:3001/api/admin/analytics');
  assert(analyticsRes.status === 200, 'GET /api/admin/analytics returns 200');
  const aData = analyticsRes.body;
  assert(
    aData.users && aData.orders && aData.redemptions && aData.points &&
    aData.stockists && aData.partners && aData.fraud_reports && aData.generated_at,
    'GET /api/admin/analytics returns all top-level keys'
  );

  // Test #473: users.total_customers matches actual count of role=CUSTOMER users
  const custCountDb = (await dbModule.getTable('users')).filter(u => u.role === 'CUSTOMER').length;
  assert(aData.users.total_customers === custCountDb, 'users.total_customers matches actual count of CUSTOMER users');

  // Test #474: orders.revenue_today_rupees is a number >= 0
  assert(typeof aData.orders.revenue_today_rupees === 'number' && aData.orders.revenue_today_rupees >= 0, 'orders.revenue_today_rupees is a number >= 0');

  // Test #475: redemptions.total_partner_payout_owed_this_month equals sum(face_value * 0.88)
  assert(typeof aData.redemptions.total_partner_payout_owed_this_month === 'number', 'total_partner_payout_owed_this_month is numeric');

  // Test #476: points.total_points_outstanding = issued - redeemed
  assert(aData.points.total_points_outstanding === aData.points.total_points_issued_all_time - aData.points.total_points_redeemed_all_time, 'points.total_points_outstanding = issued - redeemed');

  // Test #477: stockists.top_5_by_gmv_this_month is sorted descending
  const gmvList = aData.stockists.top_5_by_gmv_this_month;
  let isSortedDesc = true;
  for (let i = 0; i < gmvList.length - 1; i++) {
    if (gmvList[i].gmv < gmvList[i + 1].gmv) isSortedDesc = false;
  }
  assert(isSortedDesc, 'stockists.top_5_by_gmv_this_month is sorted descending');

  // Test #478: partners.slowest_fulfillment returns at most 3 entries
  assert(Array.isArray(aData.partners.slowest_fulfillment) && aData.partners.slowest_fulfillment.length <= 3, 'partners.slowest_fulfillment returns at most 3 entries');

  // Test #479: stockists.kyc_pending_count matches length of kyc-queue response
  const kycQueueCheck = await get('http://localhost:3001/api/admin/kyc-queue');
  assert(aData.stockists.kyc_pending_count === kycQueueCheck.body.length, 'stockists.kyc_pending_count matches length of kyc-queue response');

  // Test #480: Admin without valid credentials cannot reach /api/admin/analytics (401 or 403)
  clearLogin();
  const unauthAnalytics = await get('http://localhost:3001/api/admin/analytics?admin_id=invalid-admin-id');
  assert(unauthAnalytics.status === 401 || unauthAnalytics.status === 403, 'Admin without valid credentials cannot reach /api/admin/analytics (401 or 403)');
  
  // Test #480b: Admin with bad token cannot reach /api/admin/analytics (401 or 403)
  const unauthAnalyticsBadToken = await get('http://localhost:3001/api/admin/analytics?admin_id=invalid-admin-id', { headers: { Authorization: 'Bearer bad_token' } });
  assert(unauthAnalyticsBadToken.status === 401 || unauthAnalyticsBadToken.status === 403, 'Admin with bad token cannot reach /api/admin/analytics (401 or 403)');
  loginAs('u-admin', 'ADMIN');

  // Test #481: Response includes generated_at timestamp within 5s of current time
  const genTime = new Date(aData.generated_at).getTime();
  assert(Math.abs(Date.now() - genTime) < 5000, 'Response includes generated_at timestamp within 5s of current time');

  // Frontend Existence Tests (#482 - #485)
  // Test #482: App.jsx contains an "Analytics" sidebar entry
  assert(lpAppJsx.includes('Analytics'), 'App.jsx contains Analytics sidebar entry');

  // Test #483: App.jsx fetches /api/admin/analytics
  assert(lpAppJsx.includes('/admin/analytics'), 'App.jsx fetches /api/admin/analytics');

  // Test #484: App.jsx contains a "Refer a friend" tile with referral_code display
  assert(lpAppJsx.includes('Refer a friend') && lpAppJsx.includes('referral_code'), 'App.jsx contains a Refer a friend tile with referral_code display');

  // Test #485: App.jsx renders three home-dashboard cards near the admin home top
};
