const {
  fs, path, dbModule, loginAs, clearLogin, post, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // ----------------------------------------------------
  // Round BF17: Master Bug Spec Regression Tests
  // ----------------------------------------------------
  console.log('\n--- Round BF17: Master Bug Spec Regression Tests ---');

  const latestAppCode = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Issue 1: Direct verify-otp for pending stockist returns 403 and no token
  const bf17PendingPhone = '9777999888';
  const bf17RegRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'BF17 Gate Test Stockist',
    phone: bf17PendingPhone, email: 'test_' + bf17PendingPhone + '@fastnet.test',
    region_id: 'r1',
    shop_name: 'Gate Store',
    shop_address: '123 Gate Road, Kolkata',
    kyc_id_type: 'AADHAAR',
    kyc_id_number: '123456789012'
  });
  assert(bf17RegRes.status === 200, 'BF17 Stockist registration succeeds with pending KYC');

  const bf17VerifyRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: bf17PendingPhone, email: 'test_' + bf17PendingPhone + '@fastnet.test',
    otp: '123456'
  });
  assert(bf17VerifyRes.status === 403 && !bf17VerifyRes.body.token && (bf17VerifyRes.body.error === 'KYC_NOT_APPROVED' || bf17VerifyRes.body.message?.includes('review')), 'Direct call to verify-otp for pending stockist returns 403 and issues no token');

  // Issue 2: Aadhaar validation in stockist registration (rejects 11 and 13 digits)
  const reg11Res = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Invalid 11 Aadhaar',
    phone: '9777999881', email: 'test_9777999881@fastnet.test',
    region_id: 'r1',
    shop_name: 'Store 11',
    shop_address: '11 Road',
    kyc_id_type: 'AADHAAR',
    kyc_id_number: '12345678901'
  });
  assert(reg11Res.status === 400 && reg11Res.body.error?.includes('12 digits'), 'Stockist registration rejects 11-digit Aadhaar with 400');

  const reg13Res = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Invalid 13 Aadhaar',
    phone: '9777999882', email: 'test_9777999882@fastnet.test',
    region_id: 'r1',
    shop_name: 'Store 13',
    shop_address: '13 Road',
    kyc_id_type: 'AADHAAR',
    kyc_id_number: '1234567890123'
  });
  assert(reg13Res.status === 400 && reg13Res.body.error?.includes('12 digits'), 'Stockist registration rejects 13-digit Aadhaar with 400');

  // Issue 3: Product creation without name or name < 2 chars returns 400
  const shortNameProdRes = await post('http://localhost:3001/api/products', {
    name: 'A',
    selling_price: 100,
    cost_price: 80,
    category: 'groceries',
    initial_stock: 10,
    stockist_id: 's1',
    region_id: 'r1',
    bill_invoice_url: 'http://example.com/bill.jpg'
  }, { rawJson: true });
  assert(shortNameProdRes.status === 400 && (shortNameProdRes.body.error === 'validation_failed' || shortNameProdRes.body.error === 'Product name is required' || shortNameProdRes.body.error?.includes('name')), 'POST /api/products with name < 2 chars returns 400');

  // Issue 4: Assigning vendor to stockist does not create duplicate stockist rows
  const stkUserToApprove = (await dbModule.getTable('users')).find(u => u.phone === bf17PendingPhone);
  if (stkUserToApprove) {
    const approveRes = await post('http://localhost:3001/api/admin/approve-kyc', {
      userId: stkUserToApprove.id,
      vendorId: 'v1'
    });
    assert(approveRes.status === 200, 'Approve KYC succeeds');
    const postStockists1 = await dbModule.getTable('stockists');
    const firstCount = postStockists1.length;
    // Approve again with same / another vendor
    await post('http://localhost:3001/api/admin/approve-kyc', {
      userId: stkUserToApprove.id,
      vendorId: 'v1'
    });
    const postStockists2 = await dbModule.getTable('stockists');
    assert(postStockists2.length === firstCount, 'Assigning vendor to stockist updates in-place and does not create duplicate stockists');
  }

  // Issue 4: Admin stockist creation with duplicate phone returns 409
  const dupPhoneRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Duplicate Phone Stockist',
    phone: bf17PendingPhone, email: 'test_' + bf17PendingPhone + '@fastnet.test',
    region_id: 'r1'
  });
  assert(dupPhoneRes.status === 409 && dupPhoneRes.body.error?.includes('already exists'), 'Creating stockist with duplicate phone returns 409');

  // Issue 6: Admin stockist create/update rejects closing time 24:00 with 400
  const time24Res = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Time 24 Stockist',
    phone: '9777999883', email: 'test_9777999883@fastnet.test',
    region_id: 'r1',
    closing_time: '24:00'
  });
  assert(time24Res.status === 400 && time24Res.body.error?.includes('between 00:00 and 23:59'), 'Admin stockist create rejects closing_time 24:00 with 400');

  const edit24Res = await post('http://localhost:3001/api/admin/stockists/s1', {
    closing_time: '24:00'
  });
  assert(edit24Res.status === 400 && edit24Res.body.error?.includes('between 00:00 and 23:59'), 'Admin stockist edit rejects closing_time 24:00 with 400');

  // Issue 7: Edit Stockist modal inputs have proper htmlFor/id and labels
  assert(latestAppCode.includes('htmlFor="edit-stk-name"') && latestAppCode.includes('id="edit-stk-name"'), 'Edit Stockist modal contains htmlFor/id pair for edit-stk-name');
  assert(latestAppCode.includes('htmlFor="edit-stk-address"') && latestAppCode.includes('id="edit-stk-address"'), 'Edit Stockist modal contains htmlFor/id pair for edit-stk-address');
  assert(latestAppCode.includes('htmlFor="edit-stk-open"') && latestAppCode.includes('id="edit-stk-open"'), 'Edit Stockist modal contains htmlFor/id pair for edit-stk-open');
  assert(latestAppCode.includes('htmlFor="edit-stk-close"') && latestAppCode.includes('id="edit-stk-close"'), 'Edit Stockist modal contains htmlFor/id pair for edit-stk-close');
  assert(latestAppCode.includes('htmlFor="edit-stk-eta"') && latestAppCode.includes('id="edit-stk-eta"'), 'Edit Stockist modal contains htmlFor/id pair for edit-stk-eta');
  assert(latestAppCode.includes('htmlFor="edit-stk-radius"') && latestAppCode.includes('id="edit-stk-radius"'), 'Edit Stockist modal contains htmlFor/id pair for edit-stk-radius');

  // Issue 8: Order creation for HOME_DELIVERY with address < 5 chars returns 400
  const shortAddrOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'DELIVERY',
    deliveryAddress: '123',
    paymentMethod: 'COD',
    stores: [{
      stockistId: 's1',
      items: [{ productId: 'p1', quantity: 1 }]
    }]
  });
  assert(shortAddrOrderRes.status === 400 && shortAddrOrderRes.body.error?.includes('minimum 5 characters'), 'HOME_DELIVERY with address < 5 chars returns 400');

  // Issue 8: Order creation for HOME_DELIVERY with address >= 5 chars returns 200
  const validAddrOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'DELIVERY',
    deliveryAddress: '123 Lake Road, Kolkata',
    paymentMethod: 'COD',
    stores: [{
      stockistId: 's1',
      items: [{ productId: 'p1', quantity: 1 }]
    }]
  });
  assert(validAddrOrderRes.status === 200 && validAddrOrderRes.body.orderId, 'HOME_DELIVERY with valid address returns 200');

  // Issue 8: Customer signup delivery address label updated to optional note
  assert(latestAppCode.includes('Delivery Address (optional, you can add this at checkout)'), 'App.jsx includes updated customer signup delivery address label');

  // Issue BF18-6b: GET /api/admin/kyc-queue returns masked ID numbers
  const bf18bKycQueueRes = await get('http://localhost:3001/api/admin/kyc-queue');
  assert(bf18bKycQueueRes.status === 200 && Array.isArray(bf18bKycQueueRes.body), 'GET /api/admin/kyc-queue returns 200 array');
  const pendingStockist = bf18bKycQueueRes.body.find(u => u.id === 'u-stk3');
  assert(pendingStockist && pendingStockist.kyc_details.id_number.startsWith('XXXX-XXXX-'), 'GET /api/admin/kyc-queue returns masked id_number');

  // Issue BF18-6b: GET /api/admin/kyc/:userId/document with non-admin token/header returns 403
  clearLogin();
  const nonAdminDocRes = await get('http://localhost:3001/api/admin/kyc/u-stk3/document');
  assert(nonAdminDocRes.status === 401, 'GET /api/admin/kyc/:userId/document anonymous returns 401');

  loginAs('u-cust1', 'CUSTOMER');
  const custDocRes = await get('http://localhost:3001/api/admin/kyc/u-stk3/document');
  assert(custDocRes.status === 403, 'GET /api/admin/kyc/:userId/document customer returns 403');

  loginAs('u-partner-admin', 'PARTNER_ADMIN');
  const partnerDocRes = await get('http://localhost:3001/api/admin/kyc/u-stk3/document');
  assert(partnerDocRes.status === 403, 'GET /api/admin/kyc/:userId/document partner-admin returns 403 (KYC documents are admin-only)');

  loginAs('u-admin', 'ADMIN');

  // Issue BF18-6b: GET /api/admin/kyc/:userId/document with valid admin header returns unmasked ID
  const adminDocRes = await get('http://localhost:3001/api/admin/kyc/u-stk3/document', { headers: { 'x-admin-user-id': 'u-admin' } });
  assert(adminDocRes.status === 200 && adminDocRes.body.id_number === '1234-5678-9012', 'GET /api/admin/kyc/:userId/document returns unmasked id_number for admin');

  // Issue BF18-6b: GET /api/admin/kyc/u-stk5/document returns document_photo_url
  const adminDocRes5 = await get('http://localhost:3001/api/admin/kyc/u-stk5/document', { headers: { 'x-admin-user-id': 'u-admin' } });
  assert(adminDocRes5.status === 200 && adminDocRes5.body.document_photo_url.startsWith('/api/kyc/documents/sample-aadhaar.jpg'), 'GET /api/admin/kyc/:userId/document returns uploaded photo URL');

  // Test #810: Setup sample file and fetch with signed URL token
  const testFilename = 'sample-aadhaar.jpg';
  const testFilepath = path.join(__dirname, '../../uploads/kyc', testFilename);
  if (!fs.existsSync(path.dirname(testFilepath))) {
    fs.mkdirSync(path.dirname(testFilepath), { recursive: true });
  }
  fs.writeFileSync(testFilepath, 'fake-image-content');
  
  const docFileRes = await get('http://localhost:3001' + adminDocRes5.body.document_photo_url);
  assert(docFileRes.status === 200, 'GET /api/kyc/documents/sample-aadhaar.jpg returns 200 with sig (Test #810)');

  clearLogin();
  // Test #811: Fetch with valid sig returns 200 even when logged out
  const docFileRes401 = await get('http://localhost:3001' + adminDocRes5.body.document_photo_url);
  assert(docFileRes401.status === 200, 'GET /api/kyc/documents/sample-aadhaar.jpg without token returns 200 (Test #811)');
  loginAs('u-admin', 'ADMIN');

  // Issue BF18-6b: App.jsx contains Show, Hide, View Document buttons, revealedIds state, and showKycDocumentModal
  const appCodeFinal = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appCodeFinal.includes('handleShowUnmaskedId') && appCodeFinal.includes('handleHideUnmaskedId'), 'App.jsx contains handleShowUnmaskedId and handleHideUnmaskedId');
  assert(appCodeFinal.includes('handleViewDocument') && appCodeFinal.includes('showKycDocumentModal'), 'App.jsx contains handleViewDocument and showKycDocumentModal');
  assert(appCodeFinal.includes('No document'), 'App.jsx contains disabled No document label for stockist without document');

};
