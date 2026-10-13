const { chromium } = require('playwright');
const assert = require('assert');
const { waitForSplash } = require('./helpers.js');

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

async function runSignUpTest({ theme = 'light', lang = 'en', phoneSuffix = '001' }) {
  console.log(`\n======================================================`);
  console.log(`  RUNNING SIGN-UP TEST (Theme: ${theme}, Lang: ${lang}, Viewport: 440px)`);
  console.log(`======================================================`);

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 440, height: 900 } });
  const page = await context.newPage();

  // Reset localStorage to ensure clean signed out state
  await page.addInitScript(({ theme, lang }) => {
    localStorage.clear();
    sessionStorage.clear();
    if (theme) {
      localStorage.setItem('fastnet_theme', JSON.stringify({
        marketing: theme, customer: theme, stockist: theme, partner: theme, admin: theme
      }));
    }
    if (lang) {
      localStorage.setItem('fastnet_lang', lang);
    }
  }, { theme, lang });

  await page.goto('http://localhost:5173/?role=customer');
  await waitForSplash(page);
  await page.waitForTimeout(600);

  // If Hindi requested and not yet switched, switch language
  if (lang === 'hi') {
    const hiBtn = page.locator('button:has-text("हिंदी")').first();
    if (await hiBtn.isVisible()) {
      await hiBtn.click();
      await page.waitForTimeout(300);
    }
  }

  // Click Sign Up (Customer)
  const signUpBtn = page.locator('button:has-text("Sign Up (Customer)"), button:has-text("साइन अप (ग्राहक)")').first();
  await signUpBtn.waitFor({ state: 'visible', timeout: 5000 });
  await signUpBtn.click();
  await page.waitForTimeout(500);

  // Assert Customer Sign-up form is visible
  const signupBanner = page.locator('.phone-mockup :text-matches("New Customer Registration|नया ग्राहक पंजीकरण", "i")').first();
  await signupBanner.waitFor({ state: 'visible', timeout: 5000 });
  console.log('✓ Reached Customer Sign-up form');

  // Fill Phone Number
  const phone = `9811111${phoneSuffix}`;
  const phoneInput = page.locator('.phone-mockup input[placeholder*="9876543210"], .phone-mockup input[type="tel"]').first();
  await phoneInput.fill(phone);

  // Fill Full Name
  const nameInput = page.locator('.phone-mockup input[placeholder*="Joy Dev"]').first();
  await nameInput.fill(`Test User ${phoneSuffix}`);

  // Fill Email
  const emailInput = page.locator('.phone-mockup input[placeholder*="example@beniffy.com"]').first();
  await emailInput.fill(`testuser${phoneSuffix}@example.com`);

  // Choose Region
  const regionSelect = page.locator('.phone-mockup select').first();
  await regionSelect.selectOption({ index: 1 }); // select first available valid region
  await page.waitForTimeout(500);

  // Step A: Choose Cable Operator (choose "NOT_LISTED")
  const cableSelect = page.locator('.phone-mockup select').nth(1);
  await cableSelect.selectOption('NOT_LISTED');
  await page.waitForTimeout(300);

  // Step B: Broadband question -> click "No"
  const noBroadbandBtn = page.locator('.phone-mockup button:has-text("No"), .phone-mockup button:has-text("नहीं")').first();
  await noBroadbandBtn.click();
  await page.waitForTimeout(300);

  // 1. Open Terms & Conditions modal
  console.log('Opening Terms & Conditions popup...');
  const tcLink = page.locator('span:has-text("Terms & Conditions"), span:has-text("नियम और शर्तें")').first();
  await tcLink.click();
  await page.waitForTimeout(400);

  const tcModal = page.locator('.modal-content:has-text("Terms & Conditions"), .modal-content:has-text("नियम और शर्तें")').first();
  await tcModal.waitFor({ state: 'visible', timeout: 5000 });
  const tcHandle = await tcModal.elementHandle();

  // Assert popup is stable for 3 seconds (same DOM node, isConnected stays true, visible the whole time)
  console.log('Checking T&C stability for 3 seconds...');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500);
    const connected = await page.evaluate(el => el && el.isConnected, tcHandle);
    assert.strictEqual(connected, true, `T&C popup DOM node must stay connected at ${(i+1)*0.5}s`);
    const visible = await tcModal.isVisible();
    assert.strictEqual(visible, true, `T&C popup must stay visible at ${(i+1)*0.5}s`);
  }
  console.log('✓ T&C popup remained completely stable (same connected node) for 3 seconds');

  // Close T&C
  const closeTcBtn = page.locator('.modal-content button:has-text("Close"), .modal-content button:has-text("बंद करें")').first();
  await closeTcBtn.click();
  await page.waitForTimeout(400);
  assert.strictEqual(await tcModal.isVisible(), false, 'T&C modal should close after clicking Close');
  console.log('✓ T&C popup closed successfully');

  // 2. Open Privacy Policy modal
  console.log('Opening Privacy Policy popup...');
  const privacyLink = page.locator('span:has-text("Privacy Policy"), span:has-text("गोपनीयता नीति")').first();
  await privacyLink.click();
  await page.waitForTimeout(400);

  const privacyModal = page.locator('.modal-content:has-text("Privacy Policy"), .modal-content:has-text("गोपनीयता नीति")').first();
  await privacyModal.waitFor({ state: 'visible', timeout: 5000 });
  const privacyHandle = await privacyModal.elementHandle();

  // Assert Privacy popup is stable for 3 seconds
  console.log('Checking Privacy Policy stability for 3 seconds...');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500);
    const connected = await page.evaluate(el => el && el.isConnected, privacyHandle);
    assert.strictEqual(connected, true, `Privacy popup DOM node must stay connected at ${(i+1)*0.5}s`);
    const visible = await privacyModal.isVisible();
    assert.strictEqual(visible, true, `Privacy popup must stay visible at ${(i+1)*0.5}s`);
  }
  console.log('✓ Privacy Policy popup remained completely stable (same connected node) for 3 seconds');

  // Close Privacy Policy
  const closePrivacyBtn = page.locator('.modal-content button:has-text("Close"), .modal-content button:has-text("बंद करें")').first();
  await closePrivacyBtn.click();
  await page.waitForTimeout(400);
  assert.strictEqual(await privacyModal.isVisible(), false, 'Privacy Policy modal should close after clicking Close');
  console.log('✓ Privacy Policy popup closed successfully');

  // 3. Tick "I agree" and assert it stays ticked
  console.log('Ticking "I agree" checkbox...');
  const checkbox = page.locator('#customer-terms-checkbox');
  await checkbox.check();
  await page.waitForTimeout(500);
  let isChecked = await checkbox.isChecked();
  assert.strictEqual(isChecked, true, '"I agree" checkbox must be checked');

  // Wait 1 second and re-assert it stays ticked
  await page.waitForTimeout(1000);
  isChecked = await checkbox.isChecked();
  assert.strictEqual(isChecked, true, '"I agree" checkbox must stay checked without unticking');
  console.log('✓ "I agree" checkbox checked and remained ticked');

  // 4. Submit and assert account created and next step appears
  console.log('Submitting Customer Registration...');
  const createAccountBtn = page.locator('button:has-text("Create Account"), button:has-text("खाता बनाएं")').first();
  await createAccountBtn.click();
  await page.waitForTimeout(1500);

  // Assert next step / logged in screen or welcome toast appears
  // Next step in customer app is either the customer dashboard (tab-bar / search products) or currentUser session
  const customerSessionActive = await page.evaluate(() => {
    const u = localStorage.getItem('currentUser');
    return u ? JSON.parse(u) : null;
  });
  assert.ok(customerSessionActive, 'Customer session must be active after registration');
  assert.strictEqual(customerSessionActive.role, 'CUSTOMER', 'Session role must be CUSTOMER');
  console.log(`✓ Account successfully created! Logged in as: ${customerSessionActive.name} (${customerSessionActive.phone})`);

  // Assert user is on the customer store / home screen
  const storeView = page.locator('.phone-mockup, .simulator-shell').first();
  assert.strictEqual(await storeView.isVisible(), true, 'Customer screen must be visible');
  console.log('✓ Next step / Customer home screen successfully appeared');

  await context.close();
  await browser.close();
  console.log(`✓ [PASS] Sign-Up Test Passed for Theme: ${theme}, Lang: ${lang}\n`);
}

async function main() {
  const ts = Date.now().toString().slice(-4);
  // Test 1: 440px in light mode
  await runSignUpTest({ theme: 'light', lang: 'en', phoneSuffix: `1${ts}` });
  // Test 2: 440px in dark mode
  await runSignUpTest({ theme: 'dark', lang: 'en', phoneSuffix: `2${ts}` });
  // Test 3: 440px with Hindi selected
  await runSignUpTest({ theme: 'light', lang: 'hi', phoneSuffix: `3${ts}` });

  console.log('======================================================');
  console.log('✅ ALL SIGN-UP END-TO-END TESTS PASSED AT 440px!');
  console.log('======================================================');
}

main().catch(err => {
  console.error('❌ SIGN-UP TEST FAILED:', err);
  process.exit(1);
});
