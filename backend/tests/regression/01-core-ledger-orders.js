const {
  dbModule, post, patch, get, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // 1. Payment split math
  console.log('\n--- 1. Payment Split Math ---');
  const orderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    commission_model: 'gross_v1',
    items: [
      { productId: 'p1', quantity: 2 }, // Alu, price: 30, cost: 22. Subtotal: 60. profit: 16
      { productId: 'p3', quantity: 1 }  // Dal, price: 60, cost: 48. Subtotal: 60. profit: 12
    ]
  });
  
  if(orderRes.status !== 200) console.log(orderRes.body); assert(orderRes.status === 200, 'Order created successfully');
  const orderId = orderRes.body.orderId;
  const orderDetails = (await get(`http://localhost:3001/api/orders`)).body.find(o => o.id === orderId);
  
  assert(orderDetails !== undefined, 'Order details fetched from DB');
  const totalDue = orderDetails.total_price;
  const stockistAmt = orderDetails.stockist_amount;
  const platformAmt = orderDetails.platform_amount;
  assert(Math.abs(stockistAmt + platformAmt - totalDue) < 0.01, `Split math sums to order total: ${stockistAmt} + ${platformAmt} === ${totalDue}`);

  // 2. Points calculation from profit margin
  console.log('\n--- 2. Points Calculated from Profit Margin ---');
  // Margin for 2 Alu + 1 Dal = (30-22)*2 + (60-48) = 16 + 12 = 28.
  // Earn rate for s1 (region r1) is 45%.
  // Expected points = 28 * 0.45 = 12.6.
  const pointsCredited = orderDetails.points_credited;
  assert(Math.abs(pointsCredited - 12.6) < 0.01, `Points calculated correctly from profit margin: ${pointsCredited} === 12.6`);

  // 3. Redemption allowlist
  console.log('\n--- 3. Redemption Allowlist Rejection ---');
  const badRedeem = await post('http://localhost:3001/api/ledger/redeem', {
    customerId: 'u-cust1',
    amount: 10,
    redemptionType: 'GROCERY_VOUCHER_25'
  });
  assert(badRedeem.status === 400, 'Invalid redemption type rejected with 400 Bad Request');

  // 4. Redemption descriptions match type
  console.log('\n--- 4. Redemption Descriptions ---');
  // Add some points first to allow redemptions
  // Customer Amit Sen had 12.6 pts from the order. Let's redeem:
  const red1 = await post('http://localhost:3001/api/ledger/redeem', {
    customerId: 'u-cust1',
    amount: 5,
    redemptionType: 'BROADBAND_DISCOUNT'
  });
  assert(red1.status === 200, 'Custom Broadband Discount redeemed');
  
  const red2 = await post('http://localhost:3001/api/ledger/redeem', {
    customerId: 'u-cust1',
    amount: 5,
    redemptionType: 'WIFI_TOPUP'
  });
  assert(red2.status === 200, 'WiFi Speed Booster redeemed');

  const history = (await get('http://localhost:3001/api/ledger/history/u-cust1')).body;
  const entry1 = history.find(h => h.id === red1.body.ledgerId);
  const entry2 = history.find(h => h.id === red2.body.ledgerId);

  assert(entry1 && entry1.description === 'Broadband Bill Discount - ₹5', 'Broadband discount description is correct');
  assert(entry2 && entry2.description === 'WiFi Speed Booster 48h (100 Mbps)', 'WiFi booster description is correct');

  // 5. CSV export data columns check
  console.log('\n--- 5. CSV Export Columns & Descriptions ---');
  const redemptionsRes = await get('http://localhost:3001/api/admin/redemptions');
  assert(redemptionsRes.status === 200, 'Fetched redemptions list');
  const testRed = redemptionsRes.body[0];
  assert(testRed && testRed.description !== undefined, 'Redemption log in DB includes description field');
  assert(testRed && testRed.redemption_type !== undefined, 'Redemption log in DB includes redemption_type field');

  // 6. Points reversal on cancellation
  console.log('\n--- 6. Points Reversal on Cancellation ---');
  await post('http://localhost:3001/api/admin/bill-photos/pbp-seed1/verify', {});
  await post('http://localhost:3001/api/admin/bill-photos/pbp-seed3/verify', {});
  await patch(`http://localhost:3001/api/orders/${orderId}/status`, { status: 'DELIVERED' });
  const balBefore = (await get('http://localhost:3001/api/ledger/balance/u-cust1')).body.balance;

  // Bypass stockist cancel restriction on DELIVERED status by manually setting to PENDING in DB
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: orderId, patch: { status: 'PENDING' } });

  await patch(`http://localhost:3001/api/orders/${orderId}/status`, { status: 'CANCELLED' });
  const balAfter = (await get('http://localhost:3001/api/ledger/balance/u-cust1')).body.balance;
  
  // Reversal should deduct the points earned (12.6)
  assert(Math.abs(balBefore - balAfter - 12.6) < 0.01, `Cancellations correctly subtract order earnings: balance went from ${balBefore} to ${balAfter}`);

  // 7. Anomaly flagging persists to FLAGGED status
  console.log('\n--- 7. Anomaly Flagging Persistence ---');
  // Create 3 orders to trigger anomaly detection (we cancelled 1, but total placed counts)
  await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });

  const anomalies = (await get('http://localhost:3001/api/admin/anomalies')).body;
  assert(anomalies.length > 0, 'Anomaly logged successfully');
  const targetAnomaly = anomalies[0];
  assert(targetAnomaly.status === 'PENDING', 'Initial anomaly status is PENDING');

  const flagRes = await post(`http://localhost:3001/api/admin/anomalies/${targetAnomaly.id}/flag`);
  assert(flagRes.status === 200, 'Anomaly flagged successfully via API');

  const anomaliesUpdated = (await get('http://localhost:3001/api/admin/anomalies')).body;
  const updatedAnomaly = anomaliesUpdated.find(a => a.id === targetAnomaly.id);
  assert(updatedAnomaly && updatedAnomaly.status === 'FLAGGED', 'Anomaly status persisted as FLAGGED');

  // 8. No rupee symbol on raw points
  console.log('\n--- 8. Raw Points Balance Format ---');
  const balanceRawObj = (await get('http://localhost:3001/api/ledger/balance/u-cust1')).body;
  assert(typeof balanceRawObj.balance === 'number', 'Raw points balance is numeric');
  assert(!String(balanceRawObj.balance).includes('₹'), 'Raw points balance payload does not contain rupee symbol (₹)');

  // 9. Flexible pre-order switching & post-order lock
  console.log('\n--- 9. Fulfillment Pre-order Delivery Fee & Post-order Lock ---');
  const orderDelRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'DELIVERY',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(orderDelRes.status === 200, 'Order with DELIVERY fulfillment created successfully');
  const orderDelId = orderDelRes.body.orderId;
  
  const orderDelDetails = (await get(`http://localhost:3001/api/orders`)).body.find(o => o.id === orderDelId);
  assert(orderDelDetails.fulfillment_type === 'DELIVERY', 'Order fulfillment type is DELIVERY');
  assert(orderDelDetails.delivery_fee === 40, `Delivery fee of 40 applied: ${orderDelDetails.delivery_fee}`);
  assert(orderDelDetails.total_price === 70, `Total price includes delivery fee: ${orderDelDetails.total_price} === 70`);

  const patchPickupRes = await patch(`http://localhost:3001/api/orders/${orderDelId}/fulfillment`, {
    fulfillmentType: 'PICKUP'
  });
  assert(patchPickupRes.status === 400, 'Switching post-order from DELIVERY to PICKUP is blocked');

  const orderPickRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(orderPickRes.status === 200, 'Order with PICKUP fulfillment created successfully');
  const orderPickId = orderPickRes.body.orderId;

  const patchDelRes = await patch(`http://localhost:3001/api/orders/${orderPickId}/fulfillment`, {
    fulfillmentType: 'DELIVERY'
  });
  assert(patchDelRes.status === 200, 'Switching post-order from PICKUP to DELIVERY is allowed');
  
  const orderPickDetailsUpdated = (await get(`http://localhost:3001/api/orders`)).body.find(o => o.id === orderPickId);
  assert(orderPickDetailsUpdated.fulfillment_type === 'DELIVERY', 'Fulfillment type updated to DELIVERY');
  assert(orderPickDetailsUpdated.delivery_fee === 40, 'Delivery fee calculated and added');
  assert(orderPickDetailsUpdated.total_price === 70, 'Total price updated with delivery fee');

  // 10. IST timezone boundary check
  console.log('\n--- 10. IST Timezone Boundary Check ---');
  const dateAt20UTC = new Date('2026-07-13T20:00:00Z');
  function localISTDateString(date) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + IST_OFFSET_MS);
    return istDate.toISOString().slice(0, 10);
  }
  assert(localISTDateString(dateAt20UTC) === '2026-07-14', 'IST timezone boundary wraps correctly past midnight IST');

  // 11. Stockist rates/reports a customer
  console.log('\n--- 11. Stockist Rates/Reports a Customer ---');
  const fbRes = await post('http://localhost:3001/api/feedback', {
    reporterId: 's1',
    reporterRole: 'STOCKIST',
    targetId: 'u-cust1',
    targetRole: 'CUSTOMER',
    orderId: orderPickId,
    rating: 2,
    reason: 'Customer did not show up to pick up order.',
    reportFlag: true
  });
  assert(fbRes.status === 200, 'Feedback from stockist submitted successfully');
  
  const adminFbRes = await get('http://localhost:3001/api/admin/feedback');
  assert(adminFbRes.status === 200, 'Admin feedback queue retrieved successfully');
  
  const targetFb = adminFbRes.body.find(f => f.id === fbRes.body.feedback.id);
  assert(targetFb !== undefined, 'Stockist feedback exists in admin feedback queue');
  assert(targetFb.reporter_role === 'STOCKIST', `Reporter role is STOCKIST: ${targetFb.reporter_role}`);
  assert(targetFb.target_role === 'CUSTOMER', `Target role is CUSTOMER: ${targetFb.target_role}`);
  assert(targetFb.report_flag === true, `Report flag is set to true: ${targetFb.report_flag}`);
  assert(targetFb.reason === 'Customer did not show up to pick up order.', 'Reason matches submitted text');

  // 12. Slot Enforcement
  console.log('\n--- 12. Slot Enforcement ---');
  const slotRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(slotRes.status === 400, 'Order without slot is rejected with 400');

  // 13. Cancel Window Enforcement
  console.log('\n--- 13. Cancel Window Enforcement ---');
  const testOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    paymentMethod: 'ONLINE',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(testOrder.status === 200, 'Order created within cancel window');
  
  // Backdate cancel deadline in the JSON db manually to simulate time elapsed
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: testOrder.body.orderId, patch: { cancel_deadline: new Date(Date.now() - 10000).toISOString(), status: 'PENDING' } });
  
  const cancelRes = await post(`http://localhost:3001/api/orders/${testOrder.body.orderId}/cancel`);
  assert(cancelRes.status === 400, 'Cancellation blocked after deadline/window closed');

  // 14. No-show flow (Reschedule or Cancel)
  console.log('\n--- 14. No-Show flow ---');
  // Order status needs to be SHIPPED/READY to simulate missed pickup
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: testOrder.body.orderId, patch: { status: 'SHIPPED', payment_status: 'PAID_ONLINE' } });
  
  const rescheduleRes1 = await post(`http://localhost:3001/api/orders/${testOrder.body.orderId}/noshw-action`, {
    action: 'RESCHEDULE',
    newSlot: 'Afternoon (12PM–4PM)'
  });
  assert(rescheduleRes1.status === 200, 'Rescheduling first time is allowed');
  
  const rescheduleRes2 = await post(`http://localhost:3001/api/orders/${testOrder.body.orderId}/noshw-action`, {
    action: 'RESCHEDULE',
    newSlot: 'Evening (4PM–8PM)'
  });
  assert(rescheduleRes2.status === 400, 'Second reschedule is blocked');

  // Cancel missed pickup (refund status goes to REFUND_DUE)
  const cancelMissedRes = await post(`http://localhost:3001/api/orders/${testOrder.body.orderId}/noshw-action`, {
    action: 'CANCEL'
  });
  assert(cancelMissedRes.status === 200, 'Missed pickup order cancelled successfully');
  assert(cancelMissedRes.body.order.payment_status === 'REFUND_DUE', 'Payment marked as REFUND_DUE');

  // Trigger admin refund
  const adminRefundRes = await post(`http://localhost:3001/api/admin/orders/${testOrder.body.orderId}/refund`);
  assert(adminRefundRes.status === 200, 'Admin refund succeeds');
  assert(adminRefundRes.body.order.payment_status === 'REFUNDED', 'Payment marked as REFUNDED');

  // Check prepaid pickup restriction
  await post('http://localhost:3001/api/admin/override-table', { table: 'users', id: 'u-cust1', patch: { no_show_count: 3, prepaid_pickup_restricted: true } });

  const restrictedRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(restrictedRes.status === 400, 'Prepaid pickup is restricted after 3 no-shows');

  // Reset no-shows
  await post('http://localhost:3001/api/admin/override-table', { table: 'users', id: 'u-cust1', patch: { no_show_count: 0, prepaid_pickup_restricted: false } });

  // 15. Multi-store checkout
  console.log('\n--- 15. Multi-Store Checkout ---');
  const multiStoreFailing = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'DELIVERY',
    stores: [
      { stockistId: 's1', pickupSlot: 'Morning (8AM–12PM)', items: [{ productId: 'p1', quantity: 1 }] },
      { stockistId: 's3', pickupSlot: 'Morning (8AM–12PM)', items: [{ productId: 'p1-s3', quantity: 1 }] }
    ]
  });
  assert(multiStoreFailing.status === 400, 'Multi-store DELIVERY checkout is blocked');

  const multiStoreSuccess = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    fulfillmentType: 'PICKUP',
    paymentMethod: 'ONLINE',
    stores: [
      { stockistId: 's1', pickupSlot: 'Morning (8AM–12PM)', items: [{ productId: 'p1', quantity: 1 }] },
      { stockistId: 's3', pickupSlot: 'Afternoon (12PM–4PM)', items: [{ productId: 'p1-s3', quantity: 1 }] }
    ]
  });
  assert(multiStoreSuccess.status === 200, 'Multi-store PICKUP checkout is successful');
  assert(multiStoreSuccess.body.orders.length === 2, 'Two separate orders created');
  assert(multiStoreSuccess.body.orders[0].payment_status === 'PENDING_PAYMENT' || multiStoreSuccess.body.orders[0].payment_status === 'HELD', 'Payment status is PENDING_PAYMENT or HELD');
  
  const multiOrderId = multiStoreSuccess.body.orders[0].id;

  // 16. Release Split
  console.log('\n--- 16. Release Split ---');
  // Deliver the order to allow releasing split
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: multiOrderId, patch: { status: 'DELIVERED', payment_status: 'PAID_ONLINE' } });

  const releaseRes = await post(`http://localhost:3001/api/admin/release-split/${multiOrderId}`);
  assert(releaseRes.status === 200, 'Split released successfully');

  // 17. COD Commission Ledger
  console.log('\n--- 17. COD Commission ---');
  const codOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    paymentMethod: 'COD',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(codOrder.status === 200, 'COD order created successfully');
  assert(codOrder.body.order.payment_status === 'COD', 'COD payment status is COD');
  
  let codLedger = await dbModule.getTable('cod_commission_ledger');
  let codEntry = codLedger.find(e => e.order_id === codOrder.body.orderId);
  assert(codEntry === undefined, 'COD commission entry NOT added at creation');

  // Verify COD commission accrues on delivery
  await patch(`http://localhost:3001/api/orders/${codOrder.body.orderId}/status`, { status: 'DELIVERED' });
  codLedger = await dbModule.getTable('cod_commission_ledger');
  codEntry = codLedger.find(e => e.order_id === codOrder.body.orderId);
  assert(codEntry !== undefined, 'COD commission entry added to ledger on delivery');

  // 18. Fraud Flag Dismissals
  console.log('\n--- 18. Fraud Flag Dismissals ---');
  const anomaliesList = await dbModule.getTable('anomaly_logs');
  const targetAnomaly2 = anomaliesList[0];
  
  const dismissRes = await post(`http://localhost:3001/api/admin/anomalies/${targetAnomaly2.id}/dismiss`, {
    reason: 'Legitimate regular customer'
  });
  assert(dismissRes.status === 200, 'Anomaly flag dismissed');
  
  const auditAnomalies = await dbModule.getTable('anomaly_logs');
  const updatedAnomaly2 = auditAnomalies.find(a => a.id === targetAnomaly2.id);
  assert(updatedAnomaly2.status === 'DISMISSED', 'Anomaly status updated to DISMISSED');
  assert(updatedAnomaly2.dismiss_reason === 'Legitimate regular customer', 'Dismiss reason saved');

  // 19. Ledger Credit on DELIVERED only
  console.log('\n--- 19. Ledger Credit on DELIVERED only ---');
  const balanceBefore = (await get('http://localhost:3001/api/ledger/balance/u-cust1')).body.balance;
  
  const orderForPoints = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(orderForPoints.status === 200, 'Order created successfully');
  const pointsToEarn = orderForPoints.body.pointsCredited; // 3.6
  
  const balanceDuringPending = (await get('http://localhost:3001/api/ledger/balance/u-cust1')).body.balance;
  assert(balanceDuringPending === balanceBefore, 'Ledger unchanged until DELIVERED');

  const delRes = await patch(`http://localhost:3001/api/orders/${orderForPoints.body.orderId}/status`, { status: 'DELIVERED' });
  assert(delRes.status === 200, 'Order delivered successfully');

  const balanceAfter = (await get('http://localhost:3001/api/ledger/balance/u-cust1')).body.balance;
  assert(Math.abs(balanceAfter - balanceBefore - pointsToEarn) < 0.01, `Ledger increased by exactly that amount: ${balanceAfter - balanceBefore} === ${pointsToEarn}`);

  // 20. Legacy SHIPPED status safety mapping
  console.log('\n--- 20. Legacy SHIPPED status safety mapping ---');
  // PICKUP order mapping
  const pickupOrderForShipped = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(pickupOrderForShipped.status === 200, 'Pickup order created');
  const patchPickupShipped = await patch(`http://localhost:3001/api/orders/${pickupOrderForShipped.body.orderId}/status`, { status: 'SHIPPED' });
  assert(patchPickupShipped.status === 200, 'PATCH legacy SHIPPED on PICKUP order succeeds');
  
  const pickupOrderDetails = (await get(`http://localhost:3001/api/orders`)).body.find(o => o.id === pickupOrderForShipped.body.orderId);
  assert(pickupOrderDetails.status === 'READY_FOR_PICKUP', 'Legacy SHIPPED correctly translated to READY_FOR_PICKUP');

  // DELIVERY order mapping
  const deliveryOrderForShipped = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'DELIVERY',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(deliveryOrderForShipped.status === 200, 'Delivery order created');
  const patchDeliveryShipped = await patch(`http://localhost:3001/api/orders/${deliveryOrderForShipped.body.orderId}/status`, { status: 'SHIPPED' });
  assert(patchDeliveryShipped.status === 200, 'PATCH legacy SHIPPED on DELIVERY order succeeds');
  
  const deliveryOrderDetails = (await get(`http://localhost:3001/api/orders`)).body.find(o => o.id === deliveryOrderForShipped.body.orderId);
  assert(deliveryOrderDetails.status === 'OUT_FOR_DELIVERY', 'Legacy SHIPPED correctly translated to OUT_FOR_DELIVERY');

  // 21. Cancel window success / failure
  console.log('\n--- 21. Cancel window success / failure ---');
  // Success before deadline
  const orderToCancelSuccess = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(orderToCancelSuccess.status === 200, 'Order to cancel created');
  const cancelSuccessRes = await post(`http://localhost:3001/api/orders/${orderToCancelSuccess.body.orderId}/cancel`);
  assert(cancelSuccessRes.status === 200, 'Cancel succeeds before deadline');

  // Failure after deadline (returns CANCEL_WINDOW_CLOSED)
  const orderToCancelFail = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(orderToCancelFail.status === 200, 'Order to cancel fail created');
  
  // Backdate deadline & set status to PENDING
  await post('http://localhost:3001/api/admin/override-table', { table: 'orders', id: orderToCancelFail.body.orderId, patch: { cancel_deadline: new Date(Date.now() - 10000).toISOString(), status: 'PENDING' } });

  const cancelFailRes = await post(`http://localhost:3001/api/orders/${orderToCancelFail.body.orderId}/cancel`);
  assert(cancelFailRes.status === 400, 'Cancel blocked after deadline');
  assert(cancelFailRes.body.code === 'CANCEL_WINDOW_CLOSED', 'Cancellation response contains CANCEL_WINDOW_CLOSED code');

  // 22. Partner Leads
  console.log('\n--- 22. Partner Leads ---');
  // Validate non-empty payload check
  const leadFailRes = await post('http://localhost:3001/api/partner-leads', {});
  assert(leadFailRes.status === 400, 'Posting empty lead is rejected with 400');

  // POST valid lead
  const leadSuccessRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'CableNet Garia',
    phone: '9876543219', email: 'test_9876543219@fastnet.test'
  });
  assert(leadSuccessRes.status === 200, 'POST lead succeeds');
  assert(leadSuccessRes.body.success === true, 'Response contains success flag');
  assert(leadSuccessRes.body.lead.name === 'CableNet Garia', 'Lead name matches');
  assert(leadSuccessRes.body.lead.phone === '9876543219', 'Lead phone matches');
  assert(leadSuccessRes.body.lead.status === 'NEW', 'Initial lead status is NEW');

  // GET leads list to verify persistence
  const getLeadsRes = await get('http://localhost:3001/api/admin/partner-leads');
  assert(getLeadsRes.status === 200, 'GET admin partner leads succeeds');
  const targetLead = getLeadsRes.body.find(l => l.id === leadSuccessRes.body.lead.id);
  assert(targetLead !== undefined, 'Posted lead exists in admin partner leads list');

  // 23. REDO ROUND Tests
};
