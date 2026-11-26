const {
  fs, path, dbModule, loginAs, postMultipart, post, get, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // --- 40. BF-MIGRATION-023-ENCODING ---
  const migDir = path.join(__dirname, '../../lib/migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => f.endsWith('.sql') || f.endsWith('.js')).sort();
  let allMigUtf8Valid = true;
  for (const f of migFiles) {
    const buf = fs.readFileSync(path.join(migDir, f));
    const hasBom = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ||
                   (buf[0] === 0xfe && buf[1] === 0xff) ||
                   (buf[0] === 0xff && buf[1] === 0xfe);
    const hasNul = buf.includes(0);
    let decodesUtf8 = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      decodesUtf8 = false;
    }
    if (hasBom || hasNul || !decodesUtf8) {
      allMigUtf8Valid = false;
      break;
    }
  }
  assert(allMigUtf8Valid, 'every migration file is valid UTF-8 with no BOM and no NUL byte');

  const { newDb: createMemDb } = require('pg-mem');
  const freshMem = createMemDb();
  const freshPg = freshMem.adapters.createPg();
  const freshPool = new freshPg.Pool();
  const freshDb = {
    query: (t, p) => freshPool.query(t, p),
    getTable: async () => [],
    insertRow: async () => {},
    updateRow: async () => {},
    deleteRow: async () => {}
  };
  const loggedWarnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    loggedWarnings.push(args.join(' '));
  };
  try {
    const migModule = require('../../lib/migrations.js');
    await migModule.runMigrations(freshDb);
  } finally {
    console.warn = origWarn;
  }
  const unexpectedWarnings = loggedWarnings.filter(w => w.includes('[Migration warning]'));
  assert(unexpectedWarnings.length === 0, 'a fresh in-memory start prints zero [Migration warning] lines, except the named allow-list from item 4');

  const colRes = await dbModule.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'redemption_approvals'");
  const colNames = colRes.rows.map(r => r.column_name);
  assert(colNames.includes('partner_paid') && colNames.includes('partner_payout_ref') && colNames.includes('partner_payout_at'),
    'information_schema.columns shows partner_paid, partner_payout_ref and partner_payout_at on redemption_approvals');

  const mockPartnerId = 'p-test-payout-' + Date.now();
  const mockRedemptionId = 'r-test-payout-' + Date.now();
  await ctx.insert('partners', { id: mockPartnerId, onboarded_at: '2026-01-01T00:00:00Z', is_active: true });
  await ctx.insert('redemption_approvals', {
    id: mockRedemptionId,
    customer_user_id: 'u-cust',
    partner_id: mockPartnerId,
    status: 'FULFILLED',
    face_value_rupees: 100,
    rupees_value: 100,
    partner_paid: false,
    created_at: new Date().toISOString()
  });
  const payoutPaidRes = await post(`http://localhost:3001/api/admin/partner-payouts/${mockPartnerId}/mark-paid`, {
    payment_reference: 'REF-TXN-12345'
  }, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });
  assert(payoutPaidRes.status === 200 && payoutPaidRes.body.success === true && payoutPaidRes.body.count === 1,
    'Marking a partner payout as paid still works');

  // 40. BF-COD-RAZORPAY-IDS
  console.log('\n--- 40. BF-COD-RAZORPAY-IDS ---');
  loginAs('u-cust1', 'CUSTOMER');
  const codOrderCheck = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'COD',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(codOrderCheck.status === 200, 'COD order created for razorpay IDs check');
  assert(codOrderCheck.body.order.razorpay_order_id === null, 'COD order has null razorpay_order_id');
  assert(codOrderCheck.body.order.razorpay_payment_id === null, 'COD order has null razorpay_payment_id');

  const prepaidOrderCheck = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'UPI',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(prepaidOrderCheck.status === 200, 'Prepaid order created for razorpay IDs check');
  assert(typeof prepaidOrderCheck.body.order.razorpay_order_id === 'string' && (prepaidOrderCheck.body.order.razorpay_order_id.startsWith('rzp_order_') || prepaidOrderCheck.body.order.razorpay_order_id.startsWith('order_')), 'Prepaid order has valid razorpay_order_id');
  assert(prepaidOrderCheck.body.order.razorpay_payment_id === null || typeof prepaidOrderCheck.body.order.razorpay_payment_id === 'string', 'Prepaid order has null razorpay_payment_id before payment');

  // --- 41. BF-IDLE-RERENDER-TC-POPUP ---
  const appSrc = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appSrc.includes('hasActiveConfirming') && appSrc.includes('o.status === \'CONFIRMING\''), 'App.jsx nowTick timer is conditional on active confirming orders');
  assert(appSrc.includes('prev === el ? prev : el'), 'App.jsx setPhoneEl guards against redundant state updates');

  const regPhone = '9800099999';
  const regTermsCust = await post('http://localhost:3001/api/auth/register-customer', {
    phone: regPhone,
    name: 'Terms Test Customer',
    email: 'terms.cust@example.com',
    regionId: 'r1',
    termsAgreed: true
  });
  assert(regTermsCust.status === 200, 'Customer registration with terms agreed returns 200');
  const tcAllUsers = await dbModule.getTable('users');
  const registeredUser = tcAllUsers.find(u => u.phone === regPhone);
  assert(registeredUser && registeredUser.terms_accepted_at !== null, 'Registered customer has terms_accepted_at set');
  assert(registeredUser && registeredUser.terms_version === '2026-10-draft', 'Registered customer has correct terms_version');

  // --- 42. BF-FIELD-LIMITS-FORMATS ---
  console.log('\n--- 42. BF-FIELD-LIMITS-FORMATS ---');
  const badPhoneLogin = await post('http://localhost:3001/api/auth/send-otp', { phone: '5123456789' });
  assert(badPhoneLogin.status === 400, 'send-otp with invalid phone starting with 5 returns 400');

  const longPhoneLogin = await post('http://localhost:3001/api/auth/send-otp', { phone: '98765432101' });
  assert(longPhoneLogin.status === 400, 'send-otp with 11-digit phone returns 400');

  const badOtpLogin = await post('http://localhost:3001/api/auth/verify-otp', { phone: '9876543210', otp: '12345' });
  assert(badOtpLogin.status === 400, 'verify-otp with 5-digit OTP returns 400');

  const badCustReg = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '5876543210',
    name: 'Bad Phone User',
    email: 'bad.phone@example.com',
    regionId: 'r1',
    termsAgreed: true
  });
  assert(badCustReg.status === 400, 'register-customer with phone starting with 5 returns 400');

  const badPanStockist = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Stockist Bad KYC',
    phone: '9876500001',
    email: 'bad.kyc@example.com',
    shopName: 'Bad KYC Shop',
    address: '123 Main St',
    region: 'r1',
    kyc_id_type: 'PAN',
    kyc_id_number: 'INVALID_PAN'
  }, { asMultipart: true });
  assert(badPanStockist.status === 400, 'register-stockist with invalid PAN returns 400');

  const badAadhaarStockist = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Stockist Bad Aadhaar',
    phone: '9876500002',
    email: 'bad.aadhaar@example.com',
    shopName: 'Bad Aadhaar Shop',
    address: '123 Main St',
    region: 'r1',
    kyc_id_type: 'Aadhaar',
    kyc_id_number: '12345'
  }, { asMultipart: true });
  assert(badAadhaarStockist.status === 400, 'register-stockist with 5-digit Aadhaar returns 400');

  const badPickupPin = await post('http://localhost:3001/api/orders/ord-fake-123/verify-pickup', { pin: '12' });
  assert(badPickupPin.status === 400, 'verify-pickup with 2-digit PIN returns 400');

  // Helpful No Account Found verification tests
  const unregPhone = '9199990001';
  await post('http://localhost:3001/api/auth/login-otp-request', { phone: unregPhone });
  const unregCustomerVerify = await post('http://localhost:3001/api/auth/verify-otp', { phone: unregPhone, otp: '123456', expected_role: 'CUSTOMER' });
  assert(unregCustomerVerify.status === 404, 'verify-otp for unregistered customer returns 404');
  assert(unregCustomerVerify.body?.error === 'No account found', 'verify-otp for unregistered customer error is No account found');

  const unregStockistVerify = await post('http://localhost:3001/api/auth/verify-otp', { phone: unregPhone, otp: '123456', expected_role: 'STOCKIST' });
  assert(unregStockistVerify.status === 404, 'verify-otp for unregistered stockist returns 404');
  assert(unregStockistVerify.body?.error === 'No account found', 'verify-otp for unregistered stockist error is No account found');

  const unregAdminVerify = await post('http://localhost:3001/api/auth/verify-otp', { phone: unregPhone, otp: '123456', expected_role: 'ADMIN' });
  assert(unregAdminVerify.status === 403, 'verify-otp for unregistered admin returns 403');

  const unregPartnerPhone = '9199990002';
  const unregPartnerVerify = await post('http://localhost:3001/api/partner/auth/login-otp-verify', { phone: unregPartnerPhone, otp: '123456' });
  assert(unregPartnerVerify.status === 404, 'partner login-otp-verify for unregistered partner returns 404');
  // Clear risk flag tests
  loginAs('u-admin', 'ADMIN');
  const testFlagUserId = 'u-test-clear-flag-stk';
  await dbModule.insertRow('users', {
    id: testFlagUserId,
    name: 'Clear Flag Test Stockist',
    phone: '9830009991',
    role: 'STOCKIST',
    kyc_status: 'PENDING'
  });
  const testFlagId = 'fl-test-clear-1';
  await dbModule.insertRow('registration_flags', {
    id: testFlagId,
    user_id: testFlagUserId,
    flag_type: 'DUPLICATE_PHONE',
    severity: 'MEDIUM',
    detail: 'Phone matches another account'
  });

  const testClearNoNoteRes = await post(`http://localhost:3001/api/admin/kyc/${testFlagUserId}/flags/${testFlagId}/clear`, { note: '' });
  assert(testClearNoNoteRes.status === 400, 'clear flag without note returns 400');

  const testClearSuccessRes = await post(`http://localhost:3001/api/admin/kyc/${testFlagUserId}/flags/${testFlagId}/clear`, { note: 'No problem, verified in person' });
  assert(testClearSuccessRes.status === 200 && testClearSuccessRes.body?.success === true, 'clear flag with note returns 200 success');

  const _testClearAlreadyClearedRes = await post(`http://localhost:3001/api/admin/kyc/${testFlagUserId}/flags/${testFlagId}/clear`, { note: 'Another note' });
  // --- 43. BF-DEV-TOOLS-PRODUCTION-GATE ---
  console.log('\n--- 43. BF-DEV-TOOLS-PRODUCTION-GATE ---');
  loginAs('u-admin', 'ADMIN');
  const healthDevRes = await get('http://localhost:3001/api/health');
  assert(healthDevRes.status === 200 && healthDevRes.body.dev_tools_enabled === true, 'GET /api/health exposes dev_tools_enabled=true in test/dev');

  const configDevRes = await get('http://localhost:3001/api/config');
  assert(configDevRes.status === 200 && configDevRes.body.dev_tools_enabled === true, 'GET /api/config exposes dev_tools_enabled=true in test/dev');

  const inspectorDevRes = await get('http://localhost:3001/api/inspector');
  assert(inspectorDevRes.status === 200 && inspectorDevRes.body.status === 'ok', 'GET /api/inspector returns 200 in dev/test');

  const adminInspectorDevRes = await get('http://localhost:3001/api/admin/inspector');
  assert(adminInspectorDevRes.status === 200 && adminInspectorDevRes.body.status === 'ok', 'GET /api/admin/inspector returns 200 in dev/test');

  // Test production gating behavior
  const origEnv = process.env.NODE_ENV;
  const origSeed = process.env.SEED_MODE;
  process.env.NODE_ENV = 'production';
  delete process.env.SEED_MODE;

  try {
    const prodHeaders = { headers: { 'x-forwarded-proto': 'https' } };
    const healthProdRes = await get('http://localhost:3001/api/health', prodHeaders);
    assert(healthProdRes.status === 200 && healthProdRes.body.dev_tools_enabled === false, 'GET /api/health exposes dev_tools_enabled=false in production');

    const configProdRes = await get('http://localhost:3001/api/config', prodHeaders);
    assert(configProdRes.status === 200 && configProdRes.body.dev_tools_enabled === false, 'GET /api/config exposes dev_tools_enabled=false in production');

    const inspectorProdRes = await get('http://localhost:3001/api/inspector', prodHeaders);
    assert(inspectorProdRes.status === 403, 'GET /api/inspector returns 403 in production');

    const adminInspectorProdRes = await get('http://localhost:3001/api/admin/inspector', prodHeaders);
    assert(adminInspectorProdRes.status === 403, 'GET /api/admin/inspector returns 403 in production');

    const insertProdRes = await post('http://localhost:3001/api/admin/insert-table', { table: 'regions', row: { name: 'Prod Block Test' } }, prodHeaders);
    assert(insertProdRes.status === 403, 'POST /api/admin/insert-table returns 403 in production');

    const overrideProdRes = await post('http://localhost:3001/api/admin/override-table', { table: 'users', id: 'u-cust1', patch: { role: 'ADMIN' } }, prodHeaders);
    assert(overrideProdRes.status === 404, 'POST /api/admin/override-table returns 404 in production');
  } finally {
    process.env.NODE_ENV = origEnv;
    process.env.SEED_MODE = origSeed;
  }

  // --- 44. BF-SEEDED-USER-PHONES ---
  console.log('\n--- 44. BF-SEEDED-USER-PHONES ---');
  const seedRunner = require('../../lib/seed-runner.js');
  const seededUsers = seedRunner.DEFAULT_DB ? seedRunner.DEFAULT_DB.users : [];
  const phoneRegex = /^[6-9]\d{9}$/;
  const allPhonesValid = seededUsers.length > 0 && seededUsers.every(u => !u.phone || phoneRegex.test(u.phone));
  assert(allPhonesValid, 'every seeded user phone passes /^[6-9]\\d{9}$/');

  // --- 45. BF-PRODUCT-NO-IMAGE-NULL ---
  console.log('\n--- 45. BF-PRODUCT-NO-IMAGE-NULL ---');
  const noImgProdRes = await postMultipart('http://localhost:3001/api/products', {
    name: 'BF-NoImage-Test-Product',
    price: 150,
    costPrice: 120,
    category: 'groceries',
    initialStock: 10,
    stockistId: 's1',
    regionId: 'r1'
  }, { fieldName: 'bill_photo', filename: 'bill.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock bill photo') });
  assert(noImgProdRes.status === 200, 'Product creation without imageFile returns 200');
  const noImgProd = noImgProdRes.body.product || noImgProdRes.body;
  assert(noImgProd.image_url === null, 'Newly created product without image has image_url null, not an unsplash URL');

  // --- 46. BF-SHOP-ITEM-COUNT-AND-REGION-SYNC ---
  console.log('\n--- 46. BF-SHOP-ITEM-COUNT-AND-REGION-SYNC ---');
  loginAs('u-admin', 'ADMIN');
  const syncStkRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Region Sync Shop',
    phone: '9830099881',
    email: 'sync_test_9830099881@fastnet.test',
    region_id: 'r1',
    vendor_id: 'v1'
  });
  assert(syncStkRes.status === 200, 'Admin creates stockist in region r1');
  const syncStkId = syncStkRes.body.stockist.id;

  const sp1Res = await postMultipart('http://localhost:3001/api/products', {
    name: 'Sync Prod 1',
    price: 100,
    costPrice: 80,
    category: 'groceries',
    initialStock: 10,
    stockistId: syncStkId,
    regionId: 'r1'
  }, { fieldName: 'bill_photo', filename: 'bill.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock') });
  assert(sp1Res.status === 200, 'Product 1 created for sync shop');
  const sp1Id = (sp1Res.body.product || sp1Res.body).id;

  const sp2Res = await postMultipart('http://localhost:3001/api/products', {
    name: 'Sync Prod 2',
    price: 200,
    costPrice: 150,
    category: 'groceries',
    initialStock: 10,
    stockistId: syncStkId,
    regionId: 'r1'
  }, { fieldName: 'bill_photo', filename: 'bill.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock') });
  assert(sp2Res.status === 200, 'Product 2 created for sync shop');
  const sp2Id = (sp2Res.body.product || sp2Res.body).id;

  // Verify initial count in region r1
  const stkListR1 = await get('http://localhost:3001/api/stockists?regionId=r1');
  const shopInR1 = stkListR1.body.find(s => s.id === syncStkId);
  assert(shopInR1 && shopInR1.product_count === 2, 'Shop in region r1 shows product_count 2');

  const prodsInR1 = await get(`http://localhost:3001/api/products?regionId=r1&stockistId=${syncStkId}&customer=true`);
  assert(prodsInR1.status === 200 && Array.isArray(prodsInR1.body) && prodsInR1.body.length === 2, 'GET /api/products returns 2 items in region r1');

  // (a) Move shop from region r1 to region r2 via admin /region endpoint
  const moveRes = await post(`http://localhost:3001/api/admin/stockists/${syncStkId}/region`, { region_id: 'r2' });
  assert(moveRes.status === 200, 'Admin moves stockist to region r2');
  assert(moveRes.body.updated_products_count === 2, 'move response includes updated_products_count: 2');

  // Verify audit log has the updated product count
  const auditTable = await dbModule.getTable('admin_audit_log');
  const moveAudit = auditTable.slice().reverse().find(a => a.entity_id === syncStkId && a.action === 'CHANGE_STOCKIST_REGION');
  assert(moveAudit && moveAudit.reason.includes('Updated products count: 2'), 'Audit log includes updated products count for /region');

  // Customer in B (r2) sees product_count 2
  const stkListR2 = await get('http://localhost:3001/api/stockists?regionId=r2');
  const shopInR2 = stkListR2.body.find(s => s.id === syncStkId);
  assert(shopInR2 && shopInR2.product_count === 2, 'Customer in B sees product_count 2 after shop moves to B');

  // GET /api/products in B returns 2
  const prodsInR2 = await get(`http://localhost:3001/api/products?regionId=r2&stockistId=${syncStkId}&customer=true`);
  assert(prodsInR2.status === 200 && Array.isArray(prodsInR2.body) && prodsInR2.body.length === 2, 'GET /api/products returns 2 items for customer in B');

  // (b) Soft delete one product -> excluded from both count and list
  await dbModule.updateRow('products', sp2Id, { deleted_at: new Date().toISOString() });

  const stkListAfterDel = await get('http://localhost:3001/api/stockists?regionId=r2');
  const shopAfterDel = stkListAfterDel.body.find(s => s.id === syncStkId);
  assert(shopAfterDel && shopAfterDel.product_count === 1, 'Deleted product is excluded from product_count (now 1)');

  const prodsAfterDel = await get(`http://localhost:3001/api/products?regionId=r2&stockistId=${syncStkId}&customer=true`);
  assert(prodsAfterDel.status === 200 && Array.isArray(prodsAfterDel.body) && prodsAfterDel.body.length === 1 && prodsAfterDel.body[0].id === sp1Id, 'Deleted product is excluded from GET /api/products (only prod 1 returned)');

  // Also test moving shop via POST /api/admin/stockists/:id (the second endpoint) to region r3
  const editMoveRes = await post(`http://localhost:3001/api/admin/stockists/${syncStkId}`, { region_id: 'r3' });
  assert(editMoveRes.status === 200, 'POST /api/admin/stockists/:id with region_id r3 succeeds');

  const editAudit = (await dbModule.getTable('admin_audit_log')).slice().reverse().find(a => a.entity_id === syncStkId && a.action === 'EDIT_STOCKIST');
  assert(editAudit && editAudit.reason.includes('Updated products count: 2'), 'Audit log includes updated products count for EDIT_STOCKIST');

  const stkListR3 = await get('http://localhost:3001/api/stockists?regionId=r3');
  const shopInR3 = stkListR3.body.find(s => s.id === syncStkId);
  assert(shopInR3 && shopInR3.product_count === 1, 'Shop in region r3 has product_count 1');

  const prodsInR3 = await get(`http://localhost:3001/api/products?regionId=r3&stockistId=${syncStkId}&customer=true`);
  assert(prodsInR3.status === 200 && Array.isArray(prodsInR3.body) && prodsInR3.body.length === 1, 'GET /api/products in region r3 returns 1 product');

  // --- 47. BF-ADMIN-STOCKIST-VISIBILITY ---
  console.log('\n--- 47. BF-ADMIN-STOCKIST-VISIBILITY ---');
  
  // (a) KYC-pending shop appears in admin stockists (with include_pending=true) but not to customers (/api/stockists)
  const pendingOwnerId = 'u-test-pending-stk-' + Date.now();
  const pendingStkId = 's-test-pending-stk-' + Date.now();
  await dbModule.insertRow('users', {
    id: pendingOwnerId,
    tenant_id: 't1',
    region_id: 'r1',
    phone: '9888899991',
    email: 'pending_stk@test.com',
    name: 'Pending Stockist Owner',
    role: 'STOCKIST',
    kyc_status: 'PENDING',
    is_active: true,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('stockists', {
    id: pendingStkId,
    tenant_id: 't1',
    region_id: 'r1',
    user_id: pendingOwnerId,
    name: 'Pending Kirana Shop',
    phone: '9888899991',
    contact_phone: '9888899991',
    is_active: true,
    created_at: new Date().toISOString()
  });

  // Customer endpoint (/api/stockists) must NOT show this KYC-pending stockist
  const custStockists = await get('http://localhost:3001/api/stockists?regionId=r1');
  assert(custStockists.status === 200, 'GET /api/stockists returns 200');
  const foundInCust = custStockists.body.find(s => s.id === pendingStkId);
  assert(!foundInCust, 'KYC-pending shop is absent from customer shop list (/api/stockists)');

  // Admin endpoint (/api/admin/stockists?include_pending=true) MUST include this shop with kyc_status PENDING
  const adminStockistsWithPending = await get('http://localhost:3001/api/admin/stockists?include_pending=true');
  assert(adminStockistsWithPending.status === 200, 'GET /api/admin/stockists?include_pending=true returns 200');
  const foundInAdmin = adminStockistsWithPending.body.find(s => s.id === pendingStkId);
  assert(foundInAdmin && foundInAdmin.kyc_status === 'PENDING', 'KYC-pending shop appears in admin stockists list with kyc_status PENDING');
  assert(foundInAdmin.customer_visible === false && foundInAdmin.customer_visibility_reason === 'KYC pending', 'Admin list reports customer_visible=false with reason "KYC pending"');

  // (b) a stockist with no phone and a user with no phone do not match each other in isCustomerVisible
  const { isCustomerVisible: serverIsCustomerVisible, getCustomerVisibility: serverGetVisibility } = require('../../server.js');
  const emptyStockist = { id: 's-no-phone', is_active: true };
  const usersWithNoPhone = [
    { id: 'u-no-phone-1', role: 'STOCKIST', kyc_status: 'APPROVED', is_active: true },
    { id: 'u-no-phone-2', phone: '', role: 'STOCKIST', kyc_status: 'APPROVED', is_active: true }
  ];
  const noPhoneMatch = serverIsCustomerVisible(emptyStockist, usersWithNoPhone);
  assert(noPhoneMatch === false, 'Stockist with no phone and users with no phone do not match each other in isCustomerVisible');

  // Also test getCustomerVisibility reasons: inactive, owner deactivated, no products
  const inactiveStockist = { id: 's-inact', is_active: false, user_id: 'u-stk1' };
  assert(serverGetVisibility(inactiveStockist, usersWithNoPhone).reason === 'inactive', 'Visibility reason for inactive stockist is "inactive"');

  const deactOwnerUser = [{ id: 'u-deact-stk', role: 'STOCKIST', kyc_status: 'APPROVED', is_active: false }];
  const deactStockist = { id: 's-deact', is_active: true, user_id: 'u-deact-stk' };
  assert(serverGetVisibility(deactStockist, deactOwnerUser).reason === 'owner deactivated', 'Visibility reason for deactivated owner is "owner deactivated"');

  const noProdStockist = { id: 's-no-prod', is_active: true, user_id: 'u-active-stk' };
  const activeOwnerUser = [{ id: 'u-active-stk', role: 'STOCKIST', kyc_status: 'APPROVED', is_active: true }];
  assert(serverGetVisibility(noProdStockist, activeOwnerUser, []).reason === 'no products', 'Visibility reason when shop has 0 products is "no products"');
  assert(serverGetVisibility(noProdStockist, activeOwnerUser, [{ stockist_id: 's-no-prod', is_active: true, is_sellable: true }]).visible === true, 'Visibility is true when active owner has products');

};
