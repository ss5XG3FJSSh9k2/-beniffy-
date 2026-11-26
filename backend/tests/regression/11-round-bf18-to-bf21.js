const {
  fs, path, http, dbModule, getCurrentToken, post, get, assert, readBackendSource
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // Round BF18-9: Unapproved (PENDING) stockists filter & kyc_status badge derivation
  console.log('\n--- Round BF18-9: Stockists Inclusion Filter & Badge Derivation ---');

  // Test: All Stockists returns only APPROVED by default
  const defaultStksRes = await get('http://localhost:3001/api/admin/stockists');
  assert(defaultStksRes.status === 200 && Array.isArray(defaultStksRes.body), 'GET /api/admin/stockists returns 200 array');
  assert(defaultStksRes.body.length > 0, 'All Stockists default returns non-empty list');
  const allApprovedByDefault = defaultStksRes.body.every(s => s.kyc_status === 'APPROVED');
  assert(allApprovedByDefault, 'All Stockists returns only APPROVED by default');

  // Test: All Stockists with show_inactive returns APPROVED + DEACTIVATED only
  const deactStkRes = await post('http://localhost:3001/api/admin/stockists/s2/deactivate');
  assert(deactStkRes.status === 200, 'Deactivate stockist s2 succeeds');

  const inactiveStksRes = await get('http://localhost:3001/api/admin/stockists?include_inactive=true');
  assert(inactiveStksRes.status === 200 && Array.isArray(inactiveStksRes.body), 'GET /api/admin/stockists?include_inactive=true returns 200 array');
  const validStatusesOnly = inactiveStksRes.body.every(s => s.kyc_status === 'APPROVED' || s.kyc_status === 'DEACTIVATED');
  assert(validStatusesOnly, 'All Stockists with show_inactive returns APPROVED + DEACTIVATED only');
  const hasDeactivatedInList = inactiveStksRes.body.some(s => s.kyc_status === 'DEACTIVATED');
  assert(hasDeactivatedInList, 'Deactivated stockist appears in include_inactive list');

  // Reactivate s2
  await post('http://localhost:3001/api/admin/stockists/s2/reactivate');

  // Test: a PENDING stockist is absent from All Stockists in both modes
  const hasPendingDefault = defaultStksRes.body.some(s => s.kyc_status === 'PENDING' || s.user_id === 'u-stk3' || s.user_id === 'u-stk5');
  assert(!hasPendingDefault, 'a PENDING stockist is absent from All Stockists default mode');
  const hasPendingInactive = inactiveStksRes.body.some(s => s.kyc_status === 'PENDING' || s.user_id === 'u-stk3' || s.user_id === 'u-stk5');
  assert(!hasPendingInactive, 'a PENDING stockist is absent from All Stockists include_inactive mode');

  // Test: the status badge value derives from kyc_status for each of the five statuses
  const appCodeBf189 = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appCodeBf189.includes('renderKycStatusBadge'), 'App.jsx contains renderKycStatusBadge helper');
  assert(appCodeBf189.includes('ACTIVE') && appCodeBf189.includes('INACTIVE') && appCodeBf189.includes('PENDING'), 'App.jsx badge helper handles ACTIVE, INACTIVE, PENDING');
  assert(appCodeBf189.includes('REJECTED') && appCodeBf189.includes('BLACKLISTED'), 'App.jsx badge helper handles REJECTED, BLACKLISTED');
  assert(appCodeBf189.includes("ACTIVE_LIST_STATUSES = ['APPROVED']"), "App.jsx uses inclusion list ACTIVE_LIST_STATUSES = ['APPROVED']");

  // Round BF18-1b: Blacklisted & Rejected Panel Robustness
  console.log('\n--- Round BF18-1b: Blacklisted & Rejected Panel Robustness ---');

  // Reject a stockist and blacklist a stockist for test coverage
  await post('http://localhost:3001/api/admin/kyc/u-stk3/reject', { reason: 'Illegible ID photo' });
  await post('http://localhost:3001/api/admin/kyc/u-stk1/blacklist', { reason: 'Duplicate document fraud' });

  const bf1bBlRes = await get('http://localhost:3001/api/admin/blacklist');
  assert(bf1bBlRes.status === 200 && bf1bBlRes.body.success && Array.isArray(bf1bBlRes.body.blacklist), 'GET /api/admin/blacklist returns 200 with blacklist array');

  const blacklistItems = bf1bBlRes.body.blacklist;
  const rejectedRow = blacklistItems.find(r => r.kyc_status === 'REJECTED');
  const blacklistedRow = blacklistItems.find(r => r.kyc_status === 'BLACKLISTED');

  assert(rejectedRow, 'Blacklist endpoint returns a rejected row');
  assert(blacklistedRow, 'Blacklist endpoint returns a blacklisted row');

  // Test: the list endpoint returns the same field set for both row types, nulls included
  const expectedKeys = ['id', 'user_id', 'name', 'phone', 'role', 'type', 'kyc_status', 'reason', 'blacklisted_at', 'blacklisted_by', 'blacklist_until', 'repeat_rejection'];
  const rejectedHasAllKeys = expectedKeys.every(k => Object.prototype.hasOwnProperty.call(rejectedRow, k));
  const blacklistedHasAllKeys = expectedKeys.every(k => Object.prototype.hasOwnProperty.call(blacklistedRow, k));
  assert(rejectedHasAllKeys, 'Rejected row returns normalized field set with nulls where applicable');
  assert(blacklistedHasAllKeys, 'Blacklisted row returns normalized field set with nulls where applicable');
  assert(rejectedRow.blacklist_until === null, 'Rejected row has null blacklist_until expiry');

  // Test: App.jsx contains PanelErrorBoundary and safe rendering for rejected / blacklisted rows
  const appCodeBf1b = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appCodeBf1b.includes('PanelErrorBoundary'), 'App.jsx contains PanelErrorBoundary component');
  assert(appCodeBf1b.includes('No reason recorded'), 'App.jsx handles missing reason with No reason recorded fallback');
  assert(appCodeBf1b.includes('Array.isArray(blacklistedUsers)'), 'App.jsx safely handles blacklistedUsers response array/object structure');

  // Round BF18-10: Partner Login UI & Security Non-Enumeration
  console.log('\n--- Round BF18-10: Partner Login UI & Security Non-Enumeration ---');

  const appCodeBf1810 = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  // Test: the partner login page does not render an email tab by default
  assert(!appCodeBf1810.includes("disabled={!partnerSetupCompleted}"), 'partner login page does not render an email tab by default');
  assert(appCodeBf1810.includes("partnerLoginTab === 'password'"), 'partner login supports switching login forms');

  // Test: the email form is reachable through the link
  assert(appCodeBf1810.includes("Already set up email login? Sign in with email"), 'the email form link Sign in with email is present');
  assert(appCodeBf1810.includes("Back to phone login"), 'the return link Back to phone login is present');

  // Test: the email login endpoint returns the same generic error for an unknown email and for a known partner with no password set
  const unknownEmailRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'nonexistent-partner@example.com',
    password: 'Password123!'
  });
  assert(unknownEmailRes.status === 401 && unknownEmailRes.body.error === 'Invalid credentials', 'Unknown email login returns 401 Invalid credentials');

  const noPasswordUserRes = await post('http://localhost:3001/api/partner/auth/login-password', {
    email: 'adhya@fastnet.com',
    password: 'Password123!'
  });
  assert(noPasswordUserRes.status === 401 && noPasswordUserRes.body.error === 'Invalid credentials', 'Known partner email with no password returns 401 Invalid credentials (no enumeration difference)');

  // Round BF19: No duplicate route registrations
  console.log('\n--- Round BF19: No Duplicate Route Registrations ---');

  // Test: assertNoDuplicateRoutes exists and is exported
  const { assertNoDuplicateRoutes } = require('../../server.js');
  assert(typeof assertNoDuplicateRoutes === 'function', 'assertNoDuplicateRoutes is exported as a function');

  // Test: calling assertNoDuplicateRoutes on the real app does NOT throw (all dupes removed)
  let noDupeError = null;
  try { assertNoDuplicateRoutes(); } catch (e) { noDupeError = e; }
  assert(noDupeError === null, 'assertNoDuplicateRoutes does not throw on the live app (no duplicates)');

  // Test: assertNoDuplicateRoutes DOES throw when given a mock app with duplicate routes
  const express = require('express');
  const mockApp = express();
  mockApp.get('/api/test/dup', (req, res) => res.json({}));
  mockApp.get('/api/test/dup', (req, res) => res.json({}));
  let dupeError = null;
  try { assertNoDuplicateRoutes(mockApp); } catch (e) { dupeError = e; }
  assert(dupeError !== null && dupeError.message.includes('Duplicate route registrations detected'), 'assertNoDuplicateRoutes throws on duplicate routes');

  // Test: server.js no longer contains blacklisted_until field writes
  const serverCodeBf19 = readBackendSource();
  assert(!serverCodeBf19.includes('blacklisted_until'), 'server.js contains zero references to blacklisted_until');

  // Round BF20: OTP Rate Limiter Verification & Multi-Role Testing
  console.log('\n--- Round BF20: OTP Rate Limiter & Window Tuning ---');

  // Test: 6 sends without verification trips the limit (refusal states 15 minutes)
  await post('http://localhost:3001/api/admin/clear-rate-limits', {});
  const bf20TestPhone = '9876543210';
  for (let i = 1; i <= 5; i++) {
    const res = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
    assert(res.status === 200 && res.body.success, `OTP send #${i} succeeds`);
  }
  const bf20SixthSend = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
  assert(bf20SixthSend.status === 429, '6 sends without verification trips the limit');
  assert(bf20SixthSend.body.error && bf20SixthSend.body.error.includes('15 minutes'), 'Refusal message states 15 minutes, not 1 hour');
  assert(typeof bf20SixthSend.body.retry_after === 'number', 'Response contains numeric retry_after timestamp');

  // Test: failed verification does NOT clear the counter (6th send is still refused)
  const bf20WrongVerify = await post('http://localhost:3001/api/auth/verify-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test', otp: '999999' });
  assert(bf20WrongVerify.status === 400, 'failed verification returns 400');
  const bf20SendAfterFailedVerify = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
  assert(bf20SendAfterFailedVerify.status === 429, 'failed verification does NOT clear the counter');

  // Test: successful verification clears that phone's OTP counter (5 more immediately allowed)
  await post('http://localhost:3001/api/admin/clear-rate-limits', {});
  for (let i = 1; i <= 5; i++) {
    const res = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
    assert(res.status === 200, `Initial send #${i} succeeds`);
  }
  const bf20SuccessVerify = await post('http://localhost:3001/api/auth/verify-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test', otp: '123456' });
  assert(bf20SuccessVerify.status === 200 && bf20SuccessVerify.body.token, 'OTP verification succeeds and issues token');
  // Immediately send 5 more - all 5 must succeed because counter was cleared
  for (let i = 1; i <= 5; i++) {
    const res = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
    assert(res.status === 200, `successful verification clears that phone's OTP counter (send #${i})`);
  }

  // Test: the 20/hour absolute cap trips regardless of successful verifications
  // We have sent 10 OTPs so far this hour for bf20TestPhone.
  // Verify and send 5 more (total 15), then verify and send 5 more (total 20).
  await post('http://localhost:3001/api/auth/verify-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test', otp: '123456' });
  for (let i = 11; i <= 15; i++) {
    const res = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
    assert(res.status === 200, `Send #${i} succeeds under hourly cap`);
  }
  await post('http://localhost:3001/api/auth/verify-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test', otp: '123456' });
  for (let i = 16; i <= 20; i++) {
    const res = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
    assert(res.status === 200, `Send #${i} succeeds at hourly cap`);
  }
  // Now verify again (so short counter is cleared) and attempt the 21st send
  await post('http://localhost:3001/api/auth/verify-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test', otp: '123456' });
  const bf20TwentyFirstSend = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
  assert(bf20TwentyFirstSend.status === 429, 'the 20/hour absolute cap trips regardless of successful verifications');
  assert(bf20TwentyFirstSend.body.error && bf20TwentyFirstSend.body.error.includes('Too many OTP requests'), 'Hourly cap returns error message with remaining time');
  assert(typeof bf20TwentyFirstSend.body.retry_after === 'number', 'Hourly cap returns retry_after timestamp');

  // Test: clear-rate-limits returns 403 when NODE_ENV=production
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const bf20ProdClear = await post('http://localhost:3001/api/admin/clear-rate-limits', {}, { headers: { 'x-node-env': 'production', 'x-forwarded-proto': 'https' } });
  assert(bf20ProdClear.status === 403 && bf20ProdClear.body.error === 'Not allowed in production', 'clear-rate-limits returns 403 when NODE_ENV=production');
  process.env.NODE_ENV = prevEnv;

  // Clear rate limits in dev to verify immediate unblock
  const bf20DevClear = await post('http://localhost:3001/api/admin/clear-rate-limits', {});
  assert(bf20DevClear.status === 200 && bf20DevClear.body.success, 'POST /api/admin/clear-rate-limits succeeds in dev');
  const bf20UnblockedSend = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
  assert(bf20UnblockedSend.status === 200, 'OTP send unblocked immediately after clear-rate-limits');

  // Test: the empty-users-table bypass still permits first-run setup
  const existingUsers = await dbModule.getTable('users');
  await dbModule.saveTable('users', []);
  for (let i = 1; i <= 8; i++) {
    const emptyBypassRes = await post('http://localhost:3001/api/auth/send-otp', { phone: '9999911111', email: 'test_9999911111@fastnet.test' });
    assert(emptyBypassRes.status === 200, `the empty-users-table bypass still permits first-run setup (attempt #${i})`);
  }
  await dbModule.saveTable('users', existingUsers);
  await post('http://localhost:3001/api/admin/clear-rate-limits', {});

  // Test: verification step 1: log in and out 6 times in a row with verification -> all succeed
  for (let i = 1; i <= 6; i++) {
    const sendRes = await post('http://localhost:3001/api/auth/send-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test' });
    assert(sendRes.status === 200, `Login and out step #${i} send-otp succeeds`);
    const verifyRes = await post('http://localhost:3001/api/auth/verify-otp', { phone: bf20TestPhone, email: 'test_' + bf20TestPhone + '@fastnet.test', otp: '123456' });
    assert(verifyRes.status === 200 && verifyRes.body.token, `Login and out step #${i} verify-otp succeeds`);
  }

  // Round BF21-A: Wholesaler Region Name Lookup
  console.log('\n--- Round BF21-A: Wholesaler Region Name Lookup ---');

  // Test: Register four wholesalers in four different regions -> all store submitted region_id
  const testVendorRegions = ['r1', 'r2', 'r-north', 'r-east'];
  const createdVendors = [];
  for (const regId of testVendorRegions) {
    const vRes = await post('http://localhost:3001/api/admin/vendors', {
      name: `Wholesaler for ${regId}`,
      regionId: regId
    });
    assert(vRes.status === 200 && vRes.body.success, `Vendor for ${regId} registered successfully`);
    assert(vRes.body.vendor.region_id === regId, `Vendor has correct region_id ${regId}`);
    createdVendors.push(vRes.body.vendor);
  }

  // Test: GET /api/admin/vendors returns all four with distinct region_id values
  const allVendorsRes = await new Promise((resolve) => {
    http.get('http://localhost:3001/api/admin/vendors', { headers: { Authorization: 'Bearer ' + getCurrentToken() } }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
  });
  assert(allVendorsRes.status === 200, 'GET /api/admin/vendors returns 200');
  for (const regId of testVendorRegions) {
    const found = allVendorsRes.body.find(v => v.region_id === regId);
    assert(Boolean(found), `Wholesaler list contains vendor with region_id ${regId}`);
  }

  // Test: App.jsx does NOT contain hardcoded ternary for wholesaler region
  const appJsxBf21a = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!appJsxBf21a.includes("v.region_id === 'r1' ? 'Kolkata South' : 'Rural West Bengal'"), 'App.jsx does not use hardcoded ternary for wholesaler region');
  assert(appJsxBf21a.includes("regions.find(r => r.id === v.region_id)") || appJsxBf21a.includes("regions.find"), 'App.jsx resolves wholesaler region from regions list');

  // Round BF21-B: Stockist Details Modal Key Mappings
  console.log('\n--- Round BF21-B: Stockist Details Modal Key Mappings ---');

  // Test: GET /api/admin/stockists/:id returns user_phone and stockist.commission_rate
  const stockistDetailRes = await new Promise((resolve) => {
    http.get('http://localhost:3001/api/admin/stockists/s1', { headers: { Authorization: 'Bearer ' + getCurrentToken() } }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
  });
  assert(stockistDetailRes.status === 200, 'GET /api/admin/stockists/s1 returns 200');
  assert(stockistDetailRes.body.user_phone !== undefined || (stockistDetailRes.body.user && stockistDetailRes.body.user.phone !== undefined), 'Stockist detail response contains user_phone or user.phone');
  assert(stockistDetailRes.body.stockist && stockistDetailRes.body.stockist.commission_rate !== undefined, 'Stockist detail response contains stockist.commission_rate');

  // Test: App.jsx binds phone with tel: link
  const appJsxBf21b = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appJsxBf21b.includes('user_phone') && appJsxBf21b.includes('href={`tel:${phone}`}'), 'App.jsx maps user_phone and renders a tel: link');
  assert(appJsxBf21b.includes('stockist?.commission_rate'), 'App.jsx maps commission_rate from stockist.commission_rate');
  assert(!appJsxBf21b.includes('{selectedStockistDetail.commission_rate}%'), 'App.jsx does not render bare % without fallback check');

  // Round BF21-C: Add SKU Form Bounded Scroll & phone-screen Consolidation
  console.log('\n--- Round BF21-C: Add SKU Form Bounded Scroll & phone-screen Consolidation ---');

  // Test #922: index.css has single consolidated .phone-screen definition
  const indexCssBf21c = fs.readFileSync(path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');
  const phoneScreenMatches = indexCssBf21c.match(/\.phone-screen\s*\{/g);
  assert(phoneScreenMatches && phoneScreenMatches.length === 1, 'index.css has exactly one consolidated .phone-screen definition');

  // Test #923: consolidated .phone-screen contains padding-top: 16px
  const phoneScreenBlock = indexCssBf21c.match(/\.phone-screen\s*\{[^}]*\}/s);
  assert(phoneScreenBlock && phoneScreenBlock[0].includes('padding-top: 16px'), 'consolidated .phone-screen contains padding-top: 16px');

  // Test #924: Add SKU modal container in App.jsx has bounded scrolling (overflowY: 'auto' and WebkitOverflowScrolling)
  const appJsxBf21c = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appJsxBf21c.includes("showAddProductModal && (") && appJsxBf21c.includes("overflowY: 'auto'") && appJsxBf21c.includes("WebkitOverflowScrolling: 'touch'"), 'Add SKU modal container has bounded overflowY: auto and WebkitOverflowScrolling: touch');

  // Test #925: Add SKU modal overlay does not use clipping justifyContent: 'center'
  const addModalIdx = appJsxBf21c.indexOf('{showAddProductModal && (');
  const addModalChunk = appJsxBf21c.slice(addModalIdx, addModalIdx + 400);
  assert(!addModalChunk.includes("justifyContent: 'center'"), 'Add SKU modal overlay does not use clipping justifyContent: center');

  // Test #926: Edit SKU modal container also has bounded scrolling
  const editModalIdx = appJsxBf21c.indexOf('{editingProduct && (');
  const editModalChunk = appJsxBf21c.slice(editModalIdx, editModalIdx + 400);
  assert(editModalChunk.includes("overflowY: 'auto'") && editModalChunk.includes("WebkitOverflowScrolling: 'touch'"), 'Edit SKU modal container has bounded scrolling');

  // TESTER-18: KYC ID Lookup Endpoint
  console.log('\n--- TESTER-18: KYC ID Lookup Endpoint ---');
  const kycLookupInvalid = await get('http://localhost:3001/api/admin/stockists/lookup-by-id?kyc_id=123');
  assert(kycLookupInvalid.status === 400, 'KYC ID lookup with length < 12 returns 400');
  
  const kycLookupUnknown = await get('http://localhost:3001/api/admin/stockists/lookup-by-id?kyc_id=999999999999');
  assert(kycLookupUnknown.status === 404, 'KYC ID lookup for unknown ID returns 404');
  
  const auditLogAfterLookup = await get('http://localhost:3001/api/admin/audit-log');
  assert(auditLogAfterLookup.body.some(a => a.action === 'SEARCH_KYC_ID' && a.before && a.before.query === '999999999999'), 'Audit log contains SEARCH_KYC_ID entry for the lookup');

  // Test #933: Admin Transactions table overflow fix (BF-TXN-ALIGN)
  console.log('\n--- BF-TXN-ALIGN: Admin Transactions table overflow fix ---');
  const indexCssBfTxn = fs.readFileSync(path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');
  assert(indexCssBfTxn.includes('minmax(0, 1fr)'), 'index.css contains minmax(0, 1fr) for admin-grid');
  
  const appJsxBfTxn = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(appJsxBfTxn.includes("overflowX: 'auto'") && appJsxBfTxn.includes("minWidth: '1100px'"), 'Transactions section in App.jsx contains the overflowX wrapper and minWidth on stockist table');

  // Test #935: BF-GR-UI Generic Reward Modal Redesign
  console.log('\n--- BF-GR-UI: Generic Reward Modal Redesign ---');
  ctx.appJsxBfGr = appJsxBfTxn; // reuse
  
  const grModalIdx = ctx.appJsxBfGr.indexOf('{showGenericRewardModal && (');
  const grModalChunk = ctx.appJsxBfGr.slice(grModalIdx, grModalIdx + 25000);
  
  assert(grModalChunk.includes('reward-modal'), 'Modal contains className reward-modal');
  assert(!grModalChunk.includes('className="input"'), 'Modal does NOT contain className="input"');
  
  const indexCssBfGr = fs.readFileSync(path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');
  assert(indexCssBfGr.includes('.reward-modal'), 'index.css contains .reward-modal rule');
  
  const countAdminTabGR = (ctx.appJsxBfGr.match(/adminTab === 'generic_rewards' && \(/g) || []).length;
  assert(countAdminTabGR === 1, "adminTab === 'generic_rewards' && ( appears exactly once in App.jsx");
  
  assert((grModalChunk.match(/name="is_active"/g) || []).length >= 2, 'Modal contains name="is_active" for both add and edit modes');

};
