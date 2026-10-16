// Sign-up prefill from login: an email never lands in the phone field; a valid phone is prefilled.
// Run against `npm run dev:seed` (in-memory data). Usage: node tests/check_signup_prefill.js
const { chromium } = require('playwright');
const { waitForSplash, newLightPage } = require('./helpers.js');

const BASE = process.env.APP_URL || 'http://localhost:5173';
const EMAIL = 'tapas.kundu@beniffy.test';
const PHONE = '9831000001';

const ROLES = [
  { role: 'customer', tab: 'Customer App', banner: 'New Customer Registration' },
  { role: 'stockist', tab: 'Stockist App', banner: 'Register Local Shop (KYC Required)' },
];

async function launchBrowser() {
  try { return await chromium.launch({ headless: true }); }
  catch { try { return await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { return await chromium.launch({ headless: true, channel: 'msedge' }); } }
}

async function openSignupFromLogin(page, r, loginValue) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('fastnet_lang', 'en'); });
  await page.goto(BASE);
  await waitForSplash(page);
  const roleBtn = page.locator(`.role-switcher button.role-tab:has-text("${r.tab}")`);
  await roleBtn.waitFor({ state: 'visible', timeout: 5000 });
  await roleBtn.click();
  await page.waitForTimeout(400);

  const loginInput = page.locator('input[placeholder*="mobile"]').first();
  await loginInput.waitFor({ state: 'visible', timeout: 5000 });
  await loginInput.fill(loginValue);
  await page.locator('button:has-text("Send One-Time Password"), button:has-text("Send OTP")').first().click();
  const otp = page.locator('input.otp-input, input[placeholder*="OTP"]').first();
  await otp.waitFor({ state: 'visible', timeout: 5000 });
  await otp.fill('123456');
  await page.locator('button:has-text("Verify & Login"), button:has-text("Verify")').first().click();

  const action = page.locator('.toast-msg .toast-action-btn');
  await action.waitFor({ state: 'visible', timeout: 5000 });
  await action.click();
  await page.locator(`text=${r.banner}`).first().waitFor({ state: 'visible', timeout: 5000 });
}

async function read(page, r) {
  const phone = await page.locator('input.text-input[placeholder="e.g. 9876543210"]').first().inputValue();
  const email = await page.locator('input[type="email"][placeholder="example@beniffy.com"]').first().inputValue();
  const banner = await page.evaluate((title) => {
    const divs = [...document.querySelectorAll('div')].filter(d => d.textContent.includes(title));
    const inner = divs.find(d => ![...d.querySelectorAll('div')].some(c => c.textContent.includes(title)));
    return inner ? inner.textContent.trim() : '';
  }, r.banner);
  return { phone, email, banner };
}

async function run() {
  const browser = await launchBrowser();
  let failures = 0;
  const check = (label, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`); if (!ok) failures++; };

  for (const r of ROLES) {
    for (const [caseName, value] of [['email', EMAIL], ['phone', PHONE]]) {
      console.log(`\n[${r.role}] login value = ${value}`);
      const page = await newLightPage(browser);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      try {
        await openSignupFromLogin(page, r, value);
        const v = await read(page, r);
        if (caseName === 'email') {
          check('phone field empty', v.phone === '', JSON.stringify(v.phone));
          check('email field has the address', v.email === EMAIL, JSON.stringify(v.email));
          check('banner has no email', !v.banner.includes('@') && v.banner === r.banner, JSON.stringify(v.banner));
        } else {
          check('phone field prefilled', v.phone === PHONE, JSON.stringify(v.phone));
          check('banner shows phone', v.banner === `${r.banner}: ${PHONE}`, JSON.stringify(v.banner));
        }
        check('phone field digits only', /^\d*$/.test(v.phone), JSON.stringify(v.phone));
        check('no uncaught page errors', errors.length === 0, errors.join(' | '));
      } catch (e) {
        check('flow completed', false, e.message.split('\n')[0]);
      } finally {
        await page.close();
      }
    }
  }
  await browser.close();
  console.log(failures === 0 ? '\nALL SIGNUP PREFILL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
