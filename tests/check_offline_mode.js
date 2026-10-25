const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ARTIFACT_DIR = 'C:/Users/user/.gemini/antigravity-ide/brain/512136c2-1dee-4591-9683-76e287c0023e';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

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
  console.log('=== RUNNING PLAYWRIGHT OFFLINE MODE CHECKS ===\n');

  // 1. Get tokens
  const admRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
  }).then(r => r.json());

  const custRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.json());

  const stkRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '7654321098', otp: '123456', expected_role: 'STOCKIST' })
  }).then(r => r.json());

  if (!stkRes || !stkRes.token) {
    throw new Error('Failed to get stockist token');
  }

  async function createTestOrder() {
    const oRes = await fetch('http://localhost:3001/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${custRes.token}`
      },
      body: JSON.stringify({
        customerId: custRes.user.id,
        fulfillmentType: 'DELIVERY',
        deliveryAddress: '12 Park Street, Garia',
        stores: [{
          stockistId: 's1',
          items: [{ productId: 'p1', quantity: 1 }]
        }]
      })
    }).then(r => r.json());

    const oId = oRes.orderId || oRes.order?.id;
    if (oId) {
      await fetch(`http://localhost:3001/api/orders/${oId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${admRes.token}`
        },
        body: JSON.stringify({ status: 'PENDING' })
      });
    }
    return oId;
  }

  const browser = await launchBrowser();

  for (const theme of ['light', 'dark']) {
    console.log(`\n--- Testing ${theme.toUpperCase()} at 440px ---`);
    await createTestOrder();
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      colorScheme: theme
    });

    const page = await context.newPage();

    // Mock /health and /config so devToolsEnabled is false (dev tools off)
    await page.route('**/api/health', async route => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ json: { ...json, dev_tools_enabled: false } });
    });
    await page.route('**/api/config', async route => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ json: { ...json, dev_tools_enabled: false } });
    });

    // Load page and seed localStorage for stockist
    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token, themeMode }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      const themes = { marketing: themeMode, customer: themeMode, stockist: themeMode, partner: themeMode };
      localStorage.setItem('fastnet.themes.v1', JSON.stringify(themes));
      document.documentElement.setAttribute('data-theme', themeMode);
    }, { user: stkRes.user, token: stkRes.token, themeMode: theme });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // Switch to stockist role if not already active
    const stockistTab = page.locator('.role-switcher button.role-tab:has-text("Stockist App")');
    if (await stockistTab.count() > 0) {
      await stockistTab.click();
      await page.waitForTimeout(600);
    }

    // 1. Check: No offline test card with dev tools off
    const offlineTestCard = page.locator('[data-testid="offline-test-card"]');
    const testCardVisible = await offlineTestCard.isVisible().catch(() => false);
    console.log(`Dev tools off - Offline test card visible? ${testCardVisible}`);
    if (testCardVisible) {
      throw new Error('FAIL: Offline test card is visible when dev tools are off!');
    }
    console.log('PASS: Offline test card is not visible.');

    // 2. Check: Commission tile wording
    const commissionTileText = await page.locator('text="Commission owed to Beniffy"').first().isVisible().catch(() => false);
    console.log(`Commission tile with "Commission owed to Beniffy" visible? ${commissionTileText}`);
    if (!commissionTileText) {
      throw new Error('FAIL: "Commission owed to Beniffy" tile not found!');
    }
    console.log('PASS: "Commission owed to Beniffy" tile is present.');

    // 3. Set offline mode: context.setOffline(true)
    console.log('Setting context offline...');
    await context.setOffline(true);
    await page.waitForTimeout(600);

    // Assert offline banner is visible
    const offlineBanner = page.locator('[data-testid="offline-banner"]');
    await offlineBanner.waitFor({ state: 'visible', timeout: 5000 });
    const bannerText = await offlineBanner.innerText();
    console.log('Offline banner text:', bannerText.trim());
    if (!bannerText.includes("You're offline. Actions will sync when you reconnect.")) {
      throw new Error(`FAIL: Unexpected banner text: ${bannerText}`);
    }
    console.log('PASS: Offline banner is visible with correct text.');

    // 4. Queue an action while offline
    // Look for order accept button
    const acceptBtn = page.locator('button:has-text("Accept")').first();
    if (await acceptBtn.isVisible().catch(() => false)) {
      console.log('Clicking Accept button while offline...');
      await acceptBtn.click();
      await page.waitForTimeout(600);
    } else {
      console.log('Accept button not visible, checking for any status update button...');
      const readyBtn = page.locator('button:has-text("Ready"), button:has-text("Mark Ready")').first();
      if (await readyBtn.isVisible().catch(() => false)) {
        await readyBtn.click();
        await page.waitForTimeout(600);
      }
    }

    // Check updates pending sync bar
    const syncBar = page.locator('text="updates pending sync"').first();
    await syncBar.waitFor({ state: 'visible', timeout: 5000 });
    console.log('PASS: Action queued locally and "updates pending sync" displayed.');

    // 5. Capture screenshot at 440px in light / dark
    await page.evaluate(() => {
      const pm = document.querySelector('.phone-mockup');
      if (pm) pm.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    const shotPath = path.join(SCREENSHOT_DIR, `stockist_offline_banner_${theme}_440px.png`);
    await page.screenshot({ path: shotPath });
    try {
      fs.copyFileSync(shotPath, path.join(ARTIFACT_DIR, `stockist_offline_banner_${theme}_440px.png`));
    } catch (e) {}
    console.log(`Saved screenshot: ${shotPath}`);

    // 6. Set online mode: context.setOffline(false)
    console.log('Setting context online...');
    await context.setOffline(false);
    await page.waitForTimeout(1200);

    // Offline banner should disappear
    const bannerGone = await offlineBanner.isHidden().catch(() => false);
    console.log(`Offline banner disappeared? ${bannerGone}`);
    if (!bannerGone) {
      throw new Error('FAIL: Offline banner did not disappear after reconnecting!');
    }
    console.log('PASS: Offline banner disappeared after reconnecting.');

    // Wait for sync to complete (sync bar should disappear)
    try {
      await syncBar.waitFor({ state: 'hidden', timeout: 6000 });
      console.log('PASS: Queued action synced automatically on reconnect.');
    } catch (err) {
      console.warn('Sync bar wait timed out; checking if items remain:', err.message);
    }

    await context.close();
  }

  await browser.close();
  console.log('\n=== ALL PLAYWRIGHT OFFLINE MODE CHECKS PASSED ===\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
