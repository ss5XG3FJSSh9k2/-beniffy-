const TEST_PORT = process.env.TEST_PORT || '3002';
process.env.PORT = TEST_PORT;
process.env.POSTGRES_MODE = 'mem';
process.env.SEED_MODE = 'test';
process.env.ALLOW_DB_RESET = 'true';

const fs = require('fs');
const path = require('path');
const _dbModule = require('../db.js');
const {
  loginAs,
  clearLogin,
  getCurrentToken,
  setCurrentToken,
  post,
  get,
  getCounts
} = require('./lib/harness.js');

async function main() {
  console.log('=== RUNNING ACCUMULATED REGRESSION SUITE ===');

  const sMod = require('../server.js');
  await sMod.readyPromise;

  const preHarnessToken = getCurrentToken();
  clearLogin();
  const harnessCheckUnauth = await get('http://localhost:3001/api/admin/customers');
  if (harnessCheckUnauth.status !== 401) {
    console.error('Harness self-check failed: clearLogin did not produce 401, got ' + harnessCheckUnauth.status);
    process.exit(1);
  }
  loginAs('u-admin', 'ADMIN');
  const harnessCheckAuth = await get('http://localhost:3001/api/admin/customers');
  if (harnessCheckAuth.status !== 200) {
    console.error('Harness self-check failed: loginAs u-admin did not produce 200, got ' + harnessCheckAuth.status);
    process.exit(1);
  }
  setCurrentToken(preHarnessToken);

  loginAs('u-admin', 'ADMIN');
  console.log('\nResetting database...');
  await post('http://localhost:3001/api/admin/reset-db');

  const sectionsDir = path.join(__dirname, 'regression');
  const sectionFiles = fs
    .readdirSync(sectionsDir)
    .filter(f => /^\d{2}-.*\.js$/.test(f))
    .sort();

  const ctx = {};
  for (const file of sectionFiles) {
    const runSection = require(path.join(sectionsDir, file));
    await runSection(ctx);
  }

  const { testCount, passedCount } = getCounts();
  console.log(`\n=== REGRESSION SUITE COMPLETED: ${passedCount}/${testCount} tests passed ===`);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error during regression tests:', err);
  process.exit(1);
});
