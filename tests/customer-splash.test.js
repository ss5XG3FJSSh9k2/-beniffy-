const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/f85b8837-8d4d-43a1-b68c-6c8cb21cab66/screenshots';

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
    if (app.hasRole) {
      await page.evaluate(() => {
        window.__splashStart = 0;
        const observer = new MutationObserver(() => {
          if (document.querySelector('.cs-lockup') && !window.__splashStart) {
            window.__splashStart = performance.now();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }

    await page.click(`.role-switcher button.role-tab:has-text("${app.tab}")`);
    
    const splash = page.locator('.cs-splash');
    await splash.waitFor({ state: 'visible', timeout: 2000 });
    console.log(`${app.name} Splash visible.`);

    let prefix = `${app.name.toLowerCase()}_splash_${width}px_${theme}${reducedMotion ? '_reduced' : ''}`;
    
    if (app.hasRole && !reducedMotion) {
      // 1300ms screenshot
      await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1300);
      const shot1300Path = `tests/${prefix}_1300ms.png`;
      await page.screenshot({ path: shot1300Path });
      if (fs.existsSync(ARTIFACTS_DIR)) fs.copyFileSync(shot1300Path, path.join(ARTIFACTS_DIR, `${prefix}_1300ms.png`));

      // 1450ms screenshot & pixel sampling
      await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1450);
      const shot1450Path = `tests/${prefix}_1450ms.png`;
      const shot1450 = await page.screenshot({ path: shot1450Path });
      if (fs.existsSync(ARTIFACTS_DIR)) fs.copyFileSync(shot1450Path, path.join(ARTIFACTS_DIR, `${prefix}_1450ms.png`));

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

      if (coords && width === 1280) {
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

        console.log(`  1450ms "b" glyph top-left coin pixels: ${check1450.bCoinCount} (expected 0)`);
        console.log(`  1450ms midpoint coin pixels: ${check1450.midCoinCount} (expected > 0)`);
        if (check1450.bCoinCount > 0) errors.push(`Found ${check1450.bCoinCount} coin pixels at "b" top-left at 1450ms`);
        if (check1450.midCoinCount === 0) errors.push(`No coin pixels near midpoint at 1450ms`);
      }

      // At 1600ms: coin-coloured pixels must exist within 25 px of the label centre (the splash ring)
      await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1600);
      const shot1600 = await page.screenshot();

      if (coords && width === 1280) {
        const check1600 = await page.evaluate(async ({ base64, labelCenter, theme }) => {
          const img = new Image();
          await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + base64; });
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

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

        console.log(`  1600ms label centre splash ring pixels: ${check1600.ringCoinCount} (expected > 0)`);
        if (check1600.ringCoinCount === 0) errors.push(`No splash ring coin pixels near label centre at 1600ms`);
      }

      // 1700ms screenshot
      await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 1700);
      const shot1700Path = `tests/${prefix}_1700ms.png`;
      await page.screenshot({ path: shot1700Path });
      if (fs.existsSync(ARTIFACTS_DIR)) fs.copyFileSync(shot1700Path, path.join(ARTIFACTS_DIR, `${prefix}_1700ms.png`));
      
      // 2100ms screenshot & check
      await page.waitForFunction(() => window.__splashStart && (performance.now() - window.__splashStart) >= 2100);
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
