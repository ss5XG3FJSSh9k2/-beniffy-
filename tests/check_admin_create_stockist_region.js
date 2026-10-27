const { chromium } = require('playwright');
const { waitForSplash, newLightPage } = require('./helpers.js');

async function launchBrowser() {
  const options = { headless: true };
  try {
    return await chromium.launch(options);
  } catch {
    try {
      return await chromium.launch({ ...options, channel: 'chrome' });
    } catch {
      return await chromium.launch({ ...options, channel: 'msedge' });
    }
  }
}

async function run() {
  console.log('=== RUNNING ADMIN CREATE STOCKIST REGION PLAYWRIGHT TEST ===');
  
  // 1. Get Admin Session
  const admLogin = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
  }).then(r => r.ok ? r.json() : null).catch(() => null);

  if (!admLogin || !admLogin.token) {
    console.error('Failed to authenticate admin for Playwright test');
    process.exit(1);
  }

  const browser = await launchBrowser();
  try {
    const page = await newLightPage(browser);
    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
    }, { user: admLogin.user, token: admLogin.token });

    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Switch to Admin Portal
    const adminTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    await adminTab.waitFor({ state: 'visible', timeout: 5000 });
    await adminTab.click();
    await page.waitForTimeout(800);

    // Open Stockists tab in Admin sidebar
    const stockistNavBtn = page.locator('.admin-sidebar button:has-text("Stockists")');
    await stockistNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await stockistNavBtn.click();
    await page.waitForTimeout(800);

    // Click "+ Add New Stockist"
    const addStockistBtn = page.locator('button:has-text("+ Add New Stockist")');
    await addStockistBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addStockistBtn.click();
    await page.waitForTimeout(500);

    // Verify modal is open
    const modal = page.locator('.modal-content:has-text("Create New Stockist")');
    await modal.waitFor({ state: 'visible', timeout: 5000 });

    // Check Region select default value
    const regionSelect = modal.locator('select').first();
    const regionValue = await regionSelect.inputValue();
    console.log(`Region select initial value: "${regionValue}"`);
    if (regionValue !== '') {
      throw new Error(`Expected region select to start empty, but got "${regionValue}"`);
    }

    // Fill shop name and phone
    await modal.locator('input[placeholder*="Garia Super Mart"]').fill('Test Shop No Region');
    await modal.locator('input[placeholder*="9830011223"]').fill('9830011223');

    // Select a wholesaler so wholesaler requirement is satisfied
    const vendorSelect = modal.locator('select').nth(1);
    await vendorSelect.selectOption({ index: 1 });

    // Click "Create Stockist" without choosing a region
    const submitBtn = modal.locator('button:has-text("Create Stockist")');
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Check that toast appears requiring region selection
    const toast = page.locator('.toast, [role="alert"], .alert');
    const toastText = await page.evaluate(() => {
      const t = document.querySelector('.toast') || document.querySelector('[class*="toast"]');
      return t ? t.textContent : '';
    });
    console.log(`Toast text observed: "${toastText}"`);

    if (!toastText.includes('Choose a region') && !toastText.includes('क्षेत्र चुनें') && !toastText.includes('অঞ্চল নির্বাচন করুন')) {
      throw new Error(`Expected toast requiring region selection, but got: "${toastText}"`);
    }

    // Confirm modal remains open
    const isModalStillVisible = await modal.isVisible();
    if (!isModalStillVisible) {
      throw new Error('Create stockist modal closed despite empty region error');
    }

    console.log('✓ [PASS] Admin create-stockist form requires choosing a region');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ [FAIL] Playwright admin create-stockist test failed:', err);
    await browser.close();
    process.exit(1);
  }
}

run();
