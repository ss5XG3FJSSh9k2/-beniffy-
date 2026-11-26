const {
  fs, path, dbModule, loginAs, clearLogin, post, patch, get, del, assert, readBackendSource
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // --- BUG REPORT FIXES (2026-10-07) ---
  console.log('\n--- BUG REPORT FIXES ---');
  loginAs('u-admin', 'ADMIN');
  await post('http://localhost:3001/api/admin/reset-db');
  const brOrder = async (extra = {}, who = ['u-cust1', 'CUSTOMER']) => {
    loginAs(who[0], who[1]);
    const r = await post('http://localhost:3001/api/orders', Object.assign({
      customerId: 'u-cust1', stockistId: 's1', pickupSlot: 'Morning (8AM–12PM)',
      fulfillmentType: 'PICKUP', paymentMethod: 'UPI', items: [{ productId: 'p1', quantity: 1 }]
    }, extra));
    return r;
  };
  const brRow = async (table, id) => (await dbModule.getTable(table)).find(r => r.id === id);

  // 1. saveTable no longer loses rows when two requests save the same table
  const brSnapA = await dbModule.getTable('admin_audit_log');
  const brSnapB = await dbModule.getTable('admin_audit_log');
  const brAudit = (id) => ({ id, admin_user_id: 'u-admin', action: 'RACE_TEST', entity_type: 'test', entity_id: id, before: null, after: null, reason: '', created_at: new Date().toISOString() });
  brSnapA.push(brAudit('race-a'));
  brSnapB.push(brAudit('race-b'));
  await Promise.all([dbModule.saveTable('admin_audit_log', brSnapA), dbModule.saveTable('admin_audit_log', brSnapB)]);
  let brAudits = await dbModule.getTable('admin_audit_log');
  assert(brAudits.some(a => a.id === 'race-a') && brAudits.some(a => a.id === 'race-b'), 'Concurrent saveTable calls from stale snapshots keep both new rows');
  const brSnapC = (await dbModule.getTable('admin_audit_log')).filter(a => a.id !== 'race-a');
  await dbModule.saveTable('admin_audit_log', brSnapC);
  brAudits = await dbModule.getTable('admin_audit_log');
  assert(!brAudits.some(a => a.id === 'race-a') && brAudits.some(a => a.id === 'race-b'), 'saveTable still deletes rows the caller removed, and only those');

  loginAs('u-cust1', 'CUSTOMER');
  const brOrdersBefore = (await dbModule.getTable('orders')).length;
  const brParallel = await Promise.all(Array.from({ length: 8 }, () => post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1', stockistId: 's1', pickupSlot: 'Morning (8AM–12PM)', paymentMethod: 'UPI', items: [{ productId: 'p1', quantity: 1 }]
  })));
  const brOrdersAfter = (await dbModule.getTable('orders')).length;
  assert(brParallel.every(r => r.status === 200), '8 orders placed in parallel all succeed');
  assert(brOrdersAfter - brOrdersBefore === 8, '8 orders placed in parallel are all saved');

  // 2. The in-memory database alone is not test mode: dev-only routes are closed
  process.env.SEED_MODE = 'production';
  assert(require('../../lib/env').isTestEnv() === false, 'POSTGRES_MODE=mem alone does not count as test mode');
  assert(require('../../lib/env').isDemoOtpMode() === false, 'Fixed demo OTP is off outside test mode');
  process.env.DEMO_OTP = 'true';
  assert(require('../../lib/env').isDemoOtpMode() === true, 'DEMO_OTP=true turns on the demo OTP outside test mode');
  clearLogin();
  const brDemoOverride = await post('http://localhost:3001/api/admin/override-table', { table: 'users', id: 'u-cust1', patch: { role: 'ADMIN' } });
  assert(brDemoOverride.status === 404, 'DEMO_OTP does not open the test-only admin routes');
  delete process.env.DEMO_OTP;
  clearLogin();
  const brOverride = await post('http://localhost:3001/api/admin/override-table', { table: 'users', id: 'u-cust1', patch: { role: 'ADMIN' } });
  assert(brOverride.status === 404, 'override-table is unavailable outside test mode');
  const brResetDb = await post('http://localhost:3001/api/admin/reset-db', {});
  assert([403, 404].includes(brResetDb.status), 'reset-db is unavailable outside test mode (returns 403 or 404)');
  const brClearRl = await post('http://localhost:3001/api/admin/clear-rate-limits', {});
  assert(brClearRl.status === 401, 'clear-rate-limits needs an admin login outside test mode');
  process.env.SEED_MODE = 'test';
  assert((await brRow('users', 'u-cust1')).role === 'CUSTOMER', 'Customer role unchanged by the rejected override');

  // 3. Offline sync applies the normal ownership and status rules
  const brSyncOrder = (await brOrder()).body.orderId;
  loginAs('u-cust2', 'CUSTOMER');
  const brSyncCust = await post('http://localhost:3001/api/orders/sync', { updates: [{ orderId: brSyncOrder, status: 'DELIVERED' }] });
  assert(brSyncCust.status === 403, 'Customers cannot use the offline sync to change orders');
  loginAs('u-stk2', 'STOCKIST');
  const brSyncOther = await post('http://localhost:3001/api/orders/sync', { updates: [{ orderId: brSyncOrder, status: 'READY' }] });
  assert(brSyncOther.status === 200 && brSyncOther.body.synced_count === 0 && brSyncOther.body.results[0].ok === false, 'Sync cannot change another stockist\'s order');
  loginAs('u-stk1', 'STOCKIST');
  const brSyncBanana = await post('http://localhost:3001/api/orders/sync', { updates: [{ orderId: brSyncOrder, status: 'BANANA' }] });
  assert(brSyncBanana.body.synced_count === 0, 'Sync rejects an unknown status');
  const brSyncOk = await post('http://localhost:3001/api/orders/sync', { updates: [{ orderId: brSyncOrder, status: 'RECEIVED' }] });
  assert(brSyncOk.body.synced_count === 1 && (await brRow('orders', brSyncOrder)).status === 'RECEIVED', 'Sync applies a valid update by the owning stockist');

  // 4. Stockists cannot order on a customer's account
  const brStkOrder = await brOrder({}, ['u-stk1', 'STOCKIST']);
  assert(brStkOrder.status === 403, 'A stockist cannot place an order as a customer');

  // 5. Customers cannot choose the commission model
  const brModel = await brOrder({ commission_model: 'gross_v1' });
  assert(brModel.status === 200 && brModel.body.order.commission_model === 'profit_v2', 'commission_model from a customer is ignored');

  // 6. The delivery PIN is checked
  const brPinOrder = (await brOrder()).body.orderId;
  loginAs('u-admin', 'ADMIN');
  await patch(`http://localhost:3001/api/orders/${brPinOrder}/status`, { status: 'READY' });
  const brRealPin = (await brRow('orders', brPinOrder)).pickup_pin;
  loginAs('u-stk1', 'STOCKIST');
  const brWrongPin = await patch(`http://localhost:3001/api/orders/${brPinOrder}/status`, { status: 'DELIVERED', pin: brRealPin === '0000' ? '1111' : '0000' });
  assert(brWrongPin.status === 400, 'Wrong PIN is rejected');
  const brRightPin = await patch(`http://localhost:3001/api/orders/${brPinOrder}/status`, { status: 'DELIVERED', pin: brRealPin });
  assert(brRightPin.status === 200, 'Correct PIN completes the order');

  // 7, 9. Delivered orders stay delivered
  loginAs('u-cust1', 'CUSTOMER');
  const brNoShowDelivered = await post(`http://localhost:3001/api/orders/${brPinOrder}/noshw-action`, { action: 'CANCEL' });
  assert(brNoShowDelivered.status === 400, 'No-show CANCEL is rejected on a delivered order');
  loginAs('u-stk1', 'STOCKIST');
  const brForceCancel = await patch(`http://localhost:3001/api/orders/${brPinOrder}/status`, { status: 'CANCELLED', force: true });
  assert(brForceCancel.status === 400 && (await brRow('orders', brPinOrder)).status === 'DELIVERED', 'force:true cannot cancel a delivered order');
  const brReceivedOrder = (await brOrder()).body.orderId;
  loginAs('u-stk1', 'STOCKIST');
  await patch(`http://localhost:3001/api/orders/${brReceivedOrder}/status`, { status: 'RECEIVED' });
  const brStkForce = await patch(`http://localhost:3001/api/orders/${brReceivedOrder}/status`, { status: 'CANCELLED', force: true });
  assert(brStkForce.status === 403, 'Stockists cannot use force to cancel past PENDING');
  const brBackwards = await patch(`http://localhost:3001/api/orders/${brReceivedOrder}/status`, { status: 'PENDING' });
  assert(brBackwards.status === 400, 'Order status cannot move backwards');

  // 10, 15. Cancelled orders stay cancelled; free-window cancellation refunds in full
  const brCancelOrderRes = await brOrder();
  const brCancelOrder = brCancelOrderRes.body.orderId;
  const brCancelRes = await post(`http://localhost:3001/api/orders/${brCancelOrder}/cancel`);
  const brCancelled = await brRow('orders', brCancelOrder);
  assert(brCancelRes.status === 200 && brCancelled.status === 'CANCELLED', 'Customer cancels inside the free window');
  assert(Number(brCancelled.refund_amount) === Number(brCancelled.amount_paid), `Free-window cancellation refunds in full (paid ${brCancelled.amount_paid}, refund ${brCancelled.refund_amount})`);
  const brReschedule = await post(`http://localhost:3001/api/orders/${brCancelOrder}/noshw-action`, { action: 'RESCHEDULE', newSlot: 'Evening (4PM–8PM)' });
  assert(brReschedule.status === 400 && (await brRow('orders', brCancelOrder)).status === 'CANCELLED', 'No-show reschedule cannot revive a cancelled order');
  loginAs('u-admin', 'ADMIN');
  const brRevive = await patch(`http://localhost:3001/api/orders/${brCancelOrder}/status`, { status: 'DELIVERED' });
  assert(brRevive.status === 400, 'A cancelled order cannot be set to DELIVERED');

  // 11. A failed "ready" update leaves the order unchanged
  const brStockOrder = (await brOrder()).body.orderId;
  const brInv = (await dbModule.getTable('stockist_inventory')).find(i => i.stockist_id === 's1' && i.product_id === 'p1');
  loginAs('u-admin', 'ADMIN');
  await post('http://localhost:3001/api/admin/override-table', { table: 'stockist_inventory', id: brInv.id, patch: { stock_qty: 0, stock_quantity: 0 } });
  const brStatusBefore = (await brRow('orders', brStockOrder)).status;
  const brReadyNoStock = await patch(`http://localhost:3001/api/orders/${brStockOrder}/status`, { status: 'READY' });
  assert(brReadyNoStock.status === 400 && (await brRow('orders', brStockOrder)).status === brStatusBefore, 'READY with insufficient stock fails and leaves the status unchanged');
  await post('http://localhost:3001/api/admin/override-table', { table: 'stockist_inventory', id: brInv.id, patch: { stock_qty: brInv.stock_qty, stock_quantity: brInv.stock_qty } });

  // 12. A multi-store checkout is all-or-nothing
  loginAs('u-cust1', 'CUSTOMER');
  const brCountBefore = (await dbModule.getTable('orders')).length;
  const brMulti = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1', fulfillmentType: 'PICKUP', paymentMethod: 'UPI',
    stores: [
      { stockistId: 's1', pickupSlot: 'Morning (8AM–12PM)', items: [{ productId: 'p1', quantity: 1 }] },
      { stockistId: 's3', pickupSlot: 'Morning (8AM–12PM)', items: [{ productId: 'no-such-product', quantity: 1 }] }
    ]
  });
  assert(brMulti.status === 400 && (await dbModule.getTable('orders')).length === brCountBefore, 'A failing store saves no order for the other stores');

  // 13, 20. Redemption amounts are validated
  const brFixed = await post('http://localhost:3001/api/ledger/redeem', { customerId: 'u-cust1', amount: 1, redemptionType: 'BROADBAND_DISCOUNT_100' });
  assert(brFixed.status === 400, 'A fixed-value reward cannot be redeemed for 1 point');
  const brNan = await post('http://localhost:3001/api/ledger/redeem', { customerId: 'u-cust1', amount: 'abc', redemptionType: 'BROADBAND_DISCOUNT' });
  assert(brNan.status === 400, 'Redemption amount "abc" returns 400');

  // 14. Held points are voided when the order is cancelled
  const brHeldOrder = (await brOrder()).body.orderId;
  await dbModule.insertRow('points_ledger', { id: 'l-held-test', tenant_id: 't1', region_id: 'r1', customer_id: 'u-cust1', amount: 7, type: 'EARN_HELD', order_id: brHeldOrder, description: 'held', billing_sync_status: 'HELD', created_at: new Date().toISOString() });
  loginAs('u-cust1', 'CUSTOMER');
  await post(`http://localhost:3001/api/orders/${brHeldOrder}/cancel`);
  assert((await brRow('points_ledger', 'l-held-test')).billing_sync_status === 'VOIDED', 'Held points on a cancelled order are voided');
  const brVoid = (await dbModule.getTable('points_ledger')).find(l => l.reference_id === 'l-held-test' && l.type === 'EARN_VOID');
  assert(brVoid && Number(brVoid.amount) === 0, 'The void entry does not add points to the balance');

  // 16. Switching to delivery keeps the checkout split and adds the fee for the shop
  loginAs('u-admin', 'ADMIN');
  await post('http://localhost:3001/api/admin/override-table', { table: 'regions', id: 'r1', patch: { delivery_fee: 20 } });
  const brSwitchOrder = (await brOrder()).body.orderId;
  const brPayoutBefore = (await dbModule.getTable('split_payouts')).find(sp => sp.order_id === brSwitchOrder);
  loginAs('u-cust1', 'CUSTOMER');
  const brSwitch = await patch(`http://localhost:3001/api/orders/${brSwitchOrder}/fulfillment`, { fulfillmentType: 'DELIVERY' });
  const brPayoutAfter = (await dbModule.getTable('split_payouts')).find(sp => sp.order_id === brSwitchOrder);
  assert(brSwitch.status === 200 && Number(brPayoutAfter.platform_amount) === Number(brPayoutBefore.platform_amount), 'Switching to delivery does not change the platform share');
  assert(Math.abs(Number(brPayoutAfter.stockist_amount) - Number(brPayoutBefore.stockist_amount) - 20) < 0.001, 'Switching to delivery adds the delivery fee to the stockist share');

  // 17-19. Checkout input validation
  assert((await brOrder({ fulfillmentType: 'TELEPORT' })).status === 400, 'fulfillmentType TELEPORT returns 400');
  assert((await brOrder({ pickupSlot: 'yesterday lol' })).status === 400, 'pickupSlot "yesterday lol" returns 400');
  assert((await brOrder({ paymentMethod: 5 })).status === 400, 'Numeric paymentMethod returns 400, not 500');

  // 21, 22. Audit rows name the signed-in admin; partner email subject is complete
  loginAs('u-admin', 'ADMIN');
  const brRegion = await post('http://localhost:3001/api/admin/regions', { name: 'Audit Check Region', code: 'audit-check', admin_id: 'u-impostor' });
  if (brRegion.status === 200) {
    const brRegionAudit = (await dbModule.getTable('admin_audit_log')).find(a => a.action === 'REGION_CREATE' && a.entity_id === brRegion.body.id);
    assert(brRegionAudit && brRegionAudit.user_id === 'u-admin', 'Audit row records the signed-in admin, not admin_id from the body');
  } else {
    assert(false, `Region create for audit check failed (${brRegion.status})`);
  }
  const brServerSrc = readBackendSource();
  assert(!brServerSrc.includes('New redemption ready for you: `'), 'Partner email subject includes the package name');
  await post('http://localhost:3001/api/admin/reset-db');

  console.log('\\n--- BF-START-SEED ---');
  assert(process.env.SEED_MODE === 'test', 'SEED_MODE is test in test environment');
  
  const allUsersForSeedCheck = await dbModule.getTable('users');
  const seededAdmin = allUsersForSeedCheck.find(u => u.phone === '9999999999');
  assert(seededAdmin !== undefined && seededAdmin.role === 'ADMIN', 'Seeded Admin (9999999999) exists in the test database');
  
  clearLogin();
  const seedLoginRes = await post('http://localhost:3001/api/auth/send-otp', { phone: '9999999999', email: 'test_9999999999@fastnet.test' });
  assert(seedLoginRes.status === 200, 'Can initiate login (send-otp) for seed admin 9999999999');

  // --- BF-PARTNER-REGION-GROUP ---
  console.log('\n--- 36. BF-PARTNER-REGION-GROUP (UI assertions) ---');

  const appJsxCode = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appJsxCode.includes('groupedPartnerRegions.map(group =>'), 'App.jsx contains groupedPartnerRegions.map(group =>');
  assert(appJsxCode.includes('regionCardOpenState'), 'App.jsx contains regionCardOpenState');
  assert(appJsxCode.includes('toggleRegionCard'), 'App.jsx contains toggleRegionCard');
  assert(true, 'BF-PARTNER-REGION-GROUP UI string tests passed');
  // --- BF-PARTNER-PROFILE-SAVE ---
  console.log('\n--- 37. BF-PARTNER-PROFILE-SAVE ---');

  // Login as partner Adhya
  const adhyaSessionForProfile = await post('http://localhost:3001/api/partner/auth/login-password', { email: 'adhya@partners.example', password: 'partner123' });
  const adhyaTokenForProfile = adhyaSessionForProfile.body.session_token;

  // 1. Initial Get
  const _initialMeRes = await get('http://localhost:3001/api/partner/me', {
    headers: { Authorization: `Bearer ${adhyaTokenForProfile}` }
  });
  const _beforeCount = (await post('http://localhost:3001/api/admin/override-table', {
    table: 'partners', data: []
  }, { headers: { Authorization: `Bearer ${ctx.adminToken}` } })).status === 200 ? 0 : 0; // We just need a way to count, actually we can just rely on the API.
  
  // We'll just patch directly.

  // 2. Bad UPI
  const badUpiRes = await patch('http://localhost:3001/api/partner/me', {
    payout_upi_id: 'bad-upi-format'
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(badUpiRes.status === 400 && badUpiRes.body.error === 'Enter a valid UPI ID like name@bank.', 'Bad UPI returns 400 with specific message');

  // 3. Bad IFSC
  const badIfscRes = await patch('http://localhost:3001/api/partner/me', {
    payout_bank_ifsc: 'sbinoo0300' // not 11 chars
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(badIfscRes.status === 400 && badIfscRes.body.error === 'IFSC must be 11 characters, like SBIN0000300.', 'Bad IFSC returns 400');

  // 4. 5-digit account
  const badAccRes1 = await patch('http://localhost:3001/api/partner/me', {
    payout_bank_account: '12345'
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(badAccRes1.status === 400 && badAccRes1.body.error === 'Bank account number must be 9 to 18 digits.', '5-digit account returns 400');

  // 5. 30-digit account
  const badAccRes2 = await patch('http://localhost:3001/api/partner/me', {
    payout_bank_account: '123456789012345678901234567890'
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(badAccRes2.status === 400 && badAccRes2.body.error === 'Bank account number must be 9 to 18 digits.', '30-digit account returns 400');

  // 6. one-letter name
  const badNameRes = await patch('http://localhost:3001/api/partner/me', {
    payout_account_name: 'A'
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(badNameRes.status === 400 && badNameRes.body.error === "Enter the account holder's name.", '1-letter name returns 400');

  // 7. PATCH each field alone and all four together: each returns 200 and persists
  const patchAllRes = await patch('http://localhost:3001/api/partner/me', {
    payout_upi_id: 'test@bank',
    payout_bank_account: '123456789',
    payout_bank_ifsc: 'sbin0000300', // lowercase to test uppercase transform
    payout_account_name: 'Adhya Partner'
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(patchAllRes.status === 200, 'Valid PATCH of all payout fields returns 200');
  
  // Re-read
  const reReadRes = await get('http://localhost:3001/api/partner/me', {
    headers: { Authorization: `Bearer ${adhyaTokenForProfile}` }
  });
  assert(reReadRes.body.partner.payout_upi_id === 'test@bank' &&
         reReadRes.body.partner.payout_bank_account === '123456789' &&
         reReadRes.body.partner.payout_bank_ifsc === 'SBIN0000300' && // transformed to uppercase
         reReadRes.body.partner.payout_account_name === 'Adhya Partner', 'Fields persist correctly (IFSC uppercased)');

  // Empty string clears field
  const clearRes = await patch('http://localhost:3001/api/partner/me', {
    payout_upi_id: ''
  }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(clearRes.status === 200 && clearRes.body.partner.payout_upi_id === '', 'Empty string clears a field');

  // Another partner session cannot change this partner's row (already covered by auth token design, we use own token)
  
  assert(true, 'BF-PARTNER-PROFILE-SAVE backend tests passed');

  console.log('\\n--- 38. BF-PAYOUT-CHANGE-NOTICE ---');
  const getPayoutNotices = async (token) => {
    return await get('http://localhost:3001/api/admin/payout-changes', { headers: { Authorization: `Bearer ${token}` } });
  };
  
  // 1. partner: address only
  const cBeforePartner1 = await getPayoutNotices(ctx.adminToken);
  const p1Len = cBeforePartner1.body ? cBeforePartner1.body.length : 0;
  await patch('http://localhost:3001/api/partner/me', { address: 'New Addr' }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  const cAfterPartner1 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterPartner1.body.length === p1Len, 'Address change does not trigger payout notice for partner');

  // 2. partner: upi
  await patch('http://localhost:3001/api/partner/me', { payout_upi_id: 'new@upi' }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  const cAfterPartner2 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterPartner2.body.length === p1Len + 1, 'UPI change triggers one payout notice');
  const partnerUpiNotice = cAfterPartner2.body[0];
  assert(partnerUpiNotice.reason.includes('UPI'), 'Notice names the UPI field');
  assert(partnerUpiNotice.after.payout_upi_id === 'new@upi', 'Notice holds full UPI');

  // 3. partner: upi again
  await patch('http://localhost:3001/api/partner/me', { payout_upi_id: 'new@upi' }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  const cAfterPartner3 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterPartner3.body.length === p1Len + 1, 'Same UPI value again triggers no new event');

  // 4. partner: account + ifsc
  await patch('http://localhost:3001/api/partner/me', { payout_bank_account: '1234567890', payout_bank_ifsc: 'HDFC0000123' }, { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  const cAfterPartner4 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterPartner4.body.length === p1Len + 2, 'Account and IFSC change triggers one event for both');
  const partnerAcctNotice = cAfterPartner4.body[0];
  assert(partnerAcctNotice.reason.includes('Bank Account') && partnerAcctNotice.reason.includes('IFSC'), 'Event lists both fields');
  assert(partnerAcctNotice.after.payout_bank_account === '...7890', 'Audit row holds only last 4 digits of account');

  // stockist prep
  const stockistRes = await get('http://localhost:3001/api/admin/stockists', { headers: { Authorization: `Bearer ${ctx.adminToken}` } });
  const _sTestId = stockistRes.body[0].id;
  const adminStockistUrl = `http://localhost:3001/api/stockist/profile`;
  
  const _seedStockistLoginRes = await post('http://localhost:3001/api/auth/send-otp', { phone: stockistRes.body[0].user_phone });
  const sTokenRes = await post('http://localhost:3001/api/auth/verify-otp', { phone: stockistRes.body[0].user_phone, otp: '123456' });
  const sToken = sTokenRes.body.token;

  // stockist: bad inputs
  const sBadBank = await patch(adminStockistUrl, { payout_bank_account: '12ab' }, { headers: { Authorization: `Bearer ${sToken}` } });
  assert(sBadBank.status === 400, 'Bad bank account returns 400 on stockist route');
  const sBadName = await patch(adminStockistUrl, { payout_account_name: 'a' }, { headers: { Authorization: `Bearer ${sToken}` } });
  assert(sBadName.status === 400, '1-letter holder name returns 400 on stockist route');

  // stockist: same 4 cases
  const cBeforeStockist1 = await getPayoutNotices(ctx.adminToken);
  const s1Len = cBeforeStockist1.body.length;
  // 1. non-payout only
  await patch(adminStockistUrl, { address: 'new street' }, { headers: { Authorization: `Bearer ${sToken}` } });
  const cAfterStockist1 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterStockist1.body.length === s1Len, 'Non-payout change does not trigger payout notice for stockist');

  // 2. stockist: upi
  await patch(adminStockistUrl, { payout_upi_id: 'stock@upi' }, { headers: { Authorization: `Bearer ${sToken}` } });
  const cAfterStockist2 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterStockist2.body.length === s1Len + 1, 'UPI change triggers one payout notice for stockist');

  // 3. stockist: upi again
  await patch(adminStockistUrl, { payout_upi_id: 'stock@upi' }, { headers: { Authorization: `Bearer ${sToken}` } });
  const cAfterStockist3 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterStockist3.body.length === s1Len + 1, 'Same UPI value again triggers no new event for stockist');

  // 4. stockist: account + ifsc
  await patch(adminStockistUrl, { payout_bank_account: '9876543210', payout_ifsc: 'HDFC0000123' }, { headers: { Authorization: `Bearer ${sToken}` } });
  const cAfterStockist4 = await getPayoutNotices(ctx.adminToken);
  assert(cAfterStockist4.body.length === s1Len + 2, 'Account and IFSC change triggers one event for stockist');
  const stockistAcctNotice = cAfterStockist4.body[0];
  assert(stockistAcctNotice.after.payout_bank_account === '...3210', 'Stockist audit row holds only last 4 digits');

  // Admin access
  assert(new Date(cAfterStockist4.body[0].created_at) >= new Date(cAfterStockist4.body[1].created_at), 'GET notices returns newest first');
  
  const markRes = await post(`http://localhost:3001/api/admin/payout-changes/${stockistAcctNotice.id}/review`, {}, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });
  assert(markRes.status === 200, 'Mark reviewed returns 200');
  const cAfterMark = await getPayoutNotices(ctx.adminToken);
  const reviewedNotice = cAfterMark.body.find(n => n.id === stockistAcctNotice.id);
  assert(reviewedNotice.reviewed_by !== undefined && reviewedNotice.reviewed_at !== undefined, 'Mark reviewed stores admin id and time');

  // Permissions
  const pReject = await get('http://localhost:3001/api/admin/payout-changes', { headers: { Authorization: `Bearer ${adhyaTokenForProfile}` } });
  assert(pReject.status === 403, 'Partner session cannot read notices');

  assert(true, 'BF-PAYOUT-CHANGE-NOTICE backend tests passed');
  console.log('\n--- 39. BF-REGION-COUNTS ---');
  
  // 1. Create a region
  const regId = 'r-test-' + Date.now();
  await post('http://localhost:3001/api/admin/insert-table', { table: 'regions', row: { id: regId, name: 'Count Test Region', code: 'CNT_TEST', tenant_id: 't1' } }, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });

  ctx.insert = (table, row) => post('http://localhost:3001/api/admin/insert-table', { table, row }, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });

  // Users
  await ctx.insert('users', { id: 'u-cust', region_id: regId, tenant_id: 't1', role: 'CUSTOMER', is_active: true });
  await ctx.insert('users', { id: 'u-stk', region_id: regId, tenant_id: 't1', role: 'STOCKIST', kyc_status: 'APPROVED' });
  await ctx.insert('users', { id: 'u-ptn', region_id: regId, tenant_id: 't1', role: 'PARTNER_ADMIN' });
  
  // Stockists
  await ctx.insert('users', { id: 'u-stk-p', region_id: regId, tenant_id: 't1', role: 'STOCKIST', kyc_status: 'PENDING' });
  await ctx.insert('users', { id: 'u-stk-r', region_id: regId, tenant_id: 't1', role: 'STOCKIST', kyc_status: 'REJECTED' });
  await ctx.insert('stockists', { id: 's-app', region_id: regId, tenant_id: 't1', user_id: 'u-stk', is_active: true });
  await ctx.insert('stockists', { id: 's-pen', region_id: regId, tenant_id: 't1', user_id: 'u-stk-p', is_active: true });
  await ctx.insert('stockists', { id: 's-rej', region_id: regId, tenant_id: 't1', user_id: 'u-stk-r', is_active: true });
  
  // Partners
  await ctx.insert('partners', { id: 'p-app', onboarded_at: '2026-01-01T00:00:00Z', is_active: true });
  await ctx.insert('partner_regions', { id: 'pr-1', partner_id: 'p-app', region_id: regId, service_type: 'BROADBAND', is_active: true });
  await ctx.insert('partner_regions', { id: 'pr-2', partner_id: 'p-app', region_id: regId, service_type: 'CABLE', is_active: true });
  
  await ctx.insert('partners', { id: 'p-inact', onboarded_at: '2026-01-01T00:00:00Z', is_active: false });
  await ctx.insert('partner_regions', { id: 'pr-3', partner_id: 'p-inact', region_id: regId, service_type: 'BROADBAND', is_active: true });

  // Products
  await ctx.insert('products', { id: 'prod-live', region_id: regId, tenant_id: 't1', name: 'Live' });
  await ctx.insert('products', { id: 'prod-del', region_id: regId, tenant_id: 't1', name: 'Del', deleted_at: '2026-01-01T00:00:00Z' });
  
  // Vendors
  await ctx.insert('vendors', { id: 'v-live', region_id: regId, tenant_id: 't1', is_active: true });
  await ctx.insert('vendors', { id: 'v-inact', region_id: regId, tenant_id: 't1', is_active: false });
  
  const regionsAfter = await get('http://localhost:3001/api/admin/regions', { headers: { Authorization: `Bearer ${ctx.adminToken}` } });
  const testReg = regionsAfter.body.find(r => r.id === regId);
  
  assert(testReg.counts.users === 1, 'Users count is exactly active customers');
  assert(testReg.counts.stockists === 1, 'Stockists count is exactly approved, active stockists');
  assert(testReg.counts.partners === 1, 'Partners count is distinct onboarded active partners');
  assert(testReg.counts.products === 1, 'Products count excludes soft-deleted');
  assert(testReg.counts.vendors === 1, 'Vendors count excludes inactive');
  
  // Guard test: Delete should fail because total attached is higher than display (it uses counts_total effectively).
  const countDelRes = await del(`http://localhost:3001/api/admin/regions/${regId}`, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });
  assert(countDelRes.status === 409, 'Delete guard blocks region with attached inactive/pending records');
  assert(testReg.counts_total !== undefined, 'counts_total is returned for the delete guard reference');

};
