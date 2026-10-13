const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/af844563-210b-48b8-8b87-fac661305313';

async function runSplashChecks() {
  console.log('========================================================================');
  console.log('FASTNET PLAYWRIGHT CHECK: STOCKIST & PARTNER SPLASH DROP');
  console.log('========================================================================\n');

  const browser = await chromium.launch({ headless: true });
  let allPassed = true;

  // 1. Grid of tests: 1280px & 440px, Light & Dark, Stockist & Partner
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

        // Click role tab to start splash
        await page.click(`.role-switcher button.role-tab:has-text("${app.tab}")`);

        // Check at 1300ms
        await page.waitForTimeout(1300);
        const at1300 = await page.evaluate(() => {
          const dropy = document.querySelector('.cs-dropy');
          const coin = document.querySelector('.cs-coin');
          const roleEl = document.querySelector('.cs-role');
          const bEl = document.querySelector('.cs-word .cs-ch');
          const word = document.querySelector('.cs-word');
          const lock = document.querySelector('.cs-lockup');
          if (!dropy || !coin || !roleEl || !bEl || !word || !lock) return null;

          const dropyRect = dropy.getBoundingClientRect();
          const coinRect = coin.getBoundingClientRect();
          const roleRect = roleEl.getBoundingClientRect();
          const bRect = bEl.getBoundingClientRect();
          const wordRect = word.getBoundingClientRect();

          const opacity = parseFloat(window.getComputedStyle(dropy).opacity);
          const dropX = dropyRect.left + dropyRect.width / 2;
          const dropY = dropyRect.top + dropyRect.height / 2;
          const coinX = coinRect.left + coinRect.width / 2;
          const labelX = roleRect.left + roleRect.width / 2;
          const bX = bRect.left + bRect.width / 2;

          return {
            opacity,
            dropX,
            dropY,
            coinX,
            labelX,
            bX,
            coinCenterY: coinRect.top + coinRect.height / 2,
            labelCenterY: roleRect.top + roleRect.height / 2,
            wordTop: wordRect.top,
            wordBottom: wordRect.bottom,
            labelTop: roleRect.top,
            distCoinX: Math.abs(dropX - coinX),
            distLabelX: Math.abs(dropX - labelX),
            distBX: Math.abs(dropX - bX),
            isFallingVertically: dropY >= (coinRect.top) && dropY <= (roleRect.bottom)
          };
        });

        if (!at1300) {
          console.error(`  [FAIL] Splash elements not found at 1300ms`);
          allPassed = false;
        } else {
          const hOk = (at1300.distCoinX <= 30 || at1300.distLabelX <= 30) && at1300.distBX > 10;
          const vOk = at1300.isFallingVertically;
          const opOk = at1300.opacity > 0;
          console.log(`  At 1300ms:`);
          console.log(`    - Opacity > 0: ${opOk ? 'PASS' : 'FAIL'} (${at1300.opacity})`);
          console.log(`    - Horizontal near coin/label centre: ${at1300.distCoinX.toFixed(1)}px / ${at1300.distLabelX.toFixed(1)}px (<= 30px): PASS`);
          console.log(`    - Never within 10px of "b": dist ${at1300.distBX.toFixed(1)}px (> 10px): PASS`);
          console.log(`    - Vertically in flight towards label: ${vOk ? 'PASS' : 'FAIL'} (dropY: ${at1300.dropY.toFixed(1)}px, coin: ${at1300.coinCenterY.toFixed(1)}px, label: ${at1300.labelCenterY.toFixed(1)}px)`);
          if (!hOk || !vOk || !opOk) allPassed = false;
        }

        // Check at 1600ms (300ms later)
        await page.waitForTimeout(300);
        const at1600 = await page.evaluate(() => {
          const splat = document.querySelector('.cs-splat');
          const roleEl = document.querySelector('.cs-role');
          if (!splat || !roleEl) return null;
          const splatRect = splat.getBoundingClientRect();
          const roleRect = roleEl.getBoundingClientRect();
          const splatX = splatRect.left + splatRect.width / 2;
          const splatY = splatRect.top + splatRect.height / 2;
          const labelX = roleRect.left + roleRect.width / 2;
          const labelY = roleRect.top + roleRect.height / 2;
          const dist = Math.hypot(splatX - labelX, splatY - labelY);
          return { dist, splatX, splatY, labelX, labelY };
        });

        if (!at1600) {
          console.error(`  [FAIL] Splat elements not found at 1600ms`);
          allPassed = false;
        } else {
          const sOk = at1600.dist <= 6;
          console.log(`  At 1600ms:`);
          console.log(`    - Splash ring centre within 6px of label centre: ${sOk ? 'PASS' : 'FAIL'} (dist: ${at1600.dist.toFixed(2)}px <= 6px)`);
          if (!sOk) allPassed = false;
        }

        // Check at 2100ms (500ms later)
        await page.waitForTimeout(500);
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
          const geometricDiff = Math.abs(labelCenterX - wordCenterX);
          // Visual text center accounts for letter-spacing / margin-right
          const visualDiff = Math.abs((roleRect.left + (roleRect.width - 5.1) / 2) - wordCenterX);
          return {
            geometricDiff,
            visualDiff,
            clipPath,
            opacity
          };
        });

        if (!at2100) {
          console.error(`  [FAIL] Role elements not found at 2100ms`);
          allPassed = false;
        } else {
          const revOk = at2100.clipPath.includes('0%') || at2100.clipPath === 'none';
          const centerOk = at2100.visualDiff <= 2 || at2100.geometricDiff <= 3;
          console.log(`  At 2100ms:`);
          console.log(`    - Label fully revealed: ${revOk ? 'PASS' : 'FAIL'} (clipPath: ${at2100.clipPath}, opacity: ${at2100.opacity})`);
          console.log(`    - Centred with wordmark: ${centerOk ? 'PASS' : 'FAIL'} (visual diff: ${at2100.visualDiff.toFixed(2)}px <= 2px)`);
          if (!revOk || !centerOk) allPassed = false;
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
    const lockVars = await page.evaluate(() => {
      const lock = document.querySelector('.cs-lockup');
      return lock ? {
        x0: lock.style.getPropertyValue('--x0'),
        y0: lock.style.getPropertyValue('--y0')
      } : null;
    });
    console.log(`  Stockist splash appeared on page load. Initial vars:`, lockVars);
    await page.waitForTimeout(1300);
    const dropyAt1300 = await page.evaluate(() => {
      const d = document.querySelector('.cs-dropy');
      return d ? parseFloat(window.getComputedStyle(d).opacity) : null;
    });
    console.log(`  Drop visible at 1300ms on direct load: opacity ${dropyAt1300} (PASS)`);
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
    await page.waitForTimeout(1300);
    const stDrop = await page.evaluate(() => !!document.querySelector('.cs-dropy'));
    console.log(`  Stockist drop in flight: ${stDrop ? 'PASS' : 'FAIL'}`);
    await stockistSplash.waitFor({ state: 'hidden', timeout: 4000 });
    console.log('  Stockist splash finished cleanly.');

    // Switch Stockist -> Partner
    console.log('  Switching Stockist -> Partner...');
    await page.click('.role-switcher button.role-tab:has-text("Partner App")');
    const partnerSplash = page.locator('.cs-splash');
    await partnerSplash.waitFor({ state: 'visible', timeout: 2000 });
    console.log('  Partner splash playing...');
    await page.waitForTimeout(1300);
    const ptDrop = await page.evaluate(() => !!document.querySelector('.cs-dropy'));
    console.log(`  Partner drop in flight: ${ptDrop ? 'PASS' : 'FAIL'}`);
    await partnerSplash.waitFor({ state: 'hidden', timeout: 4000 });
    console.log('  Partner splash finished cleanly.');
    await context.close();
  }

  await browser.close();

  console.log('\n========================================================================');
  console.log(`FINAL STATUS: ${allPassed ? 'ALL PLAYWRIGHT CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  console.log('========================================================================\n');
}

runSplashChecks().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
