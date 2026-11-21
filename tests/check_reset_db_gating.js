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
  console.log('=== RUNNING DATABASE RESET GATING PLAYWRIGHT TEST ===');
  const screenshotsDir = path.resolve(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await launchBrowser();

  try {
    // -----------------------------------------------------------------
    // TEST 1: Admin Login with devToolsEnabled=true (Normal Dev Server)
    // -----------------------------------------------------------------
    console.log('\n--- Step 1: Admin Login with dev tools enabled ---');
    const adminToken = session.signSession('u-admin', 'ADMIN');
    const adminUser = { id: 'u-admin', name: 'Super Admin', role: 'ADMIN', phone: '9999999999' };

    const page = await newLightPage(browser);

    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('fastnet.initialRole', 'admin');
    }, { user: adminUser, token: adminToken });

    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Verify admin dashboard container is visible
    const adminContainer = page.locator('.admin-container');
    await adminContainer.waitFor({ state: 'visible', timeout: 8000 });
    console.log('Admin container visible.');

    // -----------------------------------------------------------------
    // TEST 2: Verify "Reset Database" button is NOT in main admin header
    // -----------------------------------------------------------------
    console.log('\n--- Step 2: Verify Reset Database button is NOT on main dashboard header ---');
    const headerResetBtnCount = await page.locator('.admin-header button:has-text("Reset Database")').count();
    console.log(`Reset Database buttons in .admin-header: ${headerResetBtnCount} (Expected 0)`);
    if (headerResetBtnCount !== 0) {
      throw new Error(`FAIL: Reset Database button found in .admin-header (count: ${headerResetBtnCount})`);
    }

    // -----------------------------------------------------------------
    // TEST 3: Verify Dev Tools nav item is present in sidebar and navigate to it
    // -----------------------------------------------------------------
    console.log('\n--- Step 3: Navigate to Dev Tools section ---');
    const devToolsNavBtn = page.locator('[data-testid="admin-nav-devtools"]');
    await devToolsNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Dev Tools nav button found in sidebar.');
    await devToolsNavBtn.click();
    await page.waitForTimeout(500);

    // Verify Dev Tools section visible
    const devToolsSection = page.locator('[data-testid="admin-devtools-section"]');
    await devToolsSection.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Dev Tools section visible.');

    // Verify Reset Database button is present inside Dev Tools
    const resetDbBtn = page.locator('[data-testid="reset-db-btn"]');
    await resetDbBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Reset Database button found inside Dev Tools section.');

    // -----------------------------------------------------------------
    // TEST 4: Click Reset Database, assert typed confirmation modal
    // -----------------------------------------------------------------
    console.log('\n--- Step 4: Test typed confirmation modal ---');
    await resetDbBtn.click();
    await page.waitForTimeout(400);

    // Modal overlay should be visible
    const modalOverlay = page.locator('.modal-overlay');
    await modalOverlay.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Confirmation modal opened.');

    const confirmYesBtn = page.locator('[data-testid="confirm-modal-yes"]');
    const typedInput = page.locator('[data-testid="confirm-typed-input"]');
    await confirmYesBtn.waitFor({ state: 'visible', timeout: 5000 });
    await typedInput.waitFor({ state: 'visible', timeout: 5000 });

    // Assert confirm button is disabled initially
    const isInitiallyDisabled = await confirmYesBtn.isDisabled();
    console.log(`Confirm button disabled before typing: ${isInitiallyDisabled} (Expected true)`);
    if (!isInitiallyDisabled) {
      throw new Error('FAIL: Confirm button is not disabled initially!');
    }

    // Type wrong text (e.g. "CONFIRM" or "reset")
    await typedInput.fill('CONFIRM');
    await page.waitForTimeout(200);
    const isDisabledWithWrongText = await confirmYesBtn.isDisabled();
    console.log(`Confirm button disabled with wrong text "CONFIRM": ${isDisabledWithWrongText} (Expected true)`);
    if (!isDisabledWithWrongText) {
      throw new Error('FAIL: Confirm button became enabled with incorrect text!');
    }

    await typedInput.fill('reset');
    await page.waitForTimeout(200);
    const isDisabledWithLowercase = await confirmYesBtn.isDisabled();
    console.log(`Confirm button disabled with lowercase "reset": ${isDisabledWithLowercase} (Expected true)`);
    if (!isDisabledWithLowercase) {
      throw new Error('FAIL: Confirm button became enabled with lowercase "reset"!');
    }

    // Type "RESET"
    await typedInput.fill('RESET');
    await page.waitForTimeout(200);
    const isEnabledWithReset = !(await confirmYesBtn.isDisabled());
    console.log(`Confirm button enabled with exact "RESET": ${isEnabledWithReset} (Expected true)`);
    if (!isEnabledWithReset) {
      throw new Error('FAIL: Confirm button remained disabled with exact "RESET"!');
    }

    // Click Cancel
    const cancelBtn = page.locator('[data-testid="confirm-modal-no"]');
    await cancelBtn.waitFor({ state: 'visible', timeout: 5000 });
    await cancelBtn.click();
    await page.waitForTimeout(500);

    // Assert modal is closed
    const modalCountAfterCancel = await page.locator('.modal-overlay').count();
    console.log(`Modal overlays after Cancel: ${modalCountAfterCancel} (Expected 0)`);
    if (modalCountAfterCancel !== 0) {
      throw new Error('FAIL: Modal did not close on Cancel click!');
    }

    // -----------------------------------------------------------------
    // TEST 5: Verify Settings > Integrations shows Database reset status
    // -----------------------------------------------------------------
    console.log('\n--- Step 5: Verify Settings > Integrations shows Database reset status ---');
    const integrationsNavBtn = page.locator('[data-testid="admin-nav-integrations"]');
    await integrationsNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await integrationsNavBtn.click();
    await page.waitForTimeout(500);

    const dbResetStatusCard = page.locator('[data-testid="integration-db-reset"]');
    await dbResetStatusCard.waitFor({ state: 'visible', timeout: 5000 });
    const statusCardText = await dbResetStatusCard.textContent();
    console.log(`Database reset status card text: "${statusCardText.replace(/\s+/g, ' ').trim()}"`);
    if (!statusCardText.includes('Database reset: enabled (dev only)') && !statusCardText.includes('Database reset: disabled')) {
      throw new Error(`FAIL: Integrations screen missing expected status text, found: "${statusCardText}"`);
    }

    // -----------------------------------------------------------------
    // TEST 6: Production Mode (dev_tools_enabled: false)
    // -----------------------------------------------------------------
    console.log('\n--- Step 6: Verify button absent when dev_tools_enabled is false ---');
    const prodPage = await newLightPage(browser);

    // Mock /health and /config with dev_tools_enabled: false
    await prodPage.route('**/api/health', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', dev_tools_enabled: false })
      });
    });
    await prodPage.route('**/api/config', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', dev_tools_enabled: false })
      });
    });

    await prodPage.goto('http://localhost:5173');
    await prodPage.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('fastnet.initialRole', 'admin');
    }, { user: adminUser, token: adminToken });

    await prodPage.reload();
    await waitForSplash(prodPage);
    await prodPage.waitForTimeout(500);

    await prodPage.locator('.admin-container').waitFor({ state: 'visible', timeout: 8000 });

    // Assert Dev Tools nav item is absent
    const prodDevToolsNavCount = await prodPage.locator('[data-testid="admin-nav-devtools"]').count();
    console.log(`Dev Tools nav item count with dev_tools_enabled=false: ${prodDevToolsNavCount} (Expected 0)`);
    if (prodDevToolsNavCount !== 0) {
      throw new Error('FAIL: Dev Tools nav item found in production settings!');
    }

    // Assert Reset Database button is absent from the entire DOM
    const prodResetBtnCount = await prodPage.locator('button:has-text("Reset Database"), [data-testid="reset-db-btn"]').count();
    console.log(`Total Reset Database buttons with dev_tools_enabled=false: ${prodResetBtnCount} (Expected 0)`);
    if (prodResetBtnCount !== 0) {
      throw new Error('FAIL: Reset Database button present when dev_tools_enabled is false!');
    }

    console.log('\n=== ALL PLAYWRIGHT TESTS PASSED SUCCESSFULLY! ===');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
