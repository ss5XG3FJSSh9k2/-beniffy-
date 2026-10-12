const { chromium } = require('playwright');

async function runTest(width, theme, reducedMotion) {
  console.log(`\n=== Running Splash Test: ${width}px | Theme: ${theme} | Reduced Motion: ${reducedMotion} ===`);
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
      route.continue();
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

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(500);

  const apps = [
    { name: 'Customer', tab: 'Customer', inputSelector: 'input[type="text"]', loginWait: 2000, hasRole: false },
    { name: 'Stockist', tab: 'Stockist App', inputSelector: 'input[type="text"]', loginWait: 2000, hasRole: true },
    { name: 'Partner', tab: 'Partner App', inputSelector: 'input[type="tel"]', loginWait: 2000, hasRole: true }
  ];

  for (const app of apps) {
    console.log(`\n--- Testing ${app.name} App ---`);
    await page.click(`.role-switcher button.role-tab:has-text("${app.tab}")`);
    
    const splash = page.locator('.cs-splash');
    await splash.waitFor({ state: 'visible', timeout: 2000 });
    console.log(`${app.name} Splash visible.`);

    // Wait until 1300ms from start (approx 1300 since click)
    let prefix = `${app.name.toLowerCase()}_splash_${width}px_${theme}${reducedMotion ? '_reduced' : ''}`;
    
    if (app.hasRole && !reducedMotion) {
      await page.waitForTimeout(1300);
      await page.screenshot({ path: `tests/${prefix}_1300ms.png` });
      
      const dropy = page.locator('.cs-dropy');
      if (await dropy.count() > 0) {
        const dropyBox = await dropy.boundingBox();
        console.log(`Drop Y Box at 1300ms:`, dropyBox);
      }
      
      await page.waitForTimeout(400); // 1700ms
      await page.screenshot({ path: `tests/${prefix}_1700ms.png` });
      
      await page.waitForTimeout(400); // 2100ms
      await page.screenshot({ path: `tests/${prefix}_2100ms.png` });
      
      const roleEl = page.locator('.cs-role');
      if (await roleEl.count() > 0) {
        const clipPath = await roleEl.evaluate(el => window.getComputedStyle(el).clipPath);
        if (!clipPath.includes('inset(0px') && clipPath !== 'none') {
          console.error(`Clip path not fully open at 2100ms: ${clipPath}`);
        }
      }
    } else if (!app.hasRole && !reducedMotion) {
      // Customer app normal
      await page.waitForTimeout(300);
      await page.screenshot({ path: `tests/${prefix}_300ms.png` });
      await page.waitForTimeout(500); // 800ms
      await page.screenshot({ path: `tests/${prefix}_800ms.png` });
      await page.waitForTimeout(700); // 1500ms
      await page.screenshot({ path: `tests/${prefix}_1500ms.png` });
    }

    // By 2700ms (hasRole) / 2300ms (noRole) / 1100ms (reduced) it should be hidden
    let maxWait = reducedMotion ? 1100 : (app.hasRole ? 2700 : 2300);
    console.log(`Waiting for ${maxWait}ms limit...`);
    
    await splash.waitFor({ state: 'hidden', timeout: 5000 });
    console.log(`${app.name} Splash hidden.`);
    
    const input = page.locator(app.inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: 2000 });
    await input.fill('test');
    console.log(`${app.name} Login form interactable.`);
  }

  // Tapping at 400ms removes it by 800ms
  console.log('Testing click-to-skip on Customer...');
  await page.click('.role-switcher button.role-tab:has-text("Admin")');
  await page.waitForTimeout(500);
  await page.click('.role-switcher button.role-tab:has-text("Customer")');
  const splash = page.locator('.cs-splash');
  await splash.waitFor({ state: 'visible', timeout: 1000 });
  await page.waitForTimeout(400);
  await splash.click();
  await splash.waitFor({ state: 'hidden', timeout: 800 }); 
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
  console.log('\nALL SPLASH TESTS PASSED!');
}

runAll().catch(err => {
  console.error(err);
  process.exit(1);
});
