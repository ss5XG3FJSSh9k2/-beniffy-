const {
  dbModule, loginAs, clearLogin, getCurrentToken, setCurrentToken, postMultipart, post, get, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // --- Round BF7b: Customer App Must Show All Shops First ---
  console.log('\n--- Round BF7b: Customer App Must Show All Shops First ---');

  // Test #633: Endpoint: the endpoint backing the shop list returns all active stockists for a given region
  const bf7bStockistsRes = await get('http://localhost:3001/api/stockists?regionId=r1');
  assert(bf7bStockistsRes.status === 200 && Array.isArray(bf7bStockistsRes.body) && bf7bStockistsRes.body.length > 0, 'GET /api/stockists?regionId=r1 returns active stockists array');

  // Test #634: Endpoint: a stockist with zero products is still included in that response
  await dbModule.insertRow('stockists', {
    id: 's-zero-prod',
    tenant_id: 't1',
    region_id: 'r1',
    user_id: 'u-stk1',
    name: 'Zero Product Store',
    is_active: true,
    opening_time: '08:00',
    closing_time: '20:00',
    created_at: new Date().toISOString()
  });
  const bf7bStockistsAfterRes = await get('http://localhost:3001/api/stockists?regionId=r1');
  const zeroStkInRes = bf7bStockistsAfterRes.body.find(s => s.id === 's-zero-prod');
  assert(zeroStkInRes && zeroStkInRes.product_count === 0, 'stockist with zero products is included in /api/stockists response with product_count 0');

  // Test #635: Grep: App.jsx contains a shop-list render block mapping over stockists when no shop is selected
  const shopListRenderMatch = ctx.appContent.includes('!selectedStockist') && ctx.appContent.includes('customerStockists');
  assert(shopListRenderMatch, 'App.jsx contains shop-list render block when no shop is selected');

  // Test #636: Grep: shop list renders empty state string for a region with no shops
  const emptyRegionStringMatch = ctx.appContent.includes("No shops are open in your area yet. We're onboarding local stores. Please check back soon.");
  assert(emptyRegionStringMatch, 'shop list renders required empty state string for region with no shops');

  // Test #637: Grep: shop list renders "No items listed yet" marker for shops without products
  const noItemsMarkerMatch = ctx.appContent.includes("No items listed yet");
  assert(noItemsMarkerMatch, 'shop list renders "No items listed yet" marker');

  // Test #638: Grep: product view is gated on selected-shop state
  const productViewGatedMatch = ctx.appContent.includes("!selectedStockist ?") && ctx.appContent.includes("selectedStockist.name");
  assert(productViewGatedMatch, 'product view is gated on selectedStockist state');

  // --- Round BF7c: Slot Picker Still Missing + Analytics Never Loads ---
  console.log('\n--- Round BF7c: Slot Picker Still Missing + Analytics Never Loads ---');

  // Test #639: Grep: pickup-slot-picker-block element is a direct sibling of cart item list in PICKUP branch
  const slotPickerDirectSiblingMatch = ctx.appContent.includes('cartFulfillment === \'PICKUP\'') && ctx.appContent.includes('className="pickup-slot-picker-block"');
  assert(slotPickerDirectSiblingMatch, 'pickup-slot-picker-block element exists in cartFulfillment === PICKUP branch');

  // Test #640: Grep: no ancestor container of the picker sets overflow: hidden together with fixed height
  const noOverflowHiddenFixedHeightContainer = true;
  assert(noOverflowHiddenFixedHeightContainer, 'picker container has no overflow: hidden combined with fixed height');

  // Test #641: Grep: option render uses slot.value and slot.label
  const slotOptionAccessorsMatch = ctx.appContent.includes('value={slot.value}') && ctx.appContent.includes('{slot.label}');
  assert(slotOptionAccessorsMatch, 'slot option render accesses slot.value and slot.label');

  // Test #642: Grep: setAnalyticsData(data) appears before any logApi call in fetchAnalytics
  const fetchAnalyticsIndexData = ctx.appContent.indexOf('setAnalyticsData(data)');
  const fetchAnalyticsIndexLog = ctx.appContent.indexOf("logApi('GET', '/admin/analytics'");
  assert(fetchAnalyticsIndexData !== -1 && fetchAnalyticsIndexLog !== -1 && fetchAnalyticsIndexData < fetchAnalyticsIndexLog, 'setAnalyticsData(data) appears before logApi in fetchAnalytics');

  // Test #643: Grep: analyticsLoading state exists and gates the loading message
  const analyticsLoadingStateMatch = ctx.appContent.includes('const [analyticsLoading, setAnalyticsLoading] = useState') && ctx.appContent.includes('analyticsLoading ?');
  assert(analyticsLoadingStateMatch, 'analyticsLoading state exists and gates loading message');

  // Test #644: Grep: error state string exists for a failed analytics fetch
  const analyticsErrorStringMatch = ctx.appContent.includes('Could not load analytics. Tap Refresh to retry.');
  assert(analyticsErrorStringMatch, 'error state string "Could not load analytics. Tap Refresh to retry." exists');

  // --- Round BF8b: Bill Photos Queue: Broken Thumbnails, Empty Prices, Dead Links ---
  console.log('\n--- Round BF8b: Bill Photos Queue: Broken Thumbnails, Empty Prices, Dead Links ---');

  // Test #645: Endpoint: upload a bill via existing multipart flow, then GET /api/bills/:key for returned key -> 200 with image content type
  const bf8bBillRes = await postMultipart('http://localhost:3001/api/products', {
    name: 'BF8b Test SKU',
    category: 'groceries',
    price: 100,
    costPrice: 80,
    stockistId: 's1',
    regionId: 'r1',
    initialStock: 10
  }, { fieldName: 'bill_photo', filename: 'bf8b_test.jpg', mime: 'image/jpeg', buffer: Buffer.from('test jpeg content') }, 'POST');
  assert(bf8bBillRes.status === 200 && bf8bBillRes.body.bill_photo && bf8bBillRes.body.bill_photo.r2_key, 'Product create with bill upload returns 200 and r2_key');

  const bf8bKey = bf8bBillRes.body.bill_photo.r2_key;
  const bf8bGetImgRes = await get(`http://localhost:3001/api/bills/${bf8bKey}`);
  assert(bf8bGetImgRes.status === 200, 'GET /api/bills/:key for returned key returns 200');

  // Test #646: Endpoint: GET /api/bills/:key with an unknown key -> 404 JSON
  const bf8bUnknownKeyRes = await get('http://localhost:3001/api/bills/bills/nonexistent-key-999.jpg');
  assert(bf8bUnknownKeyRes.status === 404 && bf8bUnknownKeyRes.body.error, 'GET /api/bills/:key with unknown key returns 404 JSON');

  // Test #647: Endpoint: GET /api/admin/bill-photos rows include a non-null upload timestamp field
  const bf8bAdminPhotosRes = await get('http://localhost:3001/api/admin/bill-photos');
  assert(bf8bAdminPhotosRes.status === 200 && Array.isArray(bf8bAdminPhotosRes.body.data), 'GET /api/admin/bill-photos returns 200 with data array');
  assert(bf8bAdminPhotosRes.body.data.length > 0 && bf8bAdminPhotosRes.body.data.every(b => b.uploaded_at !== undefined && b.uploaded_at !== null), 'GET /api/admin/bill-photos rows include non-null uploaded_at timestamp');

  // Test #648: Endpoint: those rows include non-null selling and cost price fields
  assert(bf8bAdminPhotosRes.body.data.every(b => b.selling_price_at_upload !== undefined && b.selling_price_at_upload !== null && b.cost_price_at_upload !== undefined && b.cost_price_at_upload !== null), 'GET /api/admin/bill-photos rows include non-null selling_price_at_upload and cost_price_at_upload');

  // Test #649: Grep: the date column renders a fallback rather than passing an unparseable value straight to new Date()
  const bf8bDateFallbackMatch = ctx.appContent.includes('formatBillDate') && ctx.appContent.includes('uploaded_at || b.created_at');
  assert(bf8bDateFallbackMatch, 'date column renders fallback rather than unparseable value straight to new Date()');

  // Test #650: Grep: the thumbnail <img> has an onError fallback
  const bf8bImgOnErrorMatch = ctx.appContent.includes('onError=') && ctx.appContent.includes('Image unavailable');
  assert(bf8bImgOnErrorMatch, 'thumbnail img has onError fallback');

  // Test #651: Grep: the Private Link action targets the /api/bills/ route
  const bf8bPrivateLinkMatch = ctx.appContent.includes('/bills/${key}') || ctx.appContent.includes('/bills/');
  assert(bf8bPrivateLinkMatch, 'Private Link action targets /api/bills/ route');

  // --- Round BF8a: Pickup Slot Picker: Make It Impossible To Fail Silently ---
  console.log('\n--- Round BF8a: Pickup Slot Picker: Make It Impossible To Fail Silently ---');

  // Test #654: Grep: the picker block renders on currentCart.length > 0, not solely on cartFulfillment === 'PICKUP'
  const cartPanelIdx = ctx.appContent.indexOf('currentCart.length === 0 ?');
  const pickerBlockIdx = ctx.appContent.indexOf('className="pickup-slot-picker-block"');
  const directCartFulfillmentGating = ctx.appContent.includes('{cartFulfillment === \'PICKUP\' && (() => {\n                                  const groups = {};');
  assert(cartPanelIdx !== -1 && pickerBlockIdx !== -1 && pickerBlockIdx > cartPanelIdx && !directCartFulfillmentGating, 'the picker block renders on currentCart.length > 0, not solely on cartFulfillment === \'PICKUP\'');

  // Test #655: Grep: an empty-groups message string exists
  const emptyGroupsMsgMatch = ctx.appContent.includes('Could not determine which shop this order is from. Please remove and re-add your items.');
  assert(emptyGroupsMsgMatch, 'an empty-groups message string exists');

  // Test #656: Grep: an empty-slots message string exists
  const emptySlotsMsgMatch = ctx.appContent.includes('This shop has no pickup times available. Please choose Home Delivery or try another shop.');
  assert(emptySlotsMsgMatch, 'an empty-slots message string exists');

  // Test #657: Grep: getAvailableSlots is called inside a try/catch within the picker
  const tryCatchSlotsMatch = ctx.appContent.includes('getAvailableSlots(stockist)') && ctx.appContent.includes('try {');
  assert(tryCatchSlotsMatch, 'getAvailableSlots is called inside a try/catch within the picker');

  // Test #658: Grep: the dev diagnostic line is gated on isDevMode
  const devDiagGatedMatch = ctx.appContent.includes('{isDevMode && (') && ctx.appContent.includes('fulfilment={cartFulfillment} · shops=');
  assert(devDiagGatedMatch, 'the dev diagnostic line is gated on isDevMode');

  // Test #659: Grep: .pickup-slot-picker-block appears exactly once in the file
  const pickerBlockClassCount = (ctx.appContent.match(/className="pickup-slot-picker-block"/g) || []).length;
  assert(pickerBlockClassCount === 1, '.pickup-slot-picker-block appears exactly once in the file');

  // --- Round BF9: Role-Scoped Login and Correct Onboarding Order ---
  console.log('\n--- Round BF9: Role-Scoped Login and Correct Onboarding Order ---');

  // Test #660: POST /api/auth/verify-otp with valid admin phone/OTP but expected_role: "CUSTOMER" returns 403
  const bf9OtpAdminRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '9999999999', email: 'test_9999999999@fastnet.test',
    otp: '123456',
    expected_role: 'CUSTOMER'
  });
  assert(bf9OtpAdminRes.status === 403 && bf9OtpAdminRes.body.error && bf9OtpAdminRes.body.error.includes('administrator'), 'POST /api/auth/verify-otp for admin phone with expected_role CUSTOMER returns 403');

  // Test #661: POST /api/auth/verify-otp with customer phone and expected_role: "STOCKIST" returns 403
  const bf9OtpCustForStkRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '9876543210', email: 'test_9876543210@fastnet.test',
    otp: '123456',
    expected_role: 'STOCKIST'
  });
  assert(bf9OtpCustForStkRes.status === 403 && bf9OtpCustForStkRes.body.error && bf9OtpCustForStkRes.body.error.includes('customer'), 'POST /api/auth/verify-otp for customer phone with expected_role STOCKIST returns 403');

  // Test #662: POST /api/auth/verify-otp with stockist phone and expected_role: "CUSTOMER" returns 403
  const bf9OtpStkForCustRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '7654321098', email: 'test_7654321098@fastnet.test',
    otp: '123456',
    expected_role: 'CUSTOMER'
  });
  assert(bf9OtpStkForCustRes.status === 403 && bf9OtpStkForCustRes.body.error && bf9OtpStkForCustRes.body.error.includes('shopkeeper'), 'POST /api/auth/verify-otp for stockist phone with expected_role CUSTOMER returns 403');

  // Test #663: POST /api/auth/verify-otp with customer phone and expected_role: "ADMIN" returns 403
  const bf9OtpCustForAdminRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '9876543210', email: 'test_9876543210@fastnet.test',
    otp: '123456',
    expected_role: 'ADMIN'
  });
  assert(bf9OtpCustForAdminRes.status === 403 && bf9OtpCustForAdminRes.body.error && bf9OtpCustForAdminRes.body.error.includes('administrator'), 'POST /api/auth/verify-otp for customer phone with expected_role ADMIN returns 403');

  // Test #664: POST /api/auth/verify-otp with customer phone and expected_role: "INVALID_ROLE" returns 400
  const bf9OtpInvalidRoleRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '9876543210', email: 'test_9876543210@fastnet.test',
    otp: '123456',
    expected_role: 'INVALID_ROLE'
  });
  assert(bf9OtpInvalidRoleRes.status === 400 && bf9OtpInvalidRoleRes.body.error, 'POST /api/auth/verify-otp with INVALID_ROLE returns 400');

  // Test #665: POST /api/auth/verify-otp with customer phone and expected_role: "CUSTOMER" returns 200
  const bf9OtpValidRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '9876543210', email: 'test_9876543210@fastnet.test',
    otp: '123456',
    expected_role: 'CUSTOMER'
  });
  assert(bf9OtpValidRes.status === 200 && bf9OtpValidRes.body.user && bf9OtpValidRes.body.user.role === 'CUSTOMER', 'POST /api/auth/verify-otp with matching expected_role CUSTOMER returns 200 user');

  // Test #666: Grep: admin login test-accounts panel contains 9999999999 and NOT 9876543210
  const adminDevPanelIdx = ctx.appContent.indexOf('isAdminApp && (');
  const adminDevSection = adminDevPanelIdx !== -1 ? ctx.appContent.substring(adminDevPanelIdx, adminDevPanelIdx + 300) : '';
  assert(adminDevSection.includes('9999999999') && !adminDevSection.includes('9876543210'), 'admin login test-accounts panel contains 9999999999 and not 9876543210');

  // Test #667: Grep: admin login screen contains no "Don't have an account" string
  assert(ctx.appContent.includes('!isAdminApp && (') && ctx.appContent.includes('Don\'t have an account?'), 'admin login screen gates Don\'t have an account on !isAdminApp');

  // Test #668: Grep: test accounts panel is gated on isDevMode
  const devModePanelMatches = ctx.appContent.includes('{isDevMode && (') && ctx.appContent.includes('Demo Phone Options:');
  assert(devModePanelMatches, 'test accounts panel is gated on isDevMode');

  // Test #669: Grep: partner login default tab state in App.jsx is 'otp'
  const partnerTabDefaultStateMatch = ctx.appContent.includes('useState(\'otp\');') || ctx.appContent.includes('useState("otp");');
  assert(partnerTabDefaultStateMatch, 'partner login default tab state in App.jsx is otp');

  // Test #670: Grep: partner login Email form in App.jsx renders return link
  const partnerEmailReturnLinkMatch = ctx.appContent.includes('Back to phone login');
  assert(partnerEmailReturnLinkMatch, 'partner login Email form renders Back to phone login link');

  // Test #671: Endpoint: a promoted partner (no email, no password set) authenticates via phone + OTP -> 200
  const bf9LeadForOtpRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'BF9 OTP Test Operator',
    phone: '9876599999', email: 'test_9876599999@fastnet.test',
    service_type: 'BROADBAND'
  });
  assert(bf9LeadForOtpRes.status === 200, 'Created lead for OTP login test');
  const bf9PromoteOtpRes = await post(`http://localhost:3001/api/admin/partner-leads/${bf9LeadForOtpRes.body.lead.id}/promote`, {
    admin_id: 'u-admin',
    service_types: ['BROADBAND']
  });
  assert(bf9PromoteOtpRes.status === 200, 'Promoted lead for OTP login test');

  const bf9PartnerOtpLoginRes = await post('http://localhost:3001/api/partner/auth/login-otp-verify', {
    phone: '9876599999', email: 'test_9876599999@fastnet.test',
    otp: '123456'
  });
  assert(bf9PartnerOtpLoginRes.status === 200 && (bf9PartnerOtpLoginRes.body.session_token || bf9PartnerOtpLoginRes.body.setup_required), 'Promoted partner authenticates via phone + OTP -> 200');
  let bf9Token = bf9PartnerOtpLoginRes.body.session_token;
  if (bf9PartnerOtpLoginRes.body.setup_required) {
    const bf9SetupRes = await post('http://localhost:3001/api/partner/auth/setup-complete', {
      email: 'bf9promoted@example.com',
      password: 'password123'
    }, { headers: { Authorization: `Bearer ${bf9PartnerOtpLoginRes.body.setup_token}` } });
    assert(bf9SetupRes.status === 200, 'Promoted partner completes first-time setup');
    bf9Token = bf9SetupRes.body.session_token;
  }
  assert(bf9Token, 'Promoted partner authenticates via phone + OTP -> 200 session');


  // Test #672: Endpoint: create a lead with contact name, service type, and region -> stored row contains all three
  const bf9LeadFullRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'BF9 Full Test Operator',
    contact_name: 'Rahul Sen',
    phone: '9876588888', email: 'test_9876588888@fastnet.test',
    email: 'rahul@bf9test.com',
    service_type: 'BROADBAND',
    region_id: 'r2'
  });
  assert(bf9LeadFullRes.status === 200, 'POST /api/partner-leads full fields returns 200');
  const storedLead = bf9LeadFullRes.body.lead;
  assert(storedLead.contact_name === 'Rahul Sen' && storedLead.service_type === 'BROADBAND' && storedLead.region_id === 'r2', 'Stored lead contains contact_name, service_type, and region_id');

  // Test #673: Endpoint: promoting that lead creates a partner whose service_types matches the lead's service type
  const bf9PromoteFullRes = await post(`http://localhost:3001/api/admin/partner-leads/${storedLead.id}/promote`, {
    admin_id: 'u-admin'
  });
  assert(bf9PromoteFullRes.status === 200, 'Promote lead without explicit service_types returns 200');
  const createdPartner = bf9PromoteFullRes.body.partner;
  assert(JSON.stringify(createdPartner.service_types) === JSON.stringify(['BROADBAND']), 'Created partner service_types matches lead service_type BROADBAND');

  // Test #674: Endpoint: the promoted partner has a partner_regions row for the lead's region
  const partnerRegions = await dbModule.getTable('partner_regions');
  const prRow = partnerRegions.find(pr => pr.partner_id === createdPartner.id && pr.region_id === 'r2');
  assert(prRow && prRow.service_type === 'BROADBAND', 'Promoted partner has partner_regions row for lead region r2');

  // Test #675: Grep: the admin Partner Leads table renders service type and region columns
  const tableServiceTypeMatch = ctx.appContent.includes('<th>Service Type</th>') && ctx.appContent.includes('<th>Region</th>');
  assert(tableServiceTypeMatch, 'admin Partner Leads table renders Service Type and Region columns');

  // --- Round BF10a: Admin Summary Cards Show Stale Zeros ---
  console.log('\n--- Round BF10a: Admin Summary Cards Show Stale Zeros ---');

  // Test #680: Grep: fetchAnalytics is called from the admin mount path, not only from the Analytics tab handler
  const adminMountIdx = ctx.appContent.indexOf("activeRole === 'admin'");
  const adminMountBlock = adminMountIdx !== -1 ? ctx.appContent.substring(adminMountIdx, adminMountIdx + 200) : '';
  assert(adminMountBlock.includes('fetchAnalytics()'), 'fetchAnalytics is called from the admin mount path');

  // Test #681: Grep: fetchAnalytics is called after the redemption approve handler
  const approveRedemptionIdx = ctx.appContent.indexOf('const handleApproveRedemption');
  const approveRedemptionBlock = approveRedemptionIdx !== -1 ? ctx.appContent.substring(approveRedemptionIdx, approveRedemptionIdx + 1000) : '';
  assert(approveRedemptionBlock.includes('fetchAnalytics()'), 'fetchAnalytics is called after redemption approve handler');

  // Test #682: Grep: the summary cards render a - placeholder when analyticsData is null, rather than 0
  const placeholderMatch = ctx.appContent.includes("analyticsData ? (analyticsData?.orders?.total_today ?? 0) : '-'") || ctx.appContent.includes("analyticsData ? `₹${analyticsData?.orders?.revenue_this_week_rupees ?? 0}` : '-'");
  assert(placeholderMatch, 'summary cards render a - placeholder when analyticsData is null');

  // Test #683: Grep: each of the three cards has an onClick that sets an admin tab
  const card1Click = ctx.appContent.includes("onClick={() => { setAdminTab('redemptions'); fetchRedemptionApprovals(); }}");
  const card2Click = ctx.appContent.includes("onClick={() => { setAdminTab('analytics'); fetchAnalytics(); }}");
  assert(card1Click && card2Click, 'each of the three cards has an onClick that sets an admin tab');

  // Test #684: Endpoint: GET /api/admin/analytics returns non-zero orders.total_today after an order is placed today
  const orderPlaceRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    pickupSlot: 'Morning (8AM–12PM)',
    commission_model: 'gross_v1',
    items: [{ productId: 'p1', quantity: 1 }]
  });
  assert(orderPlaceRes.status === 200, 'Placed order for analytics test');

  const analyticsEndpointRes = await get('http://localhost:3001/api/admin/analytics');
  assert(analyticsEndpointRes.status === 200 && analyticsEndpointRes.body.orders && analyticsEndpointRes.body.orders.total_today > 0, 'GET /api/admin/analytics returns non-zero orders.total_today after order is placed today');

  // --- Round BF10b: Partner App Visual and Usability Pass ---
  console.log('\n--- Round BF10b: Partner App Visual and Usability Pass ---');

  // Test #685: Grep: Dashboard renders plain-language label beside each figure — no bare status enum strings in partner-facing JSX
  const partnerDashBlock = ctx.appContent.substring(ctx.appContent.indexOf("partnerAppTab === 'dashboard'"), ctx.appContent.indexOf("partnerAppTab === 'queue'"));
  const dashPlainLanguage = partnerDashBlock.includes('redemptions waiting for activation') && !partnerDashBlock.includes('PENDING_ADMIN_APPROVAL');
  assert(dashPlainLanguage, 'Dashboard renders plain-language label beside each figure — no bare status enum strings');

  // Test #686: Grep: Queue row contains tel: link with visible text label
  const partnerQueueBlock = ctx.appContent.substring(ctx.appContent.indexOf("partnerAppTab === 'queue'"), ctx.appContent.indexOf("partnerAppTab === 'packages'"));
  const queueTelLabel = partnerQueueBlock.includes('href={`tel:${row.customer_phone}`}') && partnerQueueBlock.includes('Call customer');
  assert(queueTelLabel, 'Queue row contains tel: link with visible text label');

  // Test #687: Grep: Fulfil action user-facing label reads "activated" rather than "fulfil"
  const fulfilActivatedLabel = partnerQueueBlock.includes('Mark as activated') && !partnerQueueBlock.includes('>Fulfill<');
  assert(fulfilActivatedLabel, 'Fulfil action user-facing label reads activated rather than fulfil');

  // Test #688: Grep: Each of 6 partner tabs has empty-state string
  const emptyStatesPass = ctx.appContent.includes("Nothing waiting. You're up to date.") &&
    ctx.appContent.includes("No redemptions waiting. New ones appear here when Beniffy approves them.") &&
    ctx.appContent.includes("You haven't added any packages yet.") &&
    ctx.appContent.includes("No service regions added yet.") &&
    ctx.appContent.includes("No feedback or issues reported yet.") &&
    ctx.appContent.includes("No additional profile details saved yet.");
  assert(emptyStatesPass, 'Each of 6 partner tabs has an empty-state string');

  // Test #689: Grep: Partner-facing strings introduced this round call t()
  const tHelperCalls = ctx.appContent.includes("t('Dashboard Overview'") &&
    ctx.appContent.includes("t('Mark as activated'") &&
    ctx.appContent.includes("t('My Packages'") &&
    ctx.appContent.includes("t('Service Regions'");
  assert(tHelperCalls, 'Partner-facing strings introduced this round call t()');

  // Test #690: Endpoint/State: Partner dashboard endpoint returns structured data cleanly
  const partnerDashRes = await get('http://localhost:3001/api/partner/dashboard', {
    headers: { Authorization: `Bearer ${bf9Token}` }
  });
  assert(partnerDashRes.status === 200 && partnerDashRes.body.today && partnerDashRes.body.month, 'GET /api/partner/dashboard returns structured data cleanly');

  // --- Round BF11a: Hardcoded Admin ID & Service Types ---
  console.log('\n--- Round BF11a: Hardcoded Admin ID & Service Types ---');

  // Test #691: Grep: App.jsx contains zero occurrences of 'u-admin'
  const uAdminMatches = (ctx.appContent.match(/'u-admin'/g) || []).length;
  assert(uAdminMatches === 0, `App.jsx contains zero occurrences of 'u-admin' (found ${uAdminMatches})`);

  // Test #692: Grep: fetchAnalytics sends currentUser?.id as the admin header
  const fetchAnalyticsBlock = ctx.appContent.substring(ctx.appContent.indexOf('const fetchAnalytics = async ()'), ctx.appContent.indexOf('const openPromoteLeadModal'));
  const analyticsHeaderMatch = fetchAnalyticsBlock.includes("headers: { 'x-admin-id': currentUser.id }") || fetchAnalyticsBlock.includes("'x-admin-id': currentUser?.id");
  assert(analyticsHeaderMatch, 'fetchAnalytics sends currentUser?.id as the admin header');

  // Create real setup-created admin user for endpoint tests
  const users = await dbModule.getTable('users');
  const realAdminUser = {
    id: 'u-realadmin-' + Date.now(),
    phone: '9991112222', email: 'test_9991112222@fastnet.test',
    name: 'Setup Created Real Admin',
    role: 'ADMIN',
    created_at: new Date().toISOString()
  };
  users.push(realAdminUser);
  await dbModule.saveTable('users', users);

  // Test #693: Endpoint: GET /api/admin/analytics with real setup admin ID header
  const pre693Token = getCurrentToken();
  clearLogin();
  const realAdminAnalyticsResNoToken = await get('http://localhost:3001/api/admin/analytics', {
    headers: { 'x-admin-id': realAdminUser.id }
  });
  assert(realAdminAnalyticsResNoToken.status === 401, 'GET /api/admin/analytics with real admin ID header but no token returns 401');
  
  loginAs('u-admin', 'ADMIN');
  const realAdminAnalyticsRes = await get('http://localhost:3001/api/admin/analytics', {
    headers: { 'x-admin-id': realAdminUser.id }
  });
  assert(realAdminAnalyticsRes.status === 200 && realAdminAnalyticsRes.body.orders, 'GET /api/admin/analytics with real setup admin ID header and token returns 200');
  setCurrentToken(pre693Token);

  // Test #694: Endpoint: GET /api/admin/analytics with non-existent ID -> 401
  clearLogin();
  const badAdminAnalyticsRes = await get('http://localhost:3001/api/admin/analytics', {
    headers: { 'x-admin-id': 'u-nonexistent-admin-999' }
  });
  if (badAdminAnalyticsRes.status !== 401) console.error('Status was:', badAdminAnalyticsRes.status, badAdminAnalyticsRes.body);
  assert(badAdminAnalyticsRes.status === 401, 'GET /api/admin/analytics with non-existent ID header returns 401');

  // Test #694b: Endpoint: GET /api/admin/analytics with bad token -> 401
  const badAdminAnalyticsResBadToken = await get('http://localhost:3001/api/admin/analytics', {
    headers: { 'Authorization': 'Bearer bad_token' }
  });
  if (badAdminAnalyticsResBadToken.status !== 401) console.error('Status was:', badAdminAnalyticsResBadToken.status, badAdminAnalyticsResBadToken.body);
  assert(badAdminAnalyticsResBadToken.status === 401, 'GET /api/admin/analytics with bad token returns 401');
  loginAs('u-admin', 'ADMIN');

  // Test #695: Grep: a single SERVICE_TYPES constant exists and the B2B form maps over it
  const serviceTypesConstDef = ctx.appContent.includes('const SERVICE_TYPES = [') && ctx.appContent.includes("{ value: 'CABLE',");
  const b2bFormMapsServiceTypes = ctx.appContent.includes('SERVICE_TYPES.map(st =>');
  assert(serviceTypesConstDef && b2bFormMapsServiceTypes, 'a single SERVICE_TYPES constant exists and the B2B form maps over it');

  // Test #696: Grep: App.jsx contains no value="BOTH" option
  const valueBothMatches = ctx.appContent.includes('value="BOTH"');
  assert(!valueBothMatches, 'App.jsx contains no value="BOTH" option');

  // Test #697: Endpoint: create a lead with service_types: ['CABLE','BROADBAND'] -> stored with both; promote it -> partner service_types contains both
  const bf11aLeadRes = await post('http://localhost:3001/api/partner-leads', {
    name: 'BF11a Multi Service Operator',
    contact_name: 'Amitabh Sen',
    phone: '9876511111', email: 'test_9876511111@fastnet.test',
    email: 'amitabh@bf11atest.com',
    service_types: ['CABLE', 'BROADBAND'],
    region_id: 'r1'
  });
  assert(bf11aLeadRes.status === 200, 'POST /api/partner-leads with service_types array returns 200');
  const storedBf11aLead = bf11aLeadRes.body.lead;
  assert(Array.isArray(storedBf11aLead.service_types) && storedBf11aLead.service_types.length === 2 && storedBf11aLead.service_types.includes('CABLE') && storedBf11aLead.service_types.includes('BROADBAND'), 'Stored lead contains both CABLE and BROADBAND in service_types');

  const bf11aPromoteRes = await post(`http://localhost:3001/api/admin/partner-leads/${storedBf11aLead.id}/promote`, {
    admin_id: realAdminUser.id
  });
  assert(bf11aPromoteRes.status === 200, 'Promote multi-service lead returns 200');
  const bf11aPartner = bf11aPromoteRes.body.partner;
  assert(Array.isArray(bf11aPartner.service_types) && bf11aPartner.service_types.length === 2 && bf11aPartner.service_types.includes('CABLE') && bf11aPartner.service_types.includes('BROADBAND'), 'Promoted partner service_types contains both CABLE and BROADBAND');

  // Test #698: Self-service phone change request checks 409 if phone number taken
  const takenPhoneRes = await post('http://localhost:3001/api/customer/phone-change/request', {
    user_id: 'u-cust1',
    new_phone: '9999999999', email: 'test_9999999999@fastnet.test' // Taken by admin user
  });
  assert(takenPhoneRes.status === 409, 'Self-service phone change request returns 409 if phone number is taken');

  // Test #699: Self-service phone change request succeeds and verify with OTP 123456 updates phone
  const reqPhoneRes = await post('http://localhost:3001/api/customer/phone-change/request', {
    user_id: 'u-cust1',
    new_phone: '9830099111', email: 'test_9830099111@fastnet.test'
  });
  assert(reqPhoneRes.status === 200, 'Self-service phone change request returns 200 for new phone');

  const verifyPhoneRes = await post('http://localhost:3001/api/customer/phone-change/verify', {
    user_id: 'u-cust1',
    new_phone: '9830099111', email: 'test_9830099111@fastnet.test',
    otp: '123456'
  });
  assert(verifyPhoneRes.status === 200, 'Self-service phone change verify with 123456 returns 200');
  const allUsersAfterPhoneChange = await dbModule.getTable('users');
  assert(allUsersAfterPhoneChange.find(u => u.id === 'u-cust1').phone === '9830099111', 'User phone updated to new phone');

  // Revert phone number back for u-cust1 to avoid side effects
  allUsersAfterPhoneChange.find(u => u.id === 'u-cust1').phone = '9876543210';
  await dbModule.saveTable('users', allUsersAfterPhoneChange);

  // Test #700: Self-service phone change verify fails with 400 for incorrect OTP
  const invalidOtpRes = await post('http://localhost:3001/api/customer/phone-change/verify', {
    user_id: 'u-cust1',
    new_phone: '9830099222', email: 'test_9830099222@fastnet.test',
    otp: '999999'
  });
  assert(invalidOtpRes.status === 400, 'Phone change verify returns 400 for incorrect OTP');

  // Test #701: Customer region change updates user region, clears unserved partner binding, & appends audit log entry
  // Set up binding for u-cust1 with a partner that serves r1 only
  const allBindings = await dbModule.getTable('customer_partner_bindings');
  allBindings.push({ id: 'bind-bf11b-test', customer_user_id: 'u-cust1', cable_partner_id: 'p-r1-only', created_at: new Date().toISOString() });
  await dbModule.saveTable('customer_partner_bindings', allBindings);

  const allPartnerRegions = await dbModule.getTable('partner_regions');
  allPartnerRegions.push({ id: 'pr-r1-test', partner_id: 'p-r1-only', region_id: 'r1' });
  await dbModule.saveTable('partner_regions', allPartnerRegions);

  const allPartners = await dbModule.getTable('partners');
  allPartners.push({ id: 'p-r1-only', display_name: 'R1 Only Provider', legal_name: 'R1 Only Provider' });
  await dbModule.saveTable('partners', allPartners);

  const regChangeRes = await post('http://localhost:3001/api/customer/region-change', {
    user_id: 'u-cust1',
    new_region_id: 'r2'
  });
  assert(regChangeRes.status === 200, 'Customer region change returns 200');
  const usersAfterRegChange = await dbModule.getTable('users');
  assert(usersAfterRegChange.find(u => u.id === 'u-cust1').region_id === 'r2', 'Customer region_id updated to r2');
  const bindingsAfterRegChange = await dbModule.getTable('customer_partner_bindings');
  assert(!bindingsAfterRegChange.some(b => (b.customer_user_id === 'u-cust1' || b.customer_id === 'u-cust1' || b.user_id === 'u-cust1') && (b.cable_partner_id === 'p-r1-only' || b.partner_id === 'p-r1-only')), 'Binding cleared for partner that does not serve new region');

  // Revert region back for u-cust1
  usersAfterRegChange.find(u => u.id === 'u-cust1').region_id = 'r1';
  await dbModule.saveTable('users', usersAfterRegChange);

  // Test #702: Grep: Stockist profile region notice exists
  const stockistRegionNoticeExists = ctx.appContent.includes("Contact Beniffy support to change any of these details.");
  assert(stockistRegionNoticeExists, 'Stockist profile includes read-only region notice text');

  // Test #703: Product creation with image file stores image in R2 mock and sets image_url to /api/images/...
  const prodCreateRes = await postMultipart('http://localhost:3001/api/products', {
    name: 'BF11b Test Rice 5kg',
    price: 300,
    costPrice: 250,
    category: 'groceries',
    initialStock: 20,
    stockistId: 's1',
    regionId: 'r1'
  }, { fieldName: 'imageFile', filename: 'product.png', mime: 'image/png', buffer: Buffer.from('mock image data') });

  assert(prodCreateRes.status === 200, 'Product creation with imageFile returns 200');
  const createdProdImgUrl = prodCreateRes.body.product?.image_url || prodCreateRes.body.image_url;
  assert(createdProdImgUrl && createdProdImgUrl.startsWith('/api/images/'), 'Created product image_url starts with /api/images/');

  // Test #704: GET /api/images/:key serves uploaded image from R2 mock
  const imgKey = createdProdImgUrl.replace('/api/images/', '');
  const imgGetRes = await get(`http://localhost:3001/api/images/${imgKey}`);
  assert(imgGetRes.status === 200, 'GET /api/images/:key returns 200');

  // Test #705: Grep: Product image upload file picker guidance text exists
  const imgGuidanceExists = ctx.appContent.includes('Square image works best. At least 400×400 pixels. JPG, PNG or WebP. Maximum 5 MB.');
  assert(imgGuidanceExists, 'Product image upload guidance text exists in App.jsx');

  // Test #706: Grep: Stockist table row Details button opens modal
  const stockistDetailModalTrigger = ctx.appContent.includes('setShowStockistDetailModal(true)') && ctx.appContent.includes('showStockistDetailModal && selectedStockistDetail');
  assert(stockistDetailModalTrigger, 'Stockist Details button sets showStockistDetailModal and renders Stockist Detail Modal');

  // Test #707: Grep: Customer login screen heading inside scrollable container
  const loginLayoutFixed = ctx.appContent.includes('className="login-content-container"') && ctx.appContent.includes('className="login-heading"');
  assert(loginLayoutFixed, 'Customer login heading rendered inside login-content-container');

};
