const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/50e546d2-67ba-4a26-bfc9-09d168e65e7a';

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

async function runToastChecks() {
  console.log('========================================================================');
  console.log('FASTNET PLAYWRIGHT CHECK: TOAST AUTO-HIDE, COUNTDOWN & CLOSE BUTTON');
  console.log('========================================================================\n');

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  // Clear rate limits
  await fetch('http://localhost:3001/api/admin/clear-rate-limits', { method: 'POST' }).catch(() => {});

  const browser = await launchBrowser();
  let allPassed = true;

  // --- 1. Phone apps (440px) checks ---
  console.log('--- [CHECK 1] Phone app at 440px ---');
  {
    const context = await browser.newContext({
      viewport: { width: 440, height: 800 },
      hasTouch: true
    });
    const page = await context.newPage();
    await page.goto('http://localhost:5173/?role=stockist');
    await page.waitForTimeout(500);

    // Ensure splash is dismissed if present
    const splash = page.locator('.cs-splash');
    if (await splash.count() > 0) {
      await splash.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    }

    // Step 1: Trigger "No account found" by logging in with an unregistered number
    console.log('  Testing: Trigger "No account found" -> assert warning icon, gone by 5.5s...');
    const unregPhone = '91' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneInput = page.locator('input[type="tel"], input[type="text"]').first();
    await phoneInput.fill(unregPhone);
    
    // Find and click Send OTP button
    const sendOtpBtn = page.locator('button:has-text("Send One-Time Password"), button:has-text("Get OTP")').first();
    await sendOtpBtn.click();

    // Wait for OTP input to appear
    const otpInput = page.locator('input.otp-input, input[placeholder*="OTP"]');
    await otpInput.waitFor({ state: 'visible', timeout: 5000 });
    await otpInput.fill('123456');

    // Dismiss the "OTP sent" toast so we can test the "No account found" toast cleanly
    const prevToast = page.locator('.toast-msg');
    if (await prevToast.count() > 0) {
      const dismiss = prevToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await prevToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    // Click Verify & Login -> triggers "No account found"
    const verifyBtn = page.locator('button:has-text("Verify & Login"), button:has-text("Verify")').first();
    await verifyBtn.click();

    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 4000 });
    
    const toastText = await toast.textContent();
    const hasErrorText = toastText.includes('No account found');
    const hasAlertIcon = (await toast.locator('svg.lucide-circle-alert, svg.lucide-alert-circle').count()) > 0;
    const hasCountdown = (await toast.locator('.toast-countdown-bar').count()) > 0;
    const hasCloseBtn = (await toast.locator('.toast-dismiss-btn').count()) > 0;

    console.log(`    - Toast visible with "No account found": ${hasErrorText ? 'PASS' : 'FAIL'}`);
    console.log(`    - AlertCircle warning icon present: ${hasAlertIcon ? 'PASS' : 'FAIL'}`);
    console.log(`    - Countdown bar present: ${hasCountdown ? 'PASS' : 'FAIL'}`);
    console.log(`    - Close button present: ${hasCloseBtn ? 'PASS' : 'FAIL'}`);
    if (!hasErrorText || !hasAlertIcon || !hasCountdown || !hasCloseBtn) allPassed = false;

    // Wait 5.5s without interaction -> toast must be gone
    console.log('    - Waiting 5.5s without interaction...');
    await page.waitForTimeout(5500);
    const toastGone1 = (await toast.count()) === 0;
    console.log(`    - Toast gone by 5.5s without interaction: ${toastGone1 ? 'PASS' : 'FAIL'}`);
    if (!toastGone1) allPassed = false;

    // Step 2: Trigger again, tap once (page.tap) and wait -> must still be gone by 5.5s
    console.log('  Testing: Trigger again, tap once (page.tap), wait -> gone by 5.5s...');
    await verifyBtn.click();
    await toast.waitFor({ state: 'visible', timeout: 4000 });
    
    // Tap the toast
    await page.tap('.toast-msg');
    console.log('    - Tapped toast via page.tap.');
    await page.waitForTimeout(5500);
    const toastGone2 = (await toast.count()) === 0;
    console.log(`    - Toast gone by 5.5s after tap: ${toastGone2 ? 'PASS' : 'FAIL'}`);
    if (!toastGone2) allPassed = false;

    // Step 3: Trigger it, then click X -> gone immediately
    console.log('  Testing: Trigger toast, click X -> gone immediately...');
    await verifyBtn.click();
    await toast.waitFor({ state: 'visible', timeout: 4000 });
    
    const dismissBtn = toast.locator('.toast-dismiss-btn');
    await dismissBtn.click();
    await toast.waitFor({ state: 'detached', timeout: 1000 });
    const toastGone3 = (await toast.count()) === 0;
    console.log(`    - Toast gone immediately after clicking X: ${toastGone3 ? 'PASS' : 'FAIL'}`);
    if (!toastGone3) allPassed = false;

    // Step 4: Trigger it, then switch to "Open a Shop" form -> gone
    console.log('  Testing: Trigger toast, switch to "Open a Shop" form -> gone...');
    await verifyBtn.click();
    await toast.waitFor({ state: 'visible', timeout: 4000 });
    
    const openShopBtn = page.locator('button:has-text("Open a Shop"), button:has-text("दुकान खोलें"), button:has-text("দোকান খুলুন")').first();
    await openShopBtn.click();
    await toast.waitFor({ state: 'detached', timeout: 1000 });
    const toastGone4 = (await toast.count()) === 0;
    console.log(`    - Toast gone after switching to "Open a Shop": ${toastGone4 ? 'PASS' : 'FAIL'}`);
    if (!toastGone4) allPassed = false;

    await context.close();
  }

  // --- 2. Desktop (1280px) checks ---
  console.log('\n--- [CHECK 2] Desktop at 1280px ---');
  {
    await fetch('http://localhost:3001/api/admin/clear-rate-limits', { method: 'POST' }).catch(() => {});
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();
    await page.goto('http://localhost:5173/?role=stockist');
    await page.waitForTimeout(500);

    const splash = page.locator('.cs-splash');
    if (await splash.count() > 0) {
      await splash.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    }

    console.log('  Testing: Hover with mouse for 8s -> still visible & bar paused -> move away -> disappears...');
    const unregPhone = '91' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneInput = page.locator('input[type="tel"], input[type="text"]').first();
    await phoneInput.fill(unregPhone);
    
    const sendOtpBtn = page.locator('button:has-text("Send One-Time Password"), button:has-text("Get OTP")').first();
    await sendOtpBtn.click();

    const otpInput = page.locator('input.otp-input, input[placeholder*="OTP"]');
    await otpInput.waitFor({ state: 'visible', timeout: 5000 });
    await otpInput.fill('123456');

    // Dismiss any existing toast
    const prevToast = page.locator('.toast-msg');
    if (await prevToast.count() > 0) {
      const dismiss = prevToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await prevToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    const verifyBtn = page.locator('button:has-text("Verify & Login"), button:has-text("Verify")').first();
    await verifyBtn.click();

    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 4000 });

    // Hover mouse over toast
    await toast.hover();
    console.log('    - Mouse hovered over toast. Waiting 8s...');
    await page.waitForTimeout(8000);

    // Verify still visible after 8s
    const stillVisible = (await toast.count()) > 0 && (await toast.isVisible());
    const isPaused = await page.evaluate(() => {
      const bar = document.querySelector('.toast-countdown-bar');
      if (!bar) return false;
      return window.getComputedStyle(bar).animationPlayState === 'paused';
    });

    console.log(`    - Still visible after 8s hover: ${stillVisible ? 'PASS' : 'FAIL'}`);
    console.log(`    - Countdown bar animationPlayState is paused: ${isPaused ? 'PASS' : 'FAIL'}`);
    if (!stillVisible || !isPaused) allPassed = false;

    // Move mouse away
    console.log('    - Moving mouse away (0, 0)...');
    await page.mouse.move(0, 0);

    // Toast should dismiss within remaining time (~5s)
    await toast.waitFor({ state: 'detached', timeout: 6000 });
    const toastGoneHover = (await toast.count()) === 0;
    console.log(`    - Toast disappeared within remaining time: ${toastGoneHover ? 'PASS' : 'FAIL'}`);
    if (!toastGoneHover) allPassed = false;

    await context.close();
  }

  // --- 3. Screenshots: Error & Success in Light & Dark ---
  console.log('\n--- [CHECK 3] Screenshots (Error & Success in Light & Dark) ---');
  for (const theme of ['light', 'dark']) {
    await fetch('http://localhost:3001/api/admin/clear-rate-limits', { method: 'POST' }).catch(() => {});
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: theme
    });
    const page = await context.newPage();
    await page.goto('http://localhost:5173/?role=stockist');
    await page.evaluate((t) => {
      localStorage.clear();
      const themes = { marketing: t, customer: t, stockist: t, partner: t, admin: t };
      localStorage.setItem('fastnet.themes.v1', JSON.stringify(themes));
    }, theme);
    await page.goto('http://localhost:5173/?role=stockist');
    await page.waitForTimeout(500);

    const splash = page.locator('.cs-splash');
    if (await splash.count() > 0) {
      await splash.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    }

    // 1. Error toast screenshot ("No account found")
    const unregPhone = '91' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneInput = page.locator('input[type="tel"], input[type="text"]').first();
    await phoneInput.fill(unregPhone);
    const sendOtpBtn = page.locator('button:has-text("Send One-Time Password"), button:has-text("Get OTP")').first();
    await sendOtpBtn.click();

    const otpInput = page.locator('input.otp-input, input[placeholder*="OTP"]');
    await otpInput.waitFor({ state: 'visible', timeout: 5000 });
    await otpInput.fill('123456');

    // Dismiss previous toast
    const prevToast = page.locator('.toast-msg');
    if (await prevToast.count() > 0) {
      const dismiss = prevToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await prevToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    const verifyBtn = page.locator('button:has-text("Verify & Login"), button:has-text("Verify")').first();
    await verifyBtn.click();

    const toast = page.locator('.toast-msg');
    await toast.waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(300);

    const errorShot = `toast_error_${theme}.png`;
    await page.screenshot({ path: `tests/${errorShot}` });
    fs.copyFileSync(`tests/${errorShot}`, path.join(ARTIFACTS_DIR, errorShot));
    console.log(`  Captured error toast screenshot: ${errorShot}`);

    // Dismiss error toast and clear session/reset
    await toast.locator('.toast-dismiss-btn').click();
    await toast.waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});

    // 2. Success toast screenshot ("Welcome back, Madan Grocers!")
    // Click Back to change phone
    const backBtn = page.locator('button:has-text("Back")').first();
    if (await backBtn.count() > 0) await backBtn.click();

    await phoneInput.fill('7654321098');
    await sendOtpBtn.click();
    await otpInput.waitFor({ state: 'visible', timeout: 5000 });
    await otpInput.fill('123456');

    // Dismiss any interim toast
    const interimToast = page.locator('.toast-msg');
    if (await interimToast.count() > 0) {
      const dismiss = interimToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await interimToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    await verifyBtn.click();
    await toast.waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(300);

    const successShot = `toast_success_${theme}.png`;
    await page.screenshot({ path: `tests/${successShot}` });
    fs.copyFileSync(`tests/${successShot}`, path.join(ARTIFACTS_DIR, successShot));
    console.log(`  Captured success toast screenshot: ${successShot}`);

    await context.close();
  }

  // --- 4. Placement & Sideways Scrollbar checks ---
  console.log('\n--- [CHECK 4] Toast Placement and Sideways Scrollbar ---');
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    // 4.1 Stockist App: submit "Open a Shop" registration
    console.log('  Testing: Stockist App -> Submit "Open a Shop" registration...');
    await fetch('http://localhost:3001/api/admin/clear-rate-limits', { method: 'POST' }).catch(() => {});
    await page.goto('http://localhost:5173/?role=stockist');
    await page.waitForTimeout(500);

    const splash = page.locator('.cs-splash');
    if (await splash.count() > 0) {
      await splash.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    }

    const openShopBtn = page.locator('button:has-text("Open a Shop"), button:has-text("दुकान खोलें"), button:has-text("দোকান খুলুন")').first();
    await openShopBtn.click();
    await page.waitForTimeout(400);

    const phone = '98' + Math.floor(10000000 + Math.random() * 90000000);
    await page.locator('input[placeholder*="9876543210"]').fill(phone);
    await page.locator('input[placeholder*="Rafiq Ahmed"]').fill('Subir Das');
    await page.locator('input[placeholder*="example@beniffy.com"]').fill(`subir_${Date.now()}@example.com`);
    await page.locator('input[placeholder*="Ahmed General Store"]').fill('Das Supermart');
    await page.locator('.input-group select').first().selectOption({ index: 1 });
    await page.locator('input[placeholder="1234-5678-9012"]').fill('123456789012');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'doc.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake image content')
    });
    await page.locator('input[placeholder*="Shop 5"]').fill('Shop 10, Garia Station Road');

    const submitBtn = page.locator('button:has-text("Submit for KYC Review")');
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Submit for KYC Review'));
      return btn && !btn.disabled;
    }, { timeout: 5000 });
    await submitBtn.click();

    const stockistToast = page.locator('.toast-msg');
    await stockistToast.waitFor({ state: 'visible', timeout: 6000 });
    await page.waitForTimeout(300);

    const stockistMetrics = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      const p = document.querySelector('.phone-mockup');
      const ps = document.querySelector('.phone-screen');
      if (!t || !p) return null;
      const tr = t.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const tCenter = tr.left + tr.width / 2;
      const pCenter = pr.left + pr.width / 2;
      return {
        centerDiff: Math.abs(tCenter - pCenter),
        inside: tr.left >= pr.left - 1 && tr.right <= pr.right + 1,
        hasSidewaysScroll: ps ? ps.scrollWidth > ps.clientWidth : false
      };
    });

    console.log(`    - Stockist center within 2px (diff: ${stockistMetrics?.centerDiff}px): ${stockistMetrics && stockistMetrics.centerDiff <= 2 ? 'PASS' : 'FAIL'}`);
    console.log(`    - Stockist toast fully inside phone box: ${stockistMetrics && stockistMetrics.inside ? 'PASS' : 'FAIL'}`);
    console.log(`    - Stockist phone has no sideways scroll: ${stockistMetrics && !stockistMetrics.hasSidewaysScroll ? 'PASS' : 'FAIL'}`);
    if (!stockistMetrics || stockistMetrics.centerDiff > 2 || !stockistMetrics.inside || stockistMetrics.hasSidewaysScroll) {
      allPassed = false;
    }

    const stockistShot = 'toast_stockist_placement.png';
    await page.screenshot({ path: `tests/${stockistShot}` });
    fs.copyFileSync(`tests/${stockistShot}`, path.join(ARTIFACTS_DIR, stockistShot));
    console.log(`    - Captured screenshot: ${stockistShot}`);

    // Dismiss toast
    if ((await stockistToast.count()) > 0) {
      const dismiss = stockistToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await stockistToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    // 4.2 Customer App
    console.log('  Testing: Customer App toast placement...');
    await page.goto('http://localhost:5173/?role=customer');
    await page.waitForTimeout(500);
    const csSplash = page.locator('.cs-splash');
    if (await csSplash.count() > 0) {
      await csSplash.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    }

    await page.evaluate(() => window.__fastnet_show_toast('Welcome to Beniffy Customer App!', 'info'));
    const customerToast = page.locator('.toast-msg');
    await customerToast.waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(300);

    const customerMetrics = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      const p = document.querySelector('.phone-mockup');
      const ps = document.querySelector('.phone-screen');
      if (!t || !p) return null;
      const tr = t.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const tCenter = tr.left + tr.width / 2;
      const pCenter = pr.left + pr.width / 2;
      return {
        centerDiff: Math.abs(tCenter - pCenter),
        inside: tr.left >= pr.left - 1 && tr.right <= pr.right + 1,
        hasSidewaysScroll: ps ? ps.scrollWidth > ps.clientWidth : false
      };
    });

    console.log(`    - Customer center within 2px (diff: ${customerMetrics?.centerDiff}px): ${customerMetrics && customerMetrics.centerDiff <= 2 ? 'PASS' : 'FAIL'}`);
    console.log(`    - Customer toast fully inside phone box: ${customerMetrics && customerMetrics.inside ? 'PASS' : 'FAIL'}`);
    console.log(`    - Customer phone has no sideways scroll: ${customerMetrics && !customerMetrics.hasSidewaysScroll ? 'PASS' : 'FAIL'}`);
    if (!customerMetrics || customerMetrics.centerDiff > 2 || !customerMetrics.inside || customerMetrics.hasSidewaysScroll) {
      allPassed = false;
    }

    const customerShot = 'toast_customer_placement.png';
    await page.screenshot({ path: `tests/${customerShot}` });
    fs.copyFileSync(`tests/${customerShot}`, path.join(ARTIFACTS_DIR, customerShot));
    console.log(`    - Captured screenshot: ${customerShot}`);

    if ((await customerToast.count()) > 0) {
      const dismiss = customerToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await customerToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    // 4.3 Partner App
    console.log('  Testing: Partner App toast placement...');
    await page.goto('http://localhost:5173/?role=partner');
    await page.waitForTimeout(500);

    await page.evaluate(() => window.__fastnet_show_toast('Partner portal ready for orders.', 'info'));
    const partnerToast = page.locator('.toast-msg');
    await partnerToast.waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(300);

    const partnerMetrics = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      const p = document.querySelector('.phone-mockup');
      const ps = document.querySelector('.phone-screen');
      if (!t || !p) return null;
      const tr = t.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const tCenter = tr.left + tr.width / 2;
      const pCenter = pr.left + pr.width / 2;
      return {
        centerDiff: Math.abs(tCenter - pCenter),
        inside: tr.left >= pr.left - 1 && tr.right <= pr.right + 1,
        hasSidewaysScroll: ps ? ps.scrollWidth > ps.clientWidth : false
      };
    });

    console.log(`    - Partner center within 2px (diff: ${partnerMetrics?.centerDiff}px): ${partnerMetrics && partnerMetrics.centerDiff <= 2 ? 'PASS' : 'FAIL'}`);
    console.log(`    - Partner toast fully inside phone box: ${partnerMetrics && partnerMetrics.inside ? 'PASS' : 'FAIL'}`);
    console.log(`    - Partner phone has no sideways scroll: ${partnerMetrics && !partnerMetrics.hasSidewaysScroll ? 'PASS' : 'FAIL'}`);
    if (!partnerMetrics || partnerMetrics.centerDiff > 2 || !partnerMetrics.inside || partnerMetrics.hasSidewaysScroll) {
      allPassed = false;
    }

    const partnerShot = 'toast_partner_placement.png';
    await page.screenshot({ path: `tests/${partnerShot}` });
    fs.copyFileSync(`tests/${partnerShot}`, path.join(ARTIFACTS_DIR, partnerShot));
    console.log(`    - Captured screenshot: ${partnerShot}`);

    if ((await partnerToast.count()) > 0) {
      const dismiss = partnerToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await partnerToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    // 4.4 Long message (~120 chars) wrapping onto 2-3 lines
    console.log('  Testing: Long message (~120 chars) wrapping onto multiple lines...');
    const longMsg = 'This is an important notification regarding your Beniffy order status. Please review all details and confirmation carefully.';
    await page.evaluate((m) => window.__fastnet_show_toast(m, 'info'), longMsg);

    const longToast = page.locator('.toast-msg');
    await longToast.waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(300);

    const longMetrics = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      const p = document.querySelector('.phone-mockup');
      const ps = document.querySelector('.phone-screen');
      if (!t || !p) return null;
      const tr = t.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const tCenter = tr.left + tr.width / 2;
      const pCenter = pr.left + pr.width / 2;
      return {
        centerDiff: Math.abs(tCenter - pCenter),
        inside: tr.left >= pr.left - 1 && tr.right <= pr.right + 1,
        hasSidewaysScroll: ps ? ps.scrollWidth > ps.clientWidth : false,
        height: tr.height,
        isMultiLine: tr.height >= 50
      };
    });

    console.log(`    - Long toast center within 2px (diff: ${longMetrics?.centerDiff}px): ${longMetrics && longMetrics.centerDiff <= 2 ? 'PASS' : 'FAIL'}`);
    console.log(`    - Long toast fully inside phone box: ${longMetrics && longMetrics.inside ? 'PASS' : 'FAIL'}`);
    console.log(`    - Long toast has no sideways scroll: ${longMetrics && !longMetrics.hasSidewaysScroll ? 'PASS' : 'FAIL'}`);
    console.log(`    - Long toast height wraps to multiple lines (height: ${longMetrics?.height}px): ${longMetrics && longMetrics.isMultiLine ? 'PASS' : 'FAIL'}`);
    if (!longMetrics || longMetrics.centerDiff > 2 || !longMetrics.inside || longMetrics.hasSidewaysScroll || !longMetrics.isMultiLine) {
      allPassed = false;
    }

    const longShot = 'toast_long_wrapped.png';
    await page.screenshot({ path: `tests/${longShot}` });
    fs.copyFileSync(`tests/${longShot}`, path.join(ARTIFACTS_DIR, longShot));
    console.log(`    - Captured screenshot: ${longShot}`);

    if ((await longToast.count()) > 0) {
      const dismiss = longToast.locator('.toast-dismiss-btn');
      if (await dismiss.count() > 0) await dismiss.click();
      await longToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }

    // 4.5 Admin App: toast sits bottom-right of page
    console.log('  Testing: Admin App -> toast sits bottom-right of the page...');
    await page.goto('http://localhost:5173/?role=admin');
    await page.waitForTimeout(500);

    await page.evaluate(() => window.__fastnet_show_toast('Admin action executed successfully.', 'success'));
    const adminToast = page.locator('.toast-msg');
    await adminToast.waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(300);

    const adminMetrics = await page.evaluate(() => {
      const t = document.querySelector('.toast-msg');
      if (!t) return null;
      const tr = t.getBoundingClientRect();
      const rightDist = window.innerWidth - tr.right;
      const bottomDist = window.innerHeight - tr.bottom;
      return {
        rightDist,
        bottomDist,
        isBottomRight: rightDist >= 10 && rightDist <= 35 && bottomDist >= 10 && bottomDist <= 35
      };
    });

    console.log(`    - Admin toast distance from right: ${adminMetrics?.rightDist}px, bottom: ${adminMetrics?.bottomDist}px`);
    console.log(`    - Admin toast placed bottom-right: ${adminMetrics && adminMetrics.isBottomRight ? 'PASS' : 'FAIL'}`);
    if (!adminMetrics || !adminMetrics.isBottomRight) {
      allPassed = false;
    }

    const adminShot = 'toast_admin_placement.png';
    await page.screenshot({ path: `tests/${adminShot}` });
    fs.copyFileSync(`tests/${adminShot}`, path.join(ARTIFACTS_DIR, adminShot));
    console.log(`    - Captured screenshot: ${adminShot}`);

    await context.close();
  }

  await browser.close();

  console.log('\n========================================================================');
  console.log(`FINAL STATUS: ${allPassed ? 'ALL TOAST PLAYWRIGHT CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  console.log('========================================================================\n');

  if (!allPassed) process.exit(1);
}

runToastChecks().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
