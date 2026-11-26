const {
  dbModule, loginAs, post, patch, get, del, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  console.log('\n--- 23. REDO ROUND Tests ---');

  // Test A: Add SKU POST creates product visible in stockist list
  const addSkuRes = await post('http://localhost:3001/api/products', {
    name: 'Garia Fresh Butter',
    price: 150,
    costPrice: 120,
    category: 'groceries',
    initialStock: 15,
    stockistId: 's1',
    regionId: 'r1'
  });
  assert(addSkuRes.status === 200, 'POST creates product successfully');
  
  const getProductsRes = await get('http://localhost:3001/api/products?stockistId=s1');
  const targetProduct = getProductsRes.body.find(p => p.id === addSkuRes.body.product.id);
  assert(targetProduct !== undefined, 'Created product is visible in stockist list');
  assert(targetProduct.stock_qty === 15, 'Initial stock matches');

  // Test B: Product edit persists
  const editProductRes = await patch(`http://localhost:3001/api/products/${targetProduct.id}`, {
    name: 'Garia Salted Butter',
    price: 160,
    costPrice: 130,
    stockistId: 's1'
  });
  assert(editProductRes.status === 200, 'Product edit succeeds');
  assert(editProductRes.body.product.name === 'Garia Salted Butter', 'Edited name persists');
  assert(editProductRes.body.product.price === 160, 'Edited price persists');
  assert(editProductRes.body.product.cost_price === 130, 'Edited cost price persists');

  // Cross-stockist edit -> 403
  const crossEditRes = await patch(`http://localhost:3001/api/products/${targetProduct.id}`, {
    name: 'Hack Name',
    stockistId: 's2'
  });
  assert(crossEditRes.status === 403, 'Cross-stockist edit is rejected with 403');

  // costPrice > price -> 400
  const costTooHighRes = await patch(`http://localhost:3001/api/products/${targetProduct.id}`, {
    costPrice: 200,
    stockistId: 's1'
  });
  assert(costTooHighRes.status === 400, 'Cost price > price is rejected with 400');

  // Test E: Rewrite cancel conditions
  // Create a new order to test cancellation
  const cancelTestOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    paymentMethod: 'ONLINE',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(cancelTestOrder.status === 200, 'Cancel test order created');

  // Set status to READY_FOR_PICKUP to test cancellation lock (even within timer)
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: cancelTestOrder.body.orderId, patch: { status: 'READY_FOR_PICKUP' } });

  const cancelReadyRes = await post(`http://localhost:3001/api/orders/${cancelTestOrder.body.orderId}/cancel`);
  assert(cancelReadyRes.status === 400, 'Cancel at READY is blocked');
  assert(cancelReadyRes.body.code === 'CANCEL_LOCKED_READY', 'Returns CANCEL_LOCKED_READY code');

  // Reset status to PREPARING to test success cancel within timer -> REFUND_DUE
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: cancelTestOrder.body.orderId, patch: { status: 'PREPARING', payment_status: 'PAID_ONLINE' } });

  const cancelPrepRes = await post(`http://localhost:3001/api/orders/${cancelTestOrder.body.orderId}/cancel`);
  assert(cancelPrepRes.status === 200, 'Cancel at PREPARING within timer succeeds');
  assert(cancelPrepRes.body.order.payment_status === 'REFUND_DUE', 'Payment status is REFUND_DUE');

  // Test F: Admin refund
  const adminRefundRes2 = await post(`http://localhost:3001/api/admin/orders/${cancelTestOrder.body.orderId}/refund`);
  assert(adminRefundRes2.status === 200, 'Admin refund succeeds');
  assert(adminRefundRes2.body.order.payment_status === 'REFUNDED', 'Payment status is REFUNDED');

  // Double refund -> no_op
  const doubleRefundRes = await post(`http://localhost:3001/api/admin/orders/${cancelTestOrder.body.orderId}/refund`);
  assert(doubleRefundRes.status === 200, 'Double refund is a no-op');

  // Stockist cancel permissions:
  // Create another order
  const stockistCancelTestOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(stockistCancelTestOrder.status === 200, 'Stockist cancel test order created');

  // Stockist cancel at PENDING -> OK
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: stockistCancelTestOrder.body.orderId, patch: { status: 'PENDING' } });

  const stockistCancelPendingRes = await patch(`http://localhost:3001/api/orders/${stockistCancelTestOrder.body.orderId}/status`, { status: 'CANCELLED' });
  assert(stockistCancelPendingRes.status === 200, 'Stockist CANCELLED at PENDING succeeds');

  // Stockist cancel at PREPARING -> 403
  const stockistCancelTestOrder2 = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(stockistCancelTestOrder2.status === 200, 'Stockist cancel test order 2 created');

  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: stockistCancelTestOrder2.body.orderId, patch: { status: 'PREPARING' } });

  const stockistCancelPreparingRes = await patch(`http://localhost:3001/api/orders/${stockistCancelTestOrder2.body.orderId}/status`, { status: 'CANCELLED' });
  assert(stockistCancelPreparingRes.status === 403, 'Stockist CANCELLED at PREPARING is blocked with 403');
  assert(stockistCancelPreparingRes.body.code === 'STOCKIST_CANCEL_LOCKED', 'Returns STOCKIST_CANCEL_LOCKED code');

  // 24. Customer Delivered Review Feedback
  console.log('\n--- 24. Customer Delivered Review Feedback ---');
  const custReviewRes = await post('http://localhost:3001/api/feedback', {
    reporterId: 'u-cust1',
    reporterRole: 'CUSTOMER',
    targetId: 's1',
    targetRole: 'STOCKIST',
    orderId: 'ord-delivered-test',
    rating: 5,
    reason: 'Great delivery and service!',
    reportFlag: false
  });
  assert(custReviewRes.status === 200, 'Delivered review feedback submitted successfully');

  const adminFbFetch = await get('http://localhost:3001/api/admin/feedback');
  assert(adminFbFetch.status === 200, 'Admin feedback fetch succeeds');
  const reviewInAdmin = adminFbFetch.body.find(f => f.order_id === 'ord-delivered-test');
  assert(reviewInAdmin !== undefined, 'Delivered review feedback appears in admin fetch');
  assert(reviewInAdmin.rating === 5, 'Review rating matches submitted rating');

  // 25. PIN-verified delivery handoff
  console.log('\n--- 25. PIN-verified delivery handoff ---');
  const delOrderOnline = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'DELIVERY',
    paymentMethod: 'ONLINE',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(delOrderOnline.status === 200, 'Online DELIVERY order created successfully');
  const delOnlineId = delOrderOnline.body.orderId;
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: delOnlineId, patch: { payment_status: 'PAID_ONLINE' } });

  loginAs('u-stk1', 'STOCKIST');
  const directDelPatch = await patch(`http://localhost:3001/api/orders/${delOnlineId}/status`, { status: 'DELIVERED' });
  loginAs('u-admin', 'ADMIN');
  assert(directDelPatch.status === 400, 'Direct PATCH to DELIVERED on DELIVERY order is blocked with 400');
  assert(directDelPatch.body.code === 'PIN_REQUIRED', 'Response contains PIN_REQUIRED code');

  const fetchDelOnline = await get(`http://localhost:3001/api/orders?customerId=u-cust1`);
  const onlineOrdObj = fetchDelOnline.body.find(o => o.id === delOnlineId);
  assert(onlineOrdObj !== undefined, 'Online delivery order found');

  const verifyOnlinePin = await post(`http://localhost:3001/api/orders/${delOnlineId}/verify-pickup`, { pin: onlineOrdObj.pickup_pin });
  assert(verifyOnlinePin.status === 200, 'Correct PIN via verify-pickup succeeds for ONLINE delivery');
  assert(verifyOnlinePin.body.order.status === 'DELIVERED', 'ONLINE delivery order status updated to DELIVERED');

  const delOrderCod = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'DELIVERY',
    paymentMethod: 'COD',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(delOrderCod.status === 200, 'COD DELIVERY order created successfully');
  const delCodId = delOrderCod.body.orderId;

  const fetchDelCod = await get(`http://localhost:3001/api/orders?customerId=u-cust1`);
  const codOrdObj = fetchDelCod.body.find(o => o.id === delCodId);
  assert(codOrdObj !== undefined, 'COD delivery order found');

  const verifyCodPin = await post(`http://localhost:3001/api/orders/${delCodId}/verify-pickup`, { pin: codOrdObj.pickup_pin });
  assert(verifyCodPin.status === 200, 'Correct PIN via verify-pickup succeeds for COD delivery');
  assert(verifyCodPin.body.order.status === 'DELIVERED', 'COD delivery order status updated to DELIVERED');

  // 26. Customer Fraud Reports (R4)
  console.log('\n--- 26. Customer Fraud Reports (R4) ---');
  const shortFraudRes = await post('http://localhost:3001/api/customer/fraud-reports', {
    customerId: 'u-cust1',
    subject: 'Stockist issue',
    description: 'Too short'
  });
  assert(shortFraudRes.status === 400, 'Fraud report with <20 chars description is rejected with 400');

  const validFraudRes = await post('http://localhost:3001/api/customer/fraud-reports', {
    customerId: 'u-cust1',
    subject: 'Stockist issue',
    description: 'The stockist refused to honor the pickup item quantity on my order.',
    linkedEntityType: 'order',
    linkedEntityId: delOnlineId
  });
  assert(validFraudRes.status === 200, 'Valid fraud report submitted successfully');
  const fraudReportId = validFraudRes.body.report.id;

  const adminFraudFetch = await get('http://localhost:3001/api/admin/fraud-reports');
  assert(adminFraudFetch.status === 200, 'Admin fraud reports fetch succeeds');
  const foundReport = adminFraudFetch.body.find(r => r.id === fraudReportId);
  assert(foundReport !== undefined && foundReport.status === 'NEW', 'Submitted fraud report exists in NEW status');

  const triageFraud = await post(`http://localhost:3001/api/admin/fraud-reports/${fraudReportId}/status`, {
    status: 'TRIAGING'
  });
  assert(triageFraud.status === 200, 'Fraud report status updated to TRIAGING');

  const shortNoteResolve = await post(`http://localhost:3001/api/admin/fraud-reports/${fraudReportId}/status`, {
    status: 'RESOLVED',
    adminNotes: 'Short'
  });
  assert(shortNoteResolve.status === 400, 'Resolving fraud report with <10 chars note is rejected with 400');

  const validResolve = await post(`http://localhost:3001/api/admin/fraud-reports/${fraudReportId}/status`, {
    status: 'RESOLVED',
    adminNotes: 'Investigated with stockist and issued apology credit.'
  });
  assert(validResolve.status === 200, 'Resolving fraud report with valid notes succeeds');

  // 27. Customers Management & Audit Log (R5 & Part 3)
  console.log('\n--- 27. Customers Management & Audit Log (R5 & Part 3) ---');
  const adminCustList = await get('http://localhost:3001/api/admin/customers');
  assert(adminCustList.status === 200, 'GET /api/admin/customers succeeds');
  const cust1InList = adminCustList.body.find(c => c.id === 'u-cust1');
  assert(cust1InList !== undefined && cust1InList.points_balance !== undefined, 'Customer list includes points balance and order count');

  const adminCustDetail = await get('http://localhost:3001/api/admin/customers/u-cust1');
  assert(adminCustDetail.status === 200, 'GET /api/admin/customers/u-cust1 succeeds');
  assert(Array.isArray(adminCustDetail.body.orders) && Array.isArray(adminCustDetail.body.ledger), 'Customer detail includes orders and ledger');

  const editCustRes = await post('http://localhost:3001/api/admin/customers/u-cust1', {
    name: 'Customer One Updated',
    email: 'cust1updated@example.com'
  });
  assert(editCustRes.status === 200, 'Admin update customer contact succeeds');

  // Customer role calling returns 403
  loginAs('u-cust1', 'CUSTOMER');
  const custCallRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-current', { via: 'phone', phone: '9876543210' });
  assert(custCallRes.status === 403, 'Customer role calling any of these returns 403');
  loginAs('u-admin', 'ADMIN');

  // Hole check: Final change without verification returns 400
  const holeCheckRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change', { newPhone: '9830099999' });
  assert(holeCheckRes.status === 400, 'The final change without verification returns 400');
  let unchangedCust = await get('http://localhost:3001/api/admin/customers/u-cust1');
  assert(unchangedCust.body.phone === '9876543210', 'and the phone is unchanged. This is the hole that exists today.');

  // Send-current with wrong typed number returns 400
  const sendWrongRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-current', { via: 'phone', phone: '9999999999' });
  assert(sendWrongRes.status === 400, 'Send-current with the wrong typed number returns 400');

  // Send-current with correct number returns 200
  const sendRightRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-current', { via: 'phone', phone: '9876543210' });
  assert(sendRightRes.status === 200, 'With the correct number it returns 200');

  // Verify-current with wrong OTP returns 400
  const verifyWrongRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/verify-current', { otp: '000000' });
  assert(verifyWrongRes.status === 400, 'Verify-current with a wrong OTP returns 400');

  // Verify-current with 123456 returns 200
  const verifyRightRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/verify-current', { otp: '123456' });
  assert(verifyRightRes.status === 200, 'With 123456 in demo mode it returns 200');

  // Send-new before current step is verified (test on u-cust2)
  const sendNewBeforeVerify = await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/send-new', { newPhone: '9998887776' });
  assert(sendNewBeforeVerify.status === 400, 'Send-new before the current step is verified returns 400');

  // Send-new with already used number returns 400
  const sendDupRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-new', { newPhone: '8765432109' }); // u-cust2's phone
  assert(sendDupRes.status === 400, 'Send-new with a number already used by another customer returns 400');

  // Send-new twice inside 60 seconds returns 429
  // Since we rate limit by customer id, let's use u-cust2 for this to not block u-cust1.
  // First we need to verify current for u-cust2 to do send-new
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/send-current', { via: 'phone', phone: '8765432109' });
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/verify-current', { otp: '123456' });
  const sendNewRes1 = await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/send-new', { newPhone: '9830099999' });
  assert(sendNewRes1.status === 200, 'Send-new succeeds');
  const sendNewRes2 = await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/send-new', { newPhone: '9830099998' });
  assert(sendNewRes2.status === 429, 'Send-new twice inside 60 seconds returns 429 the second time');
  
  // Finish the flow for u-cust2 to reset rate limits (so we can test email flow later)
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/verify-new', { otp: '123456', newPhone: '9830099999' });
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change', { newPhone: '9830099999' });
  
  // Full path by phone on u-cust1
  await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-new', { newPhone: '9830099000' });
  const verifyNewRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/verify-new', { otp: '123456', newPhone: '9830099000' });
  assert(verifyNewRes.status === 200, 'Verify-new succeeds');
  
  const phoneChangeRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change', { newPhone: '9830099000' });
  assert(phoneChangeRes.status === 200, 'Full path by phone: change succeeds');
  
  const auditLogs = await dbModule.getTable('admin_audit_log');
  const phoneAudit = auditLogs.find(a => a.entity_id === 'u-cust1' && a.action === 'CHANGE_PHONE');
  assert(phoneAudit !== undefined && phoneAudit.after.method === 'phone', 'the audit row exists');
  
  let changedCust = await get('http://localhost:3001/api/admin/customers/u-cust1');
  assert(changedCust.body.phone === '9830099000', 'and the customer can log in with the new number (verified in DB)');

  // After verifying a new number, edit the number and try the final change. It returns 400.
  // Test on u-cust1 again.
  await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-current', { via: 'phone', phone: '9830099000' });
  await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/verify-current', { otp: '123456' });
  await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/send-new', { newPhone: '9830099001' });
  await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change/verify-new', { otp: '123456', newPhone: '9830099001' });
  const editedFinalRes = await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change', { newPhone: '9830099002' });
  assert(editedFinalRes.status === 400, 'After verifying a new number, edit the number and try the final change. It returns 400.');
  await post('http://localhost:3001/api/admin/customers/u-cust1/phone-change', { newPhone: '9830099001' });

  // Full path by email on u-cust2
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/send-current', { via: 'email' });
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/verify-current', { otp: '123456' });
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/send-new', { newPhone: '8765432000' });
  await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change/verify-new', { otp: '123456', newPhone: '8765432000' });
  const emailChangeRes = await post('http://localhost:3001/api/admin/customers/u-cust2/phone-change', { newPhone: '8765432000' });
  assert(emailChangeRes.status === 200, 'Full path by email: change succeeds');
  
  const auditLogs2 = await dbModule.getTable('admin_audit_log');
  // u-cust2 changed number twice (by phone earlier, by email now): take the newest audit row.
  const emailAudit = auditLogs2
    .filter(a => a.entity_id === 'u-cust2' && a.action === 'CHANGE_PHONE')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .pop();
  assert(emailAudit !== undefined && emailAudit.after.method === 'email', 'and the audit row records email.');

  const creditPtsRes = await post('http://localhost:3001/api/admin/customers/u-cust1/points-credit', {
    amount: 50,
    reason: 'Support compensation for delivery delay'
  });
  assert(creditPtsRes.status === 200, 'Admin manual points credit succeeds');

  const deactCustRes = await post('http://localhost:3001/api/admin/customers/u-cust1/deactivate', {});
  assert(deactCustRes.status === 200, 'Admin customer deactivation succeeds');

  const loginDeact = await post('http://localhost:3001/api/auth/verify-otp', { phone: '9830099001', email: 'test_9830099001@fastnet.test', otp: '123456' });
  assert(loginDeact.status === 403, 'Deactivated user login attempt is blocked with 403');

  const reactCustRes = await post('http://localhost:3001/api/admin/customers/u-cust1/reactivate', {});
  assert(reactCustRes.status === 200, 'Admin customer reactivation succeeds');

  // 28. Stockists Management (R6)
  console.log('\n--- 28. Stockists Management (R6) ---');
  const adminStkList = await get('http://localhost:3001/api/admin/stockists');
  assert(adminStkList.status === 200, 'GET /api/admin/stockists succeeds');
  const s1InList = adminStkList.body.find(s => s.id === 's1');
  assert(s1InList !== undefined && s1InList.gmv_30d !== undefined, 'Stockist list includes gmv_30d preview');

  const createStkRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'New Test Stockist Shop',
    phone: '9831122334', email: 'test_9831122334@fastnet.test',
    region_id: 'r1',
    vendor_id: 'v1',
    commission_rate: 12.5
  });
  assert(createStkRes.status === 200, 'Admin create stockist succeeds');
  const _newStkId = createStkRes.body.stockist.id;

  const ratePreviewRes = await post(`http://localhost:3001/api/admin/stockists/${s1InList.id}/commission-rate`, {
    rate_percent: 15.0
  });
  assert(ratePreviewRes.status === 200 && ratePreviewRes.body.preview === true, 'Commission rate request without CONFIRM returns preview calculation');

  const rateApplyRes = await post(`http://localhost:3001/api/admin/stockists/${s1InList.id}/commission-rate`, {
    rate_percent: 15.0,
    confirmationText: 'CONFIRM'
  });
  assert(rateApplyRes.status === 200, 'Commission rate update with CONFIRM succeeds');

  const deleteStkWithOrders = await del(`http://localhost:3001/api/admin/stockists/${s1InList.id}`);
  assert(deleteStkWithOrders.status === 400, 'Deleting stockist with order history is blocked with 400');

  // 29. Partner Leads & Audit Log Verification (R7 & Audit)
  console.log('\n--- 29. Partner Leads & Audit Log Verification (R7 & Audit) ---');
  const leadPostRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'Garia Cable Network',
    phone: '9830088888', email: 'test_9830088888@fastnet.test',
    region_id: 'r1'
  });
  assert(leadPostRes.status === 200, 'Partner lead created');
  const leadId = leadPostRes.body.lead.id;

  // Partner admins may work partner leads, but not KYC documents, analytics, vendors or accounts.
  loginAs('u-partner-admin', 'PARTNER_ADMIN');
  const partnerAnalyticsRes = await get('http://localhost:3001/api/admin/analytics');
  assert(partnerAnalyticsRes.status === 403, 'Partner admin cannot read platform analytics');
  const partnerKycDocRes = await get('http://localhost:3001/api/admin/kyc/u-stk5/document');
  assert(partnerKycDocRes.status === 403, 'Partner admin cannot read a stockist KYC document');
  const partnerVendorRes = await patch('http://localhost:3001/api/admin/vendors/v1', { name: 'Hijacked' });
  assert(partnerVendorRes.status === 403, 'Partner admin cannot edit a vendor');
  const partnerAccountDelRes = await del('http://localhost:3001/api/admin/users/u-stk3/account');
  assert(partnerAccountDelRes.status === 403, 'Partner admin cannot delete a user account');

  const leadStatusRes = await post(`http://localhost:3001/api/admin/partner-leads/${leadId}/status`, {
    status: 'CONTACTED'
  });
  assert(leadStatusRes.status === 200, 'Lead status updated to CONTACTED');

  const leadRejectFailRes = await post(`http://localhost:3001/api/admin/partner-leads/${leadId}/status`, {
    status: 'REJECTED',
    reason: 'no'
  });
  assert(leadRejectFailRes.status === 400, 'Lead status update to REJECTED fails with short reason');

  const leadRejectSuccessRes = await post(`http://localhost:3001/api/admin/partner-leads/${leadId}/status`, {
    status: 'REJECTED',
    reason: 'Not a good fit right now'
  });
  assert(leadRejectSuccessRes.status === 200, 'Lead status update to REJECTED succeeds with valid reason');

  loginAs('u-admin', 'ADMIN');
  const auditLogRes = await get('http://localhost:3001/api/admin/audit-log');
  assert(auditLogRes.status === 200, 'GET /api/admin/audit-log succeeds');
  assert(auditLogRes.body.length >= 5, 'Audit log contains entries for admin actions');

  // 30. Customer UI Fraud Report Button Reachability
  console.log('\n--- 30. Customer UI Fraud Report Button Reachability ---');
  const fs = require('fs');
  const path = require('path');
  const appJsxContent = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appJsxContent.includes('Report a problem'), 'App.jsx contains "Report a problem" button in customer UI');
  assert(appJsxContent.includes('onClick={() => setShowFraudReportModal(true)}'), 'App.jsx button onClick handler opens fraud report modal');

  // 31. Round R2 Customer App "Continue shopping at" Button
  console.log('\n--- 31. Round R2 Customer App "Continue shopping at" Button ---');
  assert(appJsxContent.includes('const [previousStockistId, setPreviousStockistId] = useState(null)'), 'App.jsx contains previousStockistId state declaration');
  assert(appJsxContent.includes('Continue shopping at') && appJsxContent.includes('setPreviousStockistId(null)'), 'App.jsx contains "Continue shopping at" button label and clears previousStockistId');

  // 32. Round S — Commission Model Refactor (Profit-Basis)
  console.log('\n--- 32. Round S — Commission Model Refactor (Profit-Basis) ---');

  // Config CRUD (Tests 149-152)
  const getCcRes = await get('http://localhost:3001/api/admin/commission-config');
  assert(getCcRes.status === 200, 'GET /api/admin/commission-config succeeds');
  assert(getCcRes.body.length >= 1, 'Commission config returns at least 1 row (GLOBAL default)');
  const globalRow = getCcRes.body.find(c => c.scope === 'GLOBAL');
  assert(globalRow && globalRow.stockist_reinvest_pct === 50, 'GLOBAL default row has reinvest_pct=50');

  // Test 150: Create STORE override for s1
  const postOverrideRes = await post('http://localhost:3001/api/admin/commission-config', {
    scope: 'STORE',
    stockist_id: 's1',
    stockist_reinvest_pct: 60,
    points_from_pot_pct: 30,
    partner_redemption_cut_pct: 15
  });
  assert(postOverrideRes.status === 200, 'POST STORE override succeeds');
  assert(postOverrideRes.body.config.scope === 'STORE', 'Created config scope is STORE');
  const overrideConfigId = postOverrideRes.body.config.id;

  // Test 151: Invalid percentage range
  const postInvalidRes = await post('http://localhost:3001/api/admin/commission-config', {
    scope: 'GLOBAL',
    stockist_reinvest_pct: 150,
    points_from_pot_pct: 40,
    partner_redemption_cut_pct: 12
  });
  assert(postInvalidRes.status === 400, 'POST with stockist_reinvest_pct=150 returns 400');

  // Test 152: DELETE GLOBAL row is blocked
  const deleteGlobalRes = await del(`http://localhost:3001/api/admin/commission-config/${globalRow.id}`);
  assert(deleteGlobalRes.status === 400, 'DELETE of GLOBAL default row returns 400');
  assert(deleteGlobalRes.body.error.includes('cannot delete global default'), 'DELETE error message mentions cannot delete global default');

  // Test 153: Canonical order at s3 (Price 100, Cost 80 -> Profit 20. Reinvest 50% = 10, Pot 10, Points 40% = 4, Comm = 6, Payout = 90)
  const prodResCanonical = await post('http://localhost:3001/api/products', {
    name: 'Canonical Test item',
    category: 'groceries',
    price: 100,
    costPrice: 80,
    stockistId: 's3',
    regionId: 'r1',
    initialStock: 10
  });
  assert(prodResCanonical.status === 200, 'Product for canonical settlement created');
  const canonicalProdId = prodResCanonical.body.product.id;

  const canonicalOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'PICKUP',
    stores: [
      {
        stockistId: 's3',
        pickupSlot: '10:00–11:00',
        items: [{ productId: canonicalProdId, quantity: 1 }]
      }
    ]
  });
  assert(canonicalOrderRes.status === 200, 'Canonical order created');
  const canonicalOrder = canonicalOrderRes.body.orders[0];
  assert(canonicalOrder.platform_commission === 6, `Canonical platform_commission is 6 (got ${canonicalOrder.platform_commission})`);
  assert(canonicalOrder.points_credited === 4, `Canonical points_credited is 4 (got ${canonicalOrder.points_credited})`);
  assert(canonicalOrder.stockist_payout === 90, `Canonical stockist_payout is 90 (got ${canonicalOrder.stockist_payout})`);

  // Test 154: Order at s1 with STORE override (Reinvest 60%, Points 30% -> Profit 20, Reinvest 12, Pot 8, Points 2.4, Comm 5.6, Payout 92)
  const prodResOverride = await post('http://localhost:3001/api/products', {
    name: 'Override Test item',
    category: 'groceries',
    price: 100,
    costPrice: 80,
    stockistId: 's1',
    regionId: 'r1',
    initialStock: 10
  });
  assert(prodResOverride.status === 200, 'Product for override settlement created');
  const overrideProdId = prodResOverride.body.product.id;

  const overrideOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'PICKUP',
    stores: [
      {
        stockistId: 's1',
        pickupSlot: '10:00–11:00',
        items: [{ productId: overrideProdId, quantity: 1 }]
      }
    ]
  });
  assert(overrideOrderRes.status === 200, 'Override order created');
  const overrideOrder = overrideOrderRes.body.orders[0];
  assert(overrideOrder.platform_commission === 5.6, `Override platform_commission is 5.6 (got ${overrideOrder.platform_commission})`);
  assert(overrideOrder.points_credited === 2.4, `Override points_credited is 2.4 (got ${overrideOrder.points_credited})`);
  assert(overrideOrder.stockist_payout === 92, `Override stockist_payout is 92 (got ${overrideOrder.stockist_payout})`);

  // Test 155: Loss leader (price=100, cost=100 -> profit = 0) -> 0/0/0 settlement
  const lossProdRes = await post('http://localhost:3001/api/products', {
    name: 'Loss Leader item',
    category: 'groceries',
    price: 100,
    costPrice: 100,
    stockistId: 's3',
    regionId: 'r1',
    initialStock: 10
  });
  assert(lossProdRes.status === 200, 'Loss leader product created');
  const lossProdId = lossProdRes.body.product.id;

  const lossOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'PICKUP',
    stores: [
      {
        stockistId: 's3',
        pickupSlot: '10:00–11:00',
        items: [{ productId: lossProdId, quantity: 1 }]
      }
    ]
  });
  assert(lossOrderRes.status === 200, 'Loss leader order created successfully');
  const lossOrder = lossOrderRes.body.orders[0];
  assert(lossOrder.platform_commission === 0, 'Loss leader platform_commission is 0');
  assert(lossOrder.points_credited === 0, 'Loss leader points_credited is 0');

  // Test 156: Order tagged commission_model='profit_v2'
  assert(canonicalOrder.commission_model === 'profit_v2', 'New order tagged commission_model=profit_v2');

  // Test 157: config_row_id on order matches row used (STORE for overrideOrder, GLOBAL for canonicalOrder)
  assert(overrideOrder.config_row_id === overrideConfigId, 'Override order config_row_id matches STORE config ID');
  assert(canonicalOrder.config_row_id === globalRow.id, 'Canonical order config_row_id matches GLOBAL config ID');

  // Test 158 & 159: Historical order integrity (seed orders)
  const allOrdersRes = await get('http://localhost:3001/api/orders');
  assert(allOrdersRes.status === 200, 'GET /api/orders succeeds');
  const grossV1Order = allOrdersRes.body.find(o => o.commission_model === 'gross_v1');
  assert(grossV1Order, 'Historical gross_v1 order exists');
  assert(grossV1Order.commission_model === 'gross_v1', 'Historical order returns commission_model=gross_v1');
  assert(grossV1Order.platform_commission !== undefined, 'Historical order preserves platform_commission');

  // Test 160 & 161: Partner payout helper
  ctx.serverModule = require('../../server.js');
  const defaultPayout = await ctx.serverModule.calculatePartnerPayout(250);
  assert(defaultPayout.platformCut === 30 && defaultPayout.partnerPayout === 220 && defaultPayout.cutPctUsed === 12, 'calculatePartnerPayout(250) returns 30/220/12');

  const overridePayout = await ctx.serverModule.calculatePartnerPayout(200, 's1');
  assert(overridePayout.platformCut === 30 && overridePayout.partnerPayout === 170 && overridePayout.cutPctUsed === 15, 'calculatePartnerPayout(200, s1) returns 30/170/15');

  // Test 162: Audit log coverage for commission-config mutations
  const deleteOverrideRes = await del(`http://localhost:3001/api/admin/commission-config/${overrideConfigId}`);
  assert(deleteOverrideRes.status === 200, 'DELETE of STORE override succeeds');

  const finalAuditRes = await get('http://localhost:3001/api/admin/audit-log');
  assert(finalAuditRes.status === 200, 'GET /api/admin/audit-log succeeds');
  const actionsInLog = finalAuditRes.body.map(a => a.action);
  assert(actionsInLog.includes('COMMISSION_CONFIG_CREATE'), 'Audit log contains COMMISSION_CONFIG_CREATE');
  assert(actionsInLog.includes('COMMISSION_CONFIG_DELETE'), 'Audit log contains COMMISSION_CONFIG_DELETE');

  
};
