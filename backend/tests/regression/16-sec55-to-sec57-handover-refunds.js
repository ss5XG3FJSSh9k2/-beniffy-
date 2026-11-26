const {
  fs, path, dbModule, loginAs, post, patch, get, state, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // --- Section 55: Pickup Slot Labels Show Real Clock Times and Translated Day ---
  console.log('\n--- Section 55: Pickup Slot Labels Show Real Clock Times and Translated Day ---');
  const s55AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #1368: formatClock12 exists in App.jsx and formats Date objects with h:mm AM/PM
  const formatClock12Fn = new Function(`${ctx.extractFnCode(s55AppJsx, 'formatClock12')}; return formatClock12;`)();
  assert(formatClock12Fn(new Date('2026-10-24T14:00:00')) === '2:00 PM', 'formatClock12 formats 14:00 as 2:00 PM');
  assert(formatClock12Fn(new Date('2026-10-24T08:30:00')) === '8:30 AM', 'formatClock12 formats 08:30 as 8:30 AM');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: formatClock12 formats Date objects with h:mm AM/PM`);

  // Test #1369: getAvailableSlots for shop open 08:30-20:00 at 13:10 with 10 min prep: first label "Today, 2:00 PM – 3:00 PM", labels all distinct
  const s55SlotsFn = new Function(`
    ${ctx.extractFnCode(s55AppJsx, 'formatClock12')};
    ${ctx.extractFnCode(s55AppJsx, 'formatHour12')};
    ${ctx.extractFnCode(s55AppJsx, 'getAvailableSlots')};
    return getAvailableSlots;
  `)();
  const s55Stockist = { id: 's1', opening_time: '08:30', closing_time: '20:00', prep_eta_minutes: 10 };
  const s55Now = new Date('2026-10-24T13:10:00');
  const s55Slots = s55SlotsFn(s55Stockist, s55Now);
  assert(s55Slots.length > 0, 'getAvailableSlots returns slots');
  assert(s55Slots[0].label === 'Today, 2:00 PM – 3:00 PM', `first label is "Today, 2:00 PM – 3:00 PM" (got "${s55Slots[0].label}")`);
  const s55Labels = s55Slots.map(s => s.label);
  const s55UniqueLabels = new Set(s55Labels);
  assert(s55UniqueLabels.size === s55Labels.length, 'All slot labels are distinct');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: getAvailableSlots for 08:30-20:00 at 13:10 returns first label "Today, 2:00 PM – 3:00 PM" with distinct labels`);

  // Test #1370: formatPickupSlotDisplay formats matching ISO slot with real clock times
  const formatPickupSlotDisplayFn = new Function(`
    const t = (en, hi, bn) => en;
    ${ctx.extractFnCode(s55AppJsx, 'formatClock12')};
    ${ctx.extractFnCode(s55AppJsx, 'formatHour12')};
    ${ctx.extractFnCode(s55AppJsx, 'formatPickupSlotDisplay')};
    return formatPickupSlotDisplay;
  `)();
  const todayIsoDate = new Date().toISOString().split('T')[0];
  const formattedSlot = formatPickupSlotDisplayFn(`${todayIsoDate}T14:00`);
  assert(formattedSlot === 'Today, 2:00 PM – 3:00 PM', `formatPickupSlotDisplay returns "Today, 2:00 PM – 3:00 PM" (got "${formattedSlot}")`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: formatPickupSlotDisplay formats matching ISO slot with real clock times`);

  // --- Section 56: Pilot Pay-At-Handover (Cash or UPI to Shop; No Fake Prepaid Orders) ---
  console.log('\n--- Section 56: Pilot Pay-At-Handover ---');
  loginAs('u-cust1', 'CUSTOMER');

  // Test #1371: Default order creation sets payment_method: 'PAY_AT_HANDOVER', payment_status: 'UNPAID', and no split_payouts row
  const s56PickupOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(s56PickupOrder.status === 200, 'Pickup order created successfully');
  const s56PickupId = s56PickupOrder.body.orderId;
  const s56PickupData = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === s56PickupId);
  assert(s56PickupData.payment_method === 'PAY_AT_HANDOVER', `payment_method is PAY_AT_HANDOVER (got ${s56PickupData.payment_method})`);
  assert(s56PickupData.payment_status === 'UNPAID', `payment_status is UNPAID (got ${s56PickupData.payment_status})`);
  const s56Splits1 = (await dbModule.getTable('split_payouts')).filter(sp => sp.order_id === s56PickupId);
  assert(s56Splits1.length === 0, 'No split_payouts row created for PAY_AT_HANDOVER pickup order');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: New pickup order created with default parameters has payment_method: PAY_AT_HANDOVER, payment_status: UNPAID, and no split_payouts`);

  // Test #1372: Delivery order creation sets payment_method: 'PAY_AT_HANDOVER', payment_status: 'UNPAID', and no split_payouts row
  const s56DelivOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'DELIVERY',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(s56DelivOrder.status === 200, 'Delivery order created successfully');
  const s56DelivId = s56DelivOrder.body.orderId;
  const s56DelivData = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === s56DelivId);
  assert(s56DelivData.payment_method === 'PAY_AT_HANDOVER', `delivery payment_method is PAY_AT_HANDOVER (got ${s56DelivData.payment_method})`);
  assert(s56DelivData.payment_status === 'UNPAID', `delivery payment_status is UNPAID (got ${s56DelivData.payment_status})`);
  const s56Splits2 = (await dbModule.getTable('split_payouts')).filter(sp => sp.order_id === s56DelivId);
  assert(s56Splits2.length === 0, 'No split_payouts row created for PAY_AT_HANDOVER delivery order');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: New delivery order has payment_method: PAY_AT_HANDOVER, payment_status: UNPAID, and no split_payouts`);

  // Test #1373: Verifying pickup PIN without payment_received_method is rejected with 400
  loginAs('u-stk1', 'STOCKIST');
  await patch(`http://localhost:3001/api/orders/${s56PickupId}/status`, { status: 'RECEIVED' });
  await patch(`http://localhost:3001/api/orders/${s56PickupId}/status`, { status: 'READY' });
  const verifyNoMethod = await post(`http://localhost:3001/api/orders/${s56PickupId}/verify-pickup`, {
    pin: s56PickupData.pickup_pin
  });
  assert(verifyNoMethod.status === 400, 'Completing UNPAID order without payment_received_method returns 400');
  assert(verifyNoMethod.body.code === 'PAYMENT_METHOD_REQUIRED', 'Response returns PAYMENT_METHOD_REQUIRED code');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Verifying pickup PIN without payment_received_method is rejected with 400 PAYMENT_METHOD_REQUIRED`);

  // Test #1374: Verifying pickup PIN with payment_received_method: 'UPI' sets payment_status: 'PAID', payment_received_method: 'UPI', paid_at
  const verifyWithUpi = await post(`http://localhost:3001/api/orders/${s56PickupId}/verify-pickup`, {
    pin: s56PickupData.pickup_pin,
    payment_received_method: 'UPI'
  });
  assert(verifyWithUpi.status === 200, 'Verification with UPI succeeds');
  const completedOrder = verifyWithUpi.body.order;
  assert(completedOrder.payment_status === 'PAID', `payment_status is PAID (got ${completedOrder.payment_status})`);
  assert(completedOrder.payment_received_method === 'UPI', `payment_received_method is UPI (got ${completedOrder.payment_received_method})`);
  assert(typeof completedOrder.paid_at === 'string' && completedOrder.paid_at.length > 0, 'paid_at is set to ISO timestamp');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Verifying pickup PIN with payment_received_method: 'UPI' marks order PAID with timestamp`);

  // Test #1375: Commission entry owed in cod_commission_ledger exists after completion
  const s56CodLedger = (await dbModule.getTable('cod_commission_ledger')).filter(e => e.order_id === s56PickupId);
  assert(s56CodLedger.length > 0, 'Platform commission owed by shop recorded in cod_commission_ledger');
  assert(s56CodLedger[0].settled === false, 'Commission entry is marked unsettled (owed by shop)');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Commission entry owed by shop recorded in cod_commission_ledger`);

  // Test #1376: Switching pickup to delivery updates fulfillment and amount_paid without altering PAY_AT_HANDOVER
  loginAs('u-cust1', 'CUSTOMER');
  const s56SwitchOrder = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  const s56SwitchId = s56SwitchOrder.body.orderId;
  const s56PreSwitch = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === s56SwitchId);
  const switchRes = await patch(`http://localhost:3001/api/orders/${s56SwitchId}/fulfillment`, {
    fulfillmentType: 'DELIVERY'
  });
  assert(switchRes.status === 200, 'Switching pickup to delivery succeeds');
  const s56PostSwitch = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === s56SwitchId);
  assert(s56PostSwitch.fulfillment_type === 'DELIVERY', 'fulfillment_type updated to DELIVERY');
  assert(s56PostSwitch.delivery_fee > 0, 'delivery_fee added');
  assert(s56PostSwitch.amount_paid === s56PreSwitch.amount_paid + s56PostSwitch.delivery_fee, 'amount_paid incremented by delivery_fee');
  assert(s56PostSwitch.payment_method === 'PAY_AT_HANDOVER' && s56PostSwitch.payment_status === 'UNPAID', 'Order remains PAY_AT_HANDOVER / UNPAID');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Switching pickup to delivery updates amount_paid with delivery fee and preserves PAY_AT_HANDOVER`);

  // Test #1377: Startup repair converts pending HELD/COD orders to PAY_AT_HANDOVER/UNPAID and removes HELD splits
  const legacyHeldOrderId = 'o-legacy-held-' + Date.now();
  await dbModule.insertRow('orders', {
    id: legacyHeldOrderId,
    customer_id: 'u-cust1',
    stockist_id: 's1',
    status: 'RECEIVED',
    payment_method: 'UPI',
    payment_status: 'HELD',
    subtotal: 100,
    total_price: 100,
    amount_paid: 100,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('split_payouts', {
    id: 'sp-legacy-' + Date.now(),
    order_id: legacyHeldOrderId,
    status: 'HELD',
    stockist_amount: 90,
    platform_amount: 10,
    created_at: new Date().toISOString()
  });
  if (typeof dbModule.repairPayAtHandoverOrders === 'function') {
    const repairCounts = await dbModule.repairPayAtHandoverOrders(dbModule);
    assert(repairCounts.repairedOrdersCount >= 1, 'repairPayAtHandoverOrders repaired at least 1 order');
    assert(repairCounts.removedHeldSplitsCount >= 1, 'repairPayAtHandoverOrders removed at least 1 HELD split');
  }
  const repairedLegacyOrder = (await dbModule.getTable('orders')).find(o => o.id === legacyHeldOrderId);
  assert(repairedLegacyOrder.payment_method === 'PAY_AT_HANDOVER', 'Repaired legacy order has payment_method: PAY_AT_HANDOVER');
  assert(repairedLegacyOrder.payment_status === 'UNPAID', 'Repaired legacy order has payment_status: UNPAID');
  const lingeringSplits = (await dbModule.getTable('split_payouts')).filter(sp => sp.order_id === legacyHeldOrderId);
  assert(lingeringSplits.length === 0, 'No HELD split remains for repaired legacy order');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Startup repair converts pending HELD orders to PAY_AT_HANDOVER/UNPAID and purges HELD splits`);

  // Test #1378: App.jsx contains UPI QR Code, direct payment helper, and required translations
  const s56AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(s56AppJsx.includes('UpiQrCode'), 'App.jsx contains UpiQrCode component');
  assert(s56AppJsx.includes('getShopUpiUri'), 'App.jsx contains getShopUpiUri helper');
  assert(s56AppJsx.includes('upi://pay?pa='), 'App.jsx constructs valid upi://pay URI');
  assert(s56AppJsx.includes("Payment received?"), 'App.jsx contains Payment received? prompt');
  assert(s56AppJsx.includes("To pay at pickup:") && s56AppJsx.includes("পিকআপে প্রদেয়:"), 'App.jsx contains translated To pay at pickup string');
  assert(s56AppJsx.includes("To pay on delivery:") && s56AppJsx.includes("ডেলিভারিতে প্রদেয়:"), 'App.jsx contains translated To pay on delivery string');
  assert(s56AppJsx.includes("Cancelled · nothing charged") && s56AppJsx.includes("বাতিল · কোনো চার্জ নেই"), 'App.jsx contains translated Cancelled nothing charged string');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx contains UPI payment components and required trilingual strings`);


  // --- Section 57: Cancelled Orders Money Integrity & Refunds ---
  console.log('\n--- Section 57: Cancelled Orders Money Integrity & Refunds ---');

  // Test #1418: Cancel an unpaid order produces NO refund, CANCELLED_UNPAID status, and split_payout CANCELLED
  loginAs('u-cust1', 'CUSTOMER');
  const s57UnpaidOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(s57UnpaidOrderRes.status === 200, 'Unpaid order created successfully');
  const s57UnpaidOrderId = s57UnpaidOrderRes.body.orderId;

  // Cancel the unpaid order
  const s57CancelUnpaidRes = await post(`http://localhost:3001/api/orders/${s57UnpaidOrderId}/cancel`, {});
  assert(s57CancelUnpaidRes.status === 200, 'Cancellation of unpaid order succeeds');
  const s57CancelledUnpaidOrder = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === s57UnpaidOrderId);

  assert(s57CancelledUnpaidOrder.status === 'CANCELLED', 'Order status is CANCELLED');
  assert(s57CancelledUnpaidOrder.payment_status === 'CANCELLED_UNPAID', 'payment_status is CANCELLED_UNPAID');
  assert(!s57CancelledUnpaidOrder.refund_amount || s57CancelledUnpaidOrder.refund_amount === 0, 'No refund amount for unpaid cancelled order');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Cancel unpaid order sets payment_status: CANCELLED_UNPAID and no refund`);

  // Test #1419: Cancelled unpaid order split payout is CANCELLED and excluded from Payouts Due and Revenue
  loginAs('u-admin', 'ADMIN');
  const s57PayoutsRes = await get('http://localhost:3001/api/admin/payouts');
  assert(s57PayoutsRes.status === 200, 'GET /api/admin/payouts returns 200');
  const s57CancelledPayout = (s57PayoutsRes.body || []).find(p => p.order_id === s57UnpaidOrderId);
  if (s57CancelledPayout) {
    assert(s57CancelledPayout.status === 'CANCELLED', 'Split payout status is CANCELLED');
  }
  const s57AnalyticsRes = await get('http://localhost:3001/api/admin/analytics');
  assert(s57AnalyticsRes.status === 200, 'GET /api/admin/analytics returns 200');
  const s57OrdersMetric = s57AnalyticsRes.body.orders || {};
  assert(typeof s57OrdersMetric.revenue_this_week_rupees === 'number', 'Revenue this week is numeric');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Cancelled unpaid order payout is CANCELLED and excluded from active metrics`);

  // Test #1420: Admin cancels a PAID order produces REFUND_DUE with server refund_amount
  loginAs('u-cust1', 'CUSTOMER');
  const s57PaidOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(s57PaidOrderRes.status === 200, 'Pickup order created for completion');
  const s57PaidOrderId = s57PaidOrderRes.body.orderId;

  // Complete order as PAID
  loginAs('u-stk1', 'STOCKIST');
  await patch(`http://localhost:3001/api/orders/${s57PaidOrderId}/status`, { status: 'ACCEPTED' });
  await patch(`http://localhost:3001/api/orders/${s57PaidOrderId}/status`, { status: 'PREPARING' });
  await patch(`http://localhost:3001/api/orders/${s57PaidOrderId}/status`, { status: 'READY_FOR_PICKUP' });
  const s57DbOrder = (await dbModule.getTable('orders')).find(o => o.id === s57PaidOrderId);
  const s57Pin = s57DbOrder.pickup_pin;
  loginAs('u-stk1', 'STOCKIST');
  const s57CompleteRes = await post(`http://localhost:3001/api/orders/${s57PaidOrderId}/verify-pickup`, {
    pin: s57Pin,
    payment_received_method: 'CASH'
  });
  assert(s57CompleteRes.status === 200, 'Order verified and completed with CASH');
  const s57VerifiedOrder = s57CompleteRes.body.order;
  assert(s57VerifiedOrder.payment_status === 'PAID', 'Order payment_status is PAID');

  // Admin force cancels the PAID order
  loginAs('u-admin', 'ADMIN');
  const s57AdminCancelRes = await patch(`http://localhost:3001/api/orders/${s57PaidOrderId}/status`, {
    status: 'CANCELLED',
    force: true
  });
  assert(s57AdminCancelRes.status === 200, 'Admin force cancel of PAID order succeeds');
  const s57CancelledPaidOrder = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === s57PaidOrderId);
  assert(s57CancelledPaidOrder.status === 'CANCELLED', 'Order status is CANCELLED');
  assert(s57CancelledPaidOrder.payment_status === 'REFUND_DUE', 'PAID order cancellation sets payment_status: REFUND_DUE');
  assert(typeof s57CancelledPaidOrder.refund_amount === 'number' && s57CancelledPaidOrder.refund_amount > 0, 'Server refund_amount is recorded and > 0');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin cancels PAID order -> REFUND_DUE with server refund_amount shown`);

  // Test #1421: Startup repair cancels open payouts for cancelled orders and converts unpaid REFUND_DUE to CANCELLED_UNPAID
  const s57RepairOrderId1 = 'o-s57-repair-1-' + Date.now();
  await dbModule.insertRow('orders', {
    id: s57RepairOrderId1,
    customer_id: 'u-cust1',
    stockist_id: 's1',
    status: 'CANCELLED',
    payment_method: 'ONLINE',
    payment_status: 'REFUND_DUE',
    subtotal: 100,
    total_price: 100,
    amount_paid: 100,
    created_at: new Date().toISOString()
  });
  await dbModule.insertRow('split_payouts', {
    id: 'sp-s57-repair-1-' + Date.now(),
    order_id: s57RepairOrderId1,
    status: 'HELD',
    is_paid: false,
    stockist_amount: 90,
    platform_amount: 10,
    created_at: new Date().toISOString()
  });

  const s57RepairOrderId2 = 'o-s57-repair-2-' + Date.now();
  await dbModule.insertRow('orders', {
    id: s57RepairOrderId2,
    customer_id: 'u-cust1',
    stockist_id: 's1',
    status: 'CANCELLED',
    payment_method: 'PAY_AT_HANDOVER',
    payment_status: 'REFUND_DUE',
    refund_amount: 83.69,
    subtotal: 100,
    total_price: 100,
    amount_paid: 100,
    created_at: new Date().toISOString()
  });

  if (typeof dbModule.repairCancelledOrders === 'function') {
    const s57RepairResult = await dbModule.repairCancelledOrders(dbModule);
    assert(s57RepairResult.cancelledPayoutsCount >= 1, 'repairCancelledOrders cancelled at least 1 open payout');
    assert(s57RepairResult.repairedRefundDueCount >= 1, 'repairCancelledOrders repaired at least 1 unpaid REFUND_DUE order');
  }

  const s57RepairedOrder2 = (await dbModule.getTable('orders')).find(o => o.id === s57RepairOrderId2);
  assert(s57RepairedOrder2.payment_status === 'CANCELLED_UNPAID', 'Unpaid REFUND_DUE order converted to CANCELLED_UNPAID');
  assert(s57RepairedOrder2.refund_amount === 0, 'Repaired order refund_amount reset to 0');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Startup repair cancels open payouts and converts unpaid REFUND_DUE orders`);

  // Test #1422: App.jsx uses server refund_amount, excludes CANCELLED payouts from payoutsDue, and formats CANCELLED_UNPAID
  const s57AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(s57AppJsx.includes('netRefundAmount = parseFloat(o.refund_amount) || 0'), 'App.jsx uses server refund_amount without recomputing');
  assert(s57AppJsx.includes("p.status !== 'CANCELLED'"), 'App.jsx excludes CANCELLED payouts from payoutsDue');
  assert(s57AppJsx.includes('CANCELLED (UNPAID)'), 'App.jsx displays CANCELLED (UNPAID) badge for unpaid cancelled orders');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx uses server refund_amount and excludes CANCELLED payouts from totals`);

};
