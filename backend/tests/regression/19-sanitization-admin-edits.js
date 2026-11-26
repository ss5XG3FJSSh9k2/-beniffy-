const {
  dbModule, loginAs, clearLogin, post, patch, get, state, assert, readBackendSource
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // ==========================================
  // HTML ENTITY SANITIZATION & UNESCAPING TESTS
  // ==========================================
  console.log('\n--- Testing HTML Entity Sanitization & Unescaping ---');

  // Test 1: Customer registration with quotes/apostrophes/ampersands stores literal text, not HTML entities
  clearLogin();
  const rawLitName = "Joseph D'Souza";
  const rawLitAddr = "Shop 3 & 4";
  const regLitPhone = '9831999888';
  const regLitRes = await post('http://localhost:3001/api/auth/register-customer', {
    phone: regLitPhone,
    email: 'test_dsouza@fastnet.test',
    name: rawLitName,
    address: rawLitAddr,
    region_id: 'r1',
    termsAgreed: true
  });
  assert(regLitRes.status === 200, 'Customer registration with quotes and ampersands succeeds');
  assert(regLitRes.body.user.name === "Joseph D'Souza", 'Registered name matches exact literal string "Joseph D\'Souza" without entity escaping');
  assert(!regLitRes.body.user.name.includes('&#039;') && !regLitRes.body.user.name.includes('&#39;'), 'Registered name does not contain &#39;');
  assert(!regLitRes.body.user.name.includes('&amp;'), 'Registered name does not contain &amp;');
  assert(regLitRes.body.user.address === "Shop 3 & 4", 'Registered address matches exact literal string "Shop 3 & 4" without entity escaping');
  assert(!regLitRes.body.user.address.includes('&amp;'), 'Registered address does not contain &amp;');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer registration stores literal "Joseph D'Souza" and "Shop 3 & 4" without HTML entities`);

  // Test 2: Customer profile update preserves quotes and ampersands as literal text
  loginAs(regLitRes.body.user.id, 'CUSTOMER');
  const updatedLitName = "Joseph D'Souza";
  const updatedLitAddr = "Shop 3 & 4, Station Road";
  const updateLitRes = await post(`http://localhost:3001/api/customer/${regLitRes.body.user.id}/profile`, {
    name: updatedLitName,
    address: updatedLitAddr
  });
  assert(updateLitRes.status === 200, 'Profile update returns 200');
  assert(updateLitRes.body.user && updateLitRes.body.user.name === "Joseph D'Souza", 'Updated profile name returns exact literal "Joseph D\'Souza"');
  assert(updateLitRes.body.user && updateLitRes.body.user.address === "Shop 3 & 4, Station Road", 'Updated profile address returns exact literal "Shop 3 & 4, Station Road"');
  assert(!updateLitRes.body.user.name.includes('&#39;') && !updateLitRes.body.user.name.includes('&amp;'), 'No entity escapes in updated name');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer profile update preserves literal "Joseph D'Souza" and "Shop 3 & 4, Station Road"`);

  // Test 2b: Email containing address renders escaped HTML without double escaping
  const escapedAddrForEmail = ctx.serverModule.escapeHtml(updateLitRes.body.user.address);
  const emailHtml = `<p>Delivery address: ${escapedAddrForEmail}</p>`;
  assert(escapedAddrForEmail === "Shop 3 &amp; 4, Station Road", 'escapeHtml properly escapes & to &amp; for email rendering');
  assert(emailHtml === "<p>Delivery address: Shop 3 &amp; 4, Station Road</p>", 'Email HTML contains correctly escaped address');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Email containing address renders correctly escaped HTML`);

  // Test 3: Plain-text sanitization: trims trailing spaces, removes CRLF / ASCII control chars, enforces maxLen, preserves Unicode
  const dirtyName = "   Rahul  Sharma \r\n\t \x00\x08   ";
  const hindiName = "राहुल & शर्मा (दुकान)";
  const bengaliName = "রাহুল & শর্মা 'দোকান'";
  const sanitizedDirty = ctx.serverModule.sanitizePlainText ? ctx.serverModule.sanitizePlainText(dirtyName, 50) : null;
  assert(sanitizedDirty === "Rahul  Sharma", 'sanitizePlainText trims and removes CRLF/control chars');
  const sanitizedHindi = ctx.serverModule.sanitizePlainText ? ctx.serverModule.sanitizePlainText(hindiName, 50) : null;
  assert(sanitizedHindi === hindiName, 'sanitizePlainText preserves Hindi characters and ampersand');
  const sanitizedBengali = ctx.serverModule.sanitizePlainText ? ctx.serverModule.sanitizePlainText(bengaliName, 50) : null;
  assert(sanitizedBengali === bengaliName, 'sanitizePlainText preserves Bengali characters, quotes and ampersand');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: sanitizePlainText helper correctly strips control chars and preserves non-ASCII/quotes/ampersands`);

  // Test 4: Startup repair / data repair for existing HTML-escaped user fields in database
  // Insert a mock user directly with HTML-escaped entities
  const legacyEscapedUser = {
    id: 'u-escaped-legacy',
    phone: '9831999777',
    name: "O&#039;Connor &amp; Sons &quot;Pvt&quot; Ltd",
    address: "Flat 4, 3&#039;rd Cross &amp; 4&#x27;th Main",
    role: 'CUSTOMER',
    region_id: 'r1',
    created_at: new Date().toISOString()
  };
  await dbModule.insertRow('users', legacyEscapedUser);

  // Run repairHtmlEscapedUserFields directly
  const repairedCount = await dbModule.repairHtmlEscapedUserFields(dbModule);
  assert(repairedCount >= 1, 'repairHtmlEscapedUserFields repaired at least 1 legacy user');

  const repairedUsers = await dbModule.getTable('users');
  const checkedUser = repairedUsers.find(u => u.id === 'u-escaped-legacy');
  assert(checkedUser, 'Legacy user found in users table');
  assert(checkedUser.name === 'O\'Connor & Sons "Pvt" Ltd', `Legacy name unescaped properly: "${checkedUser.name}"`);
  assert(checkedUser.address === "Flat 4, 3'rd Cross & 4'th Main", `Legacy address unescaped properly: "${checkedUser.address}"`);
  assert(!checkedUser.name.includes('&#039;') && !checkedUser.name.includes('&amp;'), 'No HTML entities remain in user name');
  assert(!checkedUser.address.includes('&#039;') && !checkedUser.address.includes('&amp;'), 'No HTML entities remain in user address');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Startup repair unescapes legacy HTML entities into clean plain text`);

  // --- Admin User Edits Allowlist & Audit Logging ---
  console.log('\n--- Testing Admin User Edits Allowlist & Audit Logging ---');
  loginAs('u-admin', 'ADMIN');

  const usersBeforePatch = await dbModule.getTable('users');
  const targetUserBefore = usersBeforePatch.find(u => u.id === 'u-cust1');
  assert(targetUserBefore, 'Target customer u-cust1 exists');
  const originalRole = targetUserBefore.role;
  const originalKyc = targetUserBefore.kyc_status;
  const originalPasswordHash = targetUserBefore.password_hash;
  const originalName = targetUserBefore.name;

  // 1. Admin sends forbidden fields: role, kyc_status, password_hash
  const forbiddenPatchRes = await patch('http://localhost:3001/api/users/u-cust1', {
    role: 'ADMIN',
    kyc_status: 'APPROVED',
    password_hash: 'hacked_password_hash'
  });
  assert(forbiddenPatchRes.status === 200, `Admin PATCH with forbidden fields returns 200, got ${forbiddenPatchRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin PATCH with forbidden fields returns 200`);

  const usersAfterForbidden = await dbModule.getTable('users');
  const targetUserAfterForbidden = usersAfterForbidden.find(u => u.id === 'u-cust1');
  assert(targetUserAfterForbidden.role === originalRole, `role not modified (expected "${originalRole}", got "${targetUserAfterForbidden.role}")`);
  assert(targetUserAfterForbidden.kyc_status === originalKyc, `kyc_status not modified (expected "${originalKyc}", got "${targetUserAfterForbidden.kyc_status}")`);
  assert(targetUserAfterForbidden.password_hash === originalPasswordHash, `password_hash not modified (expected "${originalPasswordHash}", got "${targetUserAfterForbidden.password_hash}")`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: admin PATCH with {"role":"ADMIN","kyc_status":"APPROVED","password_hash":"x"} changes none of them`);

  // 2. Admin sends allowed field (name, address) alongside forbidden field (role)
  const auditLogsBefore = await dbModule.getTable('admin_audit_log');
  const auditCountBefore = auditLogsBefore.length;

  const allowedPatchRes = await patch('http://localhost:3001/api/users/u-cust1', {
    name: 'Amit Kumar Sen',
    address: '123 Garia Station Road',
    role: 'ADMIN',
    kyc_status: 'SUPER_ADMIN'
  });
  assert(allowedPatchRes.status === 200, `Admin PATCH with allowed fields returns 200, got ${allowedPatchRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin PATCH with allowed fields returns 200`);

  const usersAfterAllowed = await dbModule.getTable('users');
  const targetUserAfterAllowed = usersAfterAllowed.find(u => u.id === 'u-cust1');
  assert(targetUserAfterAllowed.name === 'Amit Kumar Sen', `name updated to "Amit Kumar Sen", got "${targetUserAfterAllowed.name}"`);
  assert(targetUserAfterAllowed.address === '123 Garia Station Road', `address updated to "123 Garia Station Road", got "${targetUserAfterAllowed.address}"`);
  assert(targetUserAfterAllowed.role === originalRole, `role remains "${originalRole}", not modified by PATCH`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Allowed fields change while disallowed fields in same request are ignored`);

  // 3. Verify audit log entry created with before and after
  const auditLogsAfter = await dbModule.getTable('admin_audit_log');
  assert(auditLogsAfter.length > auditCountBefore, 'Audit log count increased');
  const latestAudit = auditLogsAfter[auditLogsAfter.length - 1];
  assert(latestAudit.action === 'ADMIN_EDIT_USER', `Audit action is ADMIN_EDIT_USER, got "${latestAudit.action}"`);
  assert(latestAudit.entity_id === 'u-cust1', `Audit entity_id is u-cust1, got "${latestAudit.entity_id}"`);
  assert(latestAudit.before && latestAudit.before.name === originalName, `Audit before.name matches "${originalName}"`);
  assert(latestAudit.after && latestAudit.after.name === 'Amit Kumar Sen', `Audit after.name matches "Amit Kumar Sen"`);
  assert(latestAudit.after && latestAudit.after.address === '123 Garia Station Road', `Audit after.address matches "123 Garia Station Road"`);
  assert(!latestAudit.after.role, 'Disallowed role field is not present in audit after');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin edit is audited with before and after values`);

  // 4. Non-admin self update cannot modify protected fields
  loginAs('u-cust1', 'CUSTOMER');
  const custForbiddenRes = await patch('http://localhost:3001/api/users/u-cust1', {
    role: 'ADMIN'
  });
  assert(custForbiddenRes.status === 400, `Customer trying to modify protected field role returns 400, got ${custForbiddenRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer cannot modify protected field role (returns 400)`);

  const custAllowedRes = await patch('http://localhost:3001/api/users/u-cust1', {
    name: 'Amit Sen'
  });
  assert(custAllowedRes.status === 200, `Customer self-update with allowed field returns 200, got ${custAllowedRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer self-update with allowed field returns 200`);

  clearLogin();

  // Security checks: Stop exposing shop bank details and phone numbers publicly
  console.log('\n--- BF-STOCKIST-SECURITY: Public stockist sanitization & role-based order enrichment ---');

  // 1. GET /api/stockists (no auth)
  clearLogin();
  const pubStockistsRes = await get('http://localhost:3001/api/stockists?regionId=r1');
  assert(pubStockistsRes.status === 200, `GET /api/stockists returns 200, got ${pubStockistsRes.status}`);
  assert(Array.isArray(pubStockistsRes.body) && pubStockistsRes.body.length > 0, 'GET /api/stockists returns non-empty list');
  const sensitiveShopFields = [
    'payout_upi_id', 'payout_bank_account', 'payout_ifsc', 'payout_account_name',
    'phone', 'contact_phone', 'released_phone', 'user_id', 'commission_rate',
    'personal_name', 'shop_address', 'id_type', 'id_number'
  ];
  for (const s of pubStockistsRes.body) {
    for (const field of sensitiveShopFields) {
      assert(s[field] === undefined, `Public stockist ${s.id} must not expose ${field}`);
    }
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists does not expose sensitive bank or phone fields`);

  // 2. GET /api/stockists/:id (no auth)
  clearLogin();
  const pubStockistByIdRes = await get('http://localhost:3001/api/stockists/s1');
  assert(pubStockistByIdRes.status === 200, `GET /api/stockists/s1 returns 200, got ${pubStockistByIdRes.status}`);
  for (const field of sensitiveShopFields) {
    assert(pubStockistByIdRes.body[field] === undefined, `Public stockist s1 must not expose ${field}`);
  }
  assert(pubStockistByIdRes.body.id === 's1', 'Public stockist has id');
  assert(pubStockistByIdRes.body.name, 'Public stockist has name');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/:id does not expose sensitive bank or phone fields`);

  // 3. GET /api/stockists/by-user/:userId auth checks
  clearLogin();
  const noAuthByUserRes = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(noAuthByUserRes.status === 401, `GET /api/stockists/by-user/:userId without auth returns 401, got ${noAuthByUserRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/by-user/:userId without auth returns 401`);

  loginAs('u-cust1', 'CUSTOMER');
  const custForbiddenByUserRes = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(custForbiddenByUserRes.status === 403, `GET /api/stockists/by-user/:userId as customer returns 403, got ${custForbiddenByUserRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/by-user/:userId as customer returns 403`);

  loginAs('u-stk2', 'STOCKIST');
  const otherStkForbiddenByUserRes = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(otherStkForbiddenByUserRes.status === 403, `GET /api/stockists/by-user/:userId as other stockist returns 403, got ${otherStkForbiddenByUserRes.status}`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/by-user/:userId as other stockist returns 403`);

  loginAs('u-stk1', 'STOCKIST');
  const ownerByUserRes = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(ownerByUserRes.status === 200, `GET /api/stockists/by-user/:userId as owner returns 200, got ${ownerByUserRes.status}`);
  assert(ownerByUserRes.body.id === 's1', 'Owner gets full stockist record');
  assert(ownerByUserRes.body.payout_upi_id !== undefined || ownerByUserRes.body.phone !== undefined, 'Owner gets payout/phone info');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/by-user/:userId as owner returns 200 with full data`);

  loginAs('u-admin', 'ADMIN');
  const adminByUserRes = await get('http://localhost:3001/api/stockists/by-user/u-stk1');
  assert(adminByUserRes.status === 200, `GET /api/stockists/by-user/:userId as admin returns 200, got ${adminByUserRes.status}`);
  assert(adminByUserRes.body.id === 's1', 'Admin gets full stockist record');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/stockists/by-user/:userId as admin returns 200 with full data`);

  // 4. Order enrichment security
  loginAs('u-cust1', 'CUSTOMER');
  const custOrdersRes = await get('http://localhost:3001/api/orders');
  assert(custOrdersRes.status === 200, `GET /api/orders as customer returns 200`);
  const activeOrder = custOrdersRes.body.find(o => o.customer_id === 'u-cust1' && !['DELIVERED', 'CANCELLED', 'NO_SHOW'].includes(o.status));
  if (activeOrder) {
    assert(activeOrder.stockist_upi_id !== undefined, 'Active order for own customer includes stockist_upi_id');
    assert(activeOrder.contact_phone !== undefined, 'Active order for own customer includes contact_phone');
    assert(activeOrder.stockist_payout === undefined, 'Customer order does not expose stockist_payout');
    assert(activeOrder.platform_commission === undefined, 'Customer order does not expose platform_commission');
    assert(activeOrder.stockist_amount === undefined, 'Customer order does not expose stockist_amount');
    state.testCount++; state.passedCount++;
    console.log(`[PASS] Test #${state.testCount}: Customer active order includes UPI and contact phone, but hides commission data`);
  }

  const deliveredOrder = custOrdersRes.body.find(o => o.customer_id === 'u-cust1' && o.status === 'DELIVERED');
  if (deliveredOrder) {
    assert(deliveredOrder.stockist_upi_id === undefined, 'Delivered order does not expose stockist_upi_id');
    assert(deliveredOrder.contact_phone === undefined, 'Delivered order does not expose contact_phone');
    state.testCount++; state.passedCount++;
    console.log(`[PASS] Test #${state.testCount}: Customer delivered order does not expose UPI or contact phone`);
  }

  // 5. Customer / Public Product query does not leak cost_price or margin
  clearLogin();
  const pubProdsRes = await get('http://localhost:3001/api/products?regionId=r1');
  assert(pubProdsRes.status === 200, `GET /api/products returns 200`);
  for (const p of pubProdsRes.body) {
    assert(p.cost_price === undefined, 'Public product does not leak cost_price');
    assert(p.costPrice === undefined, 'Public product does not leak costPrice');
    assert(p.margin === undefined, 'Public product does not leak margin');
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Public products query does not leak cost_price or margin`);

  // 6. Security & Integrity: No seed-data ID fallbacks in backend/server.js
  const serverFileContentForFallbacks = readBackendSource();
  const seedFallbackRegex = /\|\|\s*['"](?:r1|s1|u-cust1|u-admin)['"]/g;
  const seedMatches = serverFileContentForFallbacks.match(seedFallbackRegex);
  assert(!seedMatches || seedMatches.length === 0, `backend/server.js must not contain seed-data ID fallbacks (|| 'r1', || 's1', || 'u-cust1', || 'u-admin'). Found: ${seedMatches ? seedMatches.join(', ') : 'none'}`);

  // 7. Register customer with no region returns 400
  clearLogin();
  const regNoRegionRes = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9999900001',
    name: 'Customer No Region'
  });
  assert(regNoRegionRes.status === 400, `Register customer with no region returns 400, got ${regNoRegionRes.status}`);
  assert(regNoRegionRes.body.error === 'Choose a region.' || regNoRegionRes.body.message === 'Choose a region.', `Register customer with no region returns "Choose a region.", got ${JSON.stringify(regNoRegionRes.body)}`);

  // 8. Register customer with invalid region returns 400
  const regBadRegionRes = await post('http://localhost:3001/api/auth/register-customer', {
    phone: '9999900002',
    name: 'Customer Bad Region',
    region_id: 'non-existent-region-id'
  });
  assert(regBadRegionRes.status === 400, `Register customer with non-existent region returns 400, got ${regBadRegionRes.status}`);
  assert(regBadRegionRes.body.error === 'Invalid region' || regBadRegionRes.body.error === 'Choose a region.', `Register customer with invalid region returns error, got ${JSON.stringify(regBadRegionRes.body)}`);

  // 9. Create product as shop with no stockist record returns 400
  loginAs('u-nostk', 'STOCKIST');
  const prodNoStkRes = await post('http://localhost:3001/api/products', {
    name: 'Ghost Product',
    category: 'groceries',
    price: 100,
    cost_price: 80,
    stock: 10,
    unit: 'kg'
  });
  assert(prodNoStkRes.status === 400, `Create product as shop with no stockist record returns 400, got ${prodNoStkRes.status}`);

  // 10. Admin endpoints record the real admin id and reject unauthenticated calls
  clearLogin();
  const unauthPartnerCreate = await post('http://localhost:3001/api/admin/partners', {
    legal_name: 'Test Partner Org',
    display_name: 'Test Partner',
    contact_phone: '9888877777',
    contact_email: 'unauth.partner@example.com',
    service_types: ['BROADBAND']
  });
  assert(unauthPartnerCreate.status === 401, `Create partner unauthenticated returns 401, got ${unauthPartnerCreate.status}`);

  loginAs('u-admin', 'ADMIN');
  const authPartnerCreate = await post('http://localhost:3001/api/admin/partners', {
    legal_name: 'Real Admin Partner Inc',
    display_name: 'Real Admin Partner',
    contact_phone: '9888877776',
    contact_email: 'real.admin.partner@example.com',
    service_types: ['BROADBAND']
  });
  assert(authPartnerCreate.status === 200, `Create partner as real admin returns 200, got ${authPartnerCreate.status}`);
  assert(authPartnerCreate.body.partner && authPartnerCreate.body.partner.onboarded_by_admin_id === 'u-admin', `Partner onboarded_by_admin_id records real admin id u-admin, got ${authPartnerCreate.body?.partner?.onboarded_by_admin_id}`);

};
