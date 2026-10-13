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

async function getAdminToken() {
  // Ensure admin user exists
  await fetch('http://localhost:3001/api/setup/create-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Super Admin', phone: '9999999999', email: 'admin@fastnet.test' })
  }).catch(() => null);

  const res = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
  }).then(r => r.json()).catch(() => null);

  return res;
}

async function getCustomerToken() {
  const res = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.json()).catch(() => null);
  return res;
}

async function getStockistToken() {
  const res = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '7654321098', otp: '123456', expected_role: 'STOCKIST' })
  }).then(r => r.json()).catch(() => null);
  return res;
}

async function runTestsForViewport(browser, width, height) {
  console.log(`\n======================================================`);
  console.log(`  RUNNING PLAYWRIGHT POPUP REMOUNT CHECKS AT ${width}x${height}`);
  console.log(`======================================================\n`);

  const adminSession = await getAdminToken();
  const customerSession = await getCustomerToken();
  const stockistSession = await getStockistToken();

  // 1. ADMIN REGIONS ADD REGION TEST
  {
    console.log(`[${width}px] Testing Admin: Add Region typing & persistence...`);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173/?role=admin');
    if (adminSession && adminSession.token) {
      await page.evaluate(({ user, token }) => {
        localStorage.setItem('currentUser', JSON.stringify(user));
        localStorage.setItem('token', token);
      }, { user: adminSession.user, token: adminSession.token });
      await page.goto('http://localhost:5173/?role=admin');
    }
    await page.waitForTimeout(600);

    // Click Regions tab in Admin (expand Advanced if collapsed)
    const regionsTab = page.locator('button.admin-nav-item:has-text("Regions")').first();
    if (!(await regionsTab.isVisible())) {
      const advBtn = page.locator('button:has-text("Advanced")').first();
      if (await advBtn.isVisible()) {
        await advBtn.click();
        await page.waitForTimeout(300);
      }
    }
    await regionsTab.waitFor({ timeout: 6000 });
    await regionsTab.click();
    await page.waitForTimeout(400);

    // Click "+ Add Region"
    const addRegionBtn = page.locator('button:has-text("Add Region")').first();
    await addRegionBtn.waitFor({ timeout: 4000 });
    await addRegionBtn.click();

    // Modal opens
    const modalContent = page.locator('.modal-content:has-text("Add New Region")');
    await modalContent.waitFor({ timeout: 4000 });

    // Assert it is page-wide (not in .phone-mockup)
    const inPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await modalContent.elementHandle());
    assert.strictEqual(inPhone, false, 'Admin popup must be page-wide, NOT inside phone-mockup');

    // Keep handle to popup
    const popupHandle = await modalContent.elementHandle();

    // Find Region Name input
    const nameInput = page.locator('.modal-content input[placeholder="e.g. Kolkata South (Garia)"]');
    await nameInput.click();

    // Type with 50ms delay per key
    const typeText = 'Bishnupur East';
    await page.keyboard.type(typeText, { delay: 50 });

    // Assert input value
    const val = await nameInput.inputValue();
    assert.strictEqual(val, typeText, `Admin input value must match typed text exactly. Expected "${typeText}", got "${val}"`);

    // Assert activeElement is input
    const isFocused = await page.evaluate((el) => document.activeElement === el, await nameInput.elementHandle());
    assert.strictEqual(isFocused, true, 'Admin Region Name input must remain activeElement after typing');

    // Assert popup node identity (isConnected stays true)
    const isConnected = await page.evaluate((el) => el.isConnected, popupHandle);
    assert.strictEqual(isConnected, true, 'Admin popup DOM element must stay connected (no remounting)');

    // Save region
    const createBtn = page.locator('.modal-content button:has-text("Create Region")');
    await createBtn.click();
    await page.waitForTimeout(800);

    // Assert the new region appears in the list
    const regionRow = page.locator(`table tr td:has-text("${typeText}")`).first();
    await regionRow.waitFor({ timeout: 6000 });
    console.log(`✓ [PASS] Admin Add Region: typed "${typeText}" at 50ms/key without focus loss or remount, region saved.`);

    await context.close();
  }

  // 2. CUSTOMER REPORT A PROBLEM POPUP TEST
  {
    console.log(`[${width}px] Testing Customer: Report a Problem popup typing in phone...`);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173/?role=customer');
    if (customerSession && customerSession.token) {
      await page.evaluate(({ user, token }) => {
        localStorage.setItem('currentUser', JSON.stringify(user));
        localStorage.setItem('token', token);
      }, { user: customerSession.user, token: customerSession.token });
      await page.goto('http://localhost:5173/?role=customer');
    }

    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Switch to Points/Ledger tab (2nd phone-nav-btn)
    const navBtns = page.locator('.phone-mockup .phone-nav-btn');
    await navBtns.nth(1).click();
    await page.waitForTimeout(400);

    // Click "Report a problem"
    const reportBtn = page.locator('.phone-mockup button:has-text("Report a problem"), .phone-mockup button:has-text("समस्या")');
    await reportBtn.waitFor({ timeout: 5000 });
    await reportBtn.click();

    // Modal opens
    const modalContent = page.locator('.modal-content:has-text("Report a Problem")');
    await modalContent.waitFor({ timeout: 4000 });

    // Assert it portals into .phone-mockup
    const inPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await modalContent.elementHandle());
    assert.strictEqual(inPhone, true, 'Customer popup must portal inside .phone-mockup');

    const popupHandle = await modalContent.elementHandle();

    // Find textarea
    const textarea = page.locator('.modal-content textarea[placeholder*="Provide details"]');
    await textarea.click();

    const descText = 'Item was damaged during transit yesterday';
    await page.keyboard.type(descText, { delay: 50 });

    const val = await textarea.inputValue();
    assert.strictEqual(val, descText, `Customer textarea value must match typed text. Expected "${descText}", got "${val}"`);

    const isFocused = await page.evaluate((el) => document.activeElement === el, await textarea.elementHandle());
    assert.strictEqual(isFocused, true, 'Customer textarea must maintain focus throughout typing');

    const isConnected = await page.evaluate((el) => el.isConnected, popupHandle);
    assert.strictEqual(isConnected, true, 'Customer popup must remain connected (no remounting)');

    // Close modal
    const closeBtn = page.locator('.modal-content button:has(svg)').first();
    await closeBtn.click();
    await page.waitForTimeout(300);

    console.log(`✓ [PASS] Customer Report a Problem: typed inside phone popup without focus loss or remount.`);
    await context.close();
  }

  // 3. STOCKIST FORM POPUP TEST
  {
    console.log(`[${width}px] Testing Stockist: Change phone popup typing in phone...`);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173/?role=stockist');
    if (stockistSession && stockistSession.token) {
      await page.evaluate(({ user, token }) => {
        localStorage.setItem('currentUser', JSON.stringify(user));
        localStorage.setItem('token', token);
      }, { user: stockistSession.user, token: stockistSession.token });
      await page.goto('http://localhost:5173/?role=stockist');
    }

    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Switch to Settings tab (4th phone-nav-btn)
    const navBtns = page.locator('.phone-mockup .phone-nav-btn');
    await navBtns.nth(3).click();
    await page.waitForTimeout(400);

    // Click "Change" next to Phone Number
    const changeBtn = page.locator('.phone-mockup button:has-text("Change"), .phone-mockup button:has-text("बदलें")').first();
    await changeBtn.waitFor({ timeout: 5000 });
    await changeBtn.click();

    // Modal opens
    const modalContent = page.locator('.modal-content:has-text("Change Phone Number")');
    await modalContent.waitFor({ timeout: 4000 });

    // Assert it portals into .phone-mockup
    const inPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await modalContent.elementHandle());
    assert.strictEqual(inPhone, true, 'Stockist popup must portal inside .phone-mockup');

    const popupHandle = await modalContent.elementHandle();

    // Find input
    const phoneInput = page.locator('.modal-content input[placeholder*="Enter new phone number"]');
    await phoneInput.click();

    const newPhone = '9876543211';
    await page.keyboard.type(newPhone, { delay: 50 });

    const val = await phoneInput.inputValue();
    assert.strictEqual(val, newPhone, `Stockist input value must match typed text. Expected "${newPhone}", got "${val}"`);

    const isFocused = await page.evaluate((el) => document.activeElement === el, await phoneInput.elementHandle());
    assert.strictEqual(isFocused, true, 'Stockist input must maintain focus throughout typing');

    const isConnected = await page.evaluate((el) => el.isConnected, popupHandle);
    assert.strictEqual(isConnected, true, 'Stockist popup must remain connected (no remounting)');

    // Close modal
    const cancelBtn = page.locator('.modal-content button:has-text("Cancel")');
    await cancelBtn.click();
    await page.waitForTimeout(300);

    console.log(`✓ [PASS] Stockist Form Popup: typed inside phone popup without focus loss or remount.`);
    await context.close();
  }

  // 4. PARTNER FIRST-TIME SETUP EMAIL TEST
  {
    console.log(`[${width}px] Testing Partner: First-time setup email popup typing in phone...`);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    // Mock setup_required response for OTP verification
    await page.route('**/api/partner/auth/login-otp-verify', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setup_required: true, setup_token: 'fake-setup-token-123' })
      });
    });

    await page.goto('http://localhost:5173/?role=partner');
    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Switch to phone login tab if currently on password tab
    const phoneLoginBtn = page.locator('.phone-mockup button:has-text("phone login"), .phone-mockup button:has-text("लॉगिन")');
    if (await phoneLoginBtn.isVisible()) {
      await phoneLoginBtn.click();
      await page.waitForTimeout(300);
    }

    // Enter phone and send OTP
    const phoneInput = page.locator('.phone-mockup input[placeholder*="10-digit"]').first();
    await phoneInput.fill('9876500000');

    const sendOtpBtn = page.locator('.phone-mockup button:has-text("Send One-Time Password")');
    await sendOtpBtn.click();
    await page.waitForTimeout(400);

    // Fill OTP
    const otpInput = page.locator('.phone-mockup input[placeholder*="6-digit OTP"]').first();
    await otpInput.fill('123456');

    // Click Verify
    const verifyBtn = page.locator('.phone-mockup button:has-text("Verify")').first();
    await verifyBtn.click();

    // Modal opens: "Set up your partner account"
    const modalContent = page.locator('.modal-content:has-text("Set up your partner account")');
    await modalContent.waitFor({ timeout: 5000 });

    // Assert it portals into .phone-mockup
    const inPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await modalContent.elementHandle());
    assert.strictEqual(inPhone, true, 'Partner first-time setup popup must portal inside .phone-mockup');

    const popupHandle = await modalContent.elementHandle();

    // Find email input
    const emailInput = page.locator('.modal-content input[placeholder="partner@example.com"]');
    await emailInput.click();

    const emailText = 'adhya.cable@example.com';
    await page.keyboard.type(emailText, { delay: 50 });

    const val = await emailInput.inputValue();
    assert.strictEqual(val, emailText, `Partner setup email must match typed text. Expected "${emailText}", got "${val}"`);

    const isFocused = await page.evaluate((el) => document.activeElement === el, await emailInput.elementHandle());
    assert.strictEqual(isFocused, true, 'Partner setup email input must maintain focus throughout typing');

    const isConnected = await page.evaluate((el) => el.isConnected, popupHandle);
    assert.strictEqual(isConnected, true, 'Partner setup popup must remain connected (no remounting)');

    console.log(`✓ [PASS] Partner First-time Setup: typed email inside phone popup without focus loss or remount.`);
    await context.close();
  }

  // 5. SWITCHING ROLE TABS WHILE NO POPUP IS OPEN
  {
    console.log(`[${width}px] Testing Role Switching: Popups open in phone for phone roles, page-wide for Admin...`);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173');
    await page.waitForTimeout(600);

    // Switch to Customer tab
    await page.locator('.role-switcher button.role-tab:has-text("Customer App")').click();
    await page.waitForTimeout(400);
    // Open Terms modal
    await page.locator('button:has-text("Terms"), a:has-text("Terms")').first().click();
    const customerTermsModal = page.locator('.modal-content:has-text("Terms & Conditions")');
    await customerTermsModal.waitFor({ timeout: 4000 });
    const custInPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await customerTermsModal.elementHandle());
    assert.strictEqual(custInPhone, true, 'After switching to Customer, popup must open inside phone-mockup');
    await page.locator('.modal-content button:has-text("Close")').first().click();
    await page.waitForTimeout(300);

    // Switch to Admin tab
    await page.locator('.role-switcher button.role-tab:has-text("Admin")').click();
    await page.waitForTimeout(400);
    // Open Terms modal in Admin
    await page.locator('button:has-text("Terms"), a:has-text("Terms")').first().click();
    const adminTermsModal = page.locator('.modal-content:has-text("Terms & Conditions")');
    await adminTermsModal.waitFor({ timeout: 4000 });
    const adminInPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await adminTermsModal.elementHandle());
    assert.strictEqual(adminInPhone, false, 'After switching to Admin, popup must open page-wide (NOT in phone-mockup)');
    await page.locator('.modal-content button:has-text("Close")').first().click();
    await page.waitForTimeout(300);

    // Switch to Stockist tab
    await page.locator('.role-switcher button.role-tab:has-text("Stockist App")').click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Terms"), a:has-text("Terms")').first().click();
    const stockistTermsModal = page.locator('.modal-content:has-text("Terms & Conditions")');
    await stockistTermsModal.waitFor({ timeout: 4000 });
    const stkInPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await stockistTermsModal.elementHandle());
    assert.strictEqual(stkInPhone, true, 'After switching to Stockist, popup must open inside phone-mockup');
    await page.locator('.modal-content button:has-text("Close")').first().click();
    await page.waitForTimeout(300);

    // Switch to Partner tab
    await page.locator('.role-switcher button.role-tab:has-text("Partner App")').click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Terms"), a:has-text("Terms")').first().click();
    const partnerTermsModal = page.locator('.modal-content:has-text("Terms & Conditions")');
    await partnerTermsModal.waitFor({ timeout: 4000 });
    const ptnInPhone = await page.evaluate(el => !!el.closest('.phone-mockup'), await partnerTermsModal.elementHandle());
    assert.strictEqual(ptnInPhone, true, 'After switching to Partner, popup must open inside phone-mockup');
    await page.locator('.modal-content button:has-text("Close")').first().click();
    await page.waitForTimeout(300);

    console.log(`✓ [PASS] Role Switching: ModalLayer correctly switches between phone portaling and page-wide.`);
    await context.close();
  }

  console.log(`\n✓ [ALL PASS] All checks completed successfully for viewport ${width}x${height}!\n`);
}

async function main() {
  const browser = await launchBrowser();
  try {
    await runTestsForViewport(browser, 1280, 800);
    await runTestsForViewport(browser, 440, 900);
    console.log('\n======================================================');
    console.log('✅ ALL PLAYWRIGHT CHECKS PASSED AT 1280px AND 440px!');
    console.log('======================================================\n');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
