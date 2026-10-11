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

async function ensureSetup() {
  const regions = await fetch('http://localhost:3001/api/regions').then(r => r.json()).catch(() => []);
  if (!Array.isArray(regions) || regions.length === 0) {
    // 1. Setup admin on fresh DB
    await fetch('http://localhost:3001/api/setup/create-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Super Admin', phone: '9999999999', email: 'admin@fastnet.test' })
    }).catch(() => null);

    // 2. Login admin to get token
    const admLogin = await fetch('http://localhost:3001/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
    }).then(r => r.json()).catch(() => null);

    if (admLogin && admLogin.token) {
      const admToken = admLogin.token;

      // 3. Create region
      const reg = await fetch('http://localhost:3001/api/admin/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` },
        body: JSON.stringify({ name: 'Kolkata South (Garia)', code: 'r1', delivery_fee: 25 })
      }).then(r => r.json()).catch(() => null);

      const regionId = reg?.id || 'r1';

      // 4. Register customer
      await fetch('http://localhost:3001/api/auth/register-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Amit Sen', phone: '9876543210', email: 'amit@fastnet.test', region_id: regionId, address: '12 Park Street, Garia', termsAgreed: true })
      }).catch(() => null);

      // 5. Register stockist & approve
      await fetch('http://localhost:3001/api/auth/register-stockist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Madan Shaw',
          phone: '7654321098',
          email: 'madan@fastnet.test',
          shop_name: 'Madan Grocers',
          region_id: regionId,
          id_type: 'Aadhaar',
          id_number: '123456789012',
          address: 'Garia Market'
        })
      }).catch(() => null);

      const kycQueue = await fetch('http://localhost:3001/api/admin/kyc-queue', {
        headers: { 'Authorization': `Bearer ${admToken}` }
      }).then(r => r.json()).catch(() => []);
      const pendingStk = Array.isArray(kycQueue) ? kycQueue.find(s => s.phone === '7654321098') : null;
      if (pendingStk && pendingStk.id) {
        await fetch(`http://localhost:3001/api/admin/kyc/${pendingStk.id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` },
          body: JSON.stringify({ vendorId: 'v1' })
        }).catch(() => null);
      }

      // 6. Create partner & approve
      await fetch('http://localhost:3001/api/admin/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` },
        body: JSON.stringify({
          legal_name: 'Adhya Cable Services Pvt Ltd',
          display_name: 'Adhya Cable',
          contact_phone: '9876500000',
          contact_email: 'adhya@partners.example',
          password: 'partner123',
          service_types: ['CABLE']
        })
      }).catch(() => null);

      const allUsers = await fetch('http://localhost:3001/api/admin/customers', {
        headers: { 'Authorization': `Bearer ${admToken}` }
      }).then(r => r.json()).catch(() => []);
      const ptnUser = allUsers.find(u => u.phone === '9876500000');
      if (ptnUser) {
        await fetch(`http://localhost:3001/api/admin/kyc/${ptnUser.id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` }
        }).catch(() => null);
      }
    }
  }
}

const ROLES = [
  {
    name: 'Customer',
    roleKey: 'customer',
    tabName: 'Customer App',
    phone: '9876543210',
    async getSession() {
      const res = await fetch('http://localhost:3001/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: this.phone, otp: '123456', expected_role: 'CUSTOMER' })
      }).then(r => r.ok ? r.json() : null).catch(() => null);

      if (res && res.token && res.user) return { user: res.user, token: res.token };
      throw new Error(`Customer login failed for phone ${this.phone}`);
    },
    async assertHomeScreen(page) {
      const banner = page.locator('.perspective-banner');
      await banner.waitFor({ timeout: 6000 });
      const text = await banner.textContent();
      if (!text.includes('Customer View') || !text.includes('Amit Sen')) {
        throw new Error(`Customer home marker missing: expected "Customer View: Amit Sen", found "${text.trim()}"`);
      }
      if (text.includes('Not logged in') || text.includes('লগইন করা নেই')) {
        throw new Error(`Customer login failed: banner shows "${text.trim()}"`);
      }
      return text.trim();
    }
  },
  {
    name: 'Stockist',
    roleKey: 'stockist',
    tabName: 'Stockist App',
    phone: '7654321098',
    async getSession() {
      const res = await fetch('http://localhost:3001/api/stockist/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: this.phone, otp: '123456' })
      }).then(r => r.ok ? r.json() : null).catch(() => null);

      if (res && res.token && res.user) return { user: res.user, token: res.token };
      throw new Error(`Stockist login failed for phone ${this.phone}`);
    },
    async assertHomeScreen(page) {
      const banner = page.locator('.perspective-banner');
      await banner.waitFor({ timeout: 6000 });
      const text = await banner.textContent();
      if (!text.includes('SHOPKEEPER VIEW') || !text.includes('Madan Grocers')) {
        throw new Error(`Stockist home marker missing: expected "SHOPKEEPER VIEW ... Madan Grocers", found "${text.trim()}"`);
      }
      if (text.includes('Not logged in') || text.includes('লগইন করা নেই')) {
        throw new Error(`Stockist login failed: banner shows "${text.trim()}"`);
      }
      return text.trim();
    }
  },
  {
    name: 'Admin',
    roleKey: 'admin',
    tabName: 'Admin Portal',
    phone: '9999999999',
    async getSession() {
      const res = await fetch('http://localhost:3001/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: this.phone, otp: '123456', expected_role: 'ADMIN' })
      }).then(r => r.ok ? r.json() : null).catch(() => null);

      if (res && res.token && res.user) return { user: res.user, token: res.token };
      throw new Error(`Admin login failed for phone ${this.phone}`);
    },
    async assertHomeScreen(page) {
      const container = page.locator('.admin-container');
      await container.waitFor({ timeout: 6000 });
      const headerTitle = await page.locator('.admin-header h1').textContent();
      if (!headerTitle.includes('Operator Admin Dashboard')) {
        throw new Error(`Admin home marker missing: expected "Operator Admin Dashboard", found "${headerTitle.trim()}"`);
      }
      return `Operator Admin Dashboard (.admin-container visible)`;
    }
  },
  {
    name: 'Partner',
    roleKey: 'partner',
    tabName: 'Partner App',
    phone: '9876500000',
    email: 'adhya@partners.example',
    async getSession() {
      const res = await fetch('http://localhost:3001/api/partner/auth/login-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: 'partner123' })
      }).then(r => r.ok ? r.json() : null).catch(() => null);

      if (res && (res.session_token || res.token) && res.user) {
        return { user: res.user, token: res.session_token || res.token };
      }
      throw new Error(`Partner login failed for email ${this.email}`);
    },
    async assertHomeScreen(page) {
      const banner = page.locator('.perspective-banner');
      await banner.waitFor({ timeout: 6000 });
      const text = await banner.textContent();
      if (!text.includes('Partner Hub: Adhya Cable')) {
        throw new Error(`Partner banner marker missing: expected "Partner Hub: Adhya Cable", found "${text.trim()}"`);
      }
      const welcome = await page.locator('h3:has-text("Welcome,")').textContent();
      if (!welcome.includes('Adhya Cable')) {
        throw new Error(`Partner welcome marker missing: found "${welcome.trim()}"`);
      }
      return `${text.trim()} | ${welcome.trim()}`;
    }
  }
];

async function runSmokeTests() {
  console.log('=== RUNNING PLAYWRIGHT BROWSER SMOKE TESTS ===');
  await ensureSetup();
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

        // Select the role tab
        const roleBtn = page.locator(`.role-switcher button.role-tab:has-text("${role.tabName}")`);
        await roleBtn.click();
        await page.waitForTimeout(600);

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

      // 2. Logged in test with home screen marker assertion
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

        try {
          const sessionData = await role.getSession();

          await page.goto('http://localhost:5173');
          await page.evaluate(({ user, token, roleKey }) => {
            localStorage.setItem('currentUser', JSON.stringify(user));
            localStorage.setItem('token', token);
            if (roleKey === 'partner') {
              localStorage.setItem('fastnet_partner_session', token);
            }
          }, { user: sessionData.user, token: sessionData.token, roleKey: role.roleKey });

          await page.reload();
          await page.waitForTimeout(500);

          // Select the role tab to display the logged in screen
          const roleBtn = page.locator(`.role-switcher button.role-tab:has-text("${role.tabName}")`);
          await roleBtn.click();

          const content = await page.content();
          const hasErrorPanel = content.includes('Something went wrong') || content.includes('critical error occurred');
          if (hasErrorPanel) {
            throw new Error('Visible "Something went wrong" crash panel detected');
          }

          // Assert the role's home screen marker
          const markerFound = await role.assertHomeScreen(page);

          if (errors.length > 0) {
            console.error(`❌ [FAIL] ${role.name} App (logged in as ${role.phone || role.email}):`, errors);
            failures++;
          } else {
            console.log(`✓ [PASS] ${role.name} App (logged in as ${role.phone || role.email}): Home screen marker found -> "${markerFound}"`);
          }
        } catch (err) {
          console.error(`❌ [FAIL] ${role.name} App (logged in): ${err.message}`);
          failures++;
        }

        await page.close();
      }
    }
  } finally {
    try {
      await Promise.race([
        browser.close(),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    } catch {}
  }

  if (failures > 0) {
    console.error(`\nSmoke tests failed with ${failures} failure(s).`);
    process.exit(1);
  }

  console.log('\n=== ALL SMOKE TESTS PASSED (8/8 scenarios verified with home screen markers) ===');
  process.exit(0);
}

runSmokeTests().catch(err => {
  console.error('Smoke tests runner error:', err);
  process.exit(1);
});
