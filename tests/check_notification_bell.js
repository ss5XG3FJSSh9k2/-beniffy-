const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
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

async function run() {
  console.log('=== VERIFYING STOCKIST NOTIFICATION BELL FLOW ===');

  // 1. Authenticate Customer (9876543210)
  const custAuth = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.json());
  if (!custAuth?.token || !custAuth?.user) {
    throw new Error('Customer login failed: ' + JSON.stringify(custAuth));
  }
  const custToken = custAuth.token;
  const custUser = custAuth.user;

  // 2. Authenticate Stockist (7654321098)
  const stkAuth = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '7654321098', otp: '123456', expected_role: 'STOCKIST' })
  }).then(r => r.json());
  if (!stkAuth?.token || !stkAuth?.user) {
    throw new Error('Stockist login failed: ' + JSON.stringify(stkAuth));
  }
  const stkToken = stkAuth.token;
  const stkUser = stkAuth.user;

  // Mark all existing stockist notifications read first to have clean baseline
  await fetch('http://localhost:3001/api/notifications/read-all', {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${stkToken}` }
  });

  // 3. Customer places order with shop s1
  const orderRes = await fetch('http://localhost:3001/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${custToken}`
    },
    body: JSON.stringify({
      customerId: custUser.id,
      stockistId: 's1',
      fulfillmentType: 'PICKUP',
      pickupSlot: '12:00-14:00',
      items: [{ productId: 'p1', quantity: 1 }]
    })
  }).then(r => r.json());
  const orderId = orderRes.orderId || orderRes.orders?.[0]?.id;
  if (!orderId) {
    throw new Error('Failed to create order: ' + JSON.stringify(orderRes));
  }
  console.log('Customer placed order:', orderId);

  // 4. Customer cancels order
  const cancelRes = await fetch(`http://localhost:3001/api/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${custToken}`
    }
  }).then(r => r.json());
  console.log('Customer cancelled order:', cancelRes);

  // Verify backend notifications count for stockist
  const notifs = await fetch('http://localhost:3001/api/notifications', {
    headers: { 'Authorization': `Bearer ${stkToken}` }
  }).then(r => r.json());
  console.log(`Backend has ${notifs.length} notifications for stockist, unread: ${notifs.filter(n => !n.read_at).length}`);
  const unreadCount = notifs.filter(n => !n.read_at).length;
  if (unreadCount !== 2) {
    throw new Error(`Expected exactly 2 unread notifications for stockist, found ${unreadCount}`);
  }

  // 5. Playwright test in stockist app
  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 440, height: 850 },
    colorScheme: 'light'
  });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error('[BROWSER ERROR]', msg.text());
    }
  });

  try {
    await page.goto('http://localhost:5173');
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      localStorage.setItem('theme', 'light');
      localStorage.setItem('cookieConsent', 'accepted');
      localStorage.setItem('cookiesAccepted', 'true');
    }, { user: stkUser, token: stkToken });

    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(600);

    // Switch to Stockist role tab
    const roleBtn = page.locator('.role-switcher button.role-tab:has-text("Stockist")');
    if (await roleBtn.count() > 0) {
      await roleBtn.click();
      await page.waitForTimeout(600);
    }

    // Ensure cookie banner is dismissed before opening bell
    await page.waitForTimeout(500);
    const cookieBtn = page.locator('button:has-text("Accept")');
    if (await cookieBtn.isVisible().catch(() => false)) {
      await cookieBtn.click();
      await page.waitForTimeout(400);
    }

    // Scroll phone-mockup into view
    const phoneMockup = page.locator('.phone-mockup');
    await phoneMockup.scrollIntoViewIfNeeded();

    // Assert bell badge shows 2
    const bell = page.locator('[data-testid="notification-bell"]');
    await bell.waitFor({ state: 'visible', timeout: 5000 });
    const badge = page.locator('[data-testid="notification-badge"]');
    await badge.waitFor({ state: 'visible', timeout: 5000 });
    const badgeText = (await badge.textContent()).trim();
    console.log('Bell badge text:', badgeText);
    if (badgeText !== '2') {
      throw new Error(`Expected badge to be "2", got "${badgeText}"`);
    }

    // Open notification panel
    await bell.click();
    const panel = page.locator('[data-testid="notification-panel"]');
    await panel.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    console.log('Notification panel opened successfully');

    // Verify content of notifications
    const panelText = await panel.textContent();
    console.log('Panel text preview:', panelText.replace(/\s+/g, ' ').slice(0, 150));
    if (!panelText.includes('New order') || !panelText.includes('Order cancelled')) {
      throw new Error('Panel does not contain expected notification titles: ' + panelText);
    }
    if (!panelText.includes('Cancelled by customer')) {
      throw new Error('Panel does not contain "Cancelled by customer": ' + panelText);
    }

    // Dismiss cookie banner again if still rendered
    if (await cookieBtn.isVisible().catch(() => false)) {
      await cookieBtn.click().catch(() => {});
      await page.waitForTimeout(200);
    }

    // Capture Light Theme Screenshot at 440px
    const lightPath = path.join(screenshotsDir, 'stockist_notification_panel_light_440px.png');
    await page.screenshot({ path: lightPath });
    console.log('Saved light theme screenshot to:', lightPath);

    // Switch to dark theme and capture Dark Theme Screenshot at 440px
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
      const phone = document.querySelector('.phone-mockup');
      if (phone) phone.setAttribute('data-theme', 'dark');
    });
    await page.waitForTimeout(300);
    const darkPath = path.join(screenshotsDir, 'stockist_notification_panel_dark_440px.png');
    await page.screenshot({ path: darkPath });
    console.log('Saved dark theme screenshot to:', darkPath);

    // Tap first notification item to mark read and navigate
    const firstItem = page.locator('[data-testid^="notification-item-"]').first();
    await firstItem.click();
    await page.waitForTimeout(600);

    // Panel should close
    const isPanelHidden = await panel.isHidden().catch(() => true);
    console.log('Panel closed after item click:', isPanelHidden);

    // Unread count should drop to 1
    const updatedBadge = page.locator('[data-testid="notification-badge"]');
    await updatedBadge.waitFor({ state: 'visible', timeout: 5000 });
    const updatedBadgeText = (await updatedBadge.textContent()).trim();
    console.log('Updated bell badge text:', updatedBadgeText);
    if (updatedBadgeText !== '1') {
      throw new Error(`Expected badge to drop to "1", got "${updatedBadgeText}"`);
    }

    console.log('=== ALL NOTIFICATION BELL TESTS PASSED! ===');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
