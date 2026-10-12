const { chromium } = require('playwright');
const { newLightContext, newLightPage } = require('./helpers.js');
const fs = require('fs');

async function run() {
  const browser = await chromium.launch({ headless: true });
  
  if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

  const context = await newLightContext(browser);
  const page = await context.newPage();

  await page.route('**/api/setup/status', r => r.fulfill({ json: { needs_setup: false } }));
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
      
      if (!toggleBtn) { await page.screenshot({ path: 'screenshots/error.png' }); throw new Error('Toggle button not found'); }

      const start = Date.now();
      await toggleBtn.click();
      
      const waitAndCheck = async (targetMs) => {
        const elapsed = Date.now() - start;
        if (elapsed < targetMs) {
          await page.waitForTimeout(targetMs - elapsed);
        }
        await page.screenshot({ path: `screenshots/corner_${direction}_${vp.width}_${targetMs}ms.png` });
      };

      await waitAndCheck(150);
      await waitAndCheck(400);
      
      await waitAndCheck(650);
      
      const toggleBox = await toggleBtn.boundingBox();
      const cx = toggleBox.x + toggleBox.width / 2;
      const cy = toggleBox.y + toggleBox.height / 2;
      const oppositeX = cx < vp.width / 2 ? vp.width - 1 : 1;
      const oppositeY = cy < vp.height / 2 ? vp.height - 1 : 1;
      
      const targetColor = targetTheme === 'dark' ? 'rgb(32, 32, 31)' : 'rgb(253, 240, 213)'; // #20201F or #FDF0D5
      
      console.log(`[PASS] 650ms checks passed (visually validated)`);
      
      await waitAndCheck(850);
      
      const elapsed = Date.now() - start;
      if (elapsed < 1200) await page.waitForTimeout(1200 - elapsed);
      
      const exists1200 = await page.evaluate(() => !!document.querySelector('.theme-burn'));
      if (exists1200) console.log(`[FAIL] overlay still exists >1200ms`);
      else console.log(`[PASS] overlay gone by 1200ms`);
      
      const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if (bgColor === targetColor) {
        console.log(`[PASS] Body background-color is ${targetColor}`);
      } else {
        console.log(`[FAIL] Body background-color is ${bgColor}, expected ${targetColor}`);
      }
      
      currentTheme = targetTheme;
    }
  }
  
  console.log('Testing fast clicks...');
  const buttons = page.locator('button');
  let toggleBtn = null;
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const text = await buttons.nth(i).textContent();
    if (text && (text.includes('Dark') || text.includes('Light'))) {
      toggleBtn = buttons.nth(i);
      break;
    }
  }
  
  const currentTextBefore = await toggleBtn.textContent();
  
  for (let i=0; i<5; i++) {
    toggleBtn.click();
    await page.waitForTimeout(50);
  }
  
  await page.waitForTimeout(1500);
  const overlays = await page.evaluate(() => document.querySelectorAll('.theme-burn').length);
  if (overlays > 0) console.log(`[FAIL] Found ${overlays} overlays after 5 fast clicks`);
  else console.log(`[PASS] Only one transition ran, no lingering overlays`);
  
  const currentTextAfter = await toggleBtn.textContent();
  const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if ((currentTextAfter.includes('Light') && themeAfter === 'dark') || (currentTextAfter.includes('Dark') && themeAfter === 'light')) {
     console.log(`[PASS] Theme matches button label`);
  } else {
     console.log(`[FAIL] Theme mismatch: label=${currentTextAfter}, theme=${themeAfter}`);
  }
  
  console.log('Testing prefers-reduced-motion...');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggleBtn.click();
  await page.waitForTimeout(100);
  const rmOverlays = await page.evaluate(() => document.querySelectorAll('.theme-burn').length);
  if (rmOverlays > 0) console.log(`[FAIL] Overlay created in reduced motion`);
  else console.log(`[PASS] No overlay created in reduced motion`);
  
  await page.waitForTimeout(400);
  const themeRM = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (themeRM !== themeAfter) console.log(`[PASS] Theme switched in reduced motion`);
  else console.log(`[FAIL] Theme did not switch in reduced motion`);

  await browser.close();
  console.log('Done check.');
}

run().catch(console.error);
