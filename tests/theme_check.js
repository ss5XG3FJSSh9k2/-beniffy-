const { chromium } = require('playwright');
const fs = require('fs');

async function waitForSplash(page) {
  const splash = page.locator('.cs-splash');
  if (await splash.count() > 0) {
    try {
      await splash.waitFor({ state: 'hidden', timeout: 3500 });
    } catch (e) {}
  }
}

async function mockLogin(page, role, phone) {
  const http = require('http');
  const payload = JSON.stringify({ phone, otp: '123456', expected_role: role });
  const sessionData = await new Promise((resolve) => {
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
    req.write(payload);
    req.end();
  });
  await page.evaluate((data) => {
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    localStorage.setItem('token', data.token);
  }, sessionData);
  await page.reload();
  await page.waitForTimeout(500);
}

async function runThemeCheck() {
  console.log('=== RUNNING THEME CHECK ===');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ colorScheme: 'dark' });
  let page = await context.newPage();

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  // Clear storage
  await page.goto('http://localhost:5173');
  await page.evaluate(() => localStorage.clear());
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(500);

  const getTheme = async (selector) => await page.locator(selector).getAttribute('data-theme');
  const getResolvedTheme = async () => await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

  console.log('Testing dark mode default...');
  if (await getResolvedTheme() !== 'dark') throw new Error('B2B Site did not render dark');

  await mockLogin(page, 'CUSTOMER', '9876543210');
  await page.click('.role-switcher button.role-tab:has-text("Customer")');
  await waitForSplash(page);
  await page.waitForTimeout(300);
  if (await getTheme('.phone-mockup') !== 'dark') throw new Error('Customer did not render dark');

  // Customer goes to Profile tab to see Appearance
  await page.locator('.phone-bottom-nav .phone-nav-btn').last().click();
  await page.waitForTimeout(300);
  let settingsBtn = await page.locator('.phone-mockup button:has-text("System"), .phone-mockup button:has-text("सिस्टम")').first();
  let ariaPressed = await settingsBtn.getAttribute('aria-pressed');
  if (ariaPressed !== 'true') throw new Error('System not selected in Customer');

  await mockLogin(page, 'STOCKIST', '7654321098');
  await page.click('.role-switcher button.role-tab:has-text("Stockist")');
  await page.waitForTimeout(300);
  if (await getTheme('.phone-mockup') !== 'dark') throw new Error('Stockist did not render dark');

  // Admin
  await mockLogin(page, 'ADMIN', '9999999999');
  await page.click('.role-switcher button.role-tab:has-text("Admin")');
  await page.waitForTimeout(300);
  if (await getResolvedTheme() !== 'dark') throw new Error('Admin did not render dark');

  console.log('Testing light mode default...');
  const contextLight = await browser.newContext({ colorScheme: 'light' });
  const pageLight = await contextLight.newPage();
  await pageLight.goto('http://localhost:5173');
  await pageLight.evaluate(() => localStorage.clear());
  await pageLight.goto('http://localhost:5173');
  await pageLight.waitForTimeout(500);

  if (await pageLight.evaluate(() => document.documentElement.getAttribute('data-theme')) !== 'light') throw new Error('B2B Site did not render light');

  await mockLogin(pageLight, 'CUSTOMER', '9876543210');
  await pageLight.click('.role-switcher button.role-tab:has-text("Customer")');
  await waitForSplash(pageLight);
  await pageLight.waitForTimeout(300);
  if (await pageLight.locator('.phone-mockup').getAttribute('data-theme') !== 'light') throw new Error('Customer did not render light');
  
  console.log('Testing switch from light to dark without reload...');
  await pageLight.emulateMedia({ colorScheme: 'dark' });
  await pageLight.waitForTimeout(500);

  if (await pageLight.evaluate(() => document.documentElement.getAttribute('data-theme')) !== 'dark') throw new Error('B2B Site did not switch to dark');
  if (await pageLight.locator('.phone-mockup').getAttribute('data-theme') !== 'dark') throw new Error('Customer did not switch to dark');

  console.log('Testing manual override...');
  await pageLight.locator('.phone-bottom-nav .phone-nav-btn').last().click();
  await pageLight.waitForTimeout(300);
  await pageLight.click('.phone-mockup button:has-text("Light"), .phone-mockup button:has-text("रोशनी")');
  await pageLight.waitForTimeout(500);
  
  // Emulate dark again
  await pageLight.emulateMedia({ colorScheme: 'dark' });
  await pageLight.waitForTimeout(500);

  if (await pageLight.locator('.phone-mockup').getAttribute('data-theme') !== 'light') throw new Error('Customer override did not stay light');

  // Other apps still on System go dark
  await mockLogin(pageLight, 'STOCKIST', '7654321098');
  await pageLight.click('.role-switcher button.role-tab:has-text("Stockist")');
  await pageLight.waitForTimeout(300);
  if (await pageLight.locator('.phone-mockup').getAttribute('data-theme') !== 'dark') throw new Error('Stockist override did not go dark');

  console.log('Testing pick System again...');
  await mockLogin(pageLight, 'CUSTOMER', '9876543210');
  await pageLight.click('.role-switcher button.role-tab:has-text("Customer")');
  await waitForSplash(pageLight);
  await pageLight.waitForTimeout(300);
  await pageLight.locator('.phone-bottom-nav .phone-nav-btn').last().click();
  await pageLight.waitForTimeout(300);
  
  await pageLight.click('.phone-mockup button:has-text("System"), .phone-mockup button:has-text("सिस्टम")');
  await pageLight.waitForTimeout(300);
  if (await pageLight.locator('.phone-mockup').getAttribute('data-theme') !== 'dark') throw new Error('Customer did not follow dark after picking System');

  console.log('Testing reload...');
  await pageLight.reload();
  await pageLight.waitForTimeout(500);
  await pageLight.click('.role-switcher button.role-tab:has-text("Customer")');
  await waitForSplash(pageLight);
  await pageLight.waitForTimeout(300);
  await pageLight.locator('.phone-bottom-nav .phone-nav-btn').last().click();
  await pageLight.waitForTimeout(300);
  
  if (await pageLight.locator('.phone-mockup').getAttribute('data-theme') !== 'dark') throw new Error('Customer did not preserve System setting on reload');
  const sysBtn = await pageLight.locator('.phone-mockup button:has-text("System"), .phone-mockup button:has-text("सिस्टम")').first();
  if (await sysBtn.getAttribute('aria-pressed') !== 'true') throw new Error('System button not pressed on reload');

  // Screenshots of the settings row
  await pageLight.emulateMedia({ colorScheme: 'dark' });
  await pageLight.waitForTimeout(300);
  const rowDark = await pageLight.locator('h4:has-text("Appearance"), h5:has-text("Appearance"), h4:has-text("दिखावट")').locator('..');
  await rowDark.screenshot({ path: 'tests/settings_row_dark.png' });
  // Also copy to artifacts for user to see
  await rowDark.screenshot({ path: 'C:/Users/thari/.gemini/antigravity-ide/brain/af9da238-f020-4428-bfae-dfcc10ce724a/settings_row_dark.png' });

  await pageLight.emulateMedia({ colorScheme: 'light' });
  await pageLight.waitForTimeout(300);
  const rowLight = await pageLight.locator('h4:has-text("Appearance"), h5:has-text("Appearance"), h4:has-text("दिखावट")').locator('..');
  await rowLight.screenshot({ path: 'tests/settings_row_light.png' });
  // Also copy to artifacts
  await rowLight.screenshot({ path: 'C:/Users/thari/.gemini/antigravity-ide/brain/af9da238-f020-4428-bfae-dfcc10ce724a/settings_row_light.png' });

  if (errors.length > 0) {
    console.error('Errors found:', errors);
    process.exit(1);
  }
  console.log('Theme check completed successfully!');
  await browser.close();
}

runThemeCheck().catch(err => {
  console.error(err);
  process.exit(1);
});
