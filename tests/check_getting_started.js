const { chromium } = require('playwright');
const session = require('../backend/lib/session.js');
const { waitForSplash, newLightPage } = require('./helpers.js');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

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

async function run() {
  console.log('=== RUNNING GETTING STARTED CHECKLIST PLAYWRIGHT TEST ===');
  const screenshotsDir = path.resolve(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await launchBrowser();

  try {
    const page = await newLightPage(browser);
    page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text());
    });
    const adminToken = session.signSession('u-admin', 'ADMIN');
    const adminUser = {
      id: 'u-admin',
      name: 'Super Admin',
      phone: '9999999999',
      email: 'admin@beniffy.test',
      role: 'ADMIN',
      kyc_status: 'APPROVED'
    };

    // Fresh in-memory DB state with only the admin
    let mockRegions = [];
    let mockVendors = [];
    let mockStockists = [];
    let mockCustomers = [];

    await page.route('**/api/setup/status', route => {
      route.fulfill({ json: { needs_setup: false, user_count: 1 } });
    });

    await page.route('**/api/regions', route => {
      route.fulfill({ json: mockRegions });
    });

    await page.route('**/api/admin/regions', async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ json: mockRegions });
      }
      if (req.method() === 'POST') {
        const body = req.postDataJSON() || {};
        const newRegion = {
          id: 'r-test-' + (mockRegions.length + 1),
          tenant_id: 't1',
          name: body.name || 'Test Region',
          code: body.code || 'test-region',
          delivery_fee: body.delivery_fee ?? null,
          created_at: new Date().toISOString()
        };
        mockRegions.push(newRegion);
        return route.fulfill({ json: newRegion });
      }
      return route.continue();
    });

    await page.route('**/api/admin/vendors*', async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ json: mockVendors });
      }
      if (req.method() === 'POST') {
        const body = req.postDataJSON() || {};
        const newVendor = {
          id: 'v-test-' + (mockVendors.length + 1),
          tenant_id: 't1',
          name: body.name || 'Test Wholesaler',
          region_id: body.regionId || (mockRegions[0] && mockRegions[0].id),
          is_active: true,
          created_at: new Date().toISOString()
        };
        mockVendors.push(newVendor);
        return route.fulfill({ json: { success: true, vendor: newVendor } });
      }
      return route.continue();
    });

    await page.route('**/api/admin/stockists*', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: mockStockists });
      }
      return route.continue();
    });

    await page.route('**/api/admin/customers*', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: mockCustomers });
      }
      return route.continue();
    });

    await page.route('**/api/admin/setup-progress', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          regions: mockRegions.length,
          wholesalers: mockVendors.length,
          stockists: mockStockists.length,
          customers: mockCustomers.length
        })
      });
    });

    await page.goto('http://localhost:5173/?role=admin');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('beniffy_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('beniffy.initialRole', 'admin');
    }, { user: adminUser, token: adminToken });

    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(600);

    const checklistHeading = page.locator('h3:has-text("Getting Started: Initial Platform Setup")');
    await checklistHeading.waitFor({ state: 'visible', timeout: 8000 });
    const checklistCard = checklistHeading.locator('..');

    // (a) Verify each step has badge "1".."4" and title does NOT start with a digit followed by ". "
    console.log('\n--- Check (a): Step numbering (no duplicate "1 1.") ---');
    const stepTitles = [
      'Create your first service region',
      'Register a wholesaler for that region',
      'Wait for a shopkeeper to register, then approve them',
      'Invite customers to sign up'
    ];

    for (let i = 0; i < stepTitles.length; i++) {
      const num = String(i + 1);
      const stepRow = checklistCard.locator(`div:has(> div > div:has-text("${stepTitles[i]}"))`).first();
      await stepRow.waitFor({ state: 'visible', timeout: 5000 });

      const badgeText = await stepRow.locator('span', { hasText: new RegExp(`^${num}$`) }).first().textContent();
      assert.strictEqual(badgeText.trim(), num, `Step ${num} badge should be "${num}"`);

      const titleEl = stepRow.locator('div', { hasText: stepTitles[i] }).last();
      const titleText = (await titleEl.textContent()).trim();
      assert(!/^\d+\.\s/.test(titleText), `Step ${num} title "${titleText}" must NOT start with digit + ". "`);
      console.log(`  [PASS] Step ${num}: badge="${badgeText.trim()}", title="${titleText}"`);
    }

    await page.screenshot({ path: path.join(screenshotsDir, 'getting_started_initial.png') });

    // (b) Create a region through the Regions tab UI, go back to dashboard WITHOUT reload
    console.log('\n--- Check (b): Create region -> dashboard without reload ---');
    const step1Text = checklistCard.locator('text=Create your first service region');
    await step1Text.scrollIntoViewIfNeeded();
    await step1Text.click();
    await page.waitForTimeout(800);

    await page.locator('button:has-text("+ Add Region")').click();
    await page.waitForTimeout(300);
    await page.locator('input[placeholder*="Kolkata South"]').fill('Garia Test Region');
    await page.locator('button:has-text("Create Region")').click();
    await page.waitForTimeout(600);

    // Navigate back to Home Dashboard WITHOUT reloading
    await page.locator('.admin-nav-item:has-text("Home")').first().click();
    await page.waitForTimeout(500);

    await checklistHeading.waitFor({ state: 'visible', timeout: 5000 });
    const step2RowAfterReg = checklistCard.locator('div[style*="justify-content: space-between"]', { hasText: 'Register a wholesaler for that region' });
    const step2ActionText = (await step2RowAfterReg.locator('> span').textContent()).trim();
    assert(step2ActionText.includes('Go'), `Step 2 should show "Go" after region creation, got "${step2ActionText}"`);
    assert(!step2ActionText.includes('Locked'), 'Step 2 must NOT show "Locked" after region creation');
    console.log(`  [PASS] Step 1 done, Step 2 shows "${step2ActionText}" (no reload)`);

    await page.screenshot({ path: path.join(screenshotsDir, 'getting_started_after_region.png') });

    // (c) Create a wholesaler through UI, back to dashboard without reload
    console.log('\n--- Check (c): Create wholesaler -> dashboard without reload ---');
    await checklistCard.locator('text=Register a wholesaler for that region').click();
    await page.waitForTimeout(400);

    await page.locator('input[placeholder*="Garia Staples Wholesale Hub"]').fill('Garia Test Wholesaler');
    const regionSelect = page.locator('div:has(> h3:has-text("Register Wholesaler")) select.text-input');
    await regionSelect.selectOption({ index: 1 });
    await page.locator('button:has-text("Register Wholesaler")').click();
    await page.waitForTimeout(300);

    // Confirm modal
    await page.locator('button:has-text("Yes, Register")').click();
    await page.waitForTimeout(600);

    // Navigate back to Home Dashboard WITHOUT reloading
    await page.locator('.admin-nav-item:has-text("Home")').first().click();
    await page.waitForTimeout(500);

    const step3RowAfterVen = checklistCard.locator('div[style*="justify-content: space-between"]', { hasText: 'Wait for a shopkeeper to register' });
    const step3ActionText = (await step3RowAfterVen.locator('> span').textContent()).trim();
    assert(step3ActionText.includes('Go'), `Step 3 should show "Go" after wholesaler creation, got "${step3ActionText}"`);
    console.log(`  [PASS] Step 2 done, Step 3 unlocked ("${step3ActionText}", no reload)`);

    await page.screenshot({ path: path.join(screenshotsDir, 'getting_started_after_wholesaler.png') });

    // (d) Switch language to hi and bn and verify translations
    console.log('\n--- Check (d): Hindi and Bengali translations ---');
    await page.evaluate(() => {
      if (window.__fastnet_set_lang) window.__fastnet_set_lang('hi');
    });
    await page.waitForTimeout(400);

    const hiChecklistText = await page.locator('.admin-container').textContent();
    assert(hiChecklistText.includes('उन्नत → क्षेत्र'), 'Hindi "Advanced → Regions" missing');
    assert(hiChecklistText.includes('उन्नत → थोक विक्रेता'), 'Hindi "Advanced → Wholesalers" missing');
    assert(hiChecklistText.includes('लंबित केवाईसी'), 'Hindi "Pending KYC" missing');
    assert(hiChecklistText.includes('जाएं →'), 'Hindi "Go →" missing');
    assert(hiChecklistText.includes('लॉक'), 'Hindi "Locked" missing');
    console.log('  [PASS] Hindi translations verified (Locked, Go, Advanced hints)');
    await page.screenshot({ path: path.join(screenshotsDir, 'getting_started_hi.png') });

    await page.evaluate(() => {
      if (window.__fastnet_set_lang) window.__fastnet_set_lang('bn');
    });
    await page.waitForTimeout(400);

    const bnChecklistText = await page.locator('.admin-container').textContent();
    assert(bnChecklistText.includes('উন্নত → অঞ্চলসমূহ'), 'Bengali "Advanced → Regions" missing');
    assert(bnChecklistText.includes('উন্নত → পাইকারী বিক্রেতা'), 'Bengali "Advanced → Wholesalers" missing');
    assert(bnChecklistText.includes('মুলতুবি কেওয়াইসি'), 'Bengali "Pending KYC" missing');
    assert(bnChecklistText.includes('যান →'), 'Bengali "Go →" missing');
    assert(bnChecklistText.includes('লক করা'), 'Bengali "Locked" missing');
    console.log('  [PASS] Bengali translations verified (Locked, Go, Advanced hints)');
    await page.screenshot({ path: path.join(screenshotsDir, 'getting_started_bn.png') });

    // Also verify Pending and Done translations when stockist/customer exist
    mockStockists.push({ id: 's-test-1', is_active: true });
    await page.locator('.admin-nav-item').nth(1).click();
    await page.waitForTimeout(200);
    await page.locator('.admin-nav-item').first().click();
    await page.waitForTimeout(300);

    const anyChecklistHeading = page.locator('h3:has-text("Getting Started"), h3:has-text("आरंभ करना"), h3:has-text("শুরু করুন")');

    // Trigger setup-progress refresh by reloading with updated mockStockists
    await page.reload();
    await waitForSplash(page);
    await anyChecklistHeading.waitFor({ state: 'visible', timeout: 8000 });
    await page.evaluate(() => {
      if (window.__fastnet_set_lang) window.__fastnet_set_lang('hi');
    });
    await page.waitForTimeout(400);
    const hiPendingText = await page.locator('.admin-container').textContent();
    assert(hiPendingText.includes('लंबित'), 'Hindi "Pending" missing when Step 3 is done');

    await page.evaluate(() => {
      if (window.__fastnet_set_lang) window.__fastnet_set_lang('bn');
    });
    await page.waitForTimeout(400);
    const bnPendingText = await page.locator('.admin-container').textContent();
    assert(bnPendingText.includes('মুলতুবি'), 'Bengali "Pending" missing when Step 3 is done');
    console.log('  [PASS] Hindi and Bengali "Pending" verified');

    mockCustomers.push({ id: 'c-test-1', role: 'CUSTOMER', is_active: true });
    await page.reload();
    await waitForSplash(page);
    await anyChecklistHeading.waitFor({ state: 'visible', timeout: 8000 });
    await page.evaluate(() => {
      if (window.__fastnet_set_lang) window.__fastnet_set_lang('hi');
    });
    await page.waitForTimeout(400);
    const hiDoneText = await page.locator('.admin-container').textContent();
    assert(hiDoneText.includes('पूर्ण'), 'Hindi "Done" missing when Step 4 is done');

    await page.evaluate(() => {
      if (window.__fastnet_set_lang) window.__fastnet_set_lang('bn');
    });
    await page.waitForTimeout(400);
    const bnDoneText = await page.locator('.admin-container').textContent();
    assert(bnDoneText.includes('সম্পন্ন'), 'Bengali "Done" missing when Step 4 is done');
    console.log('  [PASS] Hindi and Bengali "Done" verified');

    console.log('\n=== ALL GETTING STARTED CHECKLIST PLAYWRIGHT CHECKS PASSED ===');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
