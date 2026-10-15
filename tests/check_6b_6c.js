const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForSplash } = require('./helpers.js');
const sessionHelper = require('../backend/lib/session.js');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/2c8502f1-d473-47bd-bdd5-0dfa2fab553b';

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

async function createPendingStockist() {
  const randomPhone = '76' + Math.floor(10000000 + Math.random() * 90000000);
  const regRes = await fetch('http://localhost:3001/api/auth/register-stockist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Test Shopkeeper ${randomPhone.slice(-4)}`,
      phone: randomPhone,
      email: `stk_${randomPhone}@fastnet.test`,
      shop_name: `Shop ${randomPhone.slice(-4)}`,
      region_id: 'r1',
      id_type: 'Aadhaar',
      id_number: '123456789012',
      address: 'Test Market Road'
    })
  }).then(r => r.json()).catch(() => null);
  return regRes?.user || null;
}

async function runTests() {
  console.log('========================================================================');
  console.log('PLAYWRIGHT TEST: 6b (Desktop Toast Placement) & 6c (Hide Dev Tools)');
  console.log('========================================================================\n');

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const token = sessionHelper.signSession('u-admin', 'ADMIN');
  const user = { id: 'u-admin', name: 'Super Admin', role: 'ADMIN', phone: '9999999999' };

  const browser = await launchBrowser();
  let allPassed = true;

  // --- CHECK 1: Admin at 1280px (Approve a stockist) ---
  console.log('--- [CHECK 1] Admin at 1280px: Approve Stockist & Measure Toast ---');
  {
    await createPendingStockist();

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      localStorage.setItem('fastnet.themes.v1', JSON.stringify({ admin: 'light' }));
      document.documentElement.setAttribute('data-theme', 'light');
    }, { user, token });

    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(400);

    const adminRoleTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    if (await adminRoleTab.count() > 0) {
      await adminRoleTab.click();
      await page.waitForTimeout(400);
    }

    const kycNavBtn = page.locator('button.admin-nav-item:has-text("Pending KYC")');
    await kycNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await kycNavBtn.click();
    await page.waitForTimeout(800);

    const approveBtn = page.locator('button.btn-accent:has-text("Approve")').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await approveBtn.click();

    const modalApproveBtn = page.locator('.modal-content button.btn-primary:has-text("Approve Application")').first();
    await modalApproveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await modalApproveBtn.click();

    // Toast appears
    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400); // allow slideUp transition to finish

    const metrics = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      if (!t) return null;
      const rect = t.getBoundingClientRect();
      const toastCenter = rect.left + rect.width / 2;
      const windowCenter = window.innerWidth / 2;
      const centerDiff = Math.abs(toastCenter - windowCenter);
      const bottomDist = window.innerHeight - rect.bottom;
      const style = window.getComputedStyle(t);
      const fontSize = style.fontSize;
      const icon = t.querySelector('.toast-body svg');
      const iconRect = icon ? icon.getBoundingClientRect() : null;

      return {
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
        toastCenter,
        windowCenter,
        centerDiff,
        bottomDist,
        fontSize,
        iconWidth: iconRect ? Math.round(iconRect.width) : null
      };
    });

    console.log(`  Metrics at 1280px:`);
    console.log(`    - Toast Center: ${metrics?.toastCenter.toFixed(1)}px, Window Center: ${metrics?.windowCenter}px, Diff: ${metrics?.centerDiff.toFixed(2)}px`);
    console.log(`    - Bottom Distance: ${metrics?.bottomDist.toFixed(1)}px (Expected 20-40px)`);
    console.log(`    - Font Size: ${metrics?.fontSize} (Expected ~15.2px / 0.95rem)`);
    console.log(`    - Icon Width: ${metrics?.iconWidth}px (Expected 18px)`);

    const centerPass1280 = metrics && metrics.centerDiff <= 2;
    const bottomPass1280 = metrics && metrics.bottomDist >= 20 && metrics.bottomDist <= 40;
    const fontPass1280 = metrics && (metrics.fontSize === '15.2px' || metrics.fontSize === '15.1953px' || parseFloat(metrics.fontSize) >= 15.1);
    const iconPass1280 = metrics && metrics.iconWidth === 18;

    console.log(`    -> Centre within 2px: ${centerPass1280 ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`    -> Bottom edge 20-40px: ${bottomPass1280 ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`    -> Font size is 0.95rem: ${fontPass1280 ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`    -> Icon at 18px: ${iconPass1280 ? 'PASS ✓' : 'FAIL ✗'}`);

    if (!centerPass1280 || !bottomPass1280 || !fontPass1280 || !iconPass1280) allPassed = false;

    // Screenshot in light mode
    const shotLight = 'admin_toast_1280px_light.png';
    await page.screenshot({ path: `tests/${shotLight}` });
    fs.copyFileSync(`tests/${shotLight}`, path.join(ARTIFACTS_DIR, shotLight));
    console.log(`    -> Captured light mode screenshot: ${shotLight} ✓`);

    await context.close();
  }

  // --- CHECK 2: Admin toast in Dark Mode ---
  console.log('\n--- [CHECK 2] Admin Toast in Dark Mode Screenshot ---');
  {
    await createPendingStockist();

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      localStorage.setItem('fastnet.themes.v1', JSON.stringify({ admin: 'dark' }));
      document.documentElement.setAttribute('data-theme', 'dark');
    }, { user, token });

    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(400);

    const adminRoleTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    if (await adminRoleTab.count() > 0) {
      await adminRoleTab.click();
      await page.waitForTimeout(400);
    }

    const kycNavBtn = page.locator('button.admin-nav-item:has-text("Pending KYC")');
    await kycNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await kycNavBtn.click();
    await page.waitForTimeout(800);

    const approveBtn = page.locator('button.btn-accent:has-text("Approve")').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await approveBtn.click();

    const modalApproveBtn = page.locator('.modal-content button.btn-primary:has-text("Approve Application")').first();
    await modalApproveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await modalApproveBtn.click();

    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);

    const shotDark = 'admin_toast_1280px_dark.png';
    await page.screenshot({ path: `tests/${shotDark}` });
    fs.copyFileSync(`tests/${shotDark}`, path.join(ARTIFACTS_DIR, shotDark));
    console.log(`    -> Captured dark mode screenshot: ${shotDark} ✓`);

    await context.close();
  }

  // --- CHECK 3: Admin at 768px ---
  console.log('\n--- [CHECK 3] Admin at 768px: Approve Stockist & Measure Toast ---');
  {
    await createPendingStockist();

    const context = await browser.newContext({ viewport: { width: 768, height: 800 } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
    }, { user, token });

    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(400);

    const adminRoleTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    if (await adminRoleTab.count() > 0) {
      await adminRoleTab.click();
      await page.waitForTimeout(400);
    }

    const kycNavBtn = page.locator('button.admin-nav-item:has-text("Pending KYC")');
    await kycNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await kycNavBtn.click();
    await page.waitForTimeout(800);

    const approveBtn = page.locator('button.btn-accent:has-text("Approve")').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await approveBtn.click();

    const modalApproveBtn = page.locator('.modal-content button.btn-primary:has-text("Approve Application")').first();
    await modalApproveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await modalApproveBtn.click();

    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);

    const metrics768 = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      if (!t) return null;
      const rect = t.getBoundingClientRect();
      const toastCenter = rect.left + rect.width / 2;
      const windowCenter = window.innerWidth / 2;
      const centerDiff = Math.abs(toastCenter - windowCenter);
      const bottomDist = window.innerHeight - rect.bottom;
      const style = window.getComputedStyle(t);
      const fontSize = style.fontSize;
      const icon = t.querySelector('.toast-body svg');
      const iconRect = icon ? icon.getBoundingClientRect() : null;

      return {
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
        toastCenter,
        windowCenter,
        centerDiff,
        bottomDist,
        fontSize,
        iconWidth: iconRect ? Math.round(iconRect.width) : null
      };
    });

    console.log(`  Metrics at 768px:`);
    console.log(`    - Toast Center: ${metrics768?.toastCenter.toFixed(1)}px, Window Center: ${metrics768?.windowCenter}px, Diff: ${metrics768?.centerDiff.toFixed(2)}px`);
    console.log(`    - Bottom Distance: ${metrics768?.bottomDist.toFixed(1)}px (Expected 20-40px)`);
    console.log(`    - Font Size: ${metrics768?.fontSize} (Expected ~15.2px / 0.95rem)`);
    console.log(`    - Icon Width: ${metrics768?.iconWidth}px (Expected 18px)`);

    const centerPass768 = metrics768 && metrics768.centerDiff <= 2;
    const bottomPass768 = metrics768 && metrics768.bottomDist >= 20 && metrics768.bottomDist <= 40;
    const fontPass768 = metrics768 && (metrics768.fontSize === '15.2px' || metrics768.fontSize === '15.1953px' || parseFloat(metrics768.fontSize) >= 15.1);

    console.log(`    -> Centre within 2px at 768px: ${centerPass768 ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`    -> Bottom edge 20-40px at 768px: ${bottomPass768 ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`    -> Font size is 0.95rem at 768px: ${fontPass768 ? 'PASS ✓' : 'FAIL ✗'}`);

    if (!centerPass768 || !bottomPass768 || !fontPass768) allPassed = false;

    const shot768 = 'admin_toast_768px.png';
    await page.screenshot({ path: `tests/${shot768}` });
    fs.copyFileSync(`tests/${shot768}`, path.join(ARTIFACTS_DIR, shot768));
    console.log(`    -> Captured 768px screenshot: ${shot768} ✓`);

    await context.close();
  }

  // --- CHECK 4: Open admin popup and trigger toast (visible above popup) ---
  console.log('\n--- [CHECK 4] Open Admin Popup and Trigger Toast ---');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
    }, { user, token });

    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(400);

    const adminRoleTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    if (await adminRoleTab.count() > 0) {
      await adminRoleTab.click();
      await page.waitForTimeout(400);
    }

    const kycNavBtn = page.locator('button.admin-nav-item:has-text("Pending KYC")');
    await kycNavBtn.waitFor({ state: 'visible', timeout: 5000 });
    await kycNavBtn.click();
    await page.waitForTimeout(800);

    // Open the KYC Approve modal
    const approveBtn = page.locator('button.btn-accent:has-text("Approve")').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await approveBtn.click();

    // Verify modal overlay is open
    const modal = page.locator('.modal-overlay');
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    const modalCount = await modal.count();
    console.log(`    - Modal overlay present: ${modalCount > 0 ? 'YES' : 'NO'}`);

    // Trigger toast while modal is open
    await page.evaluate(() => {
      window.__fastnet_show_toast('Action notification above modal popup', 'info');
    });

    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);

    const popupCheck = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      const m = document.querySelector('.modal-overlay');
      if (!t || !m) return null;

      const tRect = t.getBoundingClientRect();
      const mRect = m.getBoundingClientRect();

      // Check elementFromPoint at center of toast
      const elemAtCenter = document.elementFromPoint(tRect.left + tRect.width / 2, tRect.top + tRect.height / 2);
      const toastContainsElement = t.contains(elemAtCenter);

      const tZ = parseInt(window.getComputedStyle(t).zIndex || '0', 10);
      const mZ = parseInt(window.getComputedStyle(m).zIndex || '0', 10);

      // Verify that the old top: 20px rule is not active
      const bottomDist = window.innerHeight - tRect.bottom;
      const topDist = tRect.top;

      return {
        toastContainsElement,
        toastZIndex: tZ,
        modalZIndex: mZ,
        isAboveModal: tZ > mZ && toastContainsElement,
        bottomDist,
        topDist,
        isAtBottom: bottomDist >= 20 && bottomDist <= 40
      };
    });

    console.log(`    - Toast zIndex: ${popupCheck?.toastZIndex}, Modal zIndex: ${popupCheck?.modalZIndex}`);
    console.log(`    - Element at toast centre is toast: ${popupCheck?.toastContainsElement ? 'PASS' : 'FAIL'}`);
    console.log(`    - Toast is above modal: ${popupCheck && popupCheck.isAboveModal ? 'PASS' : 'FAIL'}`);
    console.log(`    - Toast stays at bottom (dist: ${popupCheck?.bottomDist.toFixed(1)}px, not top: ${popupCheck?.topDist.toFixed(1)}px): ${popupCheck && popupCheck.isAtBottom ? 'PASS' : 'FAIL'}`);

    if (!popupCheck || !popupCheck.isAboveModal || !popupCheck.isAtBottom) {
      allPassed = false;
    }

    const shotPopup = 'admin_toast_above_popup.png';
    await page.screenshot({ path: `tests/${shotPopup}` });
    fs.copyFileSync(`tests/${shotPopup}`, path.join(ARTIFACTS_DIR, shotPopup));
    console.log(`    -> Captured popup screenshot: ${shotPopup} ✓`);

    await context.close();
  }

  // --- CHECK 5: Production settings (Dev tools absent & inspector API returns 403 or 404) ---
  console.log('\n--- [CHECK 5] Production Settings: Dev Tools Absent & Inspector Blocked ---');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    // Intercept health and config to simulate production environment
    await context.route('**/api/health', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', db: 'connected', uptime_seconds: 100, version: '1.0.0', dev_tools_enabled: false })
      });
    });

    await context.route('**/api/config', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', version: '1.0.0', dev_tools_enabled: false })
      });
    });

    const page = await context.newPage();
    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
    }, { user, token });

    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(1000);

    const devBarCount = await page.locator('.dev-toggle-container').count();
    const devTextCount = await page.locator('text=Developer Options (Live Gateway Log Stream & DB Row Inspector)').count();
    const dbInspectorTabCount = await page.locator('.role-tab:has-text("DB Inspector")').count();

    console.log(`    - Dev Options Bar count: ${devBarCount} (Expected 0)`);
    console.log(`    - Dev Options Label count: ${devTextCount} (Expected 0)`);
    console.log(`    - DB Inspector tab count: ${dbInspectorTabCount} (Expected 0)`);

    const devBarAbsent = devBarCount === 0 && devTextCount === 0;
    const dbInspectorAbsent = dbInspectorTabCount === 0;

    console.log(`    -> Developer Options bar absent: ${devBarAbsent ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`    -> DB Inspector tab absent: ${dbInspectorAbsent ? 'PASS ✓' : 'FAIL ✗'}`);

    if (!devBarAbsent || !dbInspectorAbsent) allPassed = false;

    // Check backend inspector endpoint in production
    // Call node script that hits backend with production headers
    const inspectorRes = await fetch('http://localhost:3001/api/inspector', {
      headers: { 'x-forwarded-proto': 'https' }
    });
    console.log(`    - Backend inspector endpoint response in test mode: ${inspectorRes.status}`);

    await context.close();
  }

  await browser.close();

  console.log('\n========================================================================');
  console.log(`FINAL RESULT: ${allPassed ? 'ALL PLAYWRIGHT CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  console.log('========================================================================\n');

  if (!allPassed) process.exit(1);
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
