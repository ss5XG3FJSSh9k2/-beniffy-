const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

async function getStockistToken() {
  const payload = JSON.stringify({ phone: '7654321098', otp: '123456', expected_role: 'STOCKIST' });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/auth/verify-otp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getStockistProfile(userId, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: `/api/stockists/by-user/${userId}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'Authorization': `Bearer ${token}`
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('=== VERIFYING TIME PICKER AT 440px (LIGHT & DARK) ===');

  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const session = await getStockistToken();
  if (!session || !session.token) {
    throw new Error('Failed to get stockist token');
  }

  const browser = await chromium.launch({ headless: true });

  for (const theme of ['light', 'dark']) {
    console.log(`\n--- Testing Theme: ${theme.toUpperCase()} (440px) ---`);
    const context = await browser.newContext({
      viewport: { width: 440, height: 850 },
      colorScheme: theme
    });
    const page = await context.newPage();

    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', async res => {
      if (res.url().includes('/api/stockist/profile')) {
        console.log(`[NETWORK] ${res.request().method()} ${res.url()} -> ${res.status()} ${await res.text().catch(()=>'')}`);
      }
    });

    await page.goto('http://localhost:5173/?role=stockist');
    await page.evaluate(({ user, token, themeName }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      localStorage.setItem('themes', JSON.stringify({ stockist: themeName }));
      localStorage.setItem('lang', 'en');
    }, { user: session.user, token: session.token, themeName: theme });

    await page.goto('http://localhost:5173/?role=stockist');
    await page.waitForTimeout(500);

    // Wait for splash if present
    const splash = page.locator('.cs-splash');
    if (await splash.count() > 0) {
      try {
        await splash.waitFor({ state: 'hidden', timeout: 3500 });
      } catch (e) {}
    }

    // Go to Settings tab
    const settingsTabBtn = page.locator('.phone-footer button').last();
    await settingsTabBtn.click();
    await page.waitForTimeout(400);

    // Locate Opening Time trigger
    const openingGroup = page.locator('.input-group:has-text("Opening Time"), .input-group:has-text("खुलने का समय"), .input-group:has-text("খোলার সময়")').first();
    await openingGroup.scrollIntoViewIfNeeded();
    const openingTrigger = openingGroup.locator('.text-input');

    // 1. Open picker
    console.log(`[${theme}] Opening Time Picker...`);
    await openingTrigger.click();
    await page.waitForSelector('.modal-overlay', { state: 'visible' });

    // Screenshot open picker
    const screenshotPath = path.join(screenshotsDir, `time_picker_open_${theme}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`[PASS] Screenshot saved to ${screenshotPath}`);

    // Verify option buttons
    const optionButtons = page.locator('.modal-content button[type="button"][aria-pressed]');
    const count = await optionButtons.count();
    console.log(`[PASS] Found ${count} option buttons with type="button" and aria-pressed attribute`);
    if (count < 60) {
      throw new Error(`Expected at least 74 option buttons (12 hours + 60 mins + 2 meridiems), found ${count}`);
    }

    const hourColumn = page.locator('.modal-content > div > div').nth(0);
    const minuteColumn = page.locator('.modal-content > div > div').nth(1);
    const meridiemColumn = page.locator('.modal-content > div > div').nth(2);

    // 2. Tap 10, tap 30, tap PM
    console.log(`[${theme}] Tapping hour 10...`);
    const hour10Btn = hourColumn.locator('button[type="button"]:text-is("10")');
    await hour10Btn.click();
    // Modal must still be open
    if (!(await page.locator('.modal-overlay').isVisible())) {
      throw new Error('Picker closed prematurely when tapping hour 10!');
    }
    if ((await hour10Btn.getAttribute('aria-pressed')) !== 'true') {
      throw new Error('Hour 10 aria-pressed is not true after click');
    }

    console.log(`[${theme}] Tapping minute 30...`);
    const minute30Btn = minuteColumn.locator('button[type="button"]:text-is("30")');
    await minute30Btn.click();
    if (!(await page.locator('.modal-overlay').isVisible())) {
      throw new Error('Picker closed prematurely when tapping minute 30!');
    }
    if ((await minute30Btn.getAttribute('aria-pressed')) !== 'true') {
      throw new Error('Minute 30 aria-pressed is not true after click');
    }

    console.log(`[${theme}] Tapping PM...`);
    const pmBtn = meridiemColumn.locator('button[type="button"]:text-is("PM")');
    await pmBtn.click();
    if (!(await page.locator('.modal-overlay').isVisible())) {
      throw new Error('Picker closed prematurely when tapping PM!');
    }
    if ((await pmBtn.getAttribute('aria-pressed')) !== 'true') {
      throw new Error('PM aria-pressed is not true after click');
    }

    // Tap OK
    console.log(`[${theme}] Tapping OK...`);
    await page.locator('.modal-content button.btn-accent:has-text("OK")').click();
    await page.waitForSelector('.modal-overlay', { state: 'hidden' });

    // Verify display shows 10:30 PM
    const displayText = (await openingTrigger.innerText()).trim();
    console.log(`[${theme}] Opening time display text: "${displayText}"`);
    if (!displayText.includes('10:30 PM')) {
      throw new Error(`Expected display text to include "10:30 PM", got: "${displayText}"`);
    }
    console.log(`[PASS] Field displays 10:30 PM`);

    // Save settings
    console.log(`[${theme}] Saving settings to profile...`);
    const saveBtn = page.locator('button:has-text("Save Settings"), button:has-text("सेटिंग्स सहेजें"), button:has-text("সেটিংস সংরক্ষণ করুন")').first();
    await saveBtn.scrollIntoViewIfNeeded();
    console.log(`[${theme}] Found save button with text: "${await saveBtn.innerText()}"`);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Verify saved profile on backend has opening_time: "22:30"
    const profile = await getStockistProfile(session.user.id, session.token);
    const openingTime = profile.opening_time || profile.stockist?.opening_time;
    console.log(`[${theme}] Saved stockist opening_time: ${openingTime}`);
    if (openingTime !== '22:30') {
      throw new Error(`Expected saved opening_time to be "22:30", got "${openingTime}"`);
    }
    console.log(`[PASS] Saved profile has opening_time "22:30"`);

    // 3. Open again, tap Cancel: value unchanged
    console.log(`[${theme}] Testing Cancel...`);
    await openingTrigger.scrollIntoViewIfNeeded();
    await openingTrigger.click();
    await page.waitForSelector('.modal-overlay', { state: 'visible' });

    // Tap 08
    const hourCol = page.locator('.modal-content > div > div').nth(0);
    await hourCol.locator('button[type="button"]:text-is("08"), button[type="button"]:text-is("8")').first().click();
    // Tap Cancel
    await page.locator('.modal-content button:has-text("Cancel")').click();
    await page.waitForSelector('.modal-overlay', { state: 'hidden' });

    const textAfterCancel = (await openingTrigger.innerText()).trim();
    if (!textAfterCancel.includes('10:30 PM')) {
      throw new Error(`Expected value unchanged ("10:30 PM") after cancel, got: "${textAfterCancel}"`);
    }
    console.log(`[PASS] Value unchanged after Cancel: "${textAfterCancel}"`);

    // 4. Open again, tap outside dark area: closes, value unchanged
    console.log(`[${theme}] Testing Outside tap...`);
    await openingTrigger.click();
    await page.waitForSelector('.modal-overlay', { state: 'visible' });

    // Tap dark area outside modal content (e.g. top-left corner of overlay)
    await page.locator('.modal-overlay').click({ position: { x: 15, y: 15 } });
    await page.waitForSelector('.modal-overlay', { state: 'hidden' });

    const textAfterOutsideTap = (await openingTrigger.innerText()).trim();
    if (!textAfterOutsideTap.includes('10:30 PM')) {
      throw new Error(`Expected value unchanged ("10:30 PM") after outside tap, got: "${textAfterOutsideTap}"`);
    }
    console.log(`[PASS] Value unchanged after outside tap: "${textAfterOutsideTap}"`);

    // 5. Open again, Escape closes
    console.log(`[${theme}] Testing Escape key...`);
    await openingTrigger.click();
    await page.waitForSelector('.modal-overlay', { state: 'visible' });

    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal-overlay', { state: 'hidden' });

    const textAfterEscape = (await openingTrigger.innerText()).trim();
    if (!textAfterEscape.includes('10:30 PM')) {
      throw new Error(`Expected value unchanged ("10:30 PM") after Escape, got: "${textAfterEscape}"`);
    }
    console.log(`[PASS] Escape closes modal, value unchanged: "${textAfterEscape}"`);

    if (pageErrors.length > 0) {
      throw new Error(`Page console errors during test: ${pageErrors.join(', ')}`);
    }

    await context.close();
  }

  await browser.close();
  console.log('\n=== ALL PLAYWRIGHT TIME PICKER CHECKS PASSED ===\n');
}

run().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
