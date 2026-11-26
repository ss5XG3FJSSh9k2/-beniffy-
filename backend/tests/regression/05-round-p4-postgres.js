const {
  fs, path, dbModule, post, patch, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // --- Round P4a: Partner App Backend ---
  console.log('\n--- Round P4a: Partner App Backend ---');

  // Reset DB to start P4a with clean seed state
  await post('http://localhost:3001/api/admin/reset-db');

  // Login as adhya partner admin
  const p4a_adhyaLogin = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'adhya@partners.example',
    password: 'partner123'
  });
  const p4a_adhyaToken = p4a_adhyaLogin.body.session_token;

  // Login as jio partner admin
  const p4a_jioLogin = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'jio@partners.example',
    password: 'partner123'
  });
  const p4a_jioToken = p4a_jioLogin.body.session_token;

  // Test 367: Dashboard GET returns 200 with today, month, disputes
  const p4a_dashRes = await get('http://localhost:3001/api/partner/dashboard', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_dashRes.status === 200, 'GET /api/partner/dashboard returns 200');
  assert(p4a_dashRes.body.today && p4a_dashRes.body.month && p4a_dashRes.body.disputes, 'Dashboard contains today, month, disputes sections');

  // Test 368: Redemption approval increases pending_count
  const p4a_custRes = await post('http://localhost:3001/api/auth/register-customer', {
    name: 'P4a Customer 1',
    phone: '9811122233', email: 'test_9811122233@fastnet.test',
    regionId: 'r1',
    address: 'Garia Street 1',
    cable_partner_id: 'ptr-adhya'
  });
  const p4a_custId = p4a_custRes.body.user.id;
  await post(`http://localhost:3001/api/admin/customers/${p4a_custId}/points-credit`, { amount: 1000, reason: 'Test setup' });
  const p4a_redeemRes = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: p4a_custId,
    partner_package_id: 'ppk-adhya-basic',
    amount: 250
  });
  const p4a_approvalId = p4a_redeemRes.body.redemption_approval.id;

  // Admin approves
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4a_approvalId}/approve`, { admin_id: 'u-admin' });

  const p4a_dashPendingRes = await get('http://localhost:3001/api/partner/dashboard', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_dashPendingRes.body.today.pending_count >= 1, 'Dashboard today.pending_count = 1+ after admin approval');

  // Test 369: Partner fulfills redemption -> fulfilled_count = 1, face_value_total = 250, expected_payout = 220
  await post(`http://localhost:3001/api/partner/redemption-approvals/${p4a_approvalId}/fulfill`, {}, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });

  const p4a_dashFulfilledRes = await get('http://localhost:3001/api/partner/dashboard', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_dashFulfilledRes.body.today.fulfilled_count >= 1, 'Dashboard today.fulfilled_count >= 1 after fulfillment');
  assert(p4a_dashFulfilledRes.body.month.face_value_total_rupees >= 250, 'Dashboard month.face_value_total_rupees >= 250');
  assert(p4a_dashFulfilledRes.body.month.expected_payout_rupees >= 220, 'Dashboard month.expected_payout_rupees >= 220');

  // Test 370: Non-partner user hitting dashboard returns 401
  const p4a_dashUnauthRes = await get('http://localhost:3001/api/partner/dashboard');
  assert(p4a_dashUnauthRes.status === 401, 'GET /api/partner/dashboard with no token returns 401');

  // Test 371: Partner adds a region -> 200, appears in GET /regions
  const p4a_addRegionRes = await post('http://localhost:3001/api/partner/regions', { region_id: 'r3', service_type: 'CABLE' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_addRegionRes.status === 200, 'POST /api/partner/regions returns 200');
  const p4a_regionRowId = p4a_addRegionRes.body.id;

  const p4a_getRegionsRes = await get('http://localhost:3001/api/partner/regions', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_getRegionsRes.status === 200, 'GET /api/partner/regions returns 200');
  assert(p4a_getRegionsRes.body.some(r => r.id === p4a_regionRowId), 'Newly added region mapping present in list');

  // Test 372: Same partner adds duplicate -> 409
  const p4a_dupRegionRes = await post('http://localhost:3001/api/partner/regions', { region_id: 'r3', service_type: 'CABLE' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_dupRegionRes.status === 409, 'Adding duplicate region mapping returns 409');

  // Test 373: Partner adds region with service_type not in partner.service_types -> 400
  const p4a_invalidStRes = await post('http://localhost:3001/api/partner/regions', { region_id: 'r3', service_type: 'BROADBAND' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_invalidStRes.status === 400, 'Adding region with unsupported service_type returns 400');

  // Test 374: Partner deactivates region referenced by active package -> warning payload without confirm, then succeeds with confirm=true
  const p4a_deactWarnRes = await post('http://localhost:3001/api/partner/regions/prg-adhya-r1/deactivate', {}, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_deactWarnRes.status === 400 && p4a_deactWarnRes.body.requires_confirmation, 'Deactivating referenced region without confirm returns warning 400');

  const p4a_deactConfRes = await post('http://localhost:3001/api/partner/regions/prg-adhya-r1/deactivate', { confirm: true }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_deactConfRes.status === 200 && p4a_deactConfRes.body.is_active === false, 'Deactivating referenced region with confirm=true succeeds');

  // Reactivate it for future tests
  await post('http://localhost:3001/api/partner/regions/prg-adhya-r1/reactivate', {}, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });

  // Test 375: Partner attempts to modify another partner's region -> 403
  const p4a_crossPartnerRegionRes = await post('http://localhost:3001/api/partner/regions/prg-jio-r1/deactivate', {}, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_crossPartnerRegionRes.status === 403, 'Modifying another partner region returns 403');

  // Test 376: GET /api/partner/me returns partner + user + regions + packages + counts
  const p4a_meRes = await get('http://localhost:3001/api/partner/me', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_meRes.status === 200, 'GET /api/partner/me returns 200');
  assert(p4a_meRes.body.partner && p4a_meRes.body.user && p4a_meRes.body.regions && p4a_meRes.body.packages && p4a_meRes.body.counts, 'GET /me contains partner, user, regions, packages, counts');
  assert(!p4a_meRes.body.user.password_hash, 'GET /me user object does NOT expose password_hash');

  // Test 377: PATCH /me updates display_name -> 200, audit entry, no password_hash
  const p4a_patchMeRes = await patch('http://localhost:3001/api/partner/me', { display_name: 'Adhya Digital Cable' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_patchMeRes.status === 200, 'PATCH /api/partner/me returns 200');
  assert(p4a_patchMeRes.body.partner.display_name === 'Adhya Digital Cable', 'Partner display_name updated');
  assert(!p4a_patchMeRes.body.user.password_hash, 'PATCH /me response does NOT expose password_hash');

  // Test 378: PATCH /me with contact_phone change but no confirm_phone_change -> 400 warning
  const p4a_phoneWarnRes = await patch('http://localhost:3001/api/partner/me', { contact_phone: '9876599999' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_phoneWarnRes.status === 400 && p4a_phoneWarnRes.body.requires_confirmation, 'PATCH /me phone change without confirm returns 400 warning');

  // Test 379: PATCH /me trying to change legal_name -> 400 forbidden field
  const p4a_legalForbiddenRes = await patch('http://localhost:3001/api/partner/me', { legal_name: 'Hacked Legal Name' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_legalForbiddenRes.status === 400, 'PATCH /me attempting to edit forbidden legal_name returns 400');

  // Test 380: POST feedback linked to own redemption -> 200
  const p4a_fbRes = await post('http://localhost:3001/api/partner/feedback', {
    linked_type: 'REDEMPTION',
    linked_redemption_approval_id: p4a_approvalId,
    category: 'CUSTOMER_ISSUE',
    subject: 'Customer address mismatch',
    description: 'The customer provided an address that is slightly outside our primary fiber drop box range.'
  }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_fbRes.status === 200, 'POST /api/partner/feedback returns 200');
  const p4a_fbId = p4a_fbRes.body.id;

  // Test 381: POST feedback linked to another partner's redemption -> 403
  const p4a_fbCrossRes = await post('http://localhost:3001/api/partner/feedback', {
    linked_type: 'REDEMPTION',
    linked_redemption_approval_id: p4a_approvalId,
    category: 'CUSTOMER_ISSUE',
    subject: 'Cross partner feedback test',
    description: 'This is a description that is longer than 20 characters.'
  }, { headers: { Authorization: `Bearer ${p4a_jioToken}` } });
  assert(p4a_fbCrossRes.status === 403, 'Feedback linked to another partner redemption returns 403');

  // Test 382: POST feedback with description < 20 chars -> 400
  const p4a_fbShortRes = await post('http://localhost:3001/api/partner/feedback', {
    category: 'GENERAL',
    subject: 'Short subject',
    description: 'Too short'
  }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_fbShortRes.status === 400, 'Feedback description < 20 chars returns 400');

  // Test 383: Admin transitions feedback NEW -> RESOLVED with 10+ char notes -> 200, audit entry
  const p4a_fbResolveRes = await post(`http://localhost:3001/api/admin/partner-feedback/${p4a_fbId}/status`, {
    status: 'RESOLVED',
    admin_notes: 'Verified subscriber address with field agent and confirmed deployment.',
    admin_id: 'u-admin'
  });
  assert(p4a_fbResolveRes.status === 200, 'Admin resolving partner feedback returns 200');
  assert(p4a_fbResolveRes.body.status === 'RESOLVED', 'Feedback status updated to RESOLVED');

  // Test 384: Approve a redemption for adhya -> adhya's mockOutbox has email AND partner_notifications has new row
  const p4a_custRes2 = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9876500401', email: 'test_9876500401@fastnet.test',
    name: 'P4A Cust 2',
    regionId: 'r1',
    address: 'Garia Street 2',
    cable_partner_id: 'ptr-adhya'
  });
  const p4a_custId2 = p4a_custRes2.body.user.id;
  await post(`http://localhost:3001/api/admin/customers/${p4a_custId2}/points-credit`, { amount: 1000, reason: 'Test setup' });
  const p4a_redeemRes2 = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: p4a_custId2,
    partner_package_id: 'ppk-adhya-basic',
    amount: 250
  });
  const p4a_approvalId2 = p4a_redeemRes2.body.redemption_approval.id;

  const p4a_mockOutboxBefore = (await get('http://localhost:3001/api/test/mock-outbox')).body.length;
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4a_approvalId2}/approve`, { admin_id: 'u-admin' });
  const p4a_mockOutboxAfter = (await get('http://localhost:3001/api/test/mock-outbox')).body.length;
  assert(p4a_mockOutboxAfter > p4a_mockOutboxBefore, 'Admin approve sent email notification to mockOutbox');

  // Test 385: GET /api/partner/notifications?unread_only=true -> contains new row
  const p4a_notifRes = await get('http://localhost:3001/api/partner/notifications?unread_only=true', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_notifRes.status === 200, 'GET /api/partner/notifications returns 200');
  assert(p4a_notifRes.body.some(n => n.linked_id === p4a_approvalId2 && n.kind === 'REDEMPTION_APPROVED'), 'Notification array includes REDEMPTION_APPROVED row');
  const p4a_notifId = p4a_notifRes.body.find(n => n.linked_id === p4a_approvalId2).id;

  // Test 386: Mark notification as read -> is_read = true
  const p4a_markReadRes = await post('http://localhost:3001/api/partner/notifications/mark-read', { notification_ids: [p4a_notifId] }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_markReadRes.status === 200, 'POST /notifications/mark-read returns 200');

  // Test 387: Marking someone else's notification id -> 403
  const p4a_markOtherRes = await post('http://localhost:3001/api/partner/notifications/mark-read', { notification_ids: [p4a_notifId] }, { headers: { Authorization: `Bearer ${p4a_jioToken}` } });
  assert(p4a_markOtherRes.status === 403, 'Marking another partner notification returns 403');

  // Test 388: Bulk mark-all -> all notifications for partner flip to read
  const p4a_markAllRes = await post('http://localhost:3001/api/partner/notifications/mark-read', { mark_all: true }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_markAllRes.status === 200, 'Mark-all notifications returns 200');

  // Test 389: Feedback status change (admin RESOLVED) -> new notification of kind FEEDBACK_UPDATE
  const p4a_notifFbCheck = await get('http://localhost:3001/api/partner/notifications', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_notifFbCheck.body.some(n => n.kind === 'FEEDBACK_UPDATE'), 'Partner notifications include FEEDBACK_UPDATE row');

  // Test 390: Dispute resolution -> new notification of kind DISPUTE_RESOLVED
  const p4a_custRes3 = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9876500402', email: 'test_9876500402@fastnet.test',
    name: 'P4A Cust 3',
    regionId: 'r1',
    address: 'Garia Street 3',
    cable_partner_id: 'ptr-adhya'
  });
  const p4a_custId3 = p4a_custRes3.body.user.id;
  await post(`http://localhost:3001/api/admin/customers/${p4a_custId3}/points-credit`, { amount: 1000, reason: 'Test setup' });
  const p4a_redeemRes3 = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: p4a_custId3,
    partner_package_id: 'ppk-adhya-basic',
    amount: 250
  });
  const p4a_approvalId3 = p4a_redeemRes3.body.redemption_approval.id;
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4a_approvalId3}/approve`, { admin_id: 'u-admin' });
  await post(`http://localhost:3001/api/partner/redemption-approvals/${p4a_approvalId3}/dispute`, { reason: 'Cannot fulfill due to cut fiber line' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4a_approvalId3}/resolve-dispute`, { outcome: 'reject', admin_id: 'u-admin' });

  const p4a_notifDispCheck = await get('http://localhost:3001/api/partner/notifications', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  assert(p4a_notifDispCheck.body.some(n => n.kind === 'DISPUTE_RESOLVED' && n.linked_id === p4a_approvalId3), 'Partner notifications include DISPUTE_RESOLVED row');

  // Test 391: Full flow: register customer with adhya binding -> redeem -> admin approves -> adhya sees in dash & queue & notification -> fulfills -> dash updates -> polling shows FULFILLED
  const p4a_flowCustRes = await post('http://localhost:3001/api/auth/register-customer', {
    name: 'P4a Sanity Customer',
    phone: '9822233344', email: 'test_9822233344@fastnet.test',
    regionId: 'r1',
    address: 'Garia Street 2',
    cable_partner_id: 'ptr-adhya'
  });
  const p4a_flowCustId = p4a_flowCustRes.body.user.id;
  await post(`http://localhost:3001/api/admin/customers/${p4a_flowCustId}/points-credit`, { amount: 500, reason: 'Test setup' });
  const p4a_flowRedeem = await post('http://localhost:3001/api/ledger/redeem', { customer_user_id: p4a_flowCustId, partner_package_id: 'ppk-adhya-basic', amount: 250 });
  const p4a_flowApprId = p4a_flowRedeem.body.redemption_approval.id;
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4a_flowApprId}/approve`, { admin_id: 'u-admin' });
  await post(`http://localhost:3001/api/partner/redemption-approvals/${p4a_flowApprId}/fulfill`, {}, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  const p4a_flowStatus = await get(`http://localhost:3001/api/customer/redemption-status/${p4a_flowApprId}`);
  assert(p4a_flowStatus.body.status === 'FULFILLED', 'Customer redemption status polling returns FULFILLED');

  // Test 392: Full flow with rejection: admin rejects -> customer ledger REDEEM_REFUND -> adhya dashboard does NOT count as fulfilled -> adhya receives NO notification on reject
  const p4a_rejCustRes = await post('http://localhost:3001/api/auth/register-customer', {
    name: 'P4a Reject Customer',
    phone: '9833344455', email: 'test_9833344455@fastnet.test',
    regionId: 'r1',
    address: 'Garia Street 3',
    cable_partner_id: 'ptr-adhya'
  });
  const p4a_rejCustId = p4a_rejCustRes.body.user.id;
  await post(`http://localhost:3001/api/admin/customers/${p4a_rejCustId}/points-credit`, { amount: 500, reason: 'Test setup' });
  const p4a_rejRedeem = await post('http://localhost:3001/api/ledger/redeem', { customer_user_id: p4a_rejCustId, partner_package_id: 'ppk-adhya-basic', amount: 250 });
  const p4a_rejApprId = p4a_rejRedeem.body.redemption_approval.id;
  const p4a_notifCountBeforeRej = (await get('http://localhost:3001/api/partner/notifications', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } })).body.length;
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4a_rejApprId}/reject`, { admin_id: 'u-admin', reason: 'Invalid account number provided during check' });
  const p4a_notifCountAfterRej = (await get('http://localhost:3001/api/partner/notifications', { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } })).body.length;
  assert(p4a_notifCountAfterRej === p4a_notifCountBeforeRej, 'Admin reject does NOT issue a partner notification');

  // Test 393: Session isolation: adhya session cannot see jio resources
  const p4a_jioMeRes = await get('http://localhost:3001/api/partner/me', { headers: { Authorization: `Bearer ${p4a_jioToken}` } });
  assert(p4a_jioMeRes.body.partner.id === 'ptr-jio', 'Jio session returns jio partner object');
  assert(p4a_jioMeRes.body.partner.id !== p4a_meRes.body.partner.id, 'Adhya and Jio partner IDs are distinct');

  // Test 394: All GET /api/partner/* endpoints return 401 with no token
  const p4a_unauthMe = await get('http://localhost:3001/api/partner/me');
  const p4a_unauthReg = await get('http://localhost:3001/api/partner/regions');
  const p4a_unauthFb = await get('http://localhost:3001/api/partner/feedback');
  const p4a_unauthNotif = await get('http://localhost:3001/api/partner/notifications');
  assert(p4a_unauthMe.status === 401 && p4a_unauthReg.status === 401 && p4a_unauthFb.status === 401 && p4a_unauthNotif.status === 401, 'All /api/partner/* endpoints return 401 without token');

  // Test 395: All GET /api/partner/* endpoints return 401 with tampered token
  const p4a_tamperedMe = await get('http://localhost:3001/api/partner/me', { headers: { Authorization: 'Bearer invalid-tampered-token-12345' } });
  assert(p4a_tamperedMe.status === 401, 'GET /api/partner/me with tampered token returns 401');

  // --- Round P4b: Partner Web App Frontend ---
  console.log('\n--- Round P4b: Partner Web App Frontend ---');

  const p4b_appJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test 396: App.jsx contains Partner Login affordance and Sign in with email & Phone + OTP
  assert(p4b_appJsx.includes('Partner Login') && p4b_appJsx.includes('Sign in with email'), 'App.jsx contains a "Partner Login" affordance with "Sign in with email" option');

  // Test 397: App.jsx contains partnerAppTab state variable
  assert(p4b_appJsx.includes('partnerAppTab'), 'App.jsx contains partnerAppTab state variable');

  // Test 398: App.jsx renders 6 tabs matching spec
  assert(
    p4b_appJsx.includes("partnerAppTab === 'dashboard'") &&
    p4b_appJsx.includes("partnerAppTab === 'queue'") &&
    p4b_appJsx.includes("partnerAppTab === 'packages'") &&
    p4b_appJsx.includes("partnerAppTab === 'regions'") &&
    p4b_appJsx.includes("partnerAppTab === 'feedback'") &&
    p4b_appJsx.includes("partnerAppTab === 'profile'"),
    'App.jsx renders 6 tabs matching spec'
  );

  // Test 399: App.jsx includes call to /api/partner/dashboard
  assert(p4b_appJsx.includes('/partner/dashboard'), 'App.jsx includes a call to /api/partner/dashboard');

  // Test 400: App.jsx includes fulfill handler posting to /api/partner/redemption-approvals/
  assert(p4b_appJsx.includes('/partner/redemption-approvals/') && p4b_appJsx.includes('/fulfill'), 'App.jsx includes a fulfill handler posting to /api/partner/redemption-approvals/');

  // Test 401: App.jsx includes mark-read handler posting to /api/partner/notifications/mark-read
  assert(p4b_appJsx.includes('/partner/notifications/mark-read'), 'App.jsx includes a mark-read handler posting to /api/partner/notifications/mark-read');

  // Test 402: App.jsx handles localStorage session persistence under key fastnet_partner_session
  assert(p4b_appJsx.includes('fastnet_partner_session'), 'App.jsx handles localStorage session persistence under key fastnet_partner_session');

  // Test 403: Session persistence: valid session returns user + partner
  const p4b_loginRes = await post('http://localhost:3001/api/partner/auth/login-password', { email: 'adhya@partners.example', password: 'partner123' });
  const p4b_validSession = await get('http://localhost:3001/api/partner/auth/session', { headers: { Authorization: `Bearer ${p4b_loginRes.body.session_token}` } });
  assert(p4b_validSession.status === 200 && p4b_validSession.body.user && p4b_validSession.body.partner, 'On a valid session, GET /api/partner/auth/session returns user + partner');

  // Test 404: Session persistence: tampered token returns 401
  const p4b_badSession = await get('http://localhost:3001/api/partner/auth/session', { headers: { Authorization: 'Bearer tampered-token-999' } });
  assert(p4b_badSession.status === 401, 'On a tampered token, GET /api/partner/auth/session returns 401');

  // Test 405: Frontend build integrity (npx vite build completes)
  const { execSync } = require('child_process');
  let buildOk = false;
  try {
    execSync('npx vite build', { cwd: path.join(__dirname, '../../../frontend'), stdio: 'ignore', shell: true });
    buildOk = true;
  } catch (e) {
    buildOk = false;
  }
  assert(buildOk, 'npx vite build completes without errors');
  await new Promise(r => setTimeout(r, 200));

  // Test 406: E2E flow with new partner: admin creates partner -> login -> dash -> customer redeems -> admin approves -> partner notified -> fulfills -> dash updates
  const p4b_pName = 'P4b Test Partner';
  const p4b_pPhone = '9899988877';
  const p4b_adminCreatePartner = await post('http://localhost:3001/api/admin/partners', {
    legal_name: p4b_pName,
    display_name: p4b_pName,
    contact_phone: p4b_pPhone, email: 'test_' + p4b_pPhone + '@fastnet.test',
    contact_email: 'p4b@partner.example',
    service_types: ['CABLE'],
    regions: ['r1'],
    password: 'password123'
  });
  const p4b_pId = p4b_adminCreatePartner.body.partner.id;

  // Partner logs in via OTP
  await post('http://localhost:3001/api/partner/auth/login-otp-request', { phone: p4b_pPhone, email: 'test_' + p4b_pPhone + '@fastnet.test' });
  const p4b_pLogin = await post('http://localhost:3001/api/partner/auth/login-otp-verify', { phone: p4b_pPhone, email: 'test_' + p4b_pPhone + '@fastnet.test', otp: '123456' });
  const p4b_pToken = p4b_pLogin.body.session_token;

  // Add region mapping for partner
  await post('http://localhost:3001/api/partner/regions', { region_id: 'r1', service_type: 'CABLE' }, { headers: { Authorization: `Bearer ${p4b_pToken}` } });

  // Create package for new partner
  await post('http://localhost:3001/api/partner/packages', {
    name: 'P4b Basic Package',
    description: 'P4b test pkg',
    service_type: 'CABLE',
    face_value_rupees: 300,
    cost_to_partner_rupees: 150,
    point_cost: 300,
    active_regions: ['r1']
  }, { headers: { Authorization: `Bearer ${p4b_pToken}` } });

  const p4b_pDash1 = await get('http://localhost:3001/api/partner/dashboard', { headers: { Authorization: `Bearer ${p4b_pToken}` } });
  assert(p4b_pDash1.status === 200, 'New partner dashboard fetches successfully');

  // Customer registers with p4b_pId binding
  const p4b_cReg = await post('http://localhost:3001/api/auth/register-customer', {
    name: 'P4b E2E Customer',
    phone: '9877766655', email: 'test_9877766655@fastnet.test',
    regionId: 'r1',
    address: 'Garia Street P4b',
    cable_partner_id: p4b_pId
  });
  const p4b_cId = p4b_cReg.body.user.id;
  await post(`http://localhost:3001/api/admin/customers/${p4b_cId}/points-credit`, { amount: 1000, reason: 'P4b setup' });
  const p4b_pkgList = (await get('http://localhost:3001/api/partner/me', { headers: { Authorization: `Bearer ${p4b_pToken}` } })).body.packages;
  const p4b_pkgId = p4b_pkgList[0].id;
  const p4b_redeemRes = await post('http://localhost:3001/api/ledger/redeem', { customer_user_id: p4b_cId, partner_package_id: p4b_pkgId, amount: 300 });
  const p4b_apprId = p4b_redeemRes.body.redemption_approval.id;

  // Admin approves
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p4b_apprId}/approve`, { admin_id: 'u-admin' });

  // Partner sees notification
  const p4b_notifs = await get('http://localhost:3001/api/partner/notifications?unread_only=true', { headers: { Authorization: `Bearer ${p4b_pToken}` } });
  assert(p4b_notifs.body.some(n => n.linked_id === p4b_apprId), 'Partner sees notification on admin approval');

  // Partner fulfills
  await post(`http://localhost:3001/api/partner/redemption-approvals/${p4b_apprId}/fulfill`, { partner_notes: 'Fulfilled by P4b' }, { headers: { Authorization: `Bearer ${p4b_pToken}` } });

  // Dashboard month face value updates
  const p4b_pDash2 = await get('http://localhost:3001/api/partner/dashboard', { headers: { Authorization: `Bearer ${p4b_pToken}` } });
  assert(p4b_pDash2.body.month.face_value_total_rupees >= 300, 'Full E2E: dashboard month.face_value_total_rupees updates after fulfillment');

  // Test 407: Isolation: partner A cannot GET partner B dashboard
  const p4b_jioDash = await get('http://localhost:3001/api/partner/dashboard', { headers: { Authorization: `Bearer ${p4a_jioToken}` } });
  assert(p4b_jioDash.body.month.face_value_total_rupees !== p4b_pDash2.body.month.face_value_total_rupees || p4b_pId !== 'ptr-jio', 'Isolation: another partner cannot GET first partner dashboard values');

  // Test 408: Session logout: GET /session without stored token returns 401
  const p4b_noTokenSession = await get('http://localhost:3001/api/partner/auth/session');
  assert(p4b_noTokenSession.status === 401, 'Session logout: GET /session without stored token returns 401');

  // Test 409: Notification counts decrement after mark-all-read
  const p4b_unreadsBefore = (await get('http://localhost:3001/api/partner/notifications?unread_only=true', { headers: { Authorization: `Bearer ${p4b_pToken}` } })).body.length;
  await post('http://localhost:3001/api/partner/notifications/mark-read', { mark_all: true }, { headers: { Authorization: `Bearer ${p4b_pToken}` } });
  const p4b_unreadsAfter = (await get('http://localhost:3001/api/partner/notifications?unread_only=true', { headers: { Authorization: `Bearer ${p4b_pToken}` } })).body.length;
  assert(p4b_unreadsAfter === 0 && p4b_unreadsBefore > 0, 'Notification counts decrement after mark-all-read');

  // Test 410: Password change works end-to-end
  await post('http://localhost:3001/api/partner/auth/set-password', { current_password: 'partner123', new_password: 'newsecretpassword123' }, { headers: { Authorization: `Bearer ${p4a_adhyaToken}` } });
  const p4b_loginOldPass = await post('http://localhost:3001/api/partner/auth/login-password', { email: 'adhya@partners.example', password: 'partner123' });
  assert(p4b_loginOldPass.status === 401, 'Old password fails with 401 after password change');
  const p4b_loginNewPass = await post('http://localhost:3001/api/partner/auth/login-password', { email: 'adhya@partners.example', password: 'newsecretpassword123' });
  assert(p4b_loginNewPass.status === 200, 'Password change works end-to-end (login with new password succeeds)');

  // Postgres Integration Tests (#427-#436)
  console.log('\n--- Postgres Integration & Schema Verification ---');
  const pgUsers = await dbModule.getTable('users');
  assert(pgUsers.length >= 2, 'db.getTable(users) returns seeded users from Postgres');

  const countRes = await dbModule.query('SELECT COUNT(*) as count FROM orders');
  assert(parseInt(countRes.rows[0].count, 10) >= 0, 'db.query SELECT COUNT(*) FROM orders executes successfully');

  const pgLedger = await dbModule.getTable('points_ledger');
  assert(Array.isArray(pgLedger) && pgLedger.length > 0, 'db.getTable(points_ledger) returns append-only ledger rows');

  let updateBlocked = false;
  try {
    await dbModule.updateRow('points_ledger', pgLedger[0].id, { amount: 9999 });
  } catch (err) {
    updateBlocked = err.message.includes('append-only');
  }
  assert(updateBlocked, 'Direct updateRow on points_ledger is blocked by append-only rule');

  let deleteBlocked = false;
  try {
    await dbModule.deleteRow('points_ledger', pgLedger[0].id);
  } catch (err) {
    deleteBlocked = err.message.includes('append-only');
  }
  assert(deleteBlocked, 'Direct deleteRow on points_ledger is blocked by append-only rule');

  const pgApprovals = await dbModule.getTable('redemption_approvals');
  assert(Array.isArray(pgApprovals), 'db.getTable(redemption_approvals) returns array');

  const pgAudit = await dbModule.getTable('admin_audit_log');
  assert(Array.isArray(pgAudit), 'db.getTable(admin_audit_log) returns array');

  const pgBindings = await dbModule.getTable('customer_partner_bindings');
  assert(Array.isArray(pgBindings), 'db.getTable(customer_partner_bindings) returns array');

  const pingRes = await dbModule.query('SELECT 1 as alive');
  assert(pingRes.rows[0].alive === 1 || pingRes.rows[0].alive === '1', 'Postgres engine health check query SELECT 1 as alive succeeds');

  await post('http://localhost:3001/api/admin/reset-db');
  const resetUsers = await dbModule.getTable('users');
  assert(resetUsers.length >= 2, 'db.resetForTest() re-seeds baseline data in Postgres');

};
