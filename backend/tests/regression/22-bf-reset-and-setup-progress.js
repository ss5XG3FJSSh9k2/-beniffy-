const {
  dbModule, sessionHelper, loginAs, clearLogin, post, get, state, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // ==========================================
  // ROUND BF-RESET: DATABASE RESET GATING & AUDIT LOGGING
  // ==========================================
  console.log('\n--- Round BF-RESET: Database Reset Gating & Audit Logging ---');

  // 1. Unauthenticated reset-db attempt returns 403 and logs refusal
  clearLogin();
  const unauthResetRes = await post('http://localhost:3001/api/admin/reset-db', {});
  assert(unauthResetRes.status === 403, 'POST /api/admin/reset-db without auth returns 403');
  assert(unauthResetRes.body.error === 'Forbidden', 'Returns error: Forbidden');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/admin/reset-db without auth returns 403 Forbidden`);

  // Verify unauthenticated refusal logged in audit log
  let auditLog = await dbModule.getTable('admin_audit_log');
  const unauthRefusal = auditLog.slice().reverse().find(a => a.action === 'RESET_DB_REFUSED');
  assert(unauthRefusal, 'Audit log records RESET_DB_REFUSED for unauthenticated attempt');
  assert(unauthRefusal.entity_type === 'system' && unauthRefusal.entity_id === 'database', 'Audit entry targets system/database');
  assert(unauthRefusal.after?.result === 'REFUSED', 'Audit entry records result REFUSED');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Unauthenticated reset attempt logged to admin_audit_log as RESET_DB_REFUSED`);

  // 2. Non-admin roles (CUSTOMER, STOCKIST, PARTNER) return 403 and log refusal
  const custRes = await post('http://localhost:3001/api/admin/reset-db', {}, {
    headers: { Authorization: `Bearer ${ctx.custToken}` }
  });
  assert(custRes.status === 403, 'POST /api/admin/reset-db with customer token returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer reset attempt rejected with 403 Forbidden`);

  const stkToken = sessionHelper.signSession('u-stk1', 'STOCKIST');
  const stkRes = await post('http://localhost:3001/api/admin/reset-db', {}, {
    headers: { Authorization: `Bearer ${stkToken}` }
  });
  assert(stkRes.status === 403, 'POST /api/admin/reset-db with stockist token returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Stockist reset attempt rejected with 403 Forbidden`);

  const bfPartnerToken = sessionHelper.signSession('u-partner1', 'PARTNER');
  const partnerRes = await post('http://localhost:3001/api/admin/reset-db', {}, {
    headers: { Authorization: `Bearer ${bfPartnerToken}` }
  });
  assert(partnerRes.status === 403, 'POST /api/admin/reset-db with partner token returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Partner reset attempt rejected with 403 Forbidden`);

  // 3. Admin caller when ALLOW_DB_RESET !== 'true' returns 403
  loginAs('u-admin', 'ADMIN');
  const _prevAllowReset = process.env.ALLOW_DB_RESET;
  delete process.env.ALLOW_DB_RESET;
  const noEnvResetRes = await post('http://localhost:3001/api/admin/reset-db', {});
  assert(noEnvResetRes.status === 403, 'POST /api/admin/reset-db without ALLOW_DB_RESET=true returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin reset without ALLOW_DB_RESET=true returns 403`);

  // Verify refusal when ALLOW_DB_RESET missing
  auditLog = await dbModule.getTable('admin_audit_log');
  const noEnvRefusal = auditLog.slice().reverse().find(a => a.action === 'RESET_DB_REFUSED' && a.reason.includes('ALLOW_DB_RESET'));
  assert(noEnvRefusal, 'Audit log records refusal due to missing ALLOW_DB_RESET');
  assert(noEnvRefusal.after?.role === 'ADMIN', 'Audit log records caller role as ADMIN');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Missing ALLOW_DB_RESET logged to admin_audit_log`);

  // 4. Admin caller when NODE_ENV is production returns 403
  process.env.ALLOW_DB_RESET = 'true';
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const prodResetRes = await post('http://localhost:3001/api/admin/reset-db', {}, {
    headers: { 'x-forwarded-proto': 'https' }
  });
  assert(prodResetRes.status === 403, 'POST /api/admin/reset-db in production returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin reset in production mode returns 403`);

  // Restore NODE_ENV
  process.env.NODE_ENV = prevNodeEnv || 'test';

  // 5. Integrations endpoint reports database_reset status correctly
  const intStatusRes = await get('http://localhost:3001/api/admin/integrations');
  assert(intStatusRes.status === 200, 'GET /api/admin/integrations returns 200');
  assert(intStatusRes.body.database_reset, 'Integrations response includes database_reset object');
  assert(intStatusRes.body.database_reset.enabled === true, 'database_reset.enabled is true when ALLOW_DB_RESET=true in dev');
  assert(intStatusRes.body.database_reset.status_text === 'Database reset: enabled (dev only)', 'database_reset status text matches');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/integrations reports database_reset: enabled (dev only)`);

  delete process.env.ALLOW_DB_RESET;
  const intStatusDisabledRes = await get('http://localhost:3001/api/admin/integrations');
  assert(intStatusDisabledRes.body.database_reset.enabled === false, 'database_reset.enabled is false when ALLOW_DB_RESET not set');
  assert(intStatusDisabledRes.body.database_reset.status_text === 'Database reset: disabled', 'database_reset reports "Database reset: disabled"');
  process.env.ALLOW_DB_RESET = 'true';
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/integrations reports database_reset: disabled when env unset`);

  // 6. Admin caller when ALLOW_DB_RESET=true and dev mode returns 200 and logs allowed
  const allowedResetRes = await post('http://localhost:3001/api/admin/reset-db', {});
  assert(allowedResetRes.status === 200, 'POST /api/admin/reset-db returns 200 when all conditions satisfied');
  assert(allowedResetRes.body.success === true, 'Response contains success: true');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Authorized admin reset returns 200 with success: true`);

  auditLog = await dbModule.getTable('admin_audit_log');
  const allowedEntry = auditLog.slice().reverse().find(a => a.action === 'RESET_DB_ALLOWED');
  assert(allowedEntry, 'Audit log records RESET_DB_ALLOWED');
  assert(allowedEntry.entity_type === 'system' && allowedEntry.entity_id === 'database', 'Audit entry targets system/database');
  assert(allowedEntry.after?.result === 'ALLOWED', 'Audit entry records result ALLOWED');
  assert(allowedEntry.after?.role === 'ADMIN', 'Audit entry records admin role');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Allowed database reset recorded in admin_audit_log`);

  // 7. 403 when isTestEnv() is false even with ADMIN + ALLOW_DB_RESET=true
  process.env.ALLOW_DB_RESET = 'true';
  const savedTestNodeEnv7 = process.env.NODE_ENV;
  const savedTestSeedMode7 = process.env.SEED_MODE;
  process.env.NODE_ENV = 'development';
  delete process.env.SEED_MODE;

  const notTestEnvRes = await post('http://localhost:3001/api/admin/reset-db', {});
  assert(notTestEnvRes.status === 403, 'POST /api/admin/reset-db returns 403 when isTestEnv() is false');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin reset returns 403 when isTestEnv() is false`);

  auditLog = await dbModule.getTable('admin_audit_log');
  const notTestEnvRefusal = auditLog.slice().reverse().find(a => a.action === 'RESET_DB_REFUSED' && a.reason === 'Not running on the in-memory test database');
  assert(notTestEnvRefusal, 'Refusal audit logged with reason "Not running on the in-memory test database"');
  assert(notTestEnvRefusal.after?.role === 'ADMIN', 'Audit log records caller role as ADMIN');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: isTestEnv() false refusal audit logged with reason "Not running on the in-memory test database"`);

  // Integrations endpoint when isTestEnv() is false reports disabled
  const intStatusNotTestRes = await get('http://localhost:3001/api/admin/integrations');
  assert(intStatusNotTestRes.body.database_reset.enabled === false, 'database_reset.enabled is false when isTestEnv() is false');
  assert(intStatusNotTestRes.body.database_reset.status_text === 'Database reset: disabled', 'database_reset reports disabled when isTestEnv() is false');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Integrations reports Database reset: disabled when isTestEnv() is false`);

  // Restore env
  process.env.NODE_ENV = savedTestNodeEnv7;
  if (savedTestSeedMode7 !== undefined) process.env.SEED_MODE = savedTestSeedMode7;

  // 8. 403 when DEV_LAUNCHER=true
  process.env.DEV_LAUNCHER = 'true';
  const devLauncherRes = await post('http://localhost:3001/api/admin/reset-db', {});
  assert(devLauncherRes.status === 403, 'POST /api/admin/reset-db returns 403 when DEV_LAUNCHER=true');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin reset returns 403 when DEV_LAUNCHER=true`);

  auditLog = await dbModule.getTable('admin_audit_log');
  const devLauncherRefusal = auditLog.slice().reverse().find(a => a.action === 'RESET_DB_REFUSED' && a.reason === 'Not running on the in-memory test database');
  assert(devLauncherRefusal, 'DEV_LAUNCHER=true refusal audit logged with reason "Not running on the in-memory test database"');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: DEV_LAUNCHER=true refusal audit logged with reason "Not running on the in-memory test database"`);

  // Integrations endpoint when DEV_LAUNCHER=true reports disabled
  const intStatusDevLauncherRes = await get('http://localhost:3001/api/admin/integrations');
  assert(intStatusDevLauncherRes.body.database_reset.enabled === false, 'database_reset.enabled is false when DEV_LAUNCHER=true');
  assert(intStatusDevLauncherRes.body.database_reset.status_text === 'Database reset: disabled', 'database_reset reports disabled when DEV_LAUNCHER=true');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Integrations reports Database reset: disabled when DEV_LAUNCHER=true`);

  delete process.env.DEV_LAUNCHER;

  // 9. Rate limiting on reset-db: with test-env exemption turned off, send 100 requests to /api/admin/reset-db; request 101 returns 429
  await post('http://localhost:3001/api/admin/clear-rate-limits', {});

  const savedTestNodeEnv9 = process.env.NODE_ENV;
  const savedTestSeedMode9 = process.env.SEED_MODE;
  process.env.NODE_ENV = 'development';
  delete process.env.SEED_MODE;

  for (let i = 0; i < 100; i++) {
    const r = await post('http://localhost:3001/api/admin/reset-db', {});
    assert(r.status === 403, `Request ${i + 1} before rate limit is refused with 403`);
  }
  const req101 = await post('http://localhost:3001/api/admin/reset-db', {});
  assert(req101.status === 429, 'Request 101 to /api/admin/reset-db returns 429');
  assert(req101.body.error && req101.body.error.includes('Too many requests'), '429 error body received');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Request 101 to /api/admin/reset-db trips rate limit and returns 429`);

  // Restore env and clean up rate limits
  process.env.NODE_ENV = savedTestNodeEnv9;
  if (savedTestSeedMode9 !== undefined) process.env.SEED_MODE = savedTestSeedMode9;
  await post('http://localhost:3001/api/admin/clear-rate-limits', {});

  // --- Setup Progress Endpoint (GET /api/admin/setup-progress) ---
  clearLogin();
  const spNoAuthRes = await get('http://localhost:3001/api/admin/setup-progress');
  assert(spNoAuthRes.status === 401, 'GET /api/admin/setup-progress without auth returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/setup-progress without auth returns 401`);

  const spCustRes = await get('http://localhost:3001/api/admin/setup-progress', {
    headers: { Authorization: `Bearer ${ctx.custToken}` }
  });
  assert(spCustRes.status === 403, 'GET /api/admin/setup-progress with customer token returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/setup-progress with customer token returns 403`);

  const spStkRes = await get('http://localhost:3001/api/admin/setup-progress', {
    headers: { Authorization: `Bearer ${stkToken}` }
  });
  assert(spStkRes.status === 403, 'GET /api/admin/setup-progress with stockist token returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/setup-progress with stockist token returns 403`);

  const spPartnerRes = await get('http://localhost:3001/api/admin/setup-progress', {
    headers: { Authorization: `Bearer ${bfPartnerToken}` }
  });
  assert(spPartnerRes.status === 403, 'GET /api/admin/setup-progress with partner token returns 403');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/setup-progress with partner token returns 403`);

  loginAs('u-admin', 'ADMIN');
  const spAdminRes = await get('http://localhost:3001/api/admin/setup-progress');
  assert(spAdminRes.status === 200, 'GET /api/admin/setup-progress with admin token returns 200');
  assert(
    typeof spAdminRes.body.regions === 'number' &&
    typeof spAdminRes.body.wholesalers === 'number' &&
    typeof spAdminRes.body.stockists === 'number' &&
    typeof spAdminRes.body.customers === 'number',
    'GET /api/admin/setup-progress returns 4 numeric fields'
  );
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: GET /api/admin/setup-progress returns 200 with 4 numeric fields`);

  const spNewRegRes = await post('http://localhost:3001/api/admin/regions', {
    name: 'Setup Progress Test Region',
    code: 'sp-test-' + Date.now(),
    delivery_fee: 15
  });
  assert(spNewRegRes.status === 200 && spNewRegRes.body.id, 'Created test region for setup-progress');
  const spAfterRegRes = await get('http://localhost:3001/api/admin/setup-progress');
  assert(spAfterRegRes.status === 200 && spAfterRegRes.body.regions === spAdminRes.body.regions + 1, 'regions count increases by 1 after creating a region');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: setup-progress regions count increased by 1 after creating a region`);

  const spNewVenRes = await post('http://localhost:3001/api/admin/vendors', {
    name: 'Setup Progress Test Wholesaler',
    regionId: spNewRegRes.body.id
  });
  assert(spNewVenRes.status === 200 && spNewVenRes.body.success, 'Created test wholesaler for setup-progress');
  const spAfterVenRes = await get('http://localhost:3001/api/admin/setup-progress');
  assert(spAfterVenRes.status === 200 && spAfterVenRes.body.wholesalers === spAfterRegRes.body.wholesalers + 1, 'wholesalers count increases by 1 after creating a wholesaler');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: setup-progress wholesalers count increased by 1 after creating a wholesaler`);

    clearLogin();
};
