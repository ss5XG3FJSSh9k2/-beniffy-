const { chromium } = require('playwright');
const { newLightContext, newLightPage } = require('./helpers.js');
const fs = require('fs');

async function run() {
  const browser = await chromium.launch({ headless: true });
  
  if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

  const context = await newLightContext(browser);
  const page = await context.newPage();

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000); 
  
  await page.evaluate(() => {
    window.localStorage.setItem('theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await page.waitForTimeout(500);

  const viewports = [
    { width: 1280, height: 800 },
    { width: 440, height: 800 }
  ];

  let currentTheme = 'light';
  
  for (const vp of viewports) {
    await page.setViewportSize(vp);
    
    for (const direction of ['light-to-dark', 'dark-to-light']) {
      console.log(`Testing ${direction} at ${vp.width}px`);
      
      const targetTheme = direction === 'light-to-dark' ? 'dark' : 'light';
      if (currentTheme !== (direction === 'light-to-dark' ? 'light' : 'dark')) {
        currentTheme = direction === 'light-to-dark' ? 'light' : 'dark';
        await page.evaluate((t) => {
          window.localStorage.setItem('theme', t);
          document.documentElement.setAttribute('data-theme', t);
        }, currentTheme);
        await page.waitForTimeout(500);
      }

      const buttons = page.locator('button');
      const count = await buttons.count();
      let toggleBtn = null;
      for (let i = 0; i < count; i++) {
        const text = await buttons.nth(i).textContent();
        if (text && (text.includes('Dark') || text.includes('Light'))) {
          toggleBtn = buttons.nth(i);
          break;
        }
      }
      
      if (!toggleBtn) {
        throw new Error('Toggle button not found');
      }

      const start = Date.now();
      await toggleBtn.click();
      
      const waitAndCheck = async (targetMs, label) => {
        const now = Date.now();
        const elapsed = now - start;
        if (elapsed < targetMs) {
          await page.waitForTimeout(targetMs - elapsed);
        }
        
        const exists = await page.evaluate(() => !!document.querySelector('.theme-burn'));
        if (!exists) {
          console.log(`[FAIL] .theme-burn missing at ${targetMs}ms`);
        } else {
          console.log(`[PASS] .theme-burn exists at ${targetMs}ms`);
        }
        await page.screenshot({ path: `screenshots/burn_${direction}_${vp.width}_${targetMs}ms.png` });
      };

      await waitAndCheck(150, '150');
      await waitAndCheck(400, '400');
      await waitAndCheck(700, '700');
      
      const now2 = Date.now();
      if (now2 - start < 1100) {
        await page.waitForTimeout(1100 - (now2 - start));
      }
      
      const exists1000 = await page.evaluate(() => !!document.querySelector('.theme-burn'));
      if (exists1000) console.log(`[FAIL] .theme-burn still exists >1000ms`);
      else console.log(`[PASS] .theme-burn gone by 1000ms`);
      
      try {
        await toggleBtn.click();
        console.log(`[PASS] Button clicked after transition (pointer events not blocked)`);
      } catch (e) {
        console.log(`[FAIL] Pointer events blocked: ${e.message}`);
      }
      await page.waitForTimeout(500);

      await page.evaluate((t) => {
        window.localStorage.setItem('theme', t);
        document.documentElement.setAttribute('data-theme', t);
      }, targetTheme);
      await page.waitForTimeout(500);
      currentTheme = targetTheme;

      const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const expected = targetTheme === 'light' ? 'rgb(253, 240, 213)' : 'rgb(32, 32, 31)';
      if (bgColor === expected) {
        console.log(`[PASS] Body background-color is ${expected}`);
      } else {
        console.log(`[FAIL] Body background-color is ${bgColor}, expected ${expected}`);
      }
    }
  }

  await browser.close();
  console.log('Done check.');
}

run().catch(console.error);
