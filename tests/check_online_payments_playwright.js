const { chromium } = require('playwright');
const session = require('../backend/lib/session.js');
const { waitForSplash, newLightPage } = require('./helpers.js');

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
  console.log('=== RUNNING ONLINE PAYMENT & INTEGRATIONS PLAYWRIGHT TEST ===');
  const browser = await launchBrowser();

  try {
    // ----------------------------------------------------
    // TEST 1: Admin Integrations Screen shows Payments: test
    // ----------------------------------------------------
    console.log('\n--- Step 1: Verify Admin Integrations Screen ---');
    const adminToken = session.signSession('u-admin', 'ADMIN');
    const adminUser = { id: 'u-admin', name: 'Super Admin', role: 'ADMIN', phone: '9999999999' };

    const adminPage = await newLightPage(browser);
    await adminPage.goto('http://localhost:5173');
    await adminPage.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('fastnet.initialRole', 'admin');
    }, { user: adminUser, token: adminToken });

    await adminPage.reload();
    await waitForSplash(adminPage);
    await adminPage.waitForTimeout(500);

    // Switch to Admin Portal
    const adminTab = adminPage.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    await adminTab.waitFor({ state: 'visible', timeout: 5000 });
    await adminTab.click();
    await adminPage.waitForTimeout(600);

    // Navigate to Integrations screen
    const integrationsNav = adminPage.locator('[data-testid="admin-nav-integrations"], .admin-sidebar button:has-text("Integrations")').first();
    await integrationsNav.waitFor({ state: 'visible', timeout: 5000 });
    await integrationsNav.click();
    await adminPage.waitForTimeout(600);

    // Verify Integrations Screen is displayed
    const integrationsScreen = adminPage.locator('[data-testid="integrations-screen"]');
    await integrationsScreen.waitFor({ state: 'visible', timeout: 5000 });

    const paymentsCard = adminPage.locator('[data-testid="integration-payments"]');
    await paymentsCard.waitFor({ state: 'visible', timeout: 5000 });
    const paymentsText = await paymentsCard.textContent();
    console.log(`Payments card text: "${paymentsText.replace(/\s+/g, ' ').trim()}"`);

    if (!paymentsText.toLowerCase().includes('payments: test') && !paymentsText.toLowerCase().includes('test')) {
      throw new Error(`Expected Payments card to show mode "test", but got: ${paymentsText}`);
    }
    if (!paymentsText.includes('Razorpay')) {
      throw new Error(`Expected Payments card to mention Razorpay provider, but got: ${paymentsText}`);
    }
    console.log('✓ [PASS] Admin Integrations screen correctly shows Payments: test');
    await adminPage.close();

    // ----------------------------------------------------
    // TEST 2: Customer Online Checkout Flow
    // ----------------------------------------------------
    console.log('\n--- Step 2: Customer Chooses Pay Online & Completes Test Checkout ---');
    const custToken = session.signSession('u-cust1', 'CUSTOMER');
    const custUser = { id: 'u-cust1', name: 'Amit Sen', role: 'CUSTOMER', phone: '9876543210', region_id: 'r1', address: '12 Park Street, Garia' };

    const page = await newLightPage(browser);
    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('fastnet.initialRole', 'customer');
    }, { user: custUser, token: custToken });

    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(600);

    // Switch to Customer App tab
    const custTab = page.locator('.role-switcher button.role-tab:has-text("Customer App")');
    await custTab.waitFor({ state: 'visible', timeout: 5000 });
    await custTab.click();
    await page.waitForTimeout(600);

    // Click on first stockist if in stockist list
    const shopCard = page.locator('.stockist-card, .glass-card:has-text("Madan Grocers"), .glass-card:has(button:has-text("Shop Now"))').first();
    if (await shopCard.isVisible()) {
      const shopBtn = shopCard.locator('button:has-text("Shop Now"), button').first();
      await shopBtn.click();
      await page.waitForTimeout(500);
    }

    // Add first available product to cart
    const addBtn = page.locator('button:has-text("Add")').first();
    await addBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(500);

    // Open Cart via the sticky cart bar or View Cart button
    const viewCartBar = page.locator('div:has-text("View Cart"), div:has-text("কার্ট দেখুন"), div:has-text("कार्ट देखें")').last();
    await viewCartBar.waitFor({ state: 'visible', timeout: 5000 });
    await viewCartBar.click();
    await page.waitForTimeout(600);

    // Select pickup slot if selector exists
    const slotSelect = page.locator('select.text-input').first();
    if (await slotSelect.isVisible()) {
      await slotSelect.selectOption({ index: 1 });
      await page.waitForTimeout(300);
    }

    // Click "Pay online" option
    const payOnlineOption = page.locator('button:has-text("Pay online"), button:has-text("অনলাইনে পেমেন্ট"), button:has-text("ऑनलाइन भुगतान")').first();
    await payOnlineOption.waitFor({ state: 'visible', timeout: 5000 });
    await payOnlineOption.click();
    await page.waitForTimeout(400);

    // Click "Proceed to Pay Online"
    const proceedBtn = page.locator('button:has-text("Proceed to Pay Online"), button:has-text("অনলাইন পেমেন্টে এগিয়ে যান"), button:has-text("ऑनलाइन भुगतान के लिए आगे बढ़ें")').first();
    await proceedBtn.waitFor({ state: 'visible', timeout: 5000 });
    await proceedBtn.click();

    // Verify redirect to /pay/test/:orderId
    await page.waitForURL(url => url.pathname.startsWith('/pay/test/'), { timeout: 10000 });
    console.log(`Navigated to test checkout page: ${page.url()}`);

    // Verify test checkout page elements
    const successBtn = page.locator('#pay-success-btn, button:has-text("Pay successfully")');
    await successBtn.waitFor({ state: 'visible', timeout: 5000 });
    const failBtn = page.locator('#pay-fail-btn, button:has-text("Fail payment")');
    await failBtn.waitFor({ state: 'visible', timeout: 5000 });

    // Click "Pay successfully"
    await successBtn.click();

    // Verify redirection back to store with ?payment=success
    await page.waitForURL(url => url.searchParams.get('payment') === 'success', { timeout: 10000 });
    console.log(`Redirected back to app: ${page.url()}`);

    // Wait for splash screen to hide after full reload
    await waitForSplash(page);
    await page.waitForTimeout(600);

    // Ensure we are in Customer App view
    const custTabReturn = page.locator('.role-switcher button.role-tab:has-text("Customer App")');
    if (await custTabReturn.isVisible()) {
      await custTabReturn.click();
      await page.waitForTimeout(500);
    }

    // Go to Orders view
    const ordersNavBtn = page.locator('button.phone-nav-btn:has-text("Orders"), button.phone-nav-btn:has-text("অর্ডার"), button.phone-nav-btn:has-text("ऑर्डर")').first();
    await ordersNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await ordersNavBtn.click();
    await page.waitForTimeout(800);

    // Verify order shows "Paid online"
    const paidOnlineBadge = page.locator('.badge-success:has-text("Paid online"), span:has-text("Paid online"), .badge:has-text("Paid online")').first();
    await paidOnlineBadge.waitFor({ state: 'visible', timeout: 5000 });
    const badgeText = await paidOnlineBadge.textContent();
    console.log(`Order badge text: "${badgeText.trim()}"`);

    console.log('✓ [PASS] Customer chose Pay online, completed test checkout, and saw "Paid online" badge');
    await browser.close();
    console.log('\n=== ALL PLAYWRIGHT TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('❌ [FAIL] Playwright test failed:', err);
    await browser.close();
    process.exit(1);
  }
}

run();
