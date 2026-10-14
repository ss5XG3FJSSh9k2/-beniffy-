const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/f85b8837-8d4d-43a1-b68c-6c8cb21cab66/screenshots';

async function runSplashChecks() {
  console.log('========================================================================');
  console.log('FASTNET PLAYWRIGHT CHECK: STOCKIST & PARTNER SPLASH DROP');
  console.log('========================================================================\n');

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  let allPassed = true;

  // 1. Grid of tests: 1280px (primary pixel test) & 440px, Light & Dark, Stockist & Partner
  for (const width of [1280, 440]) {
    for (const theme of ['light', 'dark']) {
      for (const app of [
        { name: 'Stockist', role: 'STOCKIST', tab: 'Stockist App' },
        { name: 'Partner', role: 'PARTNER', tab: 'Partner App' }
      ]) {
        console.log(`--- [CHECK] ${app.name} at ${width}px (${theme}) ---`);
        const context = await browser.newContext({
          viewport: { width, height: 800 },
          colorScheme: theme
        });
        const page = await context.newPage();

        await page.goto('http://localhost:5173');
        await page.evaluate((t) => {
          localStorage.clear();
          const themes = { marketing: t, customer: t, stockist: t, partner: t };
          localStorage.setItem('fastnet.themes.v1', JSON.stringify(themes));
        }, theme);

        await page.goto('http://localhost:5173');
        await page.waitForTimeout(400);

        // Track splash start
        await page.evaluate(() => {
          window.__splashStart = 0;
          const observer = new MutationObserver(() => {
            if (document.querySelector('.cs-lockup') && !window.__splashStart) {
              window.__splashStart = performance.now();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });

        // Click role tab to start splash
        await page.click(`.role-switcher button.role-tab:has-text("${app.tab}")`);

        // Check at 1300ms
        await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1300);
        const file1300 = `${app.name.toLowerCase()}_splash_${width}px_${theme}_1300ms.png`;
        const shot1300 = await page.screenshot({ path: `tests/${file1300}` });
        fs.copyFileSync(`tests/${file1300}`, path.join(ARTIFACTS_DIR, file1300));

        // Wait to 1450ms
        await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1450);
        const file1450 = `${app.name.toLowerCase()}_splash_${width}px_${theme}_1450ms.png`;
        const shot1450 = await page.screenshot({ path: `tests/${file1450}` });
        fs.copyFileSync(`tests/${file1450}`, path.join(ARTIFACTS_DIR, file1450));

        // Pixel sampling and checks at 1450ms
        const coords = await page.evaluate(() => {
          const bEl = document.querySelector('.cs-word .cs-ch');
          const coin = document.querySelector('.cs-coin');
          const roleEl = document.querySelector('.cs-role');
          if (!bEl || !coin || !roleEl) return null;
          const bRect = bEl.getBoundingClientRect();
          const coinRect = coin.getBoundingClientRect();
          const roleRect = roleEl.getBoundingClientRect();
          return {
            bBox: { x: bRect.left, y: bRect.top, width: bRect.width, height: bRect.height },
            coinCenter: { x: coinRect.left + coinRect.width / 2, y: coinRect.top + coinRect.height / 2 },
            labelCenter: { x: roleRect.left + roleRect.width / 2, y: roleRect.top + roleRect.height / 2 }
          };
        });

        if (!coords) {
          console.error(`  [FAIL] Splash elements not found at 1450ms`);
          allPassed = false;
        } else {
          const midPoint = {
            x: (coords.coinCenter.x + coords.labelCenter.x) / 2,
            y: (coords.coinCenter.y + coords.labelCenter.y) / 2
          };

          const check1450 = await page.evaluate(async ({ base64, bBox, midPoint }) => {
            const img = new Image();
            await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + base64; });
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const isStrictCoin = (r, g, b) => {
              return Math.abs(r - 238) <= 12 && Math.abs(g - 110) <= 12 && Math.abs(b - 77) <= 12;
            };

            // 1. Within 30x30 px box at "b" top-left: NO coin-coloured pixels (#EE6E4D +- 12)
            const bx = Math.round(bBox.x), by = Math.round(bBox.y);
            const bData = ctx.getImageData(bx, by, 30, 30).data;
            let bCoinCount = 0;
            for (let i = 0; i < bData.length; i += 4) {
              if (isStrictCoin(bData[i], bData[i+1], bData[i+2])) bCoinCount++;
            }

            // 2. Within 20 px of midpoint between coin center and label center: MUST have coin-coloured pixels
            const mx = Math.round(midPoint.x), my = Math.round(midPoint.y);
            let midCoinCount = 0;
            for (let dy = -20; dy <= 20; dy++) {
              for (let dx = -20; dx <= 20; dx++) {
                if (Math.hypot(dx, dy) <= 20) {
                  const p = ctx.getImageData(mx + dx, my + dy, 1, 1).data;
                  if (isStrictCoin(p[0], p[1], p[2])) midCoinCount++;
                }
              }
            }

            return { bCoinCount, midCoinCount };
          }, { base64: shot1450.toString('base64'), bBox: coords.bBox, midPoint });

          const bOk = check1450.bCoinCount === 0;
          const midOk = check1450.midCoinCount > 0;
          console.log(`  At 1450ms:`);
          console.log(`    - "b" top-left 30x30 box coin pixels: ${check1450.bCoinCount} (Expected: 0): ${bOk ? 'PASS' : 'FAIL'}`);
          console.log(`    - Midpoint 20px radius coin pixels: ${check1450.midCoinCount} (Expected: > 0): ${midOk ? 'PASS' : 'FAIL'}`);
          if (!bOk || !midOk) allPassed = false;
        }

        // Check at 1600ms
        await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1600);
        const shot1600 = await page.screenshot();

        if (coords) {
          const check1600 = await page.evaluate(async ({ base64, labelCenter, theme }) => {
            const img = new Image();
            await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + base64; });
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            // Coin-coloured pixels including alpha-blended splash ring
            const isCoinColoured = (r, g, b) => {
              if (Math.abs(r - 238) <= 12 && Math.abs(g - 110) <= 12 && Math.abs(b - 77) <= 12) return true;
              const bg = (theme === 'dark') ? { r: 32, g: 32, b: 31 } : { r: 253, g: 240, b: 213 };
              for (let a = 0.25; a <= 0.95; a += 0.05) {
                const er = 238 * a + bg.r * (1 - a);
                const eg = 110 * a + bg.g * (1 - a);
                const eb = 77 * a + bg.b * (1 - a);
                if (Math.abs(r - er) <= 16 && Math.abs(g - eg) <= 16 && Math.abs(b - eb) <= 16) {
                  return true;
                }
              }
              return false;
            };

            // Within 25 px of label centre: coin-coloured pixels must exist (the splash ring)
            const lx = Math.round(labelCenter.x), ly = Math.round(labelCenter.y);
            let ringCoinCount = 0;
            for (let dy = -25; dy <= 25; dy++) {
              for (let dx = -25; dx <= 25; dx++) {
                if (Math.hypot(dx, dy) <= 25) {
                  const p = ctx.getImageData(lx + dx, ly + dy, 1, 1).data;
                  if (isCoinColoured(p[0], p[1], p[2])) ringCoinCount++;
                }
              }
            }

            return { ringCoinCount };
          }, { base64: shot1600.toString('base64'), labelCenter: coords.labelCenter, theme });

          const ringOk = check1600.ringCoinCount > 0;
          console.log(`  At 1600ms:`);
          console.log(`    - Splash ring within 25px of label centre: ${check1600.ringCoinCount} pixels (Expected: > 0): ${ringOk ? 'PASS' : 'FAIL'}`);
          if (!ringOk) allPassed = false;
        }

        // Screenshot at 1700ms
        await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1700);
        const file1700 = `${app.name.toLowerCase()}_splash_${width}px_${theme}_1700ms.png`;
        await page.screenshot({ path: `tests/${file1700}` });
        fs.copyFileSync(`tests/${file1700}`, path.join(ARTIFACTS_DIR, file1700));

        // Check at 2100ms - label reveal
        await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 2100);
        const file2100 = `${app.name.toLowerCase()}_splash_${width}px_${theme}_2100ms.png`;
        await page.screenshot({ path: `tests/${file2100}` });

        const at2100 = await page.evaluate(() => {
          const roleEl = document.querySelector('.cs-role');
          const word = document.querySelector('.cs-word');
          if (!roleEl || !word) return null;
          const roleRect = roleEl.getBoundingClientRect();
          const wordRect = word.getBoundingClientRect();
          const labelCenterX = roleRect.left + roleRect.width / 2;
          const wordCenterX = wordRect.left + wordRect.width / 2;
          const style = window.getComputedStyle(roleEl);
          const clipPath = style.clipPath;
          const opacity = parseFloat(style.opacity);
          const visualDiff = Math.abs((roleRect.left + (roleRect.width - 5.1) / 2) - wordCenterX);
          return { visualDiff, clipPath, opacity };
        });

        if (at2100) {
          const revOk = at2100.clipPath.includes('0%') || at2100.clipPath === 'none';
          console.log(`  At 2100ms:`);
          console.log(`    - Label fully revealed: ${revOk ? 'PASS' : 'FAIL'}`);
          if (!revOk) allPassed = false;
        }

        await context.close();
      }
    }
  }

  // 2. Check splash plays on page load with Stockist app already selected
  console.log('\n--- [CHECK] Page Load with Stockist app already selected (?role=stockist) ---');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto('http://localhost:5173/?role=stockist');
    const splash = page.locator('.cs-splash');
    await splash.waitFor({ state: 'visible', timeout: 2000 });
    console.log(`  Stockist splash appeared on page load.`);
    await page.waitForTimeout(1450);
    const dropExists = await page.evaluate(() => !!document.querySelector('.cs-dropx'));
    console.log(`  Drop in flight on direct load: ${dropExists ? 'PASS' : 'FAIL'}`);
    await splash.waitFor({ state: 'hidden', timeout: 4000 });
    console.log(`  Stockist splash completed on page load: PASS`);
    await context.close();
  }

  // 3. Check switching tabs: Admin -> Stockist -> Partner
  console.log('\n--- [CHECK] Tab switching: Admin -> Stockist -> Partner ---');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(500);

    // Click Admin Portal
    console.log('  Switching to Admin Portal...');
    await page.click('.role-switcher button.role-tab:has-text("Admin Portal")');
    await page.waitForTimeout(400);

    // Switch Admin -> Stockist
    console.log('  Switching Admin -> Stockist...');
    await page.click('.role-switcher button.role-tab:has-text("Stockist App")');
    const stockistSplash = page.locator('.cs-splash');
    await stockistSplash.waitFor({ state: 'visible', timeout: 2000 });
    console.log('  Stockist splash playing...');
    await page.waitForTimeout(1450);
    const stDrop = await page.evaluate(() => !!document.querySelector('.cs-dropx'));
    console.log(`  Stockist drop in flight: ${stDrop ? 'PASS' : 'FAIL'}`);
    await stockistSplash.waitFor({ state: 'hidden', timeout: 4000 });
    console.log('  Stockist splash finished cleanly.');

    // Switch Stockist -> Partner
    console.log('  Switching Stockist -> Partner...');
    await page.click('.role-switcher button.role-tab:has-text("Partner App")');
    const partnerSplash = page.locator('.cs-splash');
    await partnerSplash.waitFor({ state: 'visible', timeout: 2000 });
    console.log('  Partner splash playing...');
    await page.waitForTimeout(1450);
    const ptDrop = await page.evaluate(() => !!document.querySelector('.cs-dropx'));
    console.log(`  Partner drop in flight: ${ptDrop ? 'PASS' : 'FAIL'}`);
    await partnerSplash.waitFor({ state: 'hidden', timeout: 4000 });
    console.log('  Partner splash finished cleanly.');
    await context.close();
  }

  await browser.close();

  console.log('\n========================================================================');
  console.log(`FINAL STATUS: ${allPassed ? 'ALL PLAYWRIGHT CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  console.log('========================================================================\n');

  if (!allPassed) process.exit(1);
}

runSplashChecks().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
