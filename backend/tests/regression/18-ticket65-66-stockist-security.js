const {
  fs, path, dbModule, loginAs, clearLogin, postMultipart, post, patch, get, state, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // ==========================================
  // TICKET 65: Realistic seed data covering multi-shop, order states, payouts and notifications
  // ==========================================
  console.log('\n--- Ticket 65: Seed Data Realism & Invariants ---');
  // Reset database to ensure we test freshly seeded state
  loginAs('u-admin', 'ADMIN');
  await post('http://localhost:3001/api/admin/reset-db');

  const t65SeedRunnerMod = require('../../lib/seed-runner.js');
  const t65SeededDb = t65SeedRunnerMod.DEFAULT_DB;

  // 1. Invariant: every shop with vendor_id has a matching stockist_vendors row
  const t65AllStockists = await dbModule.getTable('stockists');
  const t65AllStockistVendors = await dbModule.getTable('stockist_vendors');
  for (const s of t65AllStockists) {
    if (s.vendor_id) {
      const match = t65AllStockistVendors.find(sv => sv.stockist_id === s.id && sv.vendor_id === s.vendor_id);
      assert(match, `Stockist ${s.id} with vendor_id ${s.vendor_id} has matching stockist_vendors row`);
    }
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Every stockist with vendor_id has a matching stockist_vendors row`);

  // 2. Invariant: every seeded phone matches /^[6-9]\d{9}$/
  const t65PhoneRegex = /^[6-9]\d{9}$/;
  for (const u of t65SeededDb.users) {
    assert(t65PhoneRegex.test(u.phone), `User ${u.id} phone ${u.phone} matches /^[6-9]\\d{9}$/`);
  }
  for (const s of t65SeededDb.stockists) {
    assert(t65PhoneRegex.test(s.contact_phone), `Stockist ${s.id} contact_phone ${s.contact_phone} matches /^[6-9]\\d{9}$/`);
  }
  for (const p of t65SeededDb.partners) {
    assert(t65PhoneRegex.test(p.contact_phone), `Partner ${p.id} contact_phone ${p.contact_phone} matches /^[6-9]\\d{9}$/`);
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Every seeded phone number matches /^[6-9]\\d{9}$/`);

  // 3. Invariant: no order has a payout without being DELIVERED
  const t65AllOrders = await dbModule.getTable('orders');
  const t65AllPayouts = await dbModule.getTable('split_payouts');
  for (const p of t65AllPayouts) {
    const ord = t65AllOrders.find(o => o.id === p.order_id);
    assert(ord && ord.status === 'DELIVERED', `Payout ${p.id} belongs to a DELIVERED order: got ${ord ? ord.status : 'null'}`);
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: No order has a payout without being DELIVERED`);

  // 4. Invariant: product_count equals customer-visible products
  const t65ServerProds = await dbModule.getTable('products');
  const { getCustomerVisibleProducts: t65GetVisibleProds } = require('../../server.js');
  const t65StockistsRes = await get('http://localhost:3001/api/stockists');
  assert(t65StockistsRes.status === 200, 'GET /api/stockists returns 200');
  for (const stk of t65StockistsRes.body) {
    const visibleCount = t65GetVisibleProds(stk, t65ServerProds).length;
    assert(stk.product_count === visibleCount, `Stockist ${stk.id} product_count (${stk.product_count}) equals visible products count (${visibleCount})`);
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist product_count equals customer-visible products`);

  // 5. Banerjee Corner Store (s3) has 6 products with cost price, stock, and null image_url
  const t65S3Prods = t65ServerProds.filter(p => p.stockist_id === 's3' && !p.deleted_at);
  assert(t65S3Prods.length === 6, `Banerjee Corner Store (s3) has 6 products: got ${t65S3Prods.length}`);
  for (const p of t65S3Prods) {
    assert(p.cost_price !== undefined && p.cost_price !== null, `Product ${p.id} has cost_price`);
    assert(p.image_url === null, `Product ${p.id} has null image_url`);
  }
  const t65S3Inv = (await dbModule.getTable('stockist_inventory')).filter(i => i.stockist_id === 's3');
  assert(t65S3Inv.length === 6 && t65S3Inv.every(i => i.stock_qty > 0), 'All 6 s3 products have positive stock in inventory');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Banerjee Corner Store (s3) has 6 stocked products with cost price and null image_url`);

  // 6. Second approved, stocked shop in Bishnupur (s4, owner phone 8432100001)
  const t65S4Shop = t65AllStockists.find(s => s.id === 's4');
  assert(t65S4Shop, 'Second Bishnupur shop s4 exists');
  assert(t65S4Shop.region_id === 'r2', 's4 is in Bishnupur (r2)');
  assert(t65S4Shop.contact_phone === '8432100001', 's4 owner contact phone is 8432100001');
  const t65S4Owner = (await dbModule.getTable('users')).find(u => u.phone === '8432100001');
  assert(t65S4Owner && t65S4Owner.role === 'STOCKIST' && t65S4Owner.kyc_status === 'APPROVED', 's4 owner is approved stockist');
  assert(t65S4Owner.email && t65S4Owner.email.includes('@'), 's4 owner has valid email');
  const t65S4VendorLink = t65AllStockistVendors.find(sv => sv.stockist_id === 's4' && sv.vendor_id === 'v2');
  assert(t65S4VendorLink, 's4 has its own wholesaler link to v2');
  const t65S4Prods = t65ServerProds.filter(p => p.stockist_id === 's4' && !p.deleted_at);
  assert(t65S4Prods.length >= 5, `s4 is stocked with at least 5 products: got ${t65S4Prods.length}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Second approved, stocked shop in Bishnupur (s4, owner 8432100001) with wholesaler link and products`);

  // 7. Payout details on every seeded shop and partner
  const t65AllPartners = await dbModule.getTable('partners');
  for (const s of t65AllStockists) {
    assert(s.payout_upi_id && s.payout_upi_id.includes('@'), `Stockist ${s.id} has payout_upi_id`);
    assert(s.payout_bank_account && /^\d{9,18}$/.test(s.payout_bank_account), `Stockist ${s.id} has valid bank account`);
    assert(s.payout_ifsc && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s.payout_ifsc), `Stockist ${s.id} has valid IFSC`);
    assert(s.payout_account_name && s.payout_account_name.length >= 2, `Stockist ${s.id} has account holder name`);
  }
  for (const p of t65AllPartners) {
    assert(p.payout_upi_id && p.payout_upi_id.includes('@'), `Partner ${p.id} has payout_upi_id`);
    assert(p.payout_bank_account && /^\d{9,18}$/.test(p.payout_bank_account), `Partner ${p.id} has valid bank account`);
    assert((p.payout_bank_ifsc || p.payout_ifsc) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(p.payout_bank_ifsc || p.payout_ifsc), `Partner ${p.id} has valid IFSC`);
    assert(p.payout_account_name && p.payout_account_name.length >= 2, `Partner ${p.id} has account holder name`);
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Payout details (UPI, bank, IFSC, holder) verified on every seeded shop and partner`);

  // 8. Seeded orders for customer 9876543210 cover CONFIRMING, READY, DELIVERED, and CANCELLED
  loginAs('u-cust1', 'CUSTOMER');
  const t65CustOrdersRes = await get('http://localhost:3001/api/orders');
  assert(t65CustOrdersRes.status === 200, 'GET /api/orders returns 200');
  const t65CustOrders = t65CustOrdersRes.body;
  const t65ConfOrder = t65CustOrders.find(o => o.status === 'CONFIRMING');
  assert(t65ConfOrder, 'Customer has a CONFIRMING order');
  assert(new Date(t65ConfOrder.cancel_deadline) > new Date(), 'CONFIRMING order is inside cancel window');

  const t65ReadyOrder = t65CustOrders.find(o => o.status === 'READY');
  assert(t65ReadyOrder, 'Customer has a READY order');
  assert(t65ReadyOrder.fulfillment_type === 'PICKUP', 'READY order is pickup');
  assert(t65ReadyOrder.pickup_slot, 'READY order has future pickup slot');

  const t65DelivOrder = t65CustOrders.find(o => o.status === 'DELIVERED');
  assert(t65DelivOrder, 'Customer has a DELIVERED order');
  assert(t65DelivOrder.payment_status === 'PAID' && (t65DelivOrder.payment_method === 'UPI' || t65DelivOrder.payment_received_method === 'UPI'), 'DELIVERED order is PAID via UPI');
  assert(parseFloat(t65DelivOrder.points_credited) > 0, 'DELIVERED order has points credited');

  const t65CancOrder = t65CustOrders.find(o => o.status === 'CANCELLED');
  assert(t65CancOrder, 'Customer has a CANCELLED order');
  assert(t65CancOrder.payment_status === 'CANCELLED_UNPAID' || t65CancOrder.payment_status === 'UNPAID', 'CANCELLED order is CANCELLED_UNPAID');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer 9876543210 orders cover CONFIRMING, READY, DELIVERED, CANCELLED`);

  // 9. Bill photos: 1 PENDING, 1 REJECTED with reason
  const t65AllBillPhotos = await dbModule.getTable('product_bill_photos');
  const t65PendingBill = t65AllBillPhotos.find(b => b.bill_status === 'PENDING');
  assert(t65PendingBill, 'Seeded bill photos include one PENDING review');
  const t65RejectedBill = t65AllBillPhotos.find(b => b.bill_status === 'REJECTED');
  assert(t65RejectedBill && t65RejectedBill.rejection_reason && t65RejectedBill.rejection_reason.length >= 5, 'Seeded bill photos include one REJECTED with a reason');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Product bill photos include one PENDING review and one REJECTED with a reason`);

  // 10. Stockist 7654321098 notifications: 1 unread new order, 1 read bill approval (bell shows 1 unread)
  loginAs('u-stk1', 'STOCKIST');
  const t65StkNotifsRes = await get('http://localhost:3001/api/notifications');
  assert(t65StkNotifsRes.status === 200, 'GET /api/notifications returns 200');
  const t65StkNotifs = t65StkNotifsRes.body;
  const t65UnreadOrders = t65StkNotifs.filter(n => n.type === 'new_order' && !n.read_at);
  assert(t65UnreadOrders.length === 1, `Stockist has 1 unread new order notification: got ${t65UnreadOrders.length}`);
  const t65ReadApprovals = t65StkNotifs.filter(n => n.type === 'bill_approved' && n.read_at);
  assert(t65ReadApprovals.length >= 1, `Stockist has read bill approval notification: got ${t65ReadApprovals.length}`);
  const t65TotalUnread = t65StkNotifs.filter(n => !n.read_at).length;
  assert(t65TotalUnread === 1, `Stockist bell shows exactly 1 unread: got ${t65TotalUnread}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist 7654321098 notifications has 1 unread new order and 1 read bill approval (total 1 unread)`);

  // 11. Multi-shop carts in Garia: customer can fetch products from two Garia shops (s1 and s3)
  const t65GariaStockistsRes = await get('http://localhost:3001/api/stockists?regionId=r1');
  assert(t65GariaStockistsRes.status === 200, 'GET /api/stockists?regionId=r1 returns 200');
  const t65GariaShops = t65GariaStockistsRes.body.filter(s => s.product_count > 0);
  assert(t65GariaShops.length >= 2, `Customer can see at least 2 stocked shops in Garia: got ${t65GariaShops.length}`);
  const t65S1ShopInGaria = t65GariaShops.find(s => s.id === 's1');
  const t65S3ShopInGaria = t65GariaShops.find(s => s.id === 's3');
  assert(t65S1ShopInGaria && t65S3ShopInGaria, 'Both Madan Grocers (s1) and Banerjee Corner Store (s3) appear with products in Garia');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer can fill carts at two Garia shops (s1 and s3)`);

  console.log('\n--- Ticket 66: Admin Payout-Change Alerts & adminFetch Relative Paths ---');
  // 1. Static check on App.jsx: no doubled API addresses in adminFetch calls
  const t66AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!t66AppJsx.includes('adminFetch(`${API_BASE}'), 'No adminFetch calls pass doubled API_BASE prefix in App.jsx');
  assert(t66AppJsx.includes("adminFetch('/admin/payout-changes')"), 'adminFetch uses clean relative path for /admin/payout-changes');
  assert(t66AppJsx.includes("adminFetch(`/admin/payout-changes/${n.id}/review`"), 'adminFetch uses clean relative path for review');
  assert(t66AppJsx.includes("path.startsWith('http')"), 'adminFetch contains safety guard for http prefixes');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx adminFetch uses clean relative paths with URL safety guard`);

  // 2. Stockist 7654321098 changes UPI ID
  const t66StkLoginRes = await post('http://localhost:3001/api/auth/verify-otp', { phone: '7654321098', otp: '123456', expected_role: 'STOCKIST' });
  assert(t66StkLoginRes.status === 200 && t66StkLoginRes.body.token, 'Stockist 7654321098 login returns 200');
  const t66StkToken = t66StkLoginRes.body.token;

  const t66NewUpi = 'madan.shaw' + Date.now() + '@okhdfcbank';
  const t66ProfileRes = await patch('http://localhost:3001/api/stockist/profile', {
    payout_upi_id: t66NewUpi
  }, { headers: { Authorization: `Bearer ${t66StkToken}` } });
  assert(t66ProfileRes.status === 200, `Stockist profile update returns 200: got ${t66ProfileRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist 7654321098 successfully updates payout UPI ID`);

  // 3. Admin (9999999999) sees payout-change alert with unread count
  const t66AdmLoginRes = await post('http://localhost:3001/api/auth/verify-otp', { phone: '9999999999', otp: '123456', expected_role: 'ADMIN' });
  assert(t66AdmLoginRes.status === 200 && t66AdmLoginRes.body.token, 'Admin login returns 200');
  const t66AdmToken = t66AdmLoginRes.body.token;

  const t66PayoutChangesRes = await get('http://localhost:3001/api/admin/payout-changes', { headers: { Authorization: `Bearer ${t66AdmToken}` } });
  assert(t66PayoutChangesRes.status === 200, `GET /api/admin/payout-changes returns 200: got ${t66PayoutChangesRes.status}`);
  assert(Array.isArray(t66PayoutChangesRes.body), 'Payout changes response is an array');

  const t66Alert = t66PayoutChangesRes.body.find(a => a.after && a.after.payout_upi_id === t66NewUpi);
  assert(t66Alert, 'Admin sees payout-change alert for updated UPI ID');
  assert(!t66Alert.reviewed_at, 'Newly created alert is unreviewed');
  const t66UnreadCount = t66PayoutChangesRes.body.filter(a => !a.reviewed_at).length;
  assert(t66UnreadCount >= 1, `Admin unread payout changes count is at least 1: got ${t66UnreadCount}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin sees payout-change alert with unread count (${t66UnreadCount})`);

  // 4. Mark reviewed clears it
  const t66ReviewRes = await post(`http://localhost:3001/api/admin/payout-changes/${t66Alert.id}/review`, {}, { headers: { Authorization: `Bearer ${t66AdmToken}` } });
  assert(t66ReviewRes.status === 200, `POST /api/admin/payout-changes/:id/review returns 200: got ${t66ReviewRes.status}`);

  const t66AfterReviewRes = await get('http://localhost:3001/api/admin/payout-changes', { headers: { Authorization: `Bearer ${t66AdmToken}` } });
  assert(t66AfterReviewRes.status === 200, 'GET /api/admin/payout-changes after review returns 200');
  const t66ReviewedAlert = t66AfterReviewRes.body.find(a => a.id === t66Alert.id);
  assert(t66ReviewedAlert && t66ReviewedAlert.reviewed_at, 'Alert is now marked reviewed');
  assert(t66ReviewedAlert.reviewed_by, 'Alert records reviewing admin ID');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin "Mark reviewed" clears unread alert status`);

  // --- BF-STOCKIST-SECURITY: Stop exposing shop bank details and phone numbers publicly ---
  console.log('\n--- BF-STOCKIST-SECURITY: Public stockist sanitization and shop data leak prevention ---');

  // 1. No-login GET /api/stockists: none of payout_*, phone, contact_phone, released_phone, user_id, commission_rate
  clearLogin();
  const secStockistsRes = await get('http://localhost:3001/api/stockists?regionId=r1');
  assert(secStockistsRes.status === 200, 'GET /api/stockists returns 200 without auth');
  assert(Array.isArray(secStockistsRes.body) && secStockistsRes.body.length > 0, 'Returns non-empty stockists list');
  const sensitiveKeys = ['payout_upi_id', 'payout_bank_account', 'payout_ifsc', 'payout_account_name', 'phone', 'contact_phone', 'released_phone', 'user_id', 'commission_rate'];
  for (const s of secStockistsRes.body) {
    for (const key of sensitiveKeys) {
      assert(s[key] === undefined, `Stockist ${s.id} does not contain sensitive key: ${key}`);
    }
    assert(s.id && s.name && s.region_id, `Stockist ${s.id} retains public fields id, name, region_id`);
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists returns 200 with no sensitive bank/phone/commission fields`);

  // 2. No-login GET /api/stockists/:id: public fields only, no sensitive keys
  clearLogin();
  const secStockistSingleRes = await get('http://localhost:3001/api/stockists/s1');
  assert(secStockistSingleRes.status === 200, 'GET /api/stockists/:id returns 200 without auth');
  for (const key of sensitiveKeys) {
    assert(secStockistSingleRes.body[key] === undefined, `Stockist s1 does not contain sensitive key: ${key}`);
  }
  assert(secStockistSingleRes.body.id === 's1' && secStockistSingleRes.body.name, 'Stockist s1 has public fields');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/:id returns 200 with publicStockist view and no sensitive fields`);

  // 3. GET /api/stockists/by-user/:userId auth and access control
  // 3a. Unauthenticated -> 401
  clearLogin();
  const secByUserUnauth = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(secByUserUnauth.status === 401, 'GET /api/stockists/by-user/:userId without auth returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/by-user/:userId requires auth (401)`);

  // 3b. Customer accessing stockist -> 403
  loginAs('u-cust1', 'CUSTOMER');
  const secByUserCust = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(secByUserCust.status === 403, 'Customer accessing /api/stockists/by-user/:userId of another user returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer forbidden from /api/stockists/by-user/:userId (403)`);

  // 3c. Different stockist accessing another stockist -> 403
  loginAs('u-stk2', 'STOCKIST');
  const secByUserOtherStk = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(secByUserOtherStk.status === 403, 'Stockist accessing /api/stockists/by-user/:userId of another stockist returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist forbidden from another stockist by-user (403)`);

  // 3d. Owner accessing their own stockist -> 200 with full data (including payout_* and phone)
  loginAs('u-stk1', 'STOCKIST');
  const secByUserOwner = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(secByUserOwner.status === 200, 'Owner accessing /api/stockists/by-user/:userId returns 200');
  assert(secByUserOwner.body.user_id === 'u-stk1', 'Owner receives their full stockist record');
  assert(secByUserOwner.body.payout_upi_id !== undefined || secByUserOwner.body.phone !== undefined, 'Owner receives their payout/contact information');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Owner can access /api/stockists/by-user/:userId with full private details`);

  // 3e. Admin accessing stockist -> 200 with full data
  loginAs('u-admin', 'ADMIN');
  const secByUserAdmin = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(secByUserAdmin.status === 200, 'Admin accessing /api/stockists/by-user/:userId returns 200');
  assert(secByUserAdmin.body.user_id === 'u-stk1', 'Admin receives full stockist record');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin can access /api/stockists/by-user/:userId with full details`);

  // 4. Customer active order vs delivered order shop data exposure
  loginAs('u-cust1', 'CUSTOMER');
  const secNewOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'PAY_AT_HANDOVER',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(secNewOrderRes.status === 200, 'Customer order creation returns 200');
  const secActiveOrder = secNewOrderRes.body.order;
  assert(secActiveOrder && secActiveOrder.id, 'Active order returned');
  assert(secActiveOrder.stockist_upi_id || secActiveOrder.payout_upi_id, 'Customer active order includes shop UPI ID');
  assert(secActiveOrder.contact_phone !== undefined, 'Customer active order includes shop contact_phone');
  assert(secActiveOrder.platform_commission === undefined, 'Customer active order hides platform_commission');
  assert(secActiveOrder.stockist_payout === undefined, 'Customer active order hides stockist_payout');
  assert(secActiveOrder.stockist_amount === undefined, 'Customer active order hides stockist_amount');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer active order includes shop UPI and contact phone, but hides commission data`);

  // 5. Customer delivered order does not expose shop UPI or contact phone
  loginAs('u-admin', 'ADMIN');
  const secDelivPatchRes = await patch(`http://localhost:3001/api/orders/${secActiveOrder.id}/status`, {
    status: 'DELIVERED',
    manual_override: true,
    reason: 'Security regression test delivery'
  });
  assert(secDelivPatchRes.status === 200, 'Admin delivers order successfully');

  loginAs('u-cust1', 'CUSTOMER');
  const secDelivCustOrders = await get('http://localhost:3001/api/orders');
  const secDelivOrderFound = secDelivCustOrders.body.find(o => o.id === secActiveOrder.id);
  assert(secDelivOrderFound && secDelivOrderFound.status === 'DELIVERED', 'Found delivered order');
  assert(secDelivOrderFound.stockist_upi_id === undefined && secDelivOrderFound.payout_upi_id === undefined, 'Delivered order does NOT include shop UPI');
  assert(secDelivOrderFound.contact_phone === undefined, 'Delivered order does NOT include shop contact_phone');
  assert(secDelivOrderFound.platform_commission === undefined, 'Delivered order does NOT include platform_commission');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer delivered order does not expose shop UPI ID or contact phone`);

  // 6. Bill photo security and signature verification
  // 6a. Upload a product with bill photo as stockist s1 (u-stk1)
  loginAs('u-stk1', 'STOCKIST');
  const billUploadRes = await postMultipart('http://localhost:3001/api/products', {
    stockistId: 's1',
    regionId: 'r1',
    name: 'Security Test Product',
    price: 150,
    costPrice: 110,
    category: 'groceries',
    initialStock: 10
  }, {
    fieldName: 'bill_photo',
    filename: 'security-bill.jpg',
    mime: 'image/jpeg',
    buffer: Buffer.from('security bill jpeg test data')
  }, 'POST');
  assert(billUploadRes.status === 200, 'Product creation with bill photo returns 200');
  const uploadedBill = billUploadRes.body.bill_photo;
  assert(uploadedBill && uploadedBill.public_url, 'Uploaded bill has public_url');
  assert(uploadedBill.public_url.includes('sig=') && uploadedBill.public_url.includes('expires='), 'Bill public_url has HMAC signature and expires params');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Product bill upload produces signed public_url with HMAC signature`);

  // 6b. Accessing /api/bills/:key with valid signature works without auth
  clearLogin();
  const signedBillUrl = uploadedBill.public_url.startsWith('http') 
    ? uploadedBill.public_url 
    : `http://localhost:3001${uploadedBill.public_url}`;
  const validSigRes = await get(signedBillUrl);
  assert(validSigRes.status === 200, 'Valid signature allows accessing bill without authentication');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Valid HMAC signed URL grants bill photo access without auth`);

  // 6c. Accessing bill with tampered signature returns 401
  const tamperedUrl = signedBillUrl.replace(/sig=[a-f0-9]+/, 'sig=badsignature0000');
  const tamperedRes = await get(tamperedUrl);
  assert(tamperedRes.status === 401, 'Tampered signature on bill photo URL returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Tampered signature returns 401`);

  // 6c-2. Accessing bill with expired signature returns 403
  const crypto = require('crypto');
  const sessionHelper = require('../../lib/session');
  const billPathPart = `/api/bills/${uploadedBill.r2_key}`;
  const pastExpires = Date.now() - 60000;
  const expiredSig = crypto.createHmac('sha256', sessionHelper.getSecret()).update(billPathPart + ':' + pastExpires).digest('hex');
  const expiredUrl = `http://localhost:3001${billPathPart}?expires=${pastExpires}&sig=${expiredSig}`;
  const expiredRes = await get(expiredUrl);
  assert(expiredRes.status === 403, `Expired signature on bill photo URL returns 403, got ${expiredRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Expired signature returns 403`);

  // 6d. Accessing raw bill path without signature or auth returns 401
  const rawBillKey = uploadedBill.r2_key;
  const rawBillUrl = `http://localhost:3001/api/bills/${rawBillKey}`;
  const rawUnauthRes = await get(rawBillUrl);
  assert(rawUnauthRes.status === 401, 'Accessing raw bill path without auth or signature returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Accessing unsigned bill photo without auth returns 401`);

  // 6e. Customer accessing raw bill path without signature returns 403
  loginAs('u-cust1', 'CUSTOMER');
  const custRawRes = await get(rawBillUrl);
  assert(custRawRes.status === 403, 'Customer accessing unsigned bill returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer forbidden from unsigned bill photo`);

  // 6f. Another stockist accessing unsigned bill returns 403
  loginAs('u-stk2', 'STOCKIST');
  const otherStkRawRes = await get(rawBillUrl);
  assert(otherStkRawRes.status === 403, 'Other stockist accessing unsigned bill returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Another stockist forbidden from accessing shop bill photo`);

  // 6g. Owner stockist or Admin accessing raw bill path returns 200
  loginAs('u-stk1', 'STOCKIST');
  const ownerRawRes = await get(rawBillUrl);
  assert(ownerRawRes.status === 200, 'Owner stockist can access their own raw bill photo');
  loginAs('u-admin', 'ADMIN');
  const adminRawRes = await get(rawBillUrl);
  assert(adminRawRes.status === 200, 'Admin can access raw bill photo');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Owner stockist and Admin can access bill photo`);

  // 7. Support settings: public config and admin settings
  console.log('\n--- BF-SUPPORT-SETTINGS: Public config and admin support settings ---');
  clearLogin();
  const pubSuppRes1 = await get('http://localhost:3001/api/config');
  assert(pubSuppRes1.status === 200, 'GET /api/config returns 200 without auth');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/config returns 200 without auth`);

  // Non-admin cannot get or update support settings
  const unauthGetSuppRes = await get('http://localhost:3001/api/admin/support-settings');
  assert(unauthGetSuppRes.status === 401, 'GET /api/admin/support-settings without auth returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/support-settings without auth returns 401`);

  const unauthSuppRes = await post('http://localhost:3001/api/admin/support-settings', { support_email: 'test@example.com' });
  assert(unauthSuppRes.status === 401, 'POST /api/admin/support-settings without auth returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/admin/support-settings without auth returns 401`);

  loginAs('u-cust1', 'CUSTOMER');
  const custSuppRes = await post('http://localhost:3001/api/admin/support-settings', { support_email: 'test@example.com' });
  assert(custSuppRes.status === 403, 'POST /api/admin/support-settings as customer returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/admin/support-settings as customer returns 403`);

  // Invalid email format returns 400
  loginAs('u-admin', 'ADMIN');
  const invalidEmailRes = await post('http://localhost:3001/api/admin/support-settings', { support_email: 'not-an-email' });
  assert(invalidEmailRes.status === 400, 'Invalid support email returns 400');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Invalid support email returns 400`);

  // Invalid phone format returns 400
  const invalidPhoneRes = await post('http://localhost:3001/api/admin/support-settings', { support_phone: '12345' });
  assert(invalidPhoneRes.status === 400, 'Invalid support phone returns 400');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Invalid support phone returns 400`);

  // Valid update by admin succeeds
  const updateSuppRes = await post('http://localhost:3001/api/admin/support-settings', {
    support_phone: '9876543210',
    support_email: 'help@beniffy.com',
    support_hours: '10:00 AM - 8:00 PM'
  });
  assert(updateSuppRes.status === 200, 'Admin updating support settings returns 200');
  assert(updateSuppRes.body.settings.support_phone === '9876543210', 'Returned updated phone');
  assert(updateSuppRes.body.settings.support_email === 'help@beniffy.com', 'Returned updated email');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin updating support settings returns 200`);

  // Public GET /api/config reflects update
  clearLogin();
  const pubSuppRes2 = await get('http://localhost:3001/api/config');
  assert(pubSuppRes2.status === 200, 'Public GET /api/config returns 200');
  assert(pubSuppRes2.body.support_phone === '9876543210', 'Public config returns updated phone');
  assert(pubSuppRes2.body.support_email === 'help@beniffy.com', 'Public config returns updated email');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Public config reflects updated support settings`);

  // Reset back to default
  loginAs('u-admin', 'ADMIN');
  await post('http://localhost:3001/api/admin/support-settings', {
    support_phone: '',
    support_email: 'support@beniffy.com',
    support_hours: '9:00 AM - 9:00 PM'
  });

};
