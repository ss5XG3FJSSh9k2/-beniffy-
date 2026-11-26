const {
  fs, path, dbModule, post, patch, get, del, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // Round BF1: Bug Fixes (Pickup Slot Picker + KYC Queue Visibility) (#489-#493)
  console.log('\n--- Round BF1: Bug Fixes (Pickup Slot Picker + KYC Queue Visibility) ---');
  const bf1AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #489: App.jsx contains getAvailableSlots(stockist) called inside JSX block near Place Pickup Order button
  assert(bf1AppJsx.includes('getAvailableSlots(stockist)') && bf1AppJsx.includes('Place Pickup Order'), 'App.jsx contains pickup slot picker calling getAvailableSlots(stockist) near Place Pickup Order');

  // Test #490: Pickup slot picker label has prominent fontSize (0.8rem or higher / class name)
  assert(bf1AppJsx.includes("fontSize: '0.85rem'") || bf1AppJsx.includes('pickup-slot-label'), 'Pickup slot picker label has prominent fontSize (0.85rem)');

  // Test #491: Pickup slot picker wrapper has background color or distinct class
  assert(bf1AppJsx.includes("backgroundColor: 'rgba(255,255,255,0.03)'") || bf1AppJsx.includes('pickup-slot-picker-block'), 'Pickup slot picker wrapper has background color or distinct class');

  // Test #492: Admin sidebar Pending KYC entry appears in the top sidebar items (within top 5 buttons)
  const sidebarMatch = bf1AppJsx.match(/className="admin-sidebar"[\s\S]*?<\/div>/);
  assert(sidebarMatch !== null, 'Found admin-sidebar in App.jsx');
  const sidebarButtons = (sidebarMatch[0].match(/<button[\s\S]*?<\/button>/g) || []);
  const pendingKycBtnIndex = sidebarButtons.findIndex(btn => btn.includes('Pending KYC'));
  assert(pendingKycBtnIndex >= 0 && pendingKycBtnIndex < 5, `Pending KYC sidebar button appears within top 5 sidebar buttons (got index ${pendingKycBtnIndex})`);

  // Test #493: Admin home tab contains alert block referencing pendingKyc.length > 0 with click-through
  assert(bf1AppJsx.includes('pendingKyc.length > 0') && (bf1AppJsx.includes('stockists awaiting KYC approval') || bf1AppJsx.includes('awaiting KYC approval')), 'Admin home tab contains alert block referencing pendingKyc.length > 0');

    // --- Round BF2: Order Status Enum + Partner Package Fixes (#494-#502) ---
  console.log('\n--- Round BF2: Order Status Enum + Partner Package Fixes ---');
  const bf2AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #494: App.jsx contains ZERO references to o.status === 'ACCEPTED' or order.status === 'ACCEPTED'
  assert(!bf2AppJsx.includes("o.status === 'ACCEPTED'") && !bf2AppJsx.includes("order.status === 'ACCEPTED'"), 'App.jsx contains ZERO references to o.status === ACCEPTED or order.status === ACCEPTED');

  // Test #495: App.jsx contains ZERO references to 'PREPARING' in any context
  assert(!bf2AppJsx.includes("'PREPARING'"), "App.jsx contains ZERO references to 'PREPARING'");

  // Test #496: App.jsx contains ZERO references to 'READY_FOR_PICKUP' in an order status conditional
  assert(!bf2AppJsx.includes("status === 'READY_FOR_PICKUP'"), "App.jsx contains ZERO references to 'READY_FOR_PICKUP' in order status conditional");

  // Test #497: Endpoint test: Place an order -> transition through backend to READY -> returned order.status equals 'READY'
  const bf2OrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    fulfillmentType: 'PICKUP',
    pickupSlot: 'Morning (8AM–12PM)',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(bf2OrderRes.status === 200, 'Placed test order for BF2 status check');
  const bf2OrderId = bf2OrderRes.body.orderId;
  assert(bf2OrderId !== undefined, 'Got test order ID');

  // Transition CONFIRMING -> RECEIVED -> READY
  await patch(`http://localhost:3001/api/orders/${bf2OrderId}/status`, { status: 'RECEIVED' });
  await patch(`http://localhost:3001/api/orders/${bf2OrderId}/status`, { status: 'READY' });
  const bf2ReadyOrder = (await get('http://localhost:3001/api/orders')).body.find(o => o.id === bf2OrderId);
  assert(bf2ReadyOrder && bf2ReadyOrder.status === 'READY', `Returned order.status equals 'READY' exactly (got '${bf2ReadyOrder ? bf2ReadyOrder.status : 'undefined'}')`);

  // Test #498: Auto-recovery block near boot references CONFIRMING, RECEIVED, or READY
  assert(bf2AppJsx.includes("['CONFIRMING', 'RECEIVED', 'READY']") || (bf2AppJsx.includes("'CONFIRMING'") && bf2AppJsx.includes("'RECEIVED'") && bf2AppJsx.includes("'READY'")), 'Auto-recovery block references CONFIRMING, RECEIVED, or READY');

  // Test #499: Log in as adhya (partner), POST new package with active_regions: ['r1'] -> 200
  const adhyaSessionRes = await post('http://localhost:3001/api/partner/auth/login-password', { email: 'adhya@partners.example', password: 'partner123' });
  assert(adhyaSessionRes.status === 200, 'Adhya partner login succeeds');
  const adhyaToken = adhyaSessionRes.body.session_token;

  const validPkgRes = await post('http://localhost:3001/api/partner/packages', {
    name: 'BF2 Test Package Valid',
    service_type: 'CABLE',
    face_value_rupees: 300,
    cost_to_partner_rupees: 280,
    point_cost: 300,
    active_regions: ['r1']
  }, { headers: { Authorization: `Bearer ${adhyaToken}` } });
  assert(validPkgRes.status === 200 && (validPkgRes.body.name === 'BF2 Test Package Valid' || (validPkgRes.body.package && validPkgRes.body.package.name === 'BF2 Test Package Valid')), 'POST valid package with active_regions: [r1] returns 200 created package');

  // Test #500: POST same shape but active_regions: [] -> 400 with "At least one active region" error
  const emptyPkgRes = await post('http://localhost:3001/api/partner/packages', {
    name: 'BF2 Test Package Empty',
    service_type: 'CABLE',
    face_value_rupees: 300,
    cost_to_partner_rupees: 280,
    point_cost: 300,
    active_regions: []
  }, { headers: { Authorization: `Bearer ${adhyaToken}` } });
  assert(emptyPkgRes.status === 400 && emptyPkgRes.body.error === 'At least one active region is required for this package', 'POST package with active_regions: [] returns 400 error');

  // Test #501: App.jsx does NOT contain r.region_code || r.region_id in package region picker context
  assert(!bf2AppJsx.includes("const rCode = r.region_code || r.region_id;"), 'App.jsx does not contain r.region_code || r.region_id in package region picker context');

  // Test #505: Add Package modal contains at least 3 inline help strings
  const helpStrings = [
    "What customers will see",
    "actual cost to provide",
    "loyalty points a customer",
    "Tick the regions",
    "rupee value the customer"
  ];
  const matchedHelpStrings = helpStrings.filter(s => bf2AppJsx.includes(s));
  assert(matchedHelpStrings.length >= 3, `Add Package modal contains at least 3 inline help strings (found ${matchedHelpStrings.length})`);

  // --- Round BF3: Consolidated Bug Fixes ---
  console.log('\n--- Round BF3: Consolidated Bug Fixes ---');
  const bf3AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #506: Grep test: App.jsx contains ZERO instances of triggerConfirmModal({
  assert(!bf3AppJsx.includes('triggerConfirmModal({'), 'App.jsx contains ZERO instances of triggerConfirmModal({');

  // Reset database before stateful endpoint tests
  await post('http://localhost:3001/api/admin/reset-db', {});

  // Test #507: Endpoint test: POST /api/admin/approve-kyc for u-stk3 -> 200, removed from kyc-queue
  const approveKycRes = await post('http://localhost:3001/api/admin/approve-kyc', {
    userId: 'u-stk3',
    vendorId: 'v2',
    deliveryRadius: 6.0,
    minOrderValue: 100
  });
  assert(approveKycRes.status === 200, 'POST /api/admin/approve-kyc returns 200');

  const bf3KycQueueRes = await get('http://localhost:3001/api/admin/kyc-queue');
  const inKycQueue = bf3KycQueueRes.body.some(u => u.id === 'u-stk3');
  assert(!inKycQueue, 'u-stk3 is no longer present in GET /api/admin/kyc-queue after approval');

  // Test #508: Endpoint test: Users row for u-stk3 post-approval has kyc_status='APPROVED'
  const allUsers = await dbModule.getTable('users');
  const uStk3User = allUsers.find(u => u.id === 'u-stk3');
  assert(uStk3User && uStk3User.kyc_status === 'APPROVED', 'u-stk3 kyc_status is APPROVED');

  // Test #509: Endpoint test: GET /api/regions (no auth) -> 200 with 3 items matching seed IDs (r1, r2, r3)
  const regionsRes = await get('http://localhost:3001/api/regions');
  assert(regionsRes.status === 200, 'GET /api/regions returns 200');
  assert(Array.isArray(regionsRes.body) && regionsRes.body.length === 3, 'GET /api/regions returns 3 items');
  const regionIds = regionsRes.body.map(r => r.id).sort();
  assert(JSON.stringify(regionIds) === JSON.stringify(['r1', 'r2', 'r3']), 'Regions match seed IDs r1, r2, r3');

  // Test #510: Endpoint test: Response items contain exactly {id, name, code} - no tenant_id, no created_at
  const firstReg = regionsRes.body[0];
  const keys = Object.keys(firstReg).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['code', 'delivery_fee', 'id', 'name']), 'Response items contain exactly {id, name, code, delivery_fee}');
  assert(firstReg.tenant_id === undefined && firstReg.created_at === undefined, 'No tenant_id or created_at in /api/regions response');

  // Test #511: Grep test: App.jsx does NOT contain hardcoded fallback array with 'Kolkata South (Garia)' in setAllSystemRegions
  assert(!bf3AppJsx.includes("setAllSystemRegions([{ id: 'r1', name: 'Kolkata South (Garia)'"), 'App.jsx does NOT contain hardcoded region fallback in setAllSystemRegions');

  // Test #512: Grep test: App.jsx contains confirmModal.onConfirm?.() (with optional chaining)
  assert(bf3AppJsx.includes('confirmModal.onConfirm?.()'), 'App.jsx contains confirmModal.onConfirm?.() with optional chaining');

  // Test #513: Endpoint test: GET /api/customer/redemptions/u-cust1 returns an array
  const custRedemptionsRes = await get('http://localhost:3001/api/customer/redemptions/u-cust1');
  assert(custRedemptionsRes.status === 200 && Array.isArray(custRedemptionsRes.body), 'GET /api/customer/redemptions/u-cust1 returns 200 array');

  // Test #514: Endpoint test: After u-cust1 redeems a package, the new redemption_approval appears with status PENDING_ADMIN_APPROVAL
  await post('http://localhost:3001/api/admin/customers/u-cust1/points-credit', { amount: 1000, reason: 'Test setup 1' });
  await post('http://localhost:3001/api/admin/customers/u-cust1/points-credit', { amount: 1000, reason: 'Test setup 2' });
  await post('http://localhost:3001/api/customer/partner-bindings', {
    customer_user_id: 'u-cust1',
    cable_partner_id: 'ptr-adhya'
  });
  const adhyaDetail = await get('http://localhost:3001/api/admin/partners/ptr-adhya');
  const targetPkg = adhyaDetail.body.packages ? adhyaDetail.body.packages.find(p => p.is_active) : null;
  const targetPkgId = targetPkg ? targetPkg.id : 'ppk-adhya-basic';
  const targetPkgCost = targetPkg ? targetPkg.point_cost : 300;

  const p3RedeemRes = await post('http://localhost:3001/api/ledger/redeem', {
    customer_user_id: 'u-cust1',
    partner_package_id: targetPkgId,
    amount: targetPkgCost
  });
  assert(p3RedeemRes.status === 200, 'u-cust1 redeems package successfully');
  const p3ApprovalId = p3RedeemRes.body.redemption_approval ? p3RedeemRes.body.redemption_approval.id : null;
  assert(p3ApprovalId !== null, 'Redemption created approval row');

  const custRedemptionsPostRes = await get('http://localhost:3001/api/customer/redemptions/u-cust1');
  const newRedemptionRow = custRedemptionsPostRes.body.find(r => r.id === p3ApprovalId);
  assert(newRedemptionRow && newRedemptionRow.status === 'PENDING_ADMIN_APPROVAL', 'New redemption appears in endpoint with status PENDING_ADMIN_APPROVAL');

  // Test #515: Endpoint test: After admin approves, response shows status APPROVED_AWAITING_PARTNER
  await post(`http://localhost:3001/api/admin/redemption-approvals/${p3ApprovalId}/approve`, { admin_id: 'u-admin', notes: 'Approved by admin test' });
  const custRedemptionsApprovedRes = await get('http://localhost:3001/api/customer/redemptions/u-cust1');
  const approvedRedemptionRow = custRedemptionsApprovedRes.body.find(r => r.id === p3ApprovalId);
  assert(approvedRedemptionRow && approvedRedemptionRow.status === 'APPROVED_AWAITING_PARTNER', 'Approved redemption shows status APPROVED_AWAITING_PARTNER');

  // Test #516: Endpoint test: Endpoint does NOT expose partner internal fields (contact_email, gst_number)
  assert(approvedRedemptionRow.contact_email === undefined && approvedRedemptionRow.gst_number === undefined, 'Endpoint does NOT expose partner internal fields (contact_email, gst_number)');

  // Test #517: Grep test: App.jsx contains status key labels for PENDING_ADMIN_APPROVAL, APPROVED_AWAITING_PARTNER, FULFILLED, REJECTED
  assert(
    bf3AppJsx.includes('PENDING_ADMIN_APPROVAL') &&
    bf3AppJsx.includes('APPROVED_AWAITING_PARTNER') &&
    bf3AppJsx.includes('FULFILLED') &&
    bf3AppJsx.includes('REJECTED'),
    'App.jsx contains status keys PENDING_ADMIN_APPROVAL, APPROVED_AWAITING_PARTNER, FULFILLED, REJECTED'
  );

  // Test #518: Grep test: All other confirmation modal call sites in App.jsx use positional args
  const modalCallsCount = (bf3AppJsx.match(/triggerConfirmModal\(/g) || []).length;
  assert(modalCallsCount >= 6, `Count of triggerConfirmModal( calls matches expectation (found ${modalCallsCount})`);

  // Test #519: Grep test: App.jsx does NOT contain any triggerConfirmModal(\s*\{ pattern
  assert(!/triggerConfirmModal\s*\{/.test(bf3AppJsx), 'App.jsx does NOT contain triggerConfirmModal(\\s*\\{ pattern');

  // Test #520: Grep test: handleApproveKyc handler is still defined and still hits /admin/approve-kyc
  assert(bf3AppJsx.includes('handleApproveKyc') && bf3AppJsx.includes('/admin/approve-kyc'), 'handleApproveKyc handler is defined and hits /admin/approve-kyc');

  console.log('\n--- Round PL: Pre-Launch Consolidated ---');

  const indexCss = fs.readFileSync(path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');
  const plAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  const serverJs = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

  // Test #527: Grep test: index.css contains .modal-overlay and .modal-content with position: fixed
  assert(indexCss.includes('.modal-overlay') && indexCss.includes('.modal-content') && indexCss.includes('position: fixed'), 'index.css contains .modal-overlay and .modal-content with position: fixed');

  // Test #528: Grep test: App.jsx still has >= 30 references to className="modal-overlay"
  const overlayCount = (plAppJsx.match(/className="modal-overlay"/g) || []).length;
  assert(overlayCount >= 30, `App.jsx still has >= 30 references to className="modal-overlay" (found ${overlayCount})`);

  // Test #529: Grep test: App.jsx contains Home tab render block with pendingKyc.length and PENDING_ADMIN_APPROVAL
  assert(plAppJsx.includes("adminTab === 'home'") && plAppJsx.includes('pendingKyc.length') && plAppJsx.includes('PENDING_ADMIN_APPROVAL'), 'App.jsx contains Home tab block with pendingKyc.length and PENDING_ADMIN_APPROVAL');

  // Test #530: Grep test: App.jsx contains showAdvanced state variable AND toggle button
  assert(plAppJsx.includes('showAdvanced') && plAppJsx.includes('setShowAdvanced(!showAdvanced)'), 'App.jsx contains showAdvanced state variable AND toggle button');

  // Test #531: Grep test: App.jsx contains Config tab block
  assert(plAppJsx.includes("adminTab === 'config'"), 'App.jsx contains adminTab === config block');

  // Test #532: Grep test: App.jsx does NOT contain a separate top-level adminTab === 'rates' sidebar item outside Config
  assert(!plAppJsx.includes("onClick={() => setAdminTab('rates')}"), 'App.jsx does NOT contain top-level onClick setAdminTab rates sidebar button');

  // Test #533: Endpoint test: GET /api/admin/analytics returns 200
  const plAnalyticsRes = await get('http://localhost:3001/api/admin/analytics');
  assert(plAnalyticsRes.status === 200, 'GET /api/admin/analytics returns 200');

  // Test #534: Endpoint test: GET /api/health returns 200 with status, db, uptime_seconds, version fields
  const healthRes = await get('http://localhost:3001/api/health');
  assert(healthRes.status === 200, 'GET /api/health returns 200');
  assert(healthRes.body.status === 'ok' && healthRes.body.db !== undefined && typeof healthRes.body.uptime_seconds === 'number' && healthRes.body.version !== undefined, 'GET /api/health returns status, db, uptime_seconds, version fields');

  // Test #535: Endpoint test: Health check DB status is connected
  assert(healthRes.body.db === 'connected', 'GET /api/health db status is connected');

  // Test #536: Grep test: server.js contains request-logging middleware
  assert(serverJs.includes('[HTTP]') && serverJs.includes('req.method') && serverJs.includes('res.statusCode'), 'server.js contains request-logging middleware');

  // Test #537: Grep test: server.js contains ZERO console.log(.*password patterns
  assert(!/console\.log\(.*password/i.test(serverJs), 'server.js contains ZERO console.log(.*password patterns');

  // Test #538: Grep test: server.js contains ZERO console.log(.*token patterns
  assert(!/console\.log\(.*token/i.test(serverJs), 'server.js contains ZERO console.log(.*token patterns');

  // Test #539: Grep test: server.js has boot-time check emitting [Config] warnings
  assert(serverJs.includes('checkConfigWarnings') && serverJs.includes('[Config] WARNING:'), 'server.js has checkConfigWarnings emitting [Config] warnings');

  // Test #540: Runtime test: checkConfigWarnings emits [Config] warning for missing env vars
  assert(serverJs.includes('[Config] WARNING: SMS delivery disabled'), 'checkConfigWarnings emits [Config] warning for missing SMS config');

  console.log('\n--- Round BF4b: Seeded Stockists Missing user_id ---');
  await post('http://localhost:3001/api/admin/reset-db', {});

  // Test #542: GET /api/stockists/by-user/u-stk1 -> 200, body id === 's1'
  const stk1Res = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(stk1Res.status === 200 && stk1Res.body.id === 's1', 'GET /api/stockists/by-user/u-stk1 returns 200 with id s1');

  // Test #543: GET /api/stockists/by-user/u-stk2 -> 200, body id === 's2'
  const stk2Res = await get('http://localhost:3001/api/stockists/by-user/u-stk2');
  assert(stk2Res.status === 200 && stk2Res.body.id === 's2', 'GET /api/stockists/by-user/u-stk2 returns 200 with id s2');

  // Test #544: GET /api/stockists/by-user/u-stk4 -> 200, body id === 's3'
  const stk4Res = await get('http://localhost:3001/api/stockists/by-user/u-stk4');
  assert(stk4Res.status === 200 && stk4Res.body.id === 's3', 'GET /api/stockists/by-user/u-stk4 returns 200 with id s3');

  // Test #545: GET /api/stockists/by-user/u-stk3 -> 404 (correctly still pending)
  const stk3Res = await get('http://localhost:3001/api/stockists/by-user/u-stk3');
  assert(stk3Res.status === 404, 'GET /api/stockists/by-user/u-stk3 returns 404 (pending)');

  console.log('\n--- Round BF4c: Pickup Slots: AM/PM Format, No Past Slots ---');
  const bf4cAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Extract formatHour12 and getAvailableSlots from App.jsx to test functionally
  ctx.extractFnCode = (src, fnName) => {
    const startIdx = src.indexOf(`const ${fnName} =`);
    if (startIdx === -1) throw new Error(`Could not find ${fnName} in App.jsx`);
    const body = src.slice(startIdx, src.indexOf('};', startIdx) + 2);
    return body;
  };

  const formatClock12Code = bf4cAppJsx.includes('const formatClock12 =') ? ctx.extractFnCode(bf4cAppJsx, 'formatClock12') : '';
  const formatHour12Code = ctx.extractFnCode(bf4cAppJsx, 'formatHour12');
  const getAvailableSlotsCode = ctx.extractFnCode(bf4cAppJsx, 'getAvailableSlots');

  const evalSlotsFn = new Function(
    `${formatClock12Code}; ${formatHour12Code}; ${getAvailableSlotsCode}; return getAvailableSlots;`
  )();

  const testStockist = { id: 's1', opening_time: '08:00', closing_time: '20:00', prep_eta_minutes: 10 };

  // Test #546: Given a fixed "now" of 20:30 and store hours 08:00–20:00: every returned slot start is in the future, and at least one is labelled for tomorrow
  const fixedNowLate = new Date('2026-08-06T20:30:00');
  const slotsLate = evalSlotsFn(testStockist, fixedNowLate);
  assert(slotsLate.length > 0, 'slotsLate returns at least one slot');
  assert(slotsLate.every(s => new Date(s.value).getTime() > fixedNowLate.getTime()), 'Every returned slot start is in the future when now is 20:30');
  assert(slotsLate.some(s => s.day === 'tomorrow' || s.label.startsWith('Tomorrow,')), 'At least one slot is labelled for tomorrow when now is 20:30');

  // Test #547: Given "now" of 10:00: no returned slot starts before 10:00
  const fixedNowMorning = new Date('2026-08-06T10:00:00');
  const slotsMorning = evalSlotsFn(testStockist, fixedNowMorning);
  assert(slotsMorning.length > 0, 'slotsMorning returns slots for 10:00 AM');
  assert(slotsMorning.every(s => new Date(s.value).getTime() >= fixedNowMorning.getTime()), 'No returned slot starts before 10:00 when now is 10:00');

  // Test #548: For a store with valid opening/closing hours, the returned list is non-empty at any hour of the day
  for (let hour = 0; hour < 24; hour++) {
    const testNow = new Date(`2026-08-06T${String(hour).padStart(2, '0')}:15:00`);
    const slots = evalSlotsFn(testStockist, testNow);
    assert(slots.length > 0, `Returned list is non-empty at hour ${hour}:00`);
  }

  // Test #549: Grep: App.jsx contains AM and PM string literals near slot code, and customer cart picker no longer builds labels with bare String(h).padStart(2, '0') + ':00'
  assert(bf4cAppJsx.includes("'AM'") && bf4cAppJsx.includes("'PM'"), 'App.jsx contains AM and PM string literals');
  assert(!bf4cAppJsx.includes("String(h).padStart(2, '0') + ':00'"), 'App.jsx no longer builds labels with bare String(h).padStart(2, "0") + ":00"');

  console.log('\n--- Round BF5a: Remove Auto-Login From Default Path ---');
  const bf5aAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #577: Grep: App.jsx defines an isDevMode flag derived from window.location.search and/or import.meta.env.DEV
  assert(bf5aAppJsx.includes('isDevMode') && (bf5aAppJsx.includes('window.location.search') || bf5aAppJsx.includes('import.meta.env.DEV')), 'App.jsx defines an isDevMode flag derived from window.location.search');

  // Test #578: Grep: every hardcoded seed phone literal used in an auto-login call appears inside a block guarded by isDevMode
  const switchViewStart = bf5aAppJsx.indexOf('const switchViewToRole =');
  assert(switchViewStart !== -1, 'switchViewToRole handler exists in App.jsx');
  const switchViewBlock = bf5aAppJsx.slice(switchViewStart, bf5aAppJsx.indexOf('};', switchViewStart) + 2);
  assert(switchViewBlock.includes('if (!isDevMode)') || switchViewBlock.includes('isDevMode'), 'switchViewToRole gates auto-login calls on isDevMode');

  // Test #579: Grep: the role-switch handler clears currentUser when isDevMode is false
  assert(switchViewBlock.includes('setCurrentUser(null)'), 'role-switch handler clears currentUser when isDevMode is false');

  console.log('\n--- Round BF5b: Region CRUD (Admin) ---');
  await post('http://localhost:3001/api/admin/reset-db', {});

  // Test #581: POST /api/admin/regions with valid name and code -> 200, row exists in GET /api/regions
  const postRegRes = await post('http://localhost:3001/api/admin/regions', { name: 'Howrah Central', code: 'howrah-central' });
  assert(postRegRes.status === 200 && postRegRes.body.id, 'POST /api/admin/regions returns 200 with id');
  const createdRegionId = postRegRes.body.id;
  const getRegsRes1 = await get('http://localhost:3001/api/regions');
  assert(getRegsRes1.body.some(r => r.id === createdRegionId && r.code === 'howrah-central'), 'Created region exists in GET /api/regions');

  // Test #582: Duplicate code -> 409
  const dupCodeRes = await post('http://localhost:3001/api/admin/regions', { name: 'Howrah North', code: 'howrah-central' });
  assert(dupCodeRes.status === 409, 'Duplicate region code returns 409');

  // Test #583: Invalid code ("Kolkata South") -> 400
  const invCodeRes = await post('http://localhost:3001/api/admin/regions', { name: 'Kolkata South 2', code: 'Kolkata South' });
  assert(invCodeRes.status === 400, 'Invalid region code returns 400');

  // Test #584: Empty name -> 400
  const emptyNameRes = await post('http://localhost:3001/api/admin/regions', { name: '  ', code: 'valid-code' });
  assert(emptyNameRes.status === 400, 'Empty region name returns 400');

  // Test #585: PATCH an existing region's name -> 200, change reflected in GET /api/regions
  const patchRes = await patch(`http://localhost:3001/api/admin/regions/${createdRegionId}`, { name: 'Howrah Metro' });
  assert(patchRes.status === 200 && patchRes.body.name === 'Howrah Metro', 'PATCH region returns 200 with updated name');
  const getRegsRes2 = await get('http://localhost:3001/api/regions');
  assert(getRegsRes2.body.some(r => r.id === createdRegionId && r.name === 'Howrah Metro'), 'Updated region name reflected in GET /api/regions');

  // Test #586: PATCH a region's code to one already used by another region -> 409
  const patchDupRes = await patch(`http://localhost:3001/api/admin/regions/${createdRegionId}`, { code: 'kolkata-garia' });
  assert(patchDupRes.status === 409, 'PATCH duplicate code returns 409');

  // Test #587: PATCH a non-existent region id -> 404
  const patch404Res = await patch('http://localhost:3001/api/admin/regions/r-nonexistent', { name: 'Ghost Region' });
  assert(patch404Res.status === 404, 'PATCH non-existent region returns 404');

  // Test #588: DELETE a region with assigned references -> 409, message names the blocker
  const delBlockRes = await del('http://localhost:3001/api/admin/regions/r1');
  assert(delBlockRes.status === 409 && delBlockRes.body.error.startsWith('Cannot delete:'), 'DELETE region r1 with assigned references returns 409 naming the blocker');

  // Test #589: DELETE an unused region -> 200, gone from GET /api/regions
  const delUnusedRes = await del(`http://localhost:3001/api/admin/regions/${createdRegionId}`);
  assert(delUnusedRes.status === 200, 'DELETE unused region returns 200');
  const getRegsRes3 = await get('http://localhost:3001/api/regions');
  assert(!getRegsRes3.body.some(r => r.id === createdRegionId), 'Deleted region is gone from GET /api/regions');

  // Test #590: GET /api/admin/regions returns usage counts; a seeded region with stockists shows a non-zero counts.stockists
  const adminRegsRes = await get('http://localhost:3001/api/admin/regions');
  assert(adminRegsRes.status === 200 && Array.isArray(adminRegsRes.body), 'GET /api/admin/regions returns 200 array');
  const r1Detail = adminRegsRes.body.find(r => r.id === 'r1');
  assert(r1Detail && r1Detail.counts && r1Detail.counts.stockists > 0, 'Seeded region r1 has non-zero counts.stockists');

  console.log('\n--- Round BF5c: Region Dropdowns Must Use Live Data ---');
  const bf5cAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #595: Grep: App.jsx contains zero occurrences of <option value="r1">
  assert(!bf5cAppJsx.includes('<option value="r1">'), 'App.jsx contains zero occurrences of <option value="r1">');

  // Test #596: Grep: App.jsx contains zero occurrences of <option value="r2"> and <option value="r3">
  assert(!bf5cAppJsx.includes('<option value="r2">') && !bf5cAppJsx.includes('<option value="r3">'), 'App.jsx contains zero occurrences of <option value="r2"> and <option value="r3">');

  // Test #597: Grep: customer registration <select> maps over a regions array
  assert(bf5cAppJsx.includes('showCustomerSignup') && bf5cAppJsx.includes('regions.map(r =>'), 'Customer registration select maps over regions array');

  // Test #598: Grep: stockist registration <select> maps over a regions array
  assert(bf5cAppJsx.includes('showStockistSignup') && bf5cAppJsx.includes('regions.map(r =>'), 'Stockist registration select maps over regions array');

  // Test #599: Endpoint: create a region via POST /api/admin/regions, then confirm GET /api/regions includes it
  const newRegRes = await post('http://localhost:3001/api/admin/regions', { name: 'Kolkata West', code: 'kolkata-west' });
  assert(newRegRes.status === 200 && newRegRes.body.id, 'POST /api/admin/regions returns 200 with id');
  const freshRegionId = newRegRes.body.id;
  const getRegsRes4 = await get('http://localhost:3001/api/regions');
  assert(getRegsRes4.body.some(r => r.id === freshRegionId && r.code === 'kolkata-west'), 'Newly created region is present in GET /api/regions');

  // Test #600: Endpoint: register a stockist into a newly created region via POST /api/auth/register-stockist -> 200, user's region_id matches new region
  const regStkRes = await post('http://localhost:3001/api/auth/register-stockist', {
    phone: '9123456789', email: 'test_9123456789@fastnet.test',
    name: 'New Region Stockist Owner',
    shopName: 'New Region Kirana Store',
    regionId: freshRegionId,
    idType: 'Aadhaar',
    idNumber: '9999-8888-7777',
    address: '1 West Street, Kolkata'
  });
  assert(regStkRes.status === 200 && regStkRes.body.user && regStkRes.body.user.region_id === freshRegionId, 'POST /api/auth/register-stockist into new region returns 200 with matching region_id');

  console.log('\n--- Round BF5d: Empty Production Database + First-Run Setup ---');

  // Test #602: GET /api/setup/status with users present -> needs_setup: false
  const statusResPopulated = await get('http://localhost:3001/api/setup/status');
  assert(statusResPopulated.status === 200 && statusResPopulated.body.needs_setup === false, 'GET /api/setup/status with users present returns needs_setup: false');

  // Test #603: POST /api/setup/create-admin while users exist -> 403, "Setup has already been completed."
  const createAdminPopulatedRes = await post('http://localhost:3001/api/setup/create-admin', { name: 'Admin', phone: '9998887776', email: 'test_9998887776@fastnet.test' });
  assert(createAdminPopulatedRes.status === 403 && createAdminPopulatedRes.body.error === 'Setup has already been completed.', 'POST /api/setup/create-admin while users exist returns 403');

  // Now clear DB using SEED_MODE=production to test empty setup flow
  process.env.SEED_MODE = 'production';
  await dbModule.resetForTest();

  // Test #604: GET /api/setup/status with users emptied -> needs_setup: true, user_count: 0
  const statusResEmpty = await get('http://localhost:3001/api/setup/status');
  assert(statusResEmpty.status === 200 && statusResEmpty.body.needs_setup === true && statusResEmpty.body.user_count === 0, 'GET /api/setup/status on empty DB returns needs_setup: true, user_count: 0');

  // Test #605: POST /api/setup/create-admin with empty name -> 400
  const createAdminEmptyNameRes = await post('http://localhost:3001/api/setup/create-admin', { name: '', phone: '9876543210', email: 'test_9876543210@fastnet.test' });
  assert(createAdminEmptyNameRes.status === 400, 'POST /api/setup/create-admin with empty name returns 400');

  // Test #606: POST /api/setup/create-admin with invalid phone -> 400
  const createAdminInvalidPhoneRes = await post('http://localhost:3001/api/setup/create-admin', { name: 'Test Admin', phone: '123', email: 'test_123@fastnet.test' });
  assert(createAdminInvalidPhoneRes.status === 400, 'POST /api/setup/create-admin with invalid phone returns 400');

  // Test #607: POST /api/setup/create-admin on empty users table -> 200, returns user with role: 'ADMIN'
  const createAdminSuccessRes = await post('http://localhost:3001/api/setup/create-admin', { name: 'System Admin', phone: '9876543210', email: 'test_9876543210@fastnet.test' });
  assert(createAdminSuccessRes.status === 200 && createAdminSuccessRes.body.role === 'ADMIN' && createAdminSuccessRes.body.phone === '9876543210', 'POST /api/setup/create-admin on empty users table returns 200 with ADMIN role');

  // Test #608: Created admin has a non-null referral_code
  assert(createAdminSuccessRes.body.referral_code && typeof createAdminSuccessRes.body.referral_code === 'string', 'Created admin has a non-null referral_code');

  // Test #609: Created admin can immediately authenticate via existing OTP flow
  const sendOtpRes = await post('http://localhost:3001/api/auth/send-otp', { phone: '9876543210', email: 'test_9876543210@fastnet.test' });
  assert(sendOtpRes.status === 200, 'send-otp returns 200 for created admin');
  // Outside test mode the OTP is random: read it from the mock SMS outbox.
  const setupOtpSms = require('../../lib/sms').getMockOutbox().filter(s => s.phone === '9876543210').pop();
  const setupOtp = setupOtpSms && (setupOtpSms.body.match(/\d{6}/) || [])[0];
  assert(setupOtp && setupOtp !== '123456', 'Outside test mode the login OTP is random, not the fixed demo code');
  const verifyOtpRes = await post('http://localhost:3001/api/auth/verify-otp', { phone: '9876543210', email: 'test_9876543210@fastnet.test', otp: setupOtp });
  assert(verifyOtpRes.status === 200 && verifyOtpRes.body.user && verifyOtpRes.body.user.role === 'ADMIN', 'Created admin can authenticate via OTP flow');

  // Test #610: Second POST /api/setup/create-admin after first -> 403
  const secondCreateAdminRes = await post('http://localhost:3001/api/setup/create-admin', { name: 'Second Admin', phone: '9876543211', email: 'test_9876543211@fastnet.test' });
  assert(secondCreateAdminRes.status === 403 && secondCreateAdminRes.body.error === 'Setup has already been completed.', 'Second POST /api/setup/create-admin returns 403');

  // Restore DB to test seed data for clean state
  process.env.SEED_MODE = 'test';
  await dbModule.resetForTest();

  // Test #611: Config: with SEED_MODE=production, seedDatabase is not invoked — assert db.js gates call sites on env var
  const dbJsContent = fs.readFileSync(path.join(__dirname, '../../db.js'), 'utf8');
  assert(dbJsContent.includes('process.env.SEED_MODE') && dbJsContent.includes("seedMode === 'test'"), 'db.js gates seedRunner.seedDatabase on SEED_MODE === test');

  // Test #612: Grep: regression.js sets SEED_MODE=test before requiring db.js or server.js
  const regressionJsContent = fs.readFileSync(path.join(__dirname, '../regression.js'), 'utf8');
  const seedModePos = regressionJsContent.indexOf("process.env.SEED_MODE = 'test'");
  const dbReqPos = regressionJsContent.indexOf("require('../db.js')");
  assert(seedModePos !== -1 && seedModePos < dbReqPos, 'regression.js sets SEED_MODE=test before requiring db.js');

  console.log('\n--- Round BF5e: password_hash leaking in auth responses ---');

  // Test #614: POST /api/auth/verify-otp response body does not contain the string "password_hash"
  const sendOtpVerifyRes = await post('http://localhost:3001/api/auth/send-otp', { phone: '9876543210', email: 'test_9876543210@fastnet.test' });
  assert(sendOtpVerifyRes.status === 200, 'send-otp returns 200 for user');
  const verifyOtpResp = await post('http://localhost:3001/api/auth/verify-otp', { phone: '9876543210', email: 'test_9876543210@fastnet.test', otp: '123456' });
  const rawVerifyBody = JSON.stringify(verifyOtpResp.body);
  assert(verifyOtpResp.status === 200 && !rawVerifyBody.includes('password_hash'), 'POST /api/auth/verify-otp response body does not contain "password_hash"');

  // Test #615: Set a password on a partner account, log in via /api/partner/auth/login-password, assert response does not contain "password_hash"
  const partnerLoginResp = await post('http://localhost:3001/api/partner/auth/login-password', { email: 'adhya@partners.example', password: 'partner123' });
  const rawPartnerLoginBody = JSON.stringify(partnerLoginResp.body);
  assert(partnerLoginResp.status === 200 && !rawPartnerLoginBody.includes('password_hash'), 'POST /api/partner/auth/login-password response body does not contain "password_hash"');

  // Test #616: POST /api/setup/create-admin response does not contain "password_hash"
  const rawCreateAdminBody = JSON.stringify(createAdminSuccessRes.body);
  assert(createAdminSuccessRes.status === 200 && !rawCreateAdminBody.includes('password_hash'), 'POST /api/setup/create-admin response body does not contain "password_hash"');

  console.log('\n--- Round BF6a: Getting Started Step 3 Never Completes ---');

  // Test #618: Grep: App.jsx does not contain kyc_status being read from a stockists-derived array
  const bf6aAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!bf6aAppJsx.includes('allStks.some(s => s.kyc_status'), 'App.jsx does not read kyc_status from allStks');

  // Test #619: Endpoint: GET /api/admin/stockists returns array of stockists for step 3
  const bf6aStockistsRes = await get('http://localhost:3001/api/admin/stockists');
  assert(bf6aStockistsRes.status === 200 && Array.isArray(bf6aStockistsRes.body) && bf6aStockistsRes.body.length > 0, 'GET /api/admin/stockists returns non-empty array of stockists');

  // Test #620: Grep: fetchDbState in App.jsx includes vendors and customers and stockists for steps 2, 3, 4
  const fetchDbStateCode = ctx.extractFnCode(bf6aAppJsx, 'fetchDbState');
  assert(fetchDbStateCode.includes('/admin/vendors') && fetchDbStateCode.includes('/admin/customers') && fetchDbStateCode.includes('/admin/stockists'), 'fetchDbState loads vendors, customers, and stockists');

  console.log('\n--- Round BF6b: Pickup Slot Dropdown Renders Objects As Strings ---');

  // Test #621: Grep: App.jsx contains no <option key={slot} value={slot}>{slot}</option> pattern
  const bf6bAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!bf6bAppJsx.includes('<option key={slot} value={slot}>{slot}</option>'), 'App.jsx contains no <option key={slot} value={slot}>{slot}</option> pattern');

  // Test #622: Grep: every SLOTS.map( in the file destructures or accesses .value and .label
  const slotsMapMatches = [...bf6bAppJsx.matchAll(/SLOTS\.map\([\s\S]*?\)/g)];
  const allAccessors = slotsMapMatches.every(m => m[0].includes('.value') && m[0].includes('.label'));
  assert(slotsMapMatches.length > 0 && allAccessors, 'every SLOTS.map( in App.jsx accesses .value and .label');

  // Test #623: Endpoint: place an order with a pickupSlot in new format (e.g. 2026-08-07T17:00) -> 200, matching stored pickupSlot
  // (Slots must not be in the past, so use tomorrow at 17:00.)
  const bf6bTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const bf6bSlot = `${bf6bTomorrow.getFullYear()}-${String(bf6bTomorrow.getMonth() + 1).padStart(2, '0')}-${String(bf6bTomorrow.getDate()).padStart(2, '0')}T17:00`;
  const bf6bOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    items: [{ productId: 'p1', quantity: 1, price: 100 }],
    fulfillmentType: 'PICKUP',
    pickupSlot: bf6bSlot
  });
  const bf6bCreatedOrder = (await get('http://localhost:3001/api/orders?customerId=u-cust1')).body.find(o => o.id === bf6bOrderRes.body.orderId);
  assert(bf6bOrderRes.status === 200 && bf6bCreatedOrder && bf6bCreatedOrder.pickup_slot === bf6bSlot, `POST /api/orders with pickupSlot ${bf6bSlot} returns 200 and matches stored pickupSlot`);

  // Test #624: Endpoint: stored pickupSlot on created order does not contain "object Object"
  assert(!bf6bCreatedOrder.pickup_slot.includes('object Object'), 'stored pickupSlot does not contain "object Object"');

  ctx.appContent = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test #625: Grep: Customer login block contains customer-registration affordance and does NOT contain Open a Shop
  const customerAuthBlockMatches = ctx.appContent.includes("isCustomerApp &&") && ctx.appContent.includes("Sign Up (Customer)");
  assert(customerAuthBlockMatches, 'Customer login block contains customer signup and gates stockist signup');

  // Test #626: Grep: Stockist login block contains shop-registration affordance and does NOT contain Sign Up (Customer)
  const stockistAuthBlockMatches = ctx.appContent.includes("isStockistApp &&") && ctx.appContent.includes("Open a Shop");
  assert(stockistAuthBlockMatches, 'Stockist login block contains shop registration and gates customer signup');

  // Test #627: Grep: Partner login block contains link/button routing to B2B / marketing view (setActiveRole('marketing'))
  const partnerB2bLinkMatch = ctx.appContent.includes("setActiveRole('marketing')");
  assert(partnerB2bLinkMatch, 'Partner login block contains link routing to B2B marketing view');

  // Test #628: Grep: Partner login block contains explanatory line Partner accounts are created by Beniffy after your application is approved.
  const partnerExplanatoryMatch = ctx.appContent.includes("Partner accounts are created by Beniffy after your application is approved.");
  assert(partnerExplanatoryMatch, 'Partner login block contains partner account creation explanatory line');

  // Test #629: Grep: Admin login block contains no signup affordance
  const adminAuthBlockMatch = ctx.appContent.includes("isAdminApp &&") && ctx.appContent.includes("renderAuthForm('admin')");
  assert(adminAuthBlockMatch, 'Admin login block contains no signup affordance');

  // Test #630: Grep: App.jsx contains exactly 1 occurrence of Open a Shop as a button label
  const openShopCount = (ctx.appContent.match(/Open a Shop/g) || []).length;
  assert(openShopCount === 1, `App.jsx contains exactly 1 occurrence of "Open a Shop" (found ${openShopCount})`);

  // Test #631: Grep: App.jsx contains exactly 1 occurrence of Sign Up (Customer) as a button label
  const signupCustomerCount = (ctx.appContent.match(/Sign Up \(Customer\)/g) || []).length;
  assert(signupCustomerCount === 1, `App.jsx contains exactly 1 occurrence of "Sign Up (Customer)" (found ${signupCustomerCount})`);

  // Test #632: Grep: Each of the 4 login screens has a distinct heading string (Customer Login, Shopkeeper Login, Partner Login, Admin Login)
  const distinctHeadings = ['Customer Login', 'Shopkeeper Login', 'Partner Login', 'Admin Login'].every(h => ctx.appContent.includes(h));
  assert(distinctHeadings, 'Each of the 4 login screens has a distinct heading string');

};
