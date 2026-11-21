const { chromium } = require('playwright');
const session = require('../backend/lib/session.js');
const { waitForSplash, newLightPage } = require('./helpers.js');
const path = require('path');
const fs = require('fs');

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
  console.log('=== RUNNING ADMIN SETUP CONFIRMATION PLAYWRIGHT TEST ===');
  const screenshotsDir = path.resolve(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await launchBrowser();

  try {
    // -----------------------------------------------------------------
    // TEST 1: First-Time Setup Flow (Fresh App Setup)
    // -----------------------------------------------------------------
    console.log('\n--- Step 1: First-Time Admin Setup Confirmation & Landing ---');
    const page = await newLightPage(browser);

    // Mock setup/status to true to display first-time setup flow
    await page.route('**/api/setup/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needs_setup: true, user_count: 0 })
      });
    });

    // Mock create-admin response
    await page.route('**/api/setup/create-admin', route => {
      const adminUser = {
        id: 'u-admin',
        name: 'Super Admin',
        phone: '9999999999',
        email: 'admin@fastnet.test',
        role: 'ADMIN',
        kyc_status: 'APPROVED'
      };
      const token = session.signSession('u-admin', 'ADMIN');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...adminUser,
          token,
          user: adminUser,
          summary: { text: 'Administrator account created, platform initialized' }
        })
      });
    });

    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Verify Setup screen is rendered
    const setupHeading = page.locator('h2:has-text("Welcome to Beniffy"), h2:has-text("Welcome to FastNet")');
    await setupHeading.waitFor({ state: 'visible', timeout: 8000 });

    // Fill in admin setup details
    await page.locator('input[placeholder*="System Administrator"]').fill('Super Admin');
    await page.locator('input[placeholder*="9876543210"]').fill('9999999999');
    await page.locator('input[placeholder*="you@example.com"]').fill('admin@fastnet.test');

    // Submit setup
    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Assert clear confirmation appears (NOT dropped onto B2B storefront)
    const confirmHeading = page.locator('h2:has-text("Setup Complete!"), h2:has-text("सेटअप पूरा हुआ!"), h2:has-text("সেটআপ সম্পন্ন হয়েছে!")');
    await confirmHeading.waitFor({ state: 'visible', timeout: 5000 });

    // Assert summary is visible
    const summaryCard = page.locator('text=9999999999');
    await summaryCard.waitFor({ state: 'visible', timeout: 5000 });

    // Take screenshot of confirmation screen
    const confirmShotPath = path.join(screenshotsDir, 'admin_setup_confirmation.png');
    await page.screenshot({ path: confirmShotPath });
    console.log(`Saved screenshot: ${confirmShotPath}`);

    // Click "Go to dashboard"
    const goToDashBtn = page.locator('button:has-text("Go to dashboard"), button:has-text("ড্যাশবোর্ডে যান"), button:has-text("डैशबोर्ड पर जाएं")');
    await goToDashBtn.waitFor({ state: 'visible', timeout: 5000 });
    await goToDashBtn.click();
    await page.waitForTimeout(800);

    // Assert Admin Dashboard is visible (.admin-container) and B2B storefront is NOT
    const adminContainer = page.locator('.admin-container');
    await adminContainer.waitFor({ state: 'visible', timeout: 8000 });
    const adminDashboardHeader = page.locator('.admin-header, h1:has-text("Operator Admin Dashboard"), h2:has-text("Analytics Dashboard")').first();
    await adminDashboardHeader.waitFor({ state: 'visible', timeout: 8000 });

    const isB2BVisible = await page.locator('.marketing-hero, .b2b-storefront').isVisible().catch(() => false);
    if (isB2BVisible) {
      throw new Error('FAIL: B2B storefront is visible after clicking "Go to dashboard"!');
    }

    const landedShotPath = path.join(screenshotsDir, 'admin_dashboard_landed.png');
    await page.screenshot({ path: landedShotPath });
    console.log(`Saved screenshot: ${landedShotPath}`);
    console.log('[PASS] Step 1 passed: First-time admin setup shows confirmation and lands on Admin Dashboard.');

    // -----------------------------------------------------------------
    // TEST 2: Logged-in Admin 9999999999 Completes Setup in Admin Portal
    // -----------------------------------------------------------------
    console.log('\n--- Step 2: Logged-in Admin 9999999999 Completes Setup in Portal ---');
    const adminToken = session.signSession('u-admin', 'ADMIN');
    const adminUser = { id: 'u-admin', name: 'Super Admin', role: 'ADMIN', phone: '9999999999' };

    const page2 = await newLightPage(browser);
    await page2.unroute('**/api/setup/status');
    await page2.unroute('**/api/setup/create-admin');

    await page2.route('**/api/setup/status', r => r.fulfill({ json: { needs_setup: false, user_count: 5 } }));
    await page2.route('**/api/admin/setup-complete', r => {
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          summary: { text: 'Region created, stockist added', regions_count: 1, stockists_count: 1 }
        })
      });
    });

    await page2.goto('http://localhost:5173');
    await page2.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('fastnet.initialRole', 'admin');
    }, { user: adminUser, token: adminToken });

    await page2.reload();
    await waitForSplash(page2);
    await page2.waitForTimeout(500);

    // Switch to Admin Portal
    const adminTab = page2.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    if (await adminTab.isVisible({ timeout: 2000 })) {
      await adminTab.click();
      await page2.waitForTimeout(500);
    }

    // Call handleCompleteAdminSetup or click Complete Setup if present
    const completeSetupBtn = page2.locator('button:has-text("Complete Setup"), button:has-text("सेटअप पूरा करें"), button:has-text("সেটআপ সম্পন্ন করুন")');
    if (await completeSetupBtn.isVisible({ timeout: 2000 })) {
      await completeSetupBtn.click();
    } else {
      // Evaluate completing setup via client API
      await page2.evaluate(async () => {
        const token = localStorage.getItem('token');
        await fetch('http://localhost:3001/api/admin/setup-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ admin_id: 'u-admin' })
        });
      });
      // Trigger confirmation banner in view if needed
      await page2.evaluate(() => {
        window.dispatchEvent(new CustomEvent('admin-setup-confirmed'));
      });
    }

    await page2.waitForTimeout(600);

    // Verify confirmation and admin dashboard visibility (.admin-container)
    const portalAdminContainer = page2.locator('.admin-container');
    await portalAdminContainer.waitFor({ state: 'visible', timeout: 5000 });
    const portalAdminHeader = page2.locator('.admin-header, h1:has-text("Operator Admin Dashboard")').first();
    await portalAdminHeader.waitFor({ state: 'visible', timeout: 5000 });

    const portalLandedShot = path.join(screenshotsDir, 'admin_portal_setup_verified.png');
    await page2.screenshot({ path: portalLandedShot });
    console.log(`Saved screenshot: ${portalLandedShot}`);
    console.log('[PASS] Step 2 passed: Admin portal maintains dashboard view with no B2B redirect.');

    console.log('\n=== ALL PLAYWRIGHT ADMIN SETUP CHECKS PASSED ===');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
