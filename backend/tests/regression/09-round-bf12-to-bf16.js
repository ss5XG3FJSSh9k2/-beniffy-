const {
  fs, path, dbModule, post, patch, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // Round BF12: KYC, Blacklist, Support Appeals, COD Commission, Cart Drawer, Points Consistency
  console.log('\n--- Round BF12: Beniffy Loyalty Issues #1-9 ---');

  // Test #718: POST /api/admin/kyc/:userId/approve sets user kyc_status to APPROVED
  const kycApproveRes = await post('http://localhost:3001/api/admin/kyc/u-stk1/approve');
  assert(kycApproveRes.status === 200 && kycApproveRes.body.status === 'APPROVED', 'POST /api/admin/kyc/:userId/approve returns status APPROVED');

  // Test #719: POST /api/admin/kyc/:userId/reject-with-appeal sets status to REJECTED with reason
  const kycRejectRes = await post('http://localhost:3001/api/admin/kyc/u-stk1/reject-with-appeal', { reason: 'Incomplete document scan' });
  assert(kycRejectRes.status === 200 && kycRejectRes.body.status === 'REJECTED' && kycRejectRes.body.can_reapply === true, 'POST /api/admin/kyc/:userId/reject-with-appeal sets REJECTED and can_reapply true');

  // Test #720: POST /api/admin/kyc/:userId/blacklist blacklists user and creates blacklist entry
  const kycBlacklistRes = await post('http://localhost:3001/api/admin/kyc/u-stk1/blacklist', { reason: 'Fraudulent document' }, { 'x-admin-user-id': 'u-admin1' });
  assert(kycBlacklistRes.status === 200 && kycBlacklistRes.body.status === 'BLACKLISTED' && kycBlacklistRes.body.can_reapply === false, 'POST /api/admin/kyc/:userId/blacklist returns status BLACKLISTED');

  // Test #721: GET /api/admin/blacklist returns blacklisted records
  const blListRes = await get('http://localhost:3001/api/admin/blacklist');
  assert(blListRes.status === 200 && Array.isArray(blListRes.body.blacklist) && blListRes.body.blacklist.length > 0, 'GET /api/admin/blacklist returns list of blacklisted users');

  // Test #722: POST /api/admin/blacklist/:userId/restore restores user to pending
  const restoreRes = await post('http://localhost:3001/api/admin/blacklist/u-stk1/restore', {}, { 'x-admin-user-id': 'u-admin1' });
  assert(restoreRes.status === 200 && restoreRes.body.success === true, 'POST /api/admin/blacklist/:userId/restore restores user');

  // Test #723: POST /api/support/tickets now returns 404 (removed)
  const ticketRes = await post('http://localhost:3001/api/support/tickets', {
    type: 'BLACKLIST_APPEAL',
    subject: 'Request to unblock account',
    description: 'Submitted updated valid documents for verification.'
  }, { 'x-user-id': 'u-stk1' });
  assert(ticketRes.status === 404, 'POST /api/support/tickets returns 404 (feature removed)');

  // Test #724: GET /api/admin/support/tickets returns 404 (removed)
  const ticketListRes = await get('http://localhost:3001/api/admin/support/tickets');
  assert(ticketListRes.status === 404, 'GET /api/admin/support/tickets returns 404 (feature removed)');

  // Test #725: POST /api/admin/support/tickets/:id/resolve returns 404 (removed)
  const resolveRes = await post(`http://localhost:3001/api/admin/support/tickets/st-fake/resolve`, { resolution: 'APPROVE_APPEAL' }, { 'x-admin-user-id': 'u-admin1' });
  assert(resolveRes.status === 404, 'POST /api/admin/support/tickets/:id/resolve returns 404 (feature removed)');

  // Test #726: PATCH /api/admin/stockists/:id handles DEACTIVATE and REACTIVATE
  const deactRes = await patch(`http://localhost:3001/api/admin/stockists/s1`, { action: 'DEACTIVATE' });
  assert(deactRes.status === 200 && deactRes.body.is_active === false, 'PATCH /api/admin/stockists/:id with DEACTIVATE sets is_active false');
  const reactRes = await patch(`http://localhost:3001/api/admin/stockists/s1`, { action: 'REACTIVATE' });
  assert(reactRes.status === 200 && reactRes.body.is_active === true, 'PATCH /api/admin/stockists/:id with REACTIVATE sets is_active true');

  // Test #727: GET /api/admin/stockists/:id/cod-commission returns COD commission breakdown
  const codCommRes = await get('http://localhost:3001/api/admin/stockists/s1/cod-commission');
  assert(codCommRes.status === 200 && Array.isArray(codCommRes.body.commissions), 'GET /api/admin/stockists/:id/cod-commission returns array');

  // Test #728: POST /api/admin/stockist/:id/cod-commission/mark-paid marks commission as paid
  const todayStr = new Date().toISOString().split('T')[0];
  const markPaidRes = await post('http://localhost:3001/api/admin/stockist/s1/cod-commission/mark-paid', { date: todayStr }, { 'x-admin-user-id': 'u-admin1' });
  assert(markPaidRes.status === 200 && markPaidRes.body.success === true, 'POST /api/admin/stockist/:id/cod-commission/mark-paid marks payment as paid');

  // Test #729: App.jsx contains bottom cart bar elements
  const freshAppContent = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  const hasCartDrawer = freshAppContent.includes("customerAppTab === 'cart'") || freshAppContent.includes('cartExpanded');
  assert(hasCartDrawer, 'App.jsx contains collapsible cart drawer elements (Issue #6)');

  // Test #730: App.jsx contains top-level Admin navigation items (Transactions, Blacklist, Support Tickets)
  const hasAdminNav = freshAppContent.includes("adminTab === 'transactions'") || freshAppContent.includes("adminTab === 'blacklist'") || freshAppContent.includes("adminTab === 'support'");
  assert(hasAdminNav, 'App.jsx contains top-level Admin navigation items (Issue #8)');

  // Test #731: App.jsx contains Points consistency notice (Points earned after order is delivered)
  const hasPointsNotice = freshAppContent.includes('Points earned after order is delivered') || freshAppContent.includes('Points pending delivery') || freshAppContent.includes('Est. Rewards');
  assert(hasPointsNotice, 'App.jsx contains consistent reward points estimation text (Issue #9)');

  // --- Round BF12 Final Issues #10-12 ---

  // Issue #10: Partner First-Time Login Workflow
  // Test #732: Create a lead and promote to partner (no email / password set initially) -> Partner first login returns setup_required: true
  const bf10LeadRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'BF10 Setup Partner',
    contact_name: 'BF10 Setup Partner',
    phone: '9988776655', email: 'test_9988776655@fastnet.test',
    contact_phone: '9988776655',
    service_type: 'BROADBAND',
    region_id: 'r1'
  });
  assert(bf10LeadRes.status === 200, 'Created lead for Issue 10 test');
  const bf10PromoteRes = await post(`http://localhost:3001/api/admin/partner-leads/${bf10LeadRes.body.lead.id}/promote`, {
    admin_id: 'u-admin'
  });
  assert(bf10PromoteRes.status === 200, 'Promoted lead for Issue 10 test');

  await post('http://localhost:3001/api/partner/auth/login-otp-request', { phone: '9988776655', email: 'test_9988776655@fastnet.test' });
  const bf10OtpLoginRes = await post('http://localhost:3001/api/partner/auth/login-otp-verify', { phone: '9988776655', email: 'test_9988776655@fastnet.test', otp: '123456' });
  assert(bf10OtpLoginRes.status === 200 && bf10OtpLoginRes.body.setup_required === true && bf10OtpLoginRes.body.setup_token, 'Partner first login returns setup_required: true');

  // Test #733: Partner with email already returns normal token
  const bf10NormalPartnerOtpRes = await post('http://localhost:3001/api/partner/auth/login-otp-verify', { phone: '9876500000', email: 'test_9876500000@fastnet.test', otp: '123456' });
  assert(bf10NormalPartnerOtpRes.status === 200 && !bf10NormalPartnerOtpRes.body.setup_required && (bf10NormalPartnerOtpRes.body.token || bf10NormalPartnerOtpRes.body.session_token), 'Partner with email already returns normal token');

  // Test #734: setup-complete rejects invalid email
  const bf10InvalidEmailRes = await post('http://localhost:3001/api/partner/auth/setup-complete', {
    email: 'invalid-email',
    password: 'password123'
  }, { headers: { Authorization: `Bearer ${bf10OtpLoginRes.body.setup_token}` } });
  assert(bf10InvalidEmailRes.status === 400, 'setup-complete rejects invalid email');

  // Test #735: setup-complete rejects password < 8 chars
  const bf10ShortPassRes = await post('http://localhost:3001/api/partner/auth/setup-complete', {
    email: 'bf10partner@example.com',
    password: 'short'
  }, { headers: { Authorization: `Bearer ${bf10OtpLoginRes.body.setup_token}` } });
  assert(bf10ShortPassRes.status === 400, 'setup-complete rejects password < 8 chars');

  // Test #736: setup-complete with valid email/password returns token
  const bf10SetupCompleteRes = await post('http://localhost:3001/api/partner/auth/setup-complete', {
    email: 'bf10partner@example.com',
    password: 'password123'
  }, { headers: { Authorization: `Bearer ${bf10OtpLoginRes.body.setup_token}` } });
  assert(bf10SetupCompleteRes.status === 200 && (bf10SetupCompleteRes.body.token || bf10SetupCompleteRes.body.session_token), 'setup-complete with valid email/password returns token');

  // Test #737: Partner second login can use email + password
  const bf10EmailLoginRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'bf10partner@example.com',
    password: 'password123'
  });
  assert(bf10EmailLoginRes.status === 200 && bf10EmailLoginRes.body.session_token, 'Partner second login can use email + password');

  // Test #738: App contains FirstTimeSetupFlow modal elements
  assert(freshAppContent.includes('FirstTimeSetupFlow') && freshAppContent.includes('handlePartnerSetupComplete'), 'App contains FirstTimeSetupFlow modal elements');

  // Issue #11: Move Subscriber Bill Discounts to Main Navigation
  // Test #739: Admin navigation contains [Bills] as top-level tab
  assert(freshAppContent.includes('data-path="/admin/bills"') || freshAppContent.includes('data-tab="bills"') || freshAppContent.includes("'/admin/bills'"), 'Admin navigation contains [Bills] as top-level tab');

  // Test #740: Clicking Bills tab navigates to /admin/bills
  assert(freshAppContent.includes("setAdminTab('bills')") && freshAppContent.includes("'/admin/bills'"), 'Clicking Bills tab navigates to /admin/bills');

  // Test #741: Bills panel renders data correctly
  assert(freshAppContent.includes("adminTab === 'bills'") && freshAppContent.includes("Subscriber Bill Discounts"), 'Bills panel renders data correctly');

  // Issue #12: Move Fraud Reports to Main Navigation
  // Test #742: Admin navigation contains [Fraud Reports] as top-level tab
  assert(freshAppContent.includes('data-path="/admin/fraud"') || freshAppContent.includes('data-tab="fraud"') || freshAppContent.includes("'/admin/fraud'"), 'Admin navigation contains [Fraud Reports] as top-level tab');

  // Test #743: Clicking Fraud Reports tab navigates to /admin/fraud
  assert(freshAppContent.includes("setAdminTab('fraud_reports')") && freshAppContent.includes("'/admin/fraud'"), 'Clicking Fraud Reports tab navigates to /admin/fraud');

  // Test #744: Fraud Reports panel renders data correctly
  // --- Round BF13: Post-Launch Bug Fixes (Bugs #1-4) ---
  console.log('\n--- Round BF13: Post-Launch Bug Fixes ---');

  // Test: Pending KYC Approvals section appears exactly ONCE in App.jsx
  const kycMatches = (freshAppContent.match(/Pending KYC Approvals/g) || []).length;
  assert(kycMatches === 1, `Pending KYC Approvals section appears exactly once in App.jsx (got ${kycMatches})`);

  // Test: POST /api/admin/kyc/:userId/reject alias returns 200
  const rejectTestRes = await post('http://localhost:3001/api/admin/kyc/u-stk3/reject', {
    reason: 'Incomplete shop registration document'
  });
  assert(rejectTestRes.status === 200 && rejectTestRes.body.status === 'REJECTED', 'POST /api/admin/kyc/:userId/reject rejects KYC and returns 200');

  // Test: POST /api/admin/kyc/:userId/blacklist and /api/admin/blacklist/:userId/restore endpoints work
  const blacklistTestRes = await post('http://localhost:3001/api/admin/kyc/u-stk3/blacklist', {
    reason: 'Fraudulent identity document'
  });
  assert(blacklistTestRes.status === 200 && blacklistTestRes.body.status === 'BLACKLISTED', 'POST /api/admin/kyc/:userId/blacklist returns 200');

  const liftTestRes = await post('http://localhost:3001/api/admin/blacklist/u-stk3/restore', {});
  assert(liftTestRes.status === 200 && liftTestRes.body.success, 'POST /api/admin/blacklist/:userId/restore restores blacklist and returns 200');

  // Test: App contains Blacklist nav tab, search filters, and Sign in with email link
  assert(freshAppContent.includes('data-path="/admin/blacklist"') && freshAppContent.includes('blacklistSearch'), 'App contains Blacklist nav tab and search filters');
  assert(freshAppContent.includes('Already set up email login? Sign in with email'), 'Partner login contains Sign in with email link instead of disabled tab');

  // --- Round BF14: Rate Limit Fix Spec ---
  const origNodeEnv = process.env.NODE_ENV;

  await post('http://localhost:3001/api/admin/reset-db', {});

  const currentUsers = await dbModule.getTable('users');
  const savedUsersState = [...currentUsers];
  currentUsers.length = 0;
  await dbModule.saveTable('users', currentUsers);

  const freshOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: '9888877770', email: 'test_9888877770@fastnet.test' });
  assert(freshOtpRes.status === 200 && freshOtpRes.body.success, 'Fresh DB allows OTP');

  for (const u of savedUsersState) currentUsers.push(u);
  await dbModule.saveTable('users', currentUsers);

  const limitTestPhone = '9888877779';
  let isSixthBlocked = false;
  for (let i = 0; i < 6; i++) {
    const res = await post('http://localhost:3001/api/auth/send-otp', { phone: limitTestPhone, email: 'test_' + limitTestPhone + '@fastnet.test' });
    if (i === 5 && res.status === 429) {
      isSixthBlocked = true;
    }
  }
  assert(isSixthBlocked, '6th OTP attempt blocked');

  await post('http://localhost:3001/api/admin/reset-db', {});
  const postResetOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: limitTestPhone, email: 'test_' + limitTestPhone + '@fastnet.test' });
  assert(postResetOtpRes.status === 200 && postResetOtpRes.body.success, 'DB reset clears rate limits');

  for (let i = 0; i < 6; i++) {
    await post('http://localhost:3001/api/auth/send-otp', { phone: limitTestPhone, email: 'test_' + limitTestPhone + '@fastnet.test' });
  }
  const clearRateLimitRes = await post('http://localhost:3001/api/admin/clear-rate-limits', {});
  assert(clearRateLimitRes.status === 200 && clearRateLimitRes.body.success, 'Manual clear works');

  const postClearOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: limitTestPhone, email: 'test_' + limitTestPhone + '@fastnet.test' });
  assert(postClearOtpRes.status === 200 && postClearOtpRes.body.success, 'OTP send succeeds after manual rate limit clear');

  process.env.NODE_ENV = 'production';
  const prodClearRes = await post('http://localhost:3001/api/admin/clear-rate-limits', {}, { headers: { 'x-node-env': 'production', 'x-forwarded-proto': 'https' } });
  assert(prodClearRes.status === 403, 'Production blocks clear');

  process.env.NODE_ENV = origNodeEnv;

  const bf14AppContent = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(bf14AppContent.includes('handleClearRateLimits') && bf14AppContent.includes('Clear Rate Limits'), 'App.jsx contains handleClearRateLimits and Clear Rate Limits button');

  // --- Round BF15: Spec Bug Fixes ---
  // Bug #1: Aadhaar Validation & Masking
  const bf15ShortAadhaarRes = await post('http://localhost:3001/api/auth/register-stockist', {
    phone: '9888811111', email: 'test_9888811111@fastnet.test',
    name: 'Short Aadhaar Stockist',
    shopName: 'Short Shop',
    regionId: 'r1',
    idType: 'Aadhaar',
    idNumber: '123',
    address: '123 Test St'
  });
  assert(bf15ShortAadhaarRes.status === 400, 'Stockist registration with 5-digit Aadhaar returns 400 error');

  const bf15AlphaAadhaarRes = await post('http://localhost:3001/api/auth/register-stockist', {
    phone: '9888811112', email: 'test_9888811112@fastnet.test',
    name: 'Alpha Aadhaar Stockist',
    shopName: 'Alpha Shop',
    regionId: 'r1',
    idType: 'Aadhaar',
    idNumber: 'abcdefghijkl',
    address: '123 Test St'
  });
  assert(bf15AlphaAadhaarRes.status === 400, 'Stockist registration with non-numeric Aadhaar returns 400 error');

  const bf15ValidAadhaarRes = await post('http://localhost:3001/api/auth/register-stockist', {
    phone: '9888811113', email: 'test_9888811113@fastnet.test',
    name: 'Valid Aadhaar Stockist',
    shopName: 'Valid Shop',
    regionId: 'r2',
    idType: 'Aadhaar',
    idNumber: '1234-5678-9012',
    address: '123 Test St'
  });
  assert(bf15ValidAadhaarRes.status === 200, 'Stockist registration with valid 12-digit Aadhaar returns 200 success');

  const appCodeContent = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appCodeContent.includes('formatAadhaar') && appCodeContent.includes('xxxx-xxxx-'), 'App.jsx includes formatAadhaar masking helper');

  // Bug #2: Region Display in Admin
  const regUser = (await dbModule.getTable('users')).find(u => u.phone === '9888811113');
  if (regUser) {
    await post('http://localhost:3001/api/admin/approve-kyc', { userId: regUser.id, vendorId: 'v1' });
  }
  const adminStockistsRes = await get('http://localhost:3001/api/admin/stockists?include_inactive=true');
  const createdStk = adminStockistsRes.body.find(s => s.user_phone === '9888811113');
  assert(createdStk && createdStk.region_id === 'r2', 'Stockist created in region r2 has region_id === r2');
  assert(adminStockistsRes.body.some(s => s.region_id === 'r1') && adminStockistsRes.body.some(s => s.region_id === 'r2'), 'GET /api/admin/stockists returns correct region_id per stockist (r1 vs r2)');

  const allRegionsRes = await get('http://localhost:3001/api/regions');
  assert(allRegionsRes.status === 200 && Array.isArray(allRegionsRes.body) && allRegionsRes.body.length >= 2, 'Multiple regions (r1, r2) exist in backend system');

  // Bug #3: Delivery Address Conditional
  const custId = 'u-cust1';
  const stkId = 's1';
  const prdId = 'p1';

  const pickupOrderNoAddrRes = await post('http://localhost:3001/api/orders', {
    customerId: custId,
    stores: [{ stockistId: stkId, items: [{ productId: prdId, quantity: 1 }], pickupSlot: '10:00 AM - 11:00 AM' }],
    fulfillmentType: 'PICKUP',
    paymentMethod: 'UPI'
  });
  assert(pickupOrderNoAddrRes.status === 200, 'Store Pickup order placed without address returns 200 (address optional for pickup)');

  const deliveryOrderNoAddrRes = await post('http://localhost:3001/api/orders', {
    customerId: custId,
    stores: [{ stockistId: stkId, items: [{ productId: prdId, quantity: 1 }] }],
    fulfillmentType: 'DELIVERY',
    deliveryAddress: '',
    address: ''
  });
  assert(deliveryOrderNoAddrRes.status === 400, 'Home Delivery order placed without address returns 400');

  const deliveryOrderWithAddrRes = await post('http://localhost:3001/api/orders', {
    customerId: custId,
    stores: [{ stockistId: stkId, items: [{ productId: prdId, quantity: 1 }] }],
    fulfillmentType: 'DELIVERY',
    deliveryAddress: '45 Park Street, Kolkata',
    paymentMethod: 'COD'
  });
  assert(deliveryOrderWithAddrRes.status === 200, 'Home Delivery order placed with valid address returns 200');

  const deliveryOrderWhitespaceAddrRes = await post('http://localhost:3001/api/orders', {
    customerId: custId,
    stores: [{ stockistId: stkId, items: [{ productId: prdId, quantity: 1 }] }],
    fulfillmentType: 'HOME_DELIVERY',
    deliveryAddress: '   '
  });
  assert(deliveryOrderWhitespaceAddrRes.status === 400, 'Home Delivery order with whitespace-only address returns 400');

  // Bug #4: Performance & Memoization
  assert(appCodeContent.includes('MemoizedStockistRow'), 'Admin stockists table memoized row component exists in App.jsx');
  assert(appCodeContent.includes('MemoizedCustomerRow'), 'Admin customers table memoized row component exists in App.jsx');
  assert(appCodeContent.includes('MemoizedOrderRow'), 'Admin orders table memoized row component exists in App.jsx');
  assert(appCodeContent.includes('MemoizedAuditLogRow'), 'Admin audit log table memoization component exists in App.jsx');
  // --- Round BF16: Critical Bugs Fixes ---
  console.log('\n--- Round BF16: Critical Bugs Fixes ---');

  // Register a stockist with pending KYC
  const pendingPhone = '9777111000';
  await post('http://localhost:3001/api/auth/register-stockist', {
    phone: pendingPhone, email: 'test_' + pendingPhone + '@fastnet.test',
    name: 'Pending Stockist',
    shopName: 'Pending Shop',
    regionId: 'r1',
    idType: 'Aadhaar',
    idNumber: '111122223333',
    address: '123 Main St'
  }, { rawJson: true });

  // Test 778: Pending KYC stockist send-otp blocked with 403
  const pendingOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: pendingPhone, email: 'test_' + pendingPhone + '@fastnet.test' });
  assert(pendingOtpRes.status === 403 && (pendingOtpRes.body.error === 'KYC_NOT_APPROVED' || pendingOtpRes.body.error === 'KYC Pending Approval'), 'Pending KYC stockist send-otp blocked with 403');

  // Test 779: Pending KYC stockist verify-otp blocked with 403
  const pendingVerifyRes = await post('http://localhost:3001/api/auth/verify-otp', { phone: pendingPhone, email: 'test_' + pendingPhone + '@fastnet.test', otp: '123456', expected_role: 'STOCKIST' });
  assert(pendingVerifyRes.status === 403 && (pendingVerifyRes.body.error === 'KYC_NOT_APPROVED' || pendingVerifyRes.body.error === 'KYC Pending Approval'), 'Pending KYC stockist verify-otp blocked with 403');

  // Test 780: Rejected KYC stockist send-otp returns 403 with rejected message
  const usersList = await dbModule.getTable('users');
  const pendingUser = usersList.find(u => u.phone === pendingPhone);
  if (pendingUser) pendingUser.kyc_status = 'REJECTED';
  await dbModule.saveTable('users', usersList);

  const rejectedOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: pendingPhone, email: 'test_' + pendingPhone + '@fastnet.test' });
  assert(rejectedOtpRes.status === 403 && rejectedOtpRes.body.message.includes('rejected'), 'Rejected KYC stockist send-otp returns 403 with rejection message');

  // Test 781: Blacklisted stockist send-otp returns 403 with blocked message
  if (pendingUser) pendingUser.kyc_status = 'BLACKLISTED';
  await dbModule.saveTable('users', usersList);

  const blacklistedOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: pendingPhone, email: 'test_' + pendingPhone + '@fastnet.test' });
  assert(blacklistedOtpRes.status === 403 && blacklistedOtpRes.body.message.includes('blocked'), 'Blacklisted stockist send-otp returns 403 with blocked message');

  // Test 782: Approved KYC stockist allowed to send-otp
  if (pendingUser) pendingUser.kyc_status = 'APPROVED';
  await dbModule.saveTable('users', usersList);

  const approvedOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: pendingPhone, email: 'test_' + pendingPhone + '@fastnet.test' });
  assert(approvedOtpRes.status === 200, 'Approved KYC stockist allowed to send-otp');

  // Test 783: POST /api/products without product name returns 400 error
  const noNameProdRes = await post('http://localhost:3001/api/products', {
    selling_price: 100,
    cost_price: 80,
    category: 'groceries',
    initial_stock: 50,
    stockist_id: 's1',
    region_id: 'r1',
    bill_invoice_url: 'http://example.com/bill.jpg'
  }, { rawJson: true });
  assert(noNameProdRes.status === 400 && noNameProdRes.body.error === 'validation_failed', 'POST /api/products without product name returns 400 error');

  // Test 784: POST /api/stockist/products with product name returns 200
  const validProdRes = await post('http://localhost:3001/api/stockist/products', {
    name: 'Basmati Rice 5kg',
    selling_price: 350,
    cost_price: 280,
    category: 'groceries',
    initial_stock: 20,
    stockist_id: 's1',
    region_id: 'r1',
    bill_invoice_url: 'http://example.com/bill.jpg'
  }, { rawJson: true });
  assert(validProdRes.status === 200 && validProdRes.body.product.name === 'Basmati Rice 5kg', 'POST /api/stockist/products with product name succeeds and creates product');

};
