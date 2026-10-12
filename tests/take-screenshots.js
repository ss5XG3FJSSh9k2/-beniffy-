const { chromium } = require('playwright');
const { newLightContext, newLightPage } = require('./helpers.js');
const fs = require('fs');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await newLightContext(browser);
  
  if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

  // Setup screen error
  for (const theme of ['light', 'dark']) {
    const page = await context.newPage();
    await page.goto('http://localhost:5173');
    await page.evaluate((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    
    await page.route('**/api/setup/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needs_setup: true })
      });
    });
    
    await page.waitForTimeout(1000); // Give it time to load
    
    const btn = await page.$('button[type="submit"]');
    if (btn) await btn.click();
    await page.waitForTimeout(500); 
    
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: `screenshots/setup_error_${theme}_1280.png` });
    await page.close();
  }

  // Crash screen
  for (const theme of ['light', 'dark']) {
    const page = await context.newPage();
    await page.goto('http://localhost:5173');
    await page.evaluate((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    
    await page.waitForTimeout(1000);
    
    await page.evaluate(() => {
      if (window.triggerCrash) window.triggerCrash();
    });
    
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: `screenshots/crash_${theme}_1280.png` });
    await page.close();
  }

  await browser.close();
}

run().catch(console.error);
