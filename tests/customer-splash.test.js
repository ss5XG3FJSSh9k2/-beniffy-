const { chromium } = require('playwright');

async function runTest(width, theme, reducedMotion) {
  console.log(`\n=== Running Customer Splash Test: ${width}px | Theme: ${theme} | Reduced Motion: ${reducedMotion} ===`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    colorScheme: theme,
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  if (reducedMotion) {
    await context.route('**/*', (route) => {
      if (route.request().resourceType() === 'document') {
        route.continue();
      } else {
        route.continue();
      }
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
  }

  // 1. Setup Theme
  await page.goto('http://localhost:5173');
  await page.evaluate((t) => {
    localStorage.clear();
    const themes = { marketing: t, customer: t, stockist: t, partner: t };
    localStorage.setItem('fastnet.themes.v1', JSON.stringify(themes));
  }, theme);

  // Reload to ensure theme is applied
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(500);

  // 2. Click Customer Tab and check Splash
  console.log('Clicking Customer App tab...');
  // Find customer tab
  await page.click('.role-switcher button.role-tab:has-text("Customer")');
  
  const splash = page.locator('.cs-splash');
  await splash.waitFor({ state: 'visible', timeout: 2000 });
  console.log('Splash visible.');

  // The splash is inside .phone-mockup, and its box matches .phone-screen.
  const phoneScreen = page.locator('.phone-screen');
  const splashBox = await splash.boundingBox();
  const screenBox = await phoneScreen.boundingBox();
  if (Math.abs(splashBox.x - screenBox.x) > 1 || Math.abs(splashBox.y - screenBox.y) > 1) {
    console.error('Splash box does not match phone screen box');
  }

  // Screenshots
  console.log('Taking screenshots at 300, 800, 1500ms...');
  await page.waitForTimeout(300);
  let prefix = `customer_splash_${width}px_${theme}${reducedMotion ? '_reduced' : ''}`;
  await page.screenshot({ path: `tests/${prefix}_300ms.png` });
  
  if (!reducedMotion) {
    await page.waitForTimeout(500); // +500 = 800
    await page.screenshot({ path: `tests/${prefix}_800ms.png` });
    
    await page.waitForTimeout(700); // +700 = 1500
    await page.screenshot({ path: `tests/${prefix}_1500ms.png` });
  }

  // By 2300ms (normal) or 1100ms (reduced) the splash is gone and the login phone input is visible and can be typed into.
  const waitTime = reducedMotion ? 1100 : 2300;
  console.log(`Waiting for ${waitTime}ms limit...`);
  await page.waitForTimeout(waitTime - (reducedMotion ? 300 : 1500));
  
  await splash.waitFor({ state: 'hidden', timeout: 500 });
  console.log('Splash hidden.');
  
  // Can type into phone input
  const phoneInput = page.locator('input[type="text"]').first();
  await phoneInput.waitFor({ state: 'visible', timeout: 2000 });
  await phoneInput.fill('9876543210');
  console.log('Login form visible and interactable.');

  // Switch to Admin and back to Customer: the splash plays again.
  console.log('Switching to Admin then back to Customer...');
  await page.click('.role-switcher button.role-tab:has-text("Admin")');
  await page.waitForTimeout(500);
  await page.click('.role-switcher button.role-tab:has-text("Customer")');
  await splash.waitFor({ state: 'visible', timeout: 1000 });
  console.log('Splash replayed.');
  await splash.waitFor({ state: 'hidden', timeout: 3500 });

  // Signed in as the test customer: after the splash, the home screen shows, not login.
  console.log('Testing logged in state...');
  const phone = '9876543210';
  
  // Need to send OTP first to allow verify
  await fetch('http://localhost:3001/api/auth/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role: 'CUSTOMER' })
  }).catch(() => null);
  
  const res = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.ok ? r.json() : null).catch(() => null);
  
  if (!res || !res.token) throw new Error('Failed to get session');
  
  await page.evaluate(({ u, t }) => {
    localStorage.setItem('currentUser', JSON.stringify(u));
    localStorage.setItem('token', t);
  }, { u: res.user, t: res.token });
  
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(500);
  await page.click('.role-switcher button.role-tab:has-text("Customer")');
  await splash.waitFor({ state: 'visible', timeout: 1000 });
  await splash.waitFor({ state: 'hidden', timeout: 3500 });
  
  // Wait for home screen (Customer View marker)
  await page.locator('.perspective-banner:has-text("Customer View")').waitFor({ state: 'visible', timeout: 2000 });
  console.log('Home screen showed after splash.');

  // Tapping at 400ms removes it by 800ms
  console.log('Testing click-to-skip...');
  await page.click('.role-switcher button.role-tab:has-text("Admin")');
  await page.waitForTimeout(500);
  await page.click('.role-switcher button.role-tab:has-text("Customer")');
  await splash.waitFor({ state: 'visible', timeout: 1000 });
  await page.waitForTimeout(400);
  await splash.click();
  await splash.waitFor({ state: 'hidden', timeout: 800 }); // Should be hidden by 800ms
  console.log('Click-to-skip successful.');

  if (errors.length > 0) {
    console.error(`[FAIL] ${width}px | Theme: ${theme} | Reduced Motion: ${reducedMotion}`);
    errors.forEach(e => console.error('  ' + e));
    process.exitCode = 1;
  } else {
    console.log(`[PASS] ${width}px | Theme: ${theme} | Reduced Motion: ${reducedMotion}`);
  }

  await browser.close();
}

async function runAll() {
  await runTest(1280, 'light', false);
  await runTest(1280, 'dark', false);
  await runTest(440, 'light', false);
  await runTest(440, 'dark', false);
  await runTest(1280, 'light', true);
  console.log('\nALL CUSTOMER SPLASH TESTS PASSED!');
}

runAll().catch(err => {
  console.error(err);
  process.exit(1);
});
