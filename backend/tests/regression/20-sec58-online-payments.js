const {
  dbModule, loginAs, clearLogin, post, patch, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // ====================================================
  // Section 58: Online Payment & Integrations (Test Mode)
  // ====================================================
  console.log('\n--- Section 58: Online Payment & Integrations (Test Mode) ---');

  const paymentsLib = require('../../lib/payments.js');
  const integrationsLib = require('../../lib/integrations.js');

  // 1. Signature generation & verification unit tests with known test vector
  const s58TestVecOrder = 'order_test_12345';
  const s58TestVecPay = 'pay_test_67890';
  const s58TestVecSec = 'test_secret_key_abcdef';
  const s58ExpectedSig = '5fd57286f9a349f2597200dd7414184ae1605f0d543a2b2b8f4eacd6b8be5c26';

  const s58ComputedSig = paymentsLib.computeSignature(s58TestVecOrder, s58TestVecPay, s58TestVecSec);
  assert(s58ComputedSig === s58ExpectedSig, `computeSignature matches exact HMAC SHA256 test vector (${s58ExpectedSig})`);

  const s58ValidSigRes = paymentsLib.verifyPaymentSignature({
    order_id: s58TestVecOrder,
    payment_id: s58TestVecPay,
    signature: s58ExpectedSig,
    secret: s58TestVecSec
  });
  assert(s58ValidSigRes === true, 'verifyPaymentSignature returns true for valid signature');

  const s58ForgedSigRes = paymentsLib.verifyPaymentSignature({
    order_id: s58TestVecOrder,
    payment_id: s58TestVecPay,
    signature: '5fd57286f9a349f2597200dd7414184ae1605f0d543a2b2b8f4eacd6b8be5c20',
    secret: s58TestVecSec
  });
  assert(s58ForgedSigRes === false, 'verifyPaymentSignature returns false for forged signature');

  // Webhook signature verification
  const s58TestWebhookRaw = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_123"}}}}';
  const s58TestWebhookSec = 'whsec_test_secret_123';
  const cryptoModule = require('crypto');
  const s58ExpectedWebhookSig = cryptoModule.createHmac('sha256', s58TestWebhookSec).update(s58TestWebhookRaw).digest('hex');

  const s58ValidWebhookRes = paymentsLib.verifyWebhookSignature(s58TestWebhookRaw, s58ExpectedWebhookSig, s58TestWebhookSec);
  assert(s58ValidWebhookRes === true, 'verifyWebhookSignature returns true for valid webhook payload and secret');

  const s58InvalidWebhookRes = paymentsLib.verifyWebhookSignature(s58TestWebhookRaw, 'invalid_webhook_sig_hex', s58TestWebhookSec);
  assert(s58InvalidWebhookRes === false, 'verifyWebhookSignature returns false for forged webhook signature');

  // 2. Integrations mode and missing requirements reporting
  const s58CurrentPaymentsMode = integrationsLib.getPaymentsMode();
  assert(s58CurrentPaymentsMode === 'test', `integrationsLib.getPaymentsMode() reports test mode in test env, got ${s58CurrentPaymentsMode}`);

  const s58MissingKeys = integrationsLib.getMissingPaymentsKeys();
  assert(s58MissingKeys.includes('RAZORPAY_KEY_ID not set') && s58MissingKeys.includes('RAZORPAY_KEY_SECRET not set'), 'getMissingPaymentsKeys identifies unconfigured live keys');

  // 3. Admin Integrations endpoint
  clearLogin();
  const s58UnauthIntegRes = await get('http://localhost:3001/api/admin/integrations');
  assert(s58UnauthIntegRes.status === 401, `GET /api/admin/integrations without auth returns 401, got ${s58UnauthIntegRes.status}`);

  loginAs('u-admin', 'ADMIN');
  const s58AdminIntegRes = await get('http://localhost:3001/api/admin/integrations');
  assert(s58AdminIntegRes.status === 200, `GET /api/admin/integrations as admin returns 200, got ${s58AdminIntegRes.status}`);
  assert(Array.isArray(s58AdminIntegRes.body.integrations) && s58AdminIntegRes.body.integrations.length >= 4, 'Admin integrations endpoint lists Payments, SMS, Email, WhatsApp');

  const s58PaymentsItem = s58AdminIntegRes.body.integrations.find(i => i.id === 'payments');
  assert(s58PaymentsItem && s58PaymentsItem.mode === 'test' && s58PaymentsItem.provider === 'Razorpay', 'Payments integration item reports provider Razorpay and mode test');

  const s58IntegJsonStr = JSON.stringify(s58AdminIntegRes.body);
  assert(!s58IntegJsonStr.includes('key_secret') && !s58IntegJsonStr.includes('whsec_') && !s58IntegJsonStr.includes('auth_key'), 'Admin integrations endpoint never exposes secret key values');

  // 4. Online Payment Order Lifecycle
  loginAs('u-cust1', 'CUSTOMER');
  const s58OnlineOrderCreateRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'ONLINE',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(s58OnlineOrderCreateRes.status === 200, `Customer places ONLINE order successfully, got ${s58OnlineOrderCreateRes.status}`);
  const s58OnlineOrderId = s58OnlineOrderCreateRes.body.orderId;
  assert(s58OnlineOrderCreateRes.body.order.payment_method === 'ONLINE', 'Order payment_method is ONLINE');
  assert(s58OnlineOrderCreateRes.body.order.payment_status === 'PENDING_PAYMENT', `Order initial payment_status is PENDING_PAYMENT, got ${s58OnlineOrderCreateRes.body.order.payment_status}`);
  assert(typeof s58OnlineOrderCreateRes.body.checkout_url === 'string' && s58OnlineOrderCreateRes.body.checkout_url.includes(`/pay/test/${s58OnlineOrderId}`), `Order returns checkout_url /pay/test/:id, got ${s58OnlineOrderCreateRes.body.checkout_url}`);

  // Stockist queue isolation: shop never sees unconfirmed or failed online orders
  loginAs('u-stk1', 'STOCKIST');
  const s58StkQueuePending = await get('http://localhost:3001/api/orders');
  const s58FoundPendingInQueue = (s58StkQueuePending.body || []).some(o => o.id === s58OnlineOrderId);
  assert(s58FoundPendingInQueue === false, 'Stockist order queue does NOT display PENDING_PAYMENT online orders');

  // Payment failure flow
  const s58FailCallbackRes = await post('http://localhost:3001/api/payments/test-callback', {
    order_id: s58OnlineOrderId,
    action: 'fail'
  });
  assert(s58FailCallbackRes.status === 200, `POST /api/payments/test-callback with action fail returns 200, got ${s58FailCallbackRes.status}`);
  assert(s58FailCallbackRes.body.payment_status === 'PAYMENT_FAILED', `Order status updated to PAYMENT_FAILED, got ${s58FailCallbackRes.body.payment_status}`);

  const s58StkQueueFailed = await get('http://localhost:3001/api/orders');
  const s58FoundFailedInQueue = (s58StkQueueFailed.body || []).some(o => o.id === s58OnlineOrderId);
  assert(s58FoundFailedInQueue === false, 'Stockist order queue does NOT display PAYMENT_FAILED online orders');

  // Verify payment ledger logged failure event
  const s58PaymentLedgerRows = await dbModule.getTable('payment_ledger');
  const s58FailedLedgerEvent = s58PaymentLedgerRows.find(l => l.order_id === s58OnlineOrderId && l.event_type === 'PAYMENT_FAILED');
  assert(s58FailedLedgerEvent !== undefined, 'payment_ledger appended PAYMENT_FAILED event');

  // Successful payment flow
  loginAs('u-cust1', 'CUSTOMER');
  const s58SuccessOrderCreateRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'ONLINE',
    items: [{ productId: 'p1', quantity: 2 }]
  });
  assert(s58SuccessOrderCreateRes.status === 200, 'Customer places second ONLINE order for success test');
  const s58SuccessOrderId = s58SuccessOrderCreateRes.body.orderId;

  // Test callback with success action
  const s58SuccessCallbackRes = await post('http://localhost:3001/api/payments/test-callback', {
    order_id: s58SuccessOrderId,
    action: 'success'
  });
  assert(s58SuccessCallbackRes.status === 200, `POST /api/payments/test-callback with action success returns 200, got ${s58SuccessCallbackRes.status}`);
  assert(s58SuccessCallbackRes.body.payment_status === 'PAID_ONLINE', `Order payment_status transitioned to PAID_ONLINE, got ${s58SuccessCallbackRes.body.payment_status}`);
  assert(typeof s58SuccessCallbackRes.body.razorpay_payment_id === 'string' && s58SuccessCallbackRes.body.razorpay_payment_id.length > 5, 'Order has valid razorpay_payment_id assigned upon payment');

  // Verify stockist queue NOW sees the PAID_ONLINE order
  loginAs('u-stk1', 'STOCKIST');
  const s58StkQueuePaid = await get('http://localhost:3001/api/orders');
  const s58FoundPaidInQueue = (s58StkQueuePaid.body || []).some(o => o.id === s58SuccessOrderId);
  assert(s58FoundPaidInQueue === true, 'Stockist order queue displays PAID_ONLINE order once payment is verified');

  // Verify client verify endpoint with forged signature is rejected with 400
  loginAs('u-cust1', 'CUSTOMER');
  const s58BadVerifyRes = await post('http://localhost:3001/api/payments/verify', {
    order_id: s58SuccessOrderId,
    razorpay_order_id: 'order_test_fake',
    razorpay_payment_id: 'pay_test_fake',
    razorpay_signature: 'bad_forged_signature_hex'
  });
  assert(s58BadVerifyRes.status === 400, `POST /api/payments/verify with forged signature returns 400, got ${s58BadVerifyRes.status}`);

  // 5. Delivery Releases Shop Transfer & Appends Ledger Event
  const s58OrderDetails = (await dbModule.getTable('orders')).find(o => o.id === s58SuccessOrderId);
  loginAs('u-stk1', 'STOCKIST');
  const s58DeliverRes = await post(`http://localhost:3001/api/orders/${s58SuccessOrderId}/verify-pickup`, {
    pin: s58OrderDetails.pickup_pin
  });
  assert(s58DeliverRes.status === 200, `verify-pickup delivers order, got ${s58DeliverRes.status}`);

  const s58PostDeliveryLedger = await dbModule.getTable('payment_ledger');
  const s58ReleaseTransferEvent = s58PostDeliveryLedger.find(l => l.order_id === s58SuccessOrderId && l.event_type === 'TRANSFER_RELEASED');
  assert(s58ReleaseTransferEvent !== undefined, 'Delivery of online order appends TRANSFER_RELEASED event to payment_ledger');

  // 6. Cancellation of PAID_ONLINE Order & Connector Refund
  loginAs('u-cust1', 'CUSTOMER');
  const s58CancelOrderCreateRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'ONLINE',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  const s58CancelOrderId = s58CancelOrderCreateRes.body.orderId;

  // Pay online
  await post('http://localhost:3001/api/payments/test-callback', {
    order_id: s58CancelOrderId,
    action: 'success'
  });

  // Cancel order within window
  const s58CustCancelRes = await post(`http://localhost:3001/api/orders/${s58CancelOrderId}/cancel`);
  assert(s58CustCancelRes.status === 200, `Customer cancels PAID_ONLINE order within window, got ${s58CustCancelRes.status}`);
  assert(s58CustCancelRes.body.order.payment_status === 'REFUND_DUE', `Cancelled online order moves to REFUND_DUE state, got ${s58CustCancelRes.body.order.payment_status}`);

  // Admin triggers refund through connector
  loginAs('u-admin', 'ADMIN');
  const s58AdminRefundOnlineRes = await post(`http://localhost:3001/api/admin/orders/${s58CancelOrderId}/refund`);
  assert(s58AdminRefundOnlineRes.status === 200, `Admin triggers refund via POST /api/admin/orders/:id/refund, got ${s58AdminRefundOnlineRes.status}`);
  assert(s58AdminRefundOnlineRes.body.order.payment_status === 'REFUNDED', `Order payment_status transitioned to REFUNDED, got ${s58AdminRefundOnlineRes.body.order.payment_status}`);
  assert(typeof s58AdminRefundOnlineRes.body.order.refund_id === 'string' && s58AdminRefundOnlineRes.body.order.refund_id.length > 5, 'Order has refund_id populated from connector');

  const s58RefundLedgerEvent = (await dbModule.getTable('payment_ledger')).find(l => l.order_id === s58CancelOrderId && l.event_type === 'REFUNDED');
  assert(s58RefundLedgerEvent !== undefined, 'payment_ledger appended REFUNDED event upon gateway refund');

  // 7. Stockist Linked Account (Razorpay Route) in Admin Shop Edit
  const s58Vendors = await dbModule.getTable('vendors');
  const s58Vendor = s58Vendors.find(v => v.region_id === 'r1') || s58Vendors[0];
  const s58UpdateStkRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Linked Route Stockist',
    region_id: 'r1',
    phone: '9840011223',
    vendor_id: s58Vendor ? s58Vendor.id : 'v1',
    linked_account_id: 'acc_route_test_123456'
  });
  assert(s58UpdateStkRes.status === 200, `Admin creates stockist with linked_account_id, got ${s58UpdateStkRes.status}`);
  assert(s58UpdateStkRes.body.stockist && s58UpdateStkRes.body.stockist.linked_account_id === 'acc_route_test_123456', 'Created stockist has linked_account_id saved');

  const s58PatchStkRes = await patch(`http://localhost:3001/api/admin/stockists/${s58UpdateStkRes.body.stockist.id}`, {
    linked_account_id: 'acc_route_updated_998877'
  });
  assert(s58PatchStkRes.status === 200, `Admin patches stockist linked_account_id, got ${s58PatchStkRes.status}`);
  const s58FetchedStk = (await dbModule.getTable('stockists')).find(s => s.id === s58UpdateStkRes.body.stockist.id);
  assert(s58FetchedStk && s58FetchedStk.linked_account_id === 'acc_route_updated_998877', 'Stockist record holds updated linked_account_id');

  // SECTION 59: MESSAGING CONNECTOR (SMS/DLT, BREVO EMAIL, META WHATSAPP & OUTBOX)
};
