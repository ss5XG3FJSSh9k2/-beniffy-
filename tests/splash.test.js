const { chromium } = require('playwright');
const fs = require('fs');

async function runTest(width, theme, reducedMotion) {
  console.log(`\n=== Running Splash Test: ${width}px | Theme: ${theme} | Reduced Motion: ${reducedMotion} ===`);
  const browser = await chromium.launch();
  let errors = [];
  try {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      colorScheme: theme,
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference'
    });
    
    const page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
        console.error(`Console Error: ${msg.text()}`);
      }
    });
    page.on('pageerror', err => {
      errors.push(err.message);
      console.error(`Page Error: ${err.message}`);
    });

    // Seed the theme key first (by going to a dummy page or blank, setting storage, then navigating to actual app)
    await page.goto('http://localhost:5173');
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => sessionStorage.clear());
    await page.evaluate((th) => {
      localStorage.setItem('theme', th);
    }, theme);
    
    console.log('Reloading to trigger fresh splash...');
    await page.goto('http://localhost:5173', { waitUntil: 'commit' });
    
    // Check #splash exists immediately
    let splashExists = await page.evaluate(() => !!document.getElementById('splash'));
    if (!splashExists) throw new Error('Splash screen did not exist on fresh load');
    
    const prefix = `tests/splash_${width}px_${theme}${reducedMotion ? '_reduced' : ''}`;
    
    if (!reducedMotion) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${prefix}_300ms.png` });
      
      await page.waitForTimeout(500); // Now at 800ms
      await page.screenshot({ path: `${prefix}_800ms.png` });
      
      await page.waitForTimeout(700); // Now at 1500ms
      await page.screenshot({ path: `${prefix}_1500ms.png` });
      
      await page.waitForTimeout(800); // Now at 2300ms
      splashExists = await page.evaluate(() => !!document.getElementById('splash'));
      if (splashExists) throw new Error('Splash screen should be removed by 2300ms');
    } else {
      // Reduced motion checks
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${prefix}_300ms.png` });
      
      await page.waitForTimeout(800); // Now at 1100ms
      splashExists = await page.evaluate(() => !!document.getElementById('splash'));
      if (splashExists) throw new Error('Splash screen should be gone by 1100ms with reduced motion');
    }
    
    // Click on a header button works
    console.log('Testing header button click...');
    const headerBtn = page.locator('button').first();
    await headerBtn.waitFor({ state: 'visible' });
    await headerBtn.click();
    console.log('Header button clicked successfully.');

    // Reload in the same tab: #splash is not present at 50ms
    console.log('Reloading same tab...');
    await page.goto('http://localhost:5173', { waitUntil: 'commit' });
    await page.waitForTimeout(50);
    splashExists = await page.evaluate(() => !!document.getElementById('splash'));
    if (splashExists) throw new Error('Splash screen should NOT be present on reload');
    
    // Test clicking to skip
    if (!reducedMotion) {
      console.log('Testing click-to-skip...');
      await page.evaluate(() => sessionStorage.clear());
      await page.goto('http://localhost:5173', { waitUntil: 'commit' });
      await page.waitForTimeout(400);
      splashExists = await page.evaluate(() => !!document.getElementById('splash'));
      if (!splashExists) throw new Error('Splash screen missing before click');
      
      await page.evaluate(() => document.getElementById('splash').click());
      await page.waitForTimeout(400); // Now at 800ms
      splashExists = await page.evaluate(() => !!document.getElementById('splash'));
      if (splashExists) throw new Error('Splash screen not removed by 800ms after click');
      console.log('Click-to-skip successful.');
    }

    if (errors.length > 0) {
      throw new Error(`Console errors detected: ${errors.join(', ')}`);
    }
    console.log(`[PASS] ${width}px | Theme: ${theme} | Reduced Motion: ${reducedMotion}`);
  } finally {
    await browser.close();
  }
}

async function runAll() {
  try {
    await runTest(1280, 'light', false);
    await runTest(1280, 'dark', false);
    await runTest(440, 'light', false);
    await runTest(440, 'dark', false);
    await runTest(1280, 'light', true); // Test reduced motion
    console.log("\nALL SPLASH TESTS PASSED!");
  } catch (err) {
    console.error("\nTEST FAILED:");
    console.error(err);
    process.exit(1);
  }
}

runAll();
