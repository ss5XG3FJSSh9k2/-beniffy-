const { chromium } = require('playwright');
const session = require('../backend/lib/session.js');

async function launchBrowser() {
  const options = { headless: true };
  try {
    return await chromium.launch(options);
  } catch (err) {
    try {
      return await chromium.launch({ ...options, channel: 'chrome' });
    } catch {
      return await chromium.launch({ ...options, channel: 'msedge' });
    }
  }
}

const ROLES = [
  {
    name: 'Customer',
    roleKey: 'customer',
    user: {
      id: 'u-cust',
      role: 'CUSTOMER',
      name: 'Amit Sen',
      phone: '9876543210',
      region_id: 'r1',
      tenant_id: 't1'
    }
  },
  {
    name: 'Stockist',
    roleKey: 'stockist',
    user: {
      id: 'u-stk',
      role: 'STOCKIST',
      name: 'Madan Grocers',
      phone: '7654321098',
      region_id: 'r1',
      tenant_id: 't1'
    }
  },
  {
    name: 'Admin',
    roleKey: 'admin',
    user: {
      id: 'u-admin',
      role: 'ADMIN',
      name: 'Admin User',
      phone: '9999999999',
      tenant_id: 't1'
    }
  },
  {
    name: 'Partner',
    roleKey: 'partner',
    user: {
      id: 'u-ptn',
      role: 'PARTNER_ADMIN',
      name: 'Adhya Broadband',
      phone: '9876500000',
      email: 'adhya@partners.example',
      partner_id: 'p-app',
      tenant_id: 't1'
    }
  }
];

async function runSmokeTests() {
  console.log('=== RUNNING PLAYWRIGHT BROWSER SMOKE TESTS ===');
  const browser = await launchBrowser();
  let failures = 0;

  try {
    for (const role of ROLES) {
      // 1. Logged out test
      {
        const page = await browser.newPage();
        const errors = [];

        page.on('pageerror', err => {
          errors.push(`Uncaught page error: ${err.message}`);
        });

        page.on('console', msg => {
          if (msg.type() === 'error') {
            const text = msg.text();
            if (text.includes('ReferenceError') || text.includes('TypeError')) {
              errors.push(`Console error: ${text}`);
            }
          }
        });

        await page.goto('http://localhost:5173');
        await page.evaluate(() => localStorage.clear());
        await page.goto('http://localhost:5173');

        // Select the role tab if available
        const roleBtn = await page.$(`button.role-tab:has-text("${role.name}"), button.role-tab:has-text("${role.roleKey}")`);
        if (roleBtn) {
          await roleBtn.click().catch(() => {});
        }
        await page.waitForTimeout(800);

        const content = await page.content();
        const hasErrorPanel = content.includes('Something went wrong') || content.includes('critical error occurred');
        if (hasErrorPanel) {
          errors.push('Visible "Something went wrong" crash panel detected');
        }

        if (errors.length > 0) {
          console.error(`❌ [FAIL] ${role.name} App (logged out):`, errors);
          failures++;
        } else {
          console.log(`✓ [PASS] ${role.name} App (logged out) loaded cleanly without crashes`);
        }

        await page.close();
      }

      // 2. Logged in as seed user test
      {
        const page = await browser.newPage();
        const errors = [];

        page.on('pageerror', err => {
          errors.push(`Uncaught page error: ${err.message}`);
        });

        page.on('console', msg => {
          if (msg.type() === 'error') {
            const text = msg.text();
            if (text.includes('ReferenceError') || text.includes('TypeError')) {
              errors.push(`Console error: ${text}`);
            }
          }
        });

        const token = session.signSession(role.user.id, role.user.role);

        await page.goto('http://localhost:5173');
        await page.evaluate(({ user, token, roleKey }) => {
          localStorage.setItem('currentUser', JSON.stringify(user));
          localStorage.setItem('token', token);
          localStorage.setItem('activeRole', roleKey);
        }, { user: role.user, token, roleKey: role.roleKey });

        await page.reload();
        await page.waitForTimeout(1000);

        const content = await page.content();
        const hasErrorPanel = content.includes('Something went wrong') || content.includes('critical error occurred');
        if (hasErrorPanel) {
          errors.push('Visible "Something went wrong" crash panel detected');
        }

        if (errors.length > 0) {
          console.error(`❌ [FAIL] ${role.name} App (logged in as seed user ${role.user.phone}):`, errors);
          failures++;
        } else {
          console.log(`✓ [PASS] ${role.name} App (logged in as seed user ${role.user.phone}) loaded cleanly`);
        }

        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\nSmoke tests failed with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log('\n=== ALL SMOKE TESTS PASSED (8/8 scenarios clean) ===');
  process.exit(0);
}

runSmokeTests().catch(err => {
  console.error('Smoke tests runner error:', err);
  process.exit(1);
});
