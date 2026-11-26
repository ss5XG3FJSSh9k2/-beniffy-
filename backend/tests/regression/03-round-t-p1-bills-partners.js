const {
  postMultipart, post, patch, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // --- Round T: Stockist Bill Upload for SKU Integrity ---
  console.log('\n--- 24. Round T: Stockist Bill Upload for SKU Integrity ---');

  // Test 184: 503 when R2 is unconfigured and R2_MOCK=false
  const unconfigRes = await post('http://localhost:3001/api/products', { name: 'Test', price: 100 }, { rawJson: true, headers: { 'x-r2-mock': 'false' } });
  assert(unconfigRes.status === 503, 'R2 unconfigured returns 503');
  assert(unconfigRes.body.error === 'r2_not_configured', 'Error code is r2_not_configured');

  // Test 185: JSON POST (missing bill_photo) returns 400 bill_photo_required
  const jsonPostRes = await post('http://localhost:3001/api/products', {
    name: 'No Bill Product',
    category: 'groceries',
    price: 100,
    costPrice: 70,
    stockistId: 's1',
    regionId: 'r1',
    initialStock: 10
  }, { rawJson: true });
  assert(jsonPostRes.status === 400, 'JSON product create rejected with 400');
  assert(jsonPostRes.body.error === 'bill_photo_required', 'Error is bill_photo_required');

  // Test 186: Non-image file type (PDF) returns 400 invalid_file_type
  const pdfRes = await postMultipart('http://localhost:3001/api/products', {
    name: 'PDF Bill SKU',
    category: 'groceries',
    price: 100,
    costPrice: 70,
    stockistId: 's1',
    regionId: 'r1',
    initialStock: 10
  }, { fieldName: 'bill_photo', filename: 'bill.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }, 'POST');
  assert(pdfRes.status === 400, 'PDF upload rejected with 400');
  assert(pdfRes.body.error === 'invalid_file_type', 'Error is invalid_file_type');

  // Test 187: Oversized file (>8MB) returns 400 file_too_large
  const largeBuffer = Buffer.alloc(8 * 1024 * 1024 + 100);
  const largeRes = await postMultipart('http://localhost:3001/api/products', {
    name: 'Large Bill SKU',
    category: 'groceries',
    price: 100,
    costPrice: 70,
    stockistId: 's1',
    regionId: 'r1',
    initialStock: 10
  }, { fieldName: 'bill_photo', filename: 'big.jpg', mime: 'image/jpeg', buffer: largeBuffer }, 'POST');
  assert(largeRes.status === 400, 'File >8MB rejected with 400');
  assert(largeRes.body.error === 'file_too_large', 'Error is file_too_large');

  // Test 188: Valid JPEG multipart POST creates product and bill_photo row
  const createBillRes = await postMultipart('http://localhost:3001/api/products', {
    name: 'Integrity SKU 101',
    category: 'groceries',
    price: 150,
    costPrice: 110,
    stockistId: 's1',
    regionId: 'r1',
    initialStock: 25
  }, { fieldName: 'bill_photo', filename: 'bill1.jpg', mime: 'image/jpeg', buffer: Buffer.from('bill jpeg data') }, 'POST');
  assert(createBillRes.status === 200, 'Valid product + bill photo upload returns 200');
  assert(createBillRes.body.product.latest_bill_photo_id, 'Product has latest_bill_photo_id');
  console.log('ACTUAL STATUS FOR 196:', createBillRes.body.bill_photo.bill_status);
  assert(createBillRes.body.bill_photo.bill_status === 'PENDING', 'Initial bill photo bill_status is PENDING');
  const integrityProdId = createBillRes.body.product.id;
  const initialBillId = createBillRes.body.bill_photo.id;

  // Test 189: Non-price edit (name change) via JSON without bill photo succeeds
  const nonPricePatchRes = await patch(`http://localhost:3001/api/products/${integrityProdId}`, {
    name: 'Integrity SKU 101 Renamed',
    stockistId: 's1'
  }, { rawJson: true });
  assert(nonPricePatchRes.status === 200, 'Non-price edit without bill photo succeeds');

  // Test 190: Price edit via JSON without bill photo fails 400 bill_required_for_price_change
  const priceNoBillPatchRes = await patch(`http://localhost:3001/api/products/${integrityProdId}`, {
    price: 160,
    stockistId: 's1'
  }, { rawJson: true });
  assert(priceNoBillPatchRes.status === 400, 'Price edit without bill photo fails with 400');
  assert(priceNoBillPatchRes.body.error === 'bill_required_for_price_change', 'Error is bill_required_for_price_change');

  // Test 191: Price edit WITH bill photo succeeds and appends bill record
  const priceWithBillPatchRes = await postMultipart(`http://localhost:3001/api/products/${integrityProdId}`, {
    name: 'Integrity SKU 101 Renamed',
    price: 160,
    costPrice: 120,
    stockistId: 's1'
  }, { fieldName: 'bill_photo', filename: 'bill2.png', mime: 'image/png', buffer: Buffer.from('bill2 png data') }, 'PATCH');
  assert(priceWithBillPatchRes.status === 200, 'Price edit with bill photo succeeds');
  const secondBillId = priceWithBillPatchRes.body.bill_photo.id;
  assert(secondBillId !== initialBillId, 'New bill photo ID created on price edit');

  // Test 192: Bill history endpoint returns chronological bill photos
  const historyRes = await get(`http://localhost:3001/api/products/${integrityProdId}/bill-history`);
  assert(historyRes.status === 200, 'GET bill history returns 200');
  assert(historyRes.body.length === 2, `Bill history returns 2 entries (got ${historyRes.body.length})`);

  // Test 193: Admin bill photos list endpoint returns paginated bill list
  const adminBillsRes = await get('http://localhost:3001/api/admin/bill-photos');
  assert(adminBillsRes.status === 200, 'GET admin bill photos returns 200');
  assert(adminBillsRes.body.data.length >= 2, 'Admin bill photos list includes uploaded bills');

  // Test 194: Rejecting bill with reason < 5 chars fails 400
  const shortRejectRes = await post(`http://localhost:3001/api/admin/bill-photos/${secondBillId}/reject`, {
    admin_id: 'u-admin',
    reason: 'Bad'
  });
  assert(shortRejectRes.status === 400, 'Reject with reason < 5 chars fails with 400');
  assert(shortRejectRes.body.error === 'reason_too_short', 'Error is reason_too_short');

  // Test 195: Rejecting bill with valid reason sets REJECTED status & product has_flagged_bill
  const rejectBillRes = await post(`http://localhost:3001/api/admin/bill-photos/${secondBillId}/reject`, {
    admin_id: 'u-admin',
    reason: 'Invoice price does not match declared wholesale cost price.'
  });
  assert(rejectBillRes.status === 200, 'Reject bill succeeds with 200');
  assert(rejectBillRes.body.bill.bill_status === 'REJECTED', 'Bill bill_status set to REJECTED');
  assert(rejectBillRes.body.product.is_sellable === false, 'Product is_sellable set to false');

  // Test 196: Verifying bill sets VERIFIED and updates audit log
  const verifyRes = await post(`http://localhost:3001/api/admin/bill-photos/${secondBillId}/verify`, {
    admin_id: 'u-admin'
  });
  assert(verifyRes.status === 200, 'Verify bill succeeds with 200');
  assert(verifyRes.body.bill.bill_status === 'VERIFIED', 'Bill bill_status set to VERIFIED');
  assert(verifyRes.body.product.is_sellable === true, 'Product is_sellable set to true');

  // Test 197: Signed URL endpoint returns presigned read URL
  const signedUrlRes = await post(`http://localhost:3001/api/admin/bill-photos/${secondBillId}/signed-url`, {});
  assert(signedUrlRes.status === 200, 'Signed URL request succeeds with 200');
  assert(signedUrlRes.body.signed_url, 'Response contains signed_url');

  // Test 198: Filtering admin bill photos by bill_status
  const rejectInitialRes = await post(`http://localhost:3001/api/admin/bill-photos/${initialBillId}/reject`, {
    admin_id: 'u-admin',
    reason: 'Rejecting initial bill for status filter testing.'
  });
  assert(rejectInitialRes.status === 200, 'Rejected initial bill for filter test');

  const filteredStatusRes = await get('http://localhost:3001/api/admin/bill-photos?bill_status=REJECTED');
  assert(filteredStatusRes.status === 200, 'Filter by bill_status returns 200');
  assert(filteredStatusRes.body.data.every(b => b.bill_status === 'REJECTED'), 'All filtered bills have bill_status REJECTED');

  // Test 199: Filtering admin bill photos by stockist_id
  const filteredStockistRes = await get('http://localhost:3001/api/admin/bill-photos?stockist_id=s1');
  assert(filteredStockistRes.status === 200, 'Filter by stockist_id returns 200');
  assert(filteredStockistRes.body.data.every(b => b.stockist_id === 's1'), 'All filtered bills belong to stockist s1');

  // Test 200: Product is sellable because latest bill is verified
  const prodCheckRes = await get(`http://localhost:3001/api/products?stockistId=s1`);
  const targetProd = prodCheckRes.body.find(p => p.id === integrityProdId);
  assert(targetProd.is_sellable === true, 'Product is sellable because latest bill is verified');

  // 33. Round P1 — Partner Data Model & Auth
  console.log('\n--- 33. Round P1: Partner Data Model & Auth ---');

  // Test 1: Password login with correct email + password -> 200 with session token
  const p1_loginRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'adhya@partners.example',
    password: 'partner123'
  });
  assert(p1_loginRes.status === 200, 'Password login with correct email + password succeeds');
  assert(p1_loginRes.body.session_token, 'Login returns session_token');
  assert(p1_loginRes.body.user && p1_loginRes.body.user.email === 'adhya@partners.example', 'Login returns user object');
  assert(p1_loginRes.body.user.password_hash === undefined, 'password_hash is stripped from login user response');
  assert(p1_loginRes.body.partner && p1_loginRes.body.partner.id === 'ptr-adhya', 'Login returns partner object');
  const adhyaSessionToken = p1_loginRes.body.session_token;

  // Test 2: Password login with wrong password -> 401 generic error
  const p1_wrongPassRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'adhya@partners.example',
    password: 'wrongpassword'
  });
  assert(p1_wrongPassRes.status === 401, 'Password login with wrong password returns 401');
  assert(p1_wrongPassRes.body.error === 'Invalid credentials', 'Returns generic error message without leak');

  // Test 3: Password login with nonexistent email -> 401 same generic error
  const p1_nonExistentEmailRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'nobody@partners.example',
    password: 'somepassword'
  });
  assert(p1_nonExistentEmailRes.status === 401, 'Password login with nonexistent email returns 401');
  assert(p1_nonExistentEmailRes.body.error === 'Invalid credentials', 'Returns same generic error message without leak');

  // Test 4: Set password with valid session -> 200; login with new password succeeds
  const p1_setPassRes = await post('http://localhost:3001/api/partner/auth/set-password', {
    new_password: 'newpartnerpassword123'
  }, { headers: { Authorization: `Bearer ${adhyaSessionToken}` } });
  assert(p1_setPassRes.status === 200, 'Set password with valid session succeeds');

  const p1_loginNewPassRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'adhya@partners.example',
    password: 'newpartnerpassword123'
  });
  assert(p1_loginNewPassRes.status === 200, 'Login with newly set password succeeds');

  // Test 5: Forgot-password with real email -> 200, mockOutbox has 1 email; reset with valid token -> 200
  await post('http://localhost:3001/api/test/clear-mock-outbox', {});

  const p1_forgotRes = await post('http://localhost:3001/api/partner/auth/forgot-password', {
    email: 'jio@partners.example'
  });
  assert(p1_forgotRes.status === 200, 'Forgot password request succeeds with 200');
  const outboxRes = await get('http://localhost:3001/api/test/mock-outbox');
  const outbox = outboxRes.body;
  assert(Array.isArray(outbox) && outbox.length === 1, 'mockOutbox contains 1 sent email');
  assert(outbox[0].to === 'jio@partners.example', 'Email sent to correct partner email');

  const resetTokenMatch = outbox[0].textBody.match(/token=([a-f0-9]+)/);
  assert(resetTokenMatch && resetTokenMatch[1], 'Reset token extracted from mock email');
  const resetToken = resetTokenMatch[1];

  const p1_resetPassRes = await post('http://localhost:3001/api/partner/auth/reset-password', {
    token: resetToken,
    new_password: 'jionewpassword123'
  });
  assert(p1_resetPassRes.status === 200, 'Reset password with valid token succeeds');

  const p1_jioLoginRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'jio@partners.example',
    password: 'jionewpassword123'
  });
  assert(p1_jioLoginRes.status === 200, 'Login with reset password succeeds for Jio partner');

  // Test 6: Reset with expired/invalid token -> 400
  const p1_invalidTokenResetRes = await post('http://localhost:3001/api/partner/auth/reset-password', {
    token: 'invalid_or_expired_token_string',
    new_password: 'anotherpassword123'
  });
  assert(p1_invalidTokenResetRes.status === 400, 'Reset password with invalid token returns 400');

  // Test 7: Rate limit: 6 password login attempts in a row from same email -> 6th returns 429
  const testRateLimitEmail = 'ratelimit@partners.example';
  for (let i = 0; i < 5; i++) {
    await post('http://localhost:3001/api/partner/auth/login-password', { email: testRateLimitEmail, password: 'bad' });
  }
  const p1_sixthAttemptRes = await post('http://localhost:3001/api/partner/auth/login-password', { email: testRateLimitEmail, password: 'bad' });
  assert(p1_sixthAttemptRes.status === 429, '6th failed login attempt from same email returns 429');

  // Test 8: login-otp-request with an existing partner's phone -> 200
  const p1_otpReqRes = await post('http://localhost:3001/api/partner/auth/login-otp-request', {
    phone: '9876500000', email: 'test_9876500000@fastnet.test'
  });
  assert(p1_otpReqRes.status === 200, 'OTP request with existing partner phone returns 200');

  // Test 9: login-otp-request with nonexistent phone -> 200 (no leak)
  const p1_otpNonExistReqRes = await post('http://localhost:3001/api/partner/auth/login-otp-request', {
    phone: '9000000000', email: 'test_9000000000@fastnet.test'
  });
  assert(p1_otpNonExistReqRes.status === 200, 'OTP request with nonexistent phone returns 200 without leak');

  // Test 10: login-otp-verify with correct OTP 123456 -> 200 with session
  const p1_otpVerifyRes = await post('http://localhost:3001/api/partner/auth/login-otp-verify', {
    phone: '9876500000', email: 'test_9876500000@fastnet.test',
    otp: '123456'
  });
  assert(p1_otpVerifyRes.status === 200, 'OTP verify for partner succeeds with 200');
  assert(p1_otpVerifyRes.body.session_token, 'OTP verify returns session token');

  // Test 11: GET /api/partner/auth/session with valid Bearer token -> returns user + partner
  const p1_sessionCheckRes = await get('http://localhost:3001/api/partner/auth/session', {
    headers: { Authorization: `Bearer ${adhyaSessionToken}` }
  });
  assert(p1_sessionCheckRes.status === 200, 'Session check with valid Bearer token returns 200');
  assert(p1_sessionCheckRes.body.partner && p1_sessionCheckRes.body.partner.id === 'ptr-adhya', 'Session check returns partner');

  // Test 12: Same endpoint with tampered token -> 401
  const p1_tamperedSessionRes = await get('http://localhost:3001/api/partner/auth/session', {
    headers: { Authorization: 'Bearer tampered_invalid_token_xyz' }
  });
  assert(p1_tamperedSessionRes.status === 401, 'Session check with tampered token returns 401');

  // Test 13: Create partner via admin -> 200, users + partners + partner_users created and linked
  const p1_createPartnerRes = await post('http://localhost:3001/api/admin/partners', {
    legal_name: 'Metro Broadband Pvt Ltd',
    display_name: 'Metro Broadband',
    contact_phone: '9876599999',
    contact_email: 'metro@partners.example',
    address: '45 Salt Lake, Kolkata',
    service_types: ['BROADBAND'],
    admin_id: 'u-admin'
  });
  assert(p1_createPartnerRes.status === 200, 'Admin create partner succeeds with 200');
  assert(p1_createPartnerRes.body.partner && p1_createPartnerRes.body.partner.id, 'Partner object created with ID');
  assert(p1_createPartnerRes.body.user && p1_createPartnerRes.body.user.phone === '9876599999', 'User object created with phone');

  // Test 14: Create partner with phone that already exists on a customer -> 409
  const p1_duplicatePhoneRes = await post('http://localhost:3001/api/admin/partners', {
    legal_name: 'Dup Phone Partner',
    display_name: 'Dup Partner',
    contact_phone: '9830099001', // u-cust1 current phone
    contact_email: 'dupphone@partners.example',
    address: 'Some Address',
    service_types: ['CABLE'],
    admin_id: 'u-admin'
  });
  assert(p1_duplicatePhoneRes.status === 409, 'Creating partner with existing customer phone returns 409');

  // Test 15: Promote a lead -> lead status ONBOARDED, promoted_partner_id set, appears in admin partners
  const p1_leadRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'Subhasish Roy',
    phone: '9876588888', email: 'test_9876588888@fastnet.test',
    email: 'subhasish@lead.example',
    business_name: 'Roy Cable Services',
    city: 'Kolkata',
    service_type: 'CABLE',
    address: '99 Garia Park'
  });
  const p1_leadId = p1_leadRes.body.lead.id;

  const p1_promoteRes = await post(`http://localhost:3001/api/admin/partner-leads/${p1_leadId}/promote`, {
    admin_id: 'u-admin',
    service_types: ['CABLE']
  });
  assert(p1_promoteRes.status === 200, 'Promote lead succeeds with 200');
  assert(p1_promoteRes.body.lead.status === 'ONBOARDED', 'Lead status updated to ONBOARDED');
  assert(p1_promoteRes.body.lead.promoted_partner_id === p1_promoteRes.body.partner.id, 'Lead promoted_partner_id linked');

  // Test 16: Promote an already-promoted lead -> 409
  const p1_rePromoteRes = await post(`http://localhost:3001/api/admin/partner-leads/${p1_leadId}/promote`, {
    admin_id: 'u-admin',
    service_types: ['CABLE']
  });
  assert(p1_rePromoteRes.status === 409, 'Promoting already promoted lead returns 409');

  // Test 17: Admin PATCH partner name -> row updated, audit log entry created
  const p1_patchPartnerRes = await patch(`http://localhost:3001/api/admin/partners/${p1_promoteRes.body.partner.id}`, {
    display_name: 'Roy Cable & Fiber'
  });
  assert(p1_patchPartnerRes.status === 200, 'Admin PATCH partner name succeeds');
  assert(p1_patchPartnerRes.body.display_name === 'Roy Cable & Fiber', 'Partner display_name updated');

  const p1_auditLogRes = await get('http://localhost:3001/api/admin/audit-log');
  assert(p1_auditLogRes.body.some(a => a.action === 'EDIT_PARTNER' && a.entity_id === p1_promoteRes.body.partner.id), 'Audit log contains EDIT_PARTNER entry');

  // Test 18: Admin deactivates partner -> is_active=false AND all packages have is_active=false
  const p1_deactivatePartnerRes = await post(`http://localhost:3001/api/admin/partners/ptr-adhya/deactivate`, {});
  assert(p1_deactivatePartnerRes.status === 200, 'Deactivate partner succeeds with 200');
  assert(p1_deactivatePartnerRes.body.is_active === false, 'Partner is_active set to false');

  const p1_adhyaDetailRes = await get('http://localhost:3001/api/admin/partners/ptr-adhya');
  assert(p1_adhyaDetailRes.body.packages.every(pkg => pkg.is_active === false), 'All partner packages deactivated on partner deactivation');

  await post(`http://localhost:3001/api/admin/partners/ptr-adhya/reactivate`, {});

  // Test 19: Admin adds region binding to partner -> row created
  const p1_addRegionRes = await post('http://localhost:3001/api/admin/partners/ptr-jio/regions', {
    region_id: 'r2',
    service_type: 'BROADBAND',
    admin_id: 'u-admin'
  });
  assert(p1_addRegionRes.status === 200, 'Admin adds region mapping to partner succeeds');
  assert(p1_addRegionRes.body.region_id === 'r2', 'Region mapping created for r2');

  // Test 20: Duplicate (partner, region, service_type) insert -> 409
  const p1_dupRegionRes = await post('http://localhost:3001/api/admin/partners/ptr-jio/regions', {
    region_id: 'r2',
    service_type: 'BROADBAND',
    admin_id: 'u-admin'
  });
  assert(p1_dupRegionRes.status === 409, 'Duplicate region mapping insert returns 409');

  // Test 21: Create package with valid service_type + active_regions -> 200
  const p1_createPkgRes = await post('http://localhost:3001/api/admin/partners/ptr-jio/packages', {
    service_type: 'BROADBAND',
    name: '₹999 Jio Mega Broadband',
    description: '300 Mbps unlimited fiber connection',
    face_value_rupees: 999,
    cost_to_partner_rupees: 500,
    point_cost: 999,
    active_regions: ['r1', 'r2']
  });
  assert(p1_createPkgRes.status === 200, 'Create package with valid service_type + active_regions succeeds');
  assert(p1_createPkgRes.body.name === '₹999 Jio Mega Broadband', 'Package created with correct name');

  // Test 21b: Create package with cost_to_partner >= face_value -> 400
  const p1_invalidCostPkgRes = await post('http://localhost:3001/api/admin/partners/ptr-jio/packages', {
    service_type: 'BROADBAND',
    name: 'Invalid Cost Pkg',
    face_value_rupees: 500,
    cost_to_partner_rupees: 500,
    point_cost: 500,
    active_regions: ['r1']
  });
  assert(p1_invalidCostPkgRes.status === 400, 'Create package with cost_to_partner >= face_value returns 400');

  // Test 22: Create package with service_type not in partner's service_types -> 400
  const p1_invalidPkgRes = await post('http://localhost:3001/api/admin/partners/ptr-jio/packages', {
    service_type: 'CABLE',
    name: 'Invalid Cable Pkg',
    face_value_rupees: 200,
    active_regions: ['r1']
  });
  assert(p1_invalidPkgRes.status === 400, 'Create package with unsupported service_type returns 400');

  // Test 23: Partner (using own session) creates package for themselves -> 200, partner_id matches
  const p1_partnerSelfPkgRes = await post('http://localhost:3001/api/partner/packages', {
    service_type: 'CABLE',
    name: '₹350 Cable Standard',
    description: 'Standard cable tier',
    face_value_rupees: 350,
    cost_to_partner_rupees: 200,
    point_cost: 350,
    active_regions: ['r1']
  }, { headers: { Authorization: `Bearer ${adhyaSessionToken}` } });
  assert(p1_partnerSelfPkgRes.status === 200, 'Partner self-service package creation succeeds');
  assert(p1_partnerSelfPkgRes.body.partner_id === 'ptr-adhya', 'Created package partner_id matches session partner');

  // Test 24: Partner attempts to create a package for a DIFFERENT partner_id -> 403
  const p1_spoofPkgRes = await post('http://localhost:3001/api/partner/packages', {
    partner_id: 'ptr-jio',
    service_type: 'BROADBAND',
    name: 'Spoofed Package',
    face_value_rupees: 500,
    active_regions: ['r1']
  }, { headers: { Authorization: `Bearer ${adhyaSessionToken}` } });
  assert(p1_spoofPkgRes.status === 403, 'Partner creating package for different partner_id returns 403');

  // Test 25: Bind customer to a valid cable partner in their region -> 200
  const p1_bindRes = await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: 'u-cust1',
    cable_partner_id: 'ptr-adhya',
    broadband_partner_id: 'ptr-jio'
  });
  assert(p1_bindRes.status === 200, 'Bind customer to valid regional partners succeeds');
  assert(p1_bindRes.body.cable_partner_id === 'ptr-adhya', 'Binding cable_partner_id set correctly');

  // Test 26: Bind customer to a partner that doesn't serve their region / service -> 400
  const p1_bogusBindRes = await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: 'u-cust2',
    cable_partner_id: 'ptr-jio'
  });
  assert(p1_bogusBindRes.status === 400, 'Bind customer to partner not offering requested service_type returns 400');

  // Test 27: GET .../available returns only partners matching customer's region grouped by service_type
  const p1_availRes = await get('http://localhost:3001/api/customer/partner-bindings/u-cust1/available');
  assert(p1_availRes.status === 200, 'GET available partners returns 200');
  assert(Array.isArray(p1_availRes.body.cable) && Array.isArray(p1_availRes.body.broadband), 'Available partners grouped by cable and broadband');
  assert(p1_availRes.body.cable.some(p => p.id === 'ptr-adhya'), 'Adhya cable appears in cable available list');

  // Test 28: Update existing binding -> audit log entry created (only on updates, not on first-set)
  const p1_updateBindRes = await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: 'u-cust1',
    cable_partner_id: 'ptr-adhya',
    broadband_partner_id: 'ptr-jio'
  });
  assert(p1_updateBindRes.status === 200, 'Updating existing binding succeeds');

  const p1_auditLogCheck = await get('http://localhost:3001/api/admin/audit-log');
  assert(p1_auditLogCheck.body.some(a => a.action === 'UPDATE_PARTNER_BINDING' && a.entity_id === 'u-cust1'), 'Audit log contains UPDATE_PARTNER_BINDING entry on update');

};
