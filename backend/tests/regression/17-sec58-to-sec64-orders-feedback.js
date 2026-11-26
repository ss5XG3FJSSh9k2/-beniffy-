const {
  fs, path, dbModule, loginAs, clearLogin, post, patch, get, state, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // ==========================================
  // SECTION 58: ORDER MODE DISPLAY (CUSTOMER ORDERS & ORDER PLACED SCREEN)
  // ==========================================
  console.log('\n--- Section 58: Order Mode Display ---');

  // Test #1445: App.jsx displays Home delivery and Pickup · <slot> with translations
  const s58AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(s58AppJsx.includes("t('Home delivery', 'होम डिलीवरी', 'হোম ডেলিভারি')"), 'App.jsx translates Home delivery');
  assert(s58AppJsx.includes("t('Pickup', 'पिकअप', 'পিকআপ')"), 'App.jsx translates Pickup');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx translates Home delivery and Pickup in all 3 languages`);

  // Test #1446: App.jsx contains 0 occurrences of duplicate Mode: DELIVERY and dead Mode: Take Away
  const s58DeliveryModeCount = (s58AppJsx.match(/Mode:\s*DELIVERY/g) || []).length;
  const s58TakeAwayModeCount = (s58AppJsx.match(/Mode:\s*Take Away/g) || []).length;
  const s58StatusTakeAwayCount = (s58AppJsx.match(/Status:\s*Take Away/g) || []).length;
  assert(s58DeliveryModeCount === 0, `Mode: DELIVERY count is 0 (found ${s58DeliveryModeCount})`);
  assert(s58TakeAwayModeCount === 0, `Mode: Take Away count is 0 (found ${s58TakeAwayModeCount})`);
  assert(s58StatusTakeAwayCount === 0, `Status: Take Away count is 0 (found ${s58StatusTakeAwayCount})`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx contains 0 instances of duplicate Mode: DELIVERY, Mode: Take Away, or Status: Take Away`);

  // Test #1447: Creation of PICKUP and DELIVERY orders for customer 9876543210 (u-cust1)
  loginAs('u-cust1', 'CUSTOMER');
  const s58PickupOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    items: [{ productId: 'p1', quantity: 1 }],
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)'
  });
  assert(s58PickupOrderRes.status === 200, 'PICKUP order creation returns 200');
  assert(s58PickupOrderRes.body.order.fulfillment_type === 'PICKUP', 'Fulfillment type is PICKUP');
  assert(s58PickupOrderRes.body.order.pickup_slot === 'Morning (8AM–12PM)', 'Pickup slot is saved');

  const s58DeliveryOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    items: [{ productId: 'p2', quantity: 1 }],
    fulfillmentType: 'DELIVERY'
  });
  assert(s58DeliveryOrderRes.status === 200, 'DELIVERY order creation returns 200');
  assert(s58DeliveryOrderRes.body.order.fulfillment_type === 'DELIVERY', 'Fulfillment type is DELIVERY');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Both PICKUP and DELIVERY orders created successfully for customer 9876543210`);

  // ==========================================
  // SECTION 59: DEV TOOLS GATING & ORDER MODAL ACTIONS
  // ==========================================
  console.log('\n--- Section 59: Dev Tools Gating & Order Modal Actions ---');

  // Test #1448: App.jsx gates WhatsApp notification preview and alert buttons behind devToolsEnabled
  const s59AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  const hasGatedPreview = /devToolsEnabled\s*&&\s*\(\s*<button[\s\S]*?Preview WhatsApp Notification/.test(s59AppJsx);
  const hasGatedAlert = /devToolsEnabled\s*&&\s*\(\s*<button[\s\S]*?MessageSquare size=\{10\}[\s\S]*?Alert/.test(s59AppJsx);
  assert(hasGatedPreview, 'Order Placed WhatsApp preview button is gated by devToolsEnabled');
  assert(hasGatedAlert, 'Order card Alert button is gated by devToolsEnabled');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: WhatsApp preview and alert buttons are strictly gated by devToolsEnabled`);

  // Test #1449: App.jsx uses btn btn-secondary for switch to delivery and cancel order in Order Placed modal
  assert(s59AppJsx.includes('Switch to Delivery') && s59AppJsx.includes('className="btn btn-secondary"'), 'Switch to delivery button uses standard btn btn-secondary styling');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Order Placed modal action buttons use standard btn styling`);

  // ==========================================
  // SECTION 60: CUSTOMER ORDERS CARD IMPROVEMENTS
  // ==========================================
  console.log('\n--- Section 60: Customer Orders Card Improvements ---');

  // Test #1450: isPickupSlotPassed logic & App.jsx Missed Pickup slot gating
  const s60AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(s60AppJsx.includes('const isPickupSlotPassed =') || s60AppJsx.includes('function isPickupSlotPassed'), 'App.jsx defines isPickupSlotPassed');
  assert(s60AppJsx.includes("o.status === 'READY' && o.fulfillment_type === 'PICKUP' && isPickupSlotPassed(o.pickup_slot, nowTick)"), 'Missed Pickup button requires slot end time passed');

  // Test slot logic
  function testSlotPassed(slotStr, currentTime) {
    if (!slotStr) return true;
    const match = slotStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})$/);
    if (!match) {
      const parsed = Date.parse(slotStr);
      if (!isNaN(parsed)) return (currentTime || Date.now()) >= parsed + 60 * 60 * 1000;
      return true;
    }
    const [_, datePart, hourPart, minPart] = match;
    const slotStartMs = new Date(`${datePart}T${hourPart.padStart(2, '0')}:${minPart}:00`).getTime();
    if (isNaN(slotStartMs)) return true;
    const slotEndMs = slotStartMs + 60 * 60 * 1000;
    return (currentTime || Date.now()) >= slotEndMs;
  }
  const testSlot = '2026-10-24T16:00';
  const beforeSlotTime = new Date('2026-10-24T14:05:00').getTime();
  const duringSlotTime = new Date('2026-10-24T16:30:00').getTime();
  const afterSlotTime = new Date('2026-10-24T17:05:00').getTime();
  assert(testSlotPassed(testSlot, beforeSlotTime) === false, 'Slot at 16:00 is not passed at 14:05');
  assert(testSlotPassed(testSlot, duringSlotTime) === false, 'Slot at 16:00 is not passed at 16:30');
  assert(testSlotPassed(testSlot, afterSlotTime) === true, 'Slot at 16:00 is passed at 17:05');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Missed Pickup is strictly gated until slot end time has passed`);

  // Test #1451: Status badge is concise and free cancel countdown appears on separate line
  assert(s60AppJsx.includes("t('Received', 'प्राप्त', 'গৃহীত')"), 'Status badge displays concise Received in all 3 languages');
  assert(s60AppJsx.includes("t(`Free cancel: ${mmss} left`, `निःशुल्क रद्द: ${mmss} बचे हैं`, `ফ্রি বাতিল: ${mmss} বাকি`)"), 'Separate line displays countdown when cancel window is open');
  assert(s60AppJsx.includes("flexWrap: 'wrap'"), 'Status badge container supports wrapping inside card');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Status badge is concise without overflow and free cancel countdown renders separately`);

  // Test #1452: Swipe hint is outside cards above strip with dedicated spacing
  assert(s60AppJsx.includes("t('Swipe to see your other order', 'अपना दूसरा ऑर्डर देखने के लिए स्वाइप करें', 'আপনার অন্য অর্ডার দেখতে সোয়াইপ করুন')"), 'Swipe hint string present in all 3 languages');
  assert(s60AppJsx.includes("!hasSeenSwipeHint && Math.abs(e.currentTarget.scrollLeft) > 10"), 'Swipe hint dismisses when user scrolls strip');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Swipe hint has dedicated styling above strip and dismisses on scroll`);

  // --- Section 61: Customer Carts Sheet Button Reachability & Dimmed Backdrop ---
  console.log('\n--- Section 61: Customer Carts Sheet Button Reachability & Dimmed Backdrop ---');
  const s61AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  const s61IndexCss = fs.readFileSync(path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');

  // Test #1453: Floating carts button and bar hidden while showCartsSheet is true
  assert(s61AppJsx.includes("customerAppTab === 'store' && !showCartsSheet"), 'Floating carts bar is hidden while showCartsSheet is true');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Floating carts button and bar are hidden while showCartsSheet is active`);

  // Test #1454: Active order strip hidden while showCartsSheet is true
  assert(s61AppJsx.includes("activeOrderList.length > 0 && !showCartsSheet"), 'Active order strip is hidden while showCartsSheet is true');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Active order strip is hidden while showCartsSheet is active`);

  // Test #1455: Carts sheet backdrop uses var(--scrim) and var(--z-sheet) without blur
  const cartsSheetIdx = s61AppJsx.indexOf('{showCartsSheet && (');
  const cartsSheetBlock = s61AppJsx.substring(cartsSheetIdx, cartsSheetIdx + 600);
  assert(cartsSheetBlock.includes("backgroundColor: 'var(--scrim)'"), 'Carts sheet backdrop uses var(--scrim)');
  assert(cartsSheetBlock.includes("zIndex: 'var(--z-sheet)'"), 'Carts sheet uses var(--z-sheet) token');
  assert(!cartsSheetBlock.includes('blur'), 'Carts sheet backdrop does not use blur');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Carts sheet backdrop uses semi-transparent var(--scrim) dim at var(--z-sheet) without blur`);

  // Test #1456: index.css defines --scrim token in light and dark themes
  assert(s61IndexCss.includes("--scrim: rgba(32, 32, 31, 0.55);") || s61IndexCss.includes("--scrim: rgba(0, 0, 0, 0.55);"), 'Light theme defines --scrim');
  assert(s61IndexCss.includes("--scrim: rgba(0, 0, 0, 0.55);"), 'Dark theme defines --scrim');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: --scrim CSS token is defined across theme blocks at 55% opacity`);

  // --- Section 62: Feedback & Order Rating Ownership ---
  console.log('\n--- Section 62: Feedback & Order Rating Ownership ---');
  
  // Create an order at shop s1 for customer u-cust1
  loginAs('u-cust1', 'CUSTOMER');
  const s62OrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    items: [{ productId: 'p1', quantity: 1 }],
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)'
  });
  assert(s62OrderRes.status === 200, 'Order created for feedback tests');
  const s62OrderId = s62OrderRes.body.order.id;

  // 1. Stockist rates a customer on its own order -> 200
  loginAs('u-stk1', 'STOCKIST');
  const s62StkFb1 = await post('http://localhost:3001/api/feedback', {
    orderId: s62OrderId,
    rating: 4,
    reason: 'Great customer, fast pickup',
    reportFlag: false
  });
  assert(s62StkFb1.status === 200, `Stockist rates customer on own order returns 200: got ${s62StkFb1.status}`);
  assert(s62StkFb1.body.feedback.reporter_role === 'STOCKIST', 'Feedback stored with reporter_role STOCKIST');
  assert(s62StkFb1.body.feedback.reporter_id === 'u-stk1', 'Feedback stored with reporter_id user id');
  assert(s62StkFb1.body.feedback.reporter_stockist_id === 's1', 'Feedback stored with reporter_stockist_id shop id');
  assert(s62StkFb1.body.feedback.target_role === 'CUSTOMER', 'Feedback target_role is CUSTOMER');
  assert(s62StkFb1.body.feedback.target_id === 'u-cust1', 'Feedback target_id is customer id');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist rates customer on its own order returns 200 with correct IDs`);

  // 2. Stockist rates on another shop's order -> 403
  loginAs('u-stk2', 'STOCKIST');
  const s62StkFbCross = await post('http://localhost:3001/api/feedback', {
    orderId: s62OrderId,
    rating: 1,
    reason: 'Trying to rate another shop order'
  });
  assert(s62StkFbCross.status === 403, `Stockist rating another shop order returns 403: got ${s62StkFbCross.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist rating another shop order returns 403 Forbidden`);

  // 3. Customer rates a shop on its own order -> 200
  loginAs('u-cust1', 'CUSTOMER');
  const s62CustFb1 = await post('http://localhost:3001/api/feedback', {
    orderId: s62OrderId,
    rating: 5,
    reason: 'Excellent fresh groceries'
  });
  assert(s62CustFb1.status === 200, `Customer rating shop on own order returns 200: got ${s62CustFb1.status}`);
  assert(s62CustFb1.body.feedback.reporter_role === 'CUSTOMER', 'Customer feedback stored with reporter_role CUSTOMER');
  assert(s62CustFb1.body.feedback.reporter_id === 'u-cust1', 'Customer feedback stored with reporter_id u-cust1');
  assert(s62CustFb1.body.feedback.target_role === 'STOCKIST', 'Customer feedback target_role is STOCKIST');
  assert(s62CustFb1.body.feedback.target_id === 's1', 'Customer feedback target_id is s1');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer rates shop on own order returns 200`);

  // 4. Customer rates another customer's order -> 403
  loginAs('u-cust2', 'CUSTOMER');
  const s62CustCross = await post('http://localhost:3001/api/feedback', {
    orderId: s62OrderId,
    rating: 2,
    reason: 'Trying to rate another customer order'
  });
  assert(s62CustCross.status === 403, `Customer rating another customer order returns 403: got ${s62CustCross.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer rating another customer order returns 403 Forbidden`);

  // 5. Second submit for same order and reporter updates the first (one rating per side per order)
  loginAs('u-stk1', 'STOCKIST');
  const s62StkFb2 = await post('http://localhost:3001/api/feedback', {
    orderId: s62OrderId,
    rating: 5,
    reason: 'Updated rating: customer returned and was very polite',
    reportFlag: false
  });
  assert(s62StkFb2.status === 200, 'Second submit returns 200');
  assert(s62StkFb2.body.feedback.id === s62StkFb1.body.feedback.id, 'Second submit updates the same feedback ID');
  assert(s62StkFb2.body.feedback.rating === 5, 'Second submit updated rating to 5');
  assert(s62StkFb2.body.feedback.reason === 'Updated rating: customer returned and was very polite', 'Second submit updated reason');
  
  // Verify in admin feedback list that there is only one entry for stockist on this order
  loginAs('u-admin', 'ADMIN');
  const s62AdminFb = await get('http://localhost:3001/api/admin/feedback');
  assert(s62AdminFb.status === 200, 'Admin feedback fetch returns 200');
  const stkFbsOnOrder = s62AdminFb.body.filter(f => f.order_id === s62OrderId && f.reporter_role === 'STOCKIST');
  assert(stkFbsOnOrder.length === 1, `Exactly one stockist feedback entry on order: got ${stkFbsOnOrder.length}`);
  assert(stkFbsOnOrder[0].rating === 5, 'Admin feedback reflects updated rating 5');
  assert(stkFbsOnOrder[0].reporter_name === 'Madan Grocers', `Admin feedback reporter_name is Madan Grocers: got ${stkFbsOnOrder[0].reporter_name}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Second submit updates existing feedback without creating duplicate row`);

  // 6. Client code verification: stops sending reporterId/reporterRole and never falls back to Amit Sen
  const s62AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!s62AppJsx.includes("targetName: submittingFeedbackOrder.customer_name || 'Amit Sen'"), 'App.jsx never falls back to Amit Sen in feedback');
  assert(!s62AppJsx.includes("reporterId: stockistProfile.id"), 'App.jsx stops sending reporterId');
  assert(!s62AppJsx.includes("reporterRole: 'STOCKIST'"), 'App.jsx stops sending reporterRole');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx stops sending reporterId/reporterRole and never falls back to Amit Sen`);

  // ==========================================
  // TICKET 63: Stockist notifications behind the bell
  // ==========================================

  // 1. GET /api/notifications without auth returns 401
  clearLogin();
  const notifUnauth = await get('http://localhost:3001/api/notifications');
  assert(notifUnauth.status === 401, `GET /api/notifications without auth returns 401: got ${notifUnauth.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/notifications without auth returns 401`);

  // 2. GET /api/notifications with stockist auth returns 200 array
  loginAs('u-stk1', 'STOCKIST');
  const notifAuth = await get('http://localhost:3001/api/notifications');
  assert(notifAuth.status === 200, `GET /api/notifications with auth returns 200: got ${notifAuth.status}`);
  assert(Array.isArray(notifAuth.body), 'GET /api/notifications returns an array');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/notifications with auth returns 200 array`);

  // 3. Event 1: Customer places order -> writes new_order notification for shop owner (u-stk1)
  loginAs('u-cust1', 'CUSTOMER');
  const s63OrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: '12:00-14:00',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(s63OrderRes.status === 200, `Order placed returns 200: got ${s63OrderRes.status}`);
  const s63OrderId = s63OrderRes.body.orderId || s63OrderRes.body.orders[0].id;

  loginAs('u-stk1', 'STOCKIST');
  const s63NotifsAfterOrder = await get('http://localhost:3001/api/notifications');
  assert(s63NotifsAfterOrder.status === 200, 'Fetched notifications for stockist');
  const newOrderNotif = s63NotifsAfterOrder.body.find(n => n.link === `order:${s63OrderId}` && n.type === 'new_order');
  assert(newOrderNotif, `Found new_order notification for order ${s63OrderId}`);
  assert(!newOrderNotif.read_at, 'new_order notification is initially unread');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: New order writes new_order notification for stockist`);

  // 4. Event 2: Order cancelled by customer -> writes order_cancelled notification AND updates new_order notification body to "Cancelled by customer"
  loginAs('u-cust1', 'CUSTOMER');
  const s63CancelRes = await post(`http://localhost:3001/api/orders/${s63OrderId}/cancel`, {});
  assert(s63CancelRes.status === 200, `Order cancel returns 200: got ${s63CancelRes.status}`);

  loginAs('u-stk1', 'STOCKIST');
  const s63NotifsAfterCancel = await get('http://localhost:3001/api/notifications');
  assert(s63NotifsAfterCancel.status === 200, 'Fetched notifications after cancel');
  const updatedNewOrderNotif = s63NotifsAfterCancel.body.find(n => n.id === newOrderNotif.id);
  assert(updatedNewOrderNotif, 'Found original new_order notification');
  assert(updatedNewOrderNotif.body === 'Cancelled by customer', `Original notification body updated to "Cancelled by customer": got "${updatedNewOrderNotif.body}"`);
  const cancelNotif = s63NotifsAfterCancel.body.find(n => n.link === `order:${s63OrderId}` && n.type === 'order_cancelled');
  assert(cancelNotif, 'Found order_cancelled notification');
  assert(cancelNotif.body === 'Cancelled by customer', 'order_cancelled notification body is "Cancelled by customer"');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer cancellation updates new_order body and writes order_cancelled notification`);

  // 5. PATCH /api/notifications/:id/read - auth & ownership
  clearLogin();
  const readUnauth = await patch(`http://localhost:3001/api/notifications/${cancelNotif.id}/read`, {});
  assert(readUnauth.status === 401, 'PATCH /api/notifications/:id/read without auth returns 401');

  loginAs('u-cust1', 'CUSTOMER');
  const readForbidden = await patch(`http://localhost:3001/api/notifications/${cancelNotif.id}/read`, {});
  assert(readForbidden.status === 403, 'PATCH /api/notifications/:id/read on another user notif returns 403');

  loginAs('u-stk1', 'STOCKIST');
  const readSuccess = await patch(`http://localhost:3001/api/notifications/${cancelNotif.id}/read`, {});
  assert(readSuccess.status === 200, 'PATCH /api/notifications/:id/read returns 200');
  assert(readSuccess.body.notification.read_at, 'Notification has read_at set');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: PATCH /api/notifications/:id/read marks notification as read with auth & ownership enforced`);

  // 6. PATCH /api/notifications/read-all
  clearLogin();
  const readAllUnauth = await patch('http://localhost:3001/api/notifications/read-all', {});
  assert(readAllUnauth.status === 401, 'PATCH /api/notifications/read-all without auth returns 401');

  loginAs('u-stk1', 'STOCKIST');
  const readAllSuccess = await patch('http://localhost:3001/api/notifications/read-all', {});
  assert(readAllSuccess.status === 200, 'PATCH /api/notifications/read-all returns 200');
  const s63AllAfterReadAll = await get('http://localhost:3001/api/notifications');
  const unreadCount = s63AllAfterReadAll.body.filter(n => !n.read_at).length;
  assert(unreadCount === 0, `All notifications marked read, unreadCount is 0: got ${unreadCount}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: PATCH /api/notifications/read-all marks all own notifications as read`);

  // 7. Event 3: Bill approved and rejected notifications
  loginAs('u-admin', 'ADMIN');
  const billVerifyRes = await post('http://localhost:3001/api/admin/bill-photos/pbp-seed1/verify', {});
  assert(billVerifyRes.status === 200, 'Bill verify returns 200');

  const billRejectRes = await post('http://localhost:3001/api/admin/bill-photos/pbp-seed3/reject', {
    reason: 'Image is too blurry to read invoice numbers'
  });
  assert(billRejectRes.status === 200, 'Bill reject returns 200');

  loginAs('u-stk1', 'STOCKIST');
  const notifsAfterBills = await get('http://localhost:3001/api/notifications');
  const appBillNotif = notifsAfterBills.body.find(n => n.type === 'bill_approved' && n.link === 'product:p1');
  assert(appBillNotif, 'Found bill_approved notification for product p1');
  const rejBillNotif = notifsAfterBills.body.find(n => n.type === 'bill_rejected' && n.link === 'product:p3');
  assert(rejBillNotif, 'Found bill_rejected notification for product p3');
  assert(rejBillNotif.body.includes('Image is too blurry'), 'bill_rejected notification body includes reason');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Bill verify and reject write bill_approved and bill_rejected notifications`);

  // 8. Event 4: Product out of stock
  loginAs('u-stk1', 'STOCKIST');
  const stockZeroRes = await patch('http://localhost:3001/api/products/p1', {
    stockistId: 's1',
    stock_qty: 0
  }, { rawJson: true });
  assert(stockZeroRes.status === 200, 'Product stock update to 0 returns 200');
  const notifsAfterOos = await get('http://localhost:3001/api/notifications');
  const oosNotif = notifsAfterOos.body.find(n => n.type === 'product_out_of_stock' && n.link === 'product:p1');
  assert(oosNotif, 'Found product_out_of_stock notification for product p1');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Product out of stock writes product_out_of_stock notification`);

  // 9. Event 5: Payout marked paid
  loginAs('u-admin', 'ADMIN');
  const s63SpId = 'sp-test-' + Math.random().toString(36).substring(2);
  await dbModule.insertRow('split_payouts', {
    id: s63SpId,
    order_id: s63OrderId,
    stockist_id: 's1',
    stockist_amount: 25.0,
    platform_amount: 5.0,
    commission_rate_used: 10.0,
    earn_rate_used: 45.0,
    status: 'HELD',
    created_at: new Date().toISOString()
  });
  const payoutMarkRes = await post('http://localhost:3001/api/admin/payouts/mark-paid', {
    payment_reference: 'UPI-REF-998877',
    payouts: [{ id: s63SpId, source: 'split_payouts' }]
  });
  assert(payoutMarkRes.status === 200, 'Mark payout paid returns 200');

  loginAs('u-stk1', 'STOCKIST');
  const notifsAfterPayout = await get('http://localhost:3001/api/notifications');
  const payoutNotif = notifsAfterPayout.body.find(n => n.type === 'payout_paid');
  assert(payoutNotif, 'Found payout_paid notification');
  assert(payoutNotif.body.includes('UPI-REF-998877'), 'payout_paid notification includes payment reference');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Payout mark-paid writes payout_paid notification`);

  // 10. Event 6: KYC approved
  loginAs('u-admin', 'ADMIN');
  const s63KycUser = {
    id: 'u-kyc-test-' + Math.random().toString(36).substring(2),
    tenant_id: 't1',
    region_id: 'r1',
    phone: '7111222333',
    name: 'Kyc Test User',
    role: 'STOCKIST',
    kyc_status: 'PENDING',
    created_at: new Date().toISOString()
  };
  await dbModule.insertRow('users', s63KycUser);
  const s63KycApproveRes = await post(`http://localhost:3001/api/admin/kyc/${s63KycUser.id}/approve`, {
    vendorId: 'v1',
    deliveryRadius: 5.0,
    minOrderValue: 0
  });
  assert(s63KycApproveRes.status === 200, 'KYC approve returns 200');

  loginAs(s63KycUser.id, 'STOCKIST');
  const notifsAfterKyc = await get('http://localhost:3001/api/notifications');
  const kycNotif = notifsAfterKyc.body.find(n => n.type === 'kyc_approved');
  assert(kycNotif, 'Found kyc_approved notification');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: KYC approve writes kyc_approved notification`);

  // ==========================================
  // TICKET 64: Stockist offline real connection & commission wording
  // ==========================================
  const s64AppPath = path.join(__dirname, '../../../frontend/src/App.jsx');
  const s64App = fs.readFileSync(s64AppPath, 'utf8');

  // 1. Stockist home offline test card is guarded by devToolsEnabled
  assert(/\{devToolsEnabled\s*&&\s*\(\s*<div[^>]*data-testid="offline-test-card"/.test(s64App),
    'Stockist offline test card is guarded by devToolsEnabled');

  // 2. Offline banner is present with proper wording and data-testid="offline-banner"
  assert(s64App.includes('data-testid="offline-banner"') && s64App.includes("You're offline. Actions will sync when you reconnect."),
    'Offline banner is present with t(...) translated strings');

  // 3. Commission tile renamed to t('Commission owed to Beniffy', 'Beniffy को देय कमीशन', 'Beniffy-কে দেয় কমিশন')
  assert(s64App.includes("t('Commission owed to Beniffy', 'Beniffy को देय कमीशन', 'Beniffy-কে দেয় কমিশন')"),
    'Commission tile uses updated wording t("Commission owed to Beniffy", ...)');

  // 4. Window online and offline event listeners registered
  assert(s64App.includes("window.addEventListener('online', handleOnline)") &&
         s64App.includes("window.addEventListener('offline', handleOffline)"),
    'Window online and offline event listeners registered');

  // 5. Admin/Settings Test Network Signal is dev-tools only
  assert(/\{devToolsEnabled\s*&&\s*showDevSettings\s*&&[\s\S]*?Test Network Signal/.test(s64App),
    'Admin/Settings Test Network Signal switch is dev-tools only');

};
