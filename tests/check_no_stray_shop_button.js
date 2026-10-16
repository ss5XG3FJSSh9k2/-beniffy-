const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForSplash } = require('./helpers.js');

const APP = process.env.APP_URL || 'http://localhost:5173';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};

async function launchBrowser() {
  try { return await chromium.launch({ headless: true }); }
  catch { try { return await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { return await chromium.launch({ headless: true, channel: 'msedge' }); } }
}

async function run() {
  const browser = await launchBrowser();
  for (const theme of ['light', 'dark']) {
    console.log(`\n[stockist | ${theme} | 440px] Check no stray Open a Shop button inside sign-up form`);
    const ctx = await browser.newContext({ viewport: { width: 440, height: 900 }, colorScheme: theme });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    try {
      await page.goto(APP);
      await page.evaluate((th) => {
        localStorage.clear();
        localStorage.setItem('fastnet_lang', 'en');
        localStorage.setItem('fastnet.themes.v1', JSON.stringify({ marketing: th, customer: th, stockist: th, admin: th, partner: th }));
      }, theme);
      await page.goto(APP);
      await waitForSplash(page);

      // Switch to Stockist App
      await page.locator('.role-switcher button.role-tab:has-text("Stockist App")').click();
      await page.waitForTimeout(400);

      // 1. Verify Login screen shows "Open a Shop" button
      const loginOpenShopBtn = page.locator('button:has-text("Open a Shop")');
      check('Login screen shows "Open a Shop" button', await loginOpenShopBtn.isVisible());

      // 2. Open "Open a Shop" from login
      await loginOpenShopBtn.click();
      await page.locator('#signup-stockist-submit-btn').waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);

      // 3. Confirm the sign-up form contains no "Open a Shop" button
      const signupOpenShopBtns = await page.locator('button:has-text("Open a Shop")').count();
      check('Sign-up form contains no "Open a Shop" button', signupOpenShopBtns === 0, signupOpenShopBtns);

      // 4. Confirm the phone field is followed directly by the next field (Owner Name)
      const fieldOrderOk = await page.evaluate(() => {
        const phoneInput = document.getElementById('signup-phone-input');
        if (!phoneInput) return false;
        const phoneGroup = phoneInput.closest('.input-group');
        if (!phoneGroup) return false;
        const nextGroup = phoneGroup.nextElementSibling;
        if (!nextGroup) return false;
        const nextInput = nextGroup.querySelector('#signup-name-input');
        return !!nextInput;
      });
      check('Phone field is followed directly by Owner Name field', fieldOrderOk);

      // 5. Screenshot in light and dark at 440px
      const shot = path.join(SHOT_DIR, `stockist_signup_no_stray_button_${theme}_440.png`);
      await page.screenshot({ path: shot });
      console.log(`  shot  ${shot}`);

      // 6. Click Back and confirm login screen still shows its "Open a Shop" button
      await page.locator('button:has-text("Back")').first().click();
      await page.waitForTimeout(400);
      check('Login screen still shows its "Open a Shop" button after Back', await loginOpenShopBtn.isVisible());
      check('No uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    } catch (e) {
      check('Flow completed without exception', false, e.message);
    } finally {
      await ctx.close();
    }
  }
  await browser.close();
  console.log(failures === 0 ? '\nALL NO-STRAY-BUTTON CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
