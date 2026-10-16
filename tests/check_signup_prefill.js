// Sign-up identifier: the login email or phone goes in its own field, shown first; the other is asked below; both required.
// Runs customer + stockist, light + dark, 440px. Needs `npm run dev:seed` (in-memory test mode; reset-db is 404 elsewhere).
// Usage: node tests/check_signup_prefill.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForSplash } = require('./helpers.js');

const APP = process.env.APP_URL || 'http://localhost:5173';
const API = process.env.API_URL || 'http://localhost:3001/api';
const EMAIL = 'tapas.kundu@beniffy.test';
const LOGIN_PHONE = '9831000001';
const NEW_PHONE = '9733000001';
const PHONE_CASE_EMAIL = 'phone.case@beniffy.test';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
// 1x1 PNG for the KYC document upload
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const ROLES = {
  customer: { tab: 'Customer App', banner: 'New Customer Registration', nameHolder: 'e.g. Joy Dev', submit: 'Create Account', endpoint: '/auth/register-customer' },
  stockist: { tab: 'Stockist App', banner: 'Register Local Shop (KYC Required)', nameHolder: 'e.g. Rafiq Ahmed', submit: 'Submit for KYC Review', endpoint: '/auth/register-stockist' },
};

let failures = 0;
const check = (label, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  -> ' + detail : ''}`); if (!ok) failures++; };

async function launchBrowser() {
  try { return await chromium.launch({ headless: true }); }
  catch { try { return await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { return await chromium.launch({ headless: true, channel: 'msedge' }); } }
}

async function resetDb() {
  const res = await fetch(`${API}/admin/reset-db`, { method: 'POST' });
  if (res.status !== 200) throw new Error(`reset-db returned ${res.status}: not an in-memory test server, refusing to continue`);
}

async function openSignup(page, r, theme, loginValue) {
  await page.goto(APP);
  await page.evaluate((th) => {
    localStorage.clear();
    localStorage.setItem('fastnet_lang', 'en');
    localStorage.setItem('fastnet.themes.v1', JSON.stringify({ marketing: th, customer: th, stockist: th, admin: th, partner: th }));
  }, theme);
  await page.goto(APP);
  await waitForSplash(page);
  await page.locator(`.role-switcher button.role-tab:has-text("${r.tab}")`).click();
  await page.waitForTimeout(400);
  const login = page.locator('input[placeholder*="mobile"]').first();
  await login.fill(loginValue);
  await page.locator('button:has-text("Send One-Time Password"), button:has-text("Send OTP")').first().click();
  const otp = page.locator('input.otp-input, input[placeholder*="OTP"]').first();
  await otp.waitFor({ state: 'visible', timeout: 5000 });
  await otp.fill('123456');
  await page.locator('button:has-text("Verify & Login"), button:has-text("Verify")').first().click();
  const action = page.locator('.toast-msg .toast-action-btn');
  await action.waitFor({ state: 'visible', timeout: 5000 });
  await action.click();
  await page.locator(`text=${r.banner}`).first().waitFor({ state: 'visible', timeout: 5000 });
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

async function readForm(page, r) {
  return page.evaluate(({ banner, nameHolder }) => {
    const nodes = [...document.querySelectorAll(`#signup-email-input, #signup-phone-input, input[placeholder="${nameHolder}"]`)];
    const order = nodes.map(n => n.id === 'signup-email-input' ? 'email' : n.id === 'signup-phone-input' ? 'phone' : 'name');
    const divs = [...document.querySelectorAll('div')].filter(d => d.textContent.includes(banner));
    const inner = divs.find(d => ![...d.querySelectorAll('div')].some(c => c.textContent.includes(banner)));
    return {
      order,
      email: document.getElementById('signup-email-input')?.value,
      phone: document.getElementById('signup-phone-input')?.value,
      phoneRequired: document.getElementById('signup-phone-input')?.required,
      emailRequired: document.getElementById('signup-email-input')?.required,
      banner: inner ? inner.textContent.trim() : '',
    };
  }, { banner: r.banner, nameHolder: r.nameHolder });
}

async function screenshotIdentifierFields(page, r, file) {
  await page.locator(`input[placeholder="${r.nameHolder}"]`).evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const box = await page.evaluate((banner) => {
    const divs = [...document.querySelectorAll('div')].filter(d => d.textContent.includes(banner));
    const b = divs.find(d => ![...d.querySelectorAll('div')].some(c => c.textContent.includes(banner))).getBoundingClientRect();
    const groups = ['signup-email-input', 'signup-phone-input'].map(id => document.getElementById(id).closest('.input-group').getBoundingClientRect());
    const bottom = Math.max(...groups.map(g => g.bottom));
    return { x: Math.max(0, b.left - 8), y: Math.max(0, b.top - 8), width: b.width + 16, height: bottom - b.top + 16 };
  }, r.banner);
  await page.screenshot({ path: file, clip: box });
}

async function fillRest(page, r, role) {
  await page.locator(`input[placeholder="${r.nameHolder}"]`).fill(role === 'customer' ? 'Tapas Kundu' : 'Tapas Kundu');
  const regionSelect = page.locator('select:has(option:text-is("Select Region"))').first();
  await regionSelect.selectOption({ index: 1 });
  if (role === 'customer') {
    await page.locator('select:has(option[value="NOT_LISTED"])').first().selectOption('NOT_LISTED');
    await page.locator('button[aria-pressed]:text-is("No")').click();
    await page.locator('#customer-terms-checkbox').check();
  } else {
    await page.locator('input[placeholder="e.g. Ahmed General Store"]').fill('Kundu Stores');
    await page.locator('input[placeholder="1234-5678-9012"]').fill('234567890123');
    await page.locator('input[type="file"]').setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('input[placeholder="e.g. Shop 5, Market Road"]').fill('Shop 5, Market Road');
  }
}

async function submitAndExpectCreated(page, r, expectPhone, expectEmail) {
  const respP = page.waitForResponse(res => res.url().includes(r.endpoint) && res.request().method() === 'POST', { timeout: 8000 });
  await page.locator(`button.btn-accent:has-text("${r.submit}")`).click();
  const resp = await respP;
  const body = await resp.json().catch(() => ({}));
  const buf = resp.request().postDataBuffer();
  const sentRaw = buf ? buf.toString('latin1') : '';
  const sentRecorded = await page.evaluate(() => JSON.stringify(window.__registerBodies || []));
  const sent = sentRaw + sentRecorded;
  check('server accepted registration (2xx)', resp.status() >= 200 && resp.status() < 300, `${resp.status()} ${body.error || ''}`.trim());
  check('request carried the sign-up phone', sent.includes(expectPhone), expectPhone);
  check('request carried the sign-up email', sent.includes(expectEmail), expectEmail);
  check('created account has phone + email', body.user && body.user.phone === expectPhone && body.user.email === expectEmail, JSON.stringify(body.user && { phone: body.user.phone, email: body.user.email }));
}

async function run() {
  const browser = await launchBrowser();
  for (const theme of ['light', 'dark']) {
    for (const role of ['customer', 'stockist']) {
      const r = ROLES[role];
      for (const kase of ['a', 'b']) {
        const loginValue = kase === 'a' ? EMAIL : LOGIN_PHONE;
        console.log(`\n[${role} | ${theme} | 440px | case (${kase})] login = ${loginValue}`);
        await resetDb();
        const ctx = await browser.newContext({ viewport: { width: 440, height: 900 }, colorScheme: theme });
        await ctx.addInitScript(() => {
          const orig = window.fetch;
          window.__registerBodies = [];
          window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('/auth/register-') && init && init.body) {
              const b = init.body;
              window.__registerBodies.push(b instanceof FormData ? Object.fromEntries([...b.entries()].filter(([, v]) => typeof v === 'string')) : String(b));
            }
            return orig.apply(this, arguments);
          };
        });
        const page = await ctx.newPage();
        const errors = [];
        const registerRequests = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', req => { if (req.url().includes(r.endpoint)) registerRequests.push(req.url()); });
        try {
          const appliedTheme = await openSignup(page, r, theme, loginValue);
          check(`theme applied (${theme})`, appliedTheme === theme, appliedTheme);
          const f = await readForm(page, r);
          if (kase === 'a') {
            check('order: Email first, Name, Phone in the lower slot', JSON.stringify(f.order) === '["email","name","phone"]', JSON.stringify(f.order));
            check('Email prefilled with login email', f.email === EMAIL, JSON.stringify(f.email));
            check('Phone empty', f.phone === '', JSON.stringify(f.phone));
            check('banner shows the email', f.banner === `${r.banner}: ${EMAIL}`, JSON.stringify(f.banner));
          } else {
            check('order: Phone first, Name, Email in the lower slot', JSON.stringify(f.order) === '["phone","name","email"]', JSON.stringify(f.order));
            check('Phone prefilled with login phone', f.phone === LOGIN_PHONE, JSON.stringify(f.phone));
            check('Email empty', f.email === '', JSON.stringify(f.email));
            check('banner shows the phone', f.banner === `${r.banner}: ${LOGIN_PHONE}`, JSON.stringify(f.banner));
          }
          check('both fields required', f.phoneRequired === true && f.emailRequired === true);
          const shot = path.join(SHOT_DIR, `signup_fields_${role}_${theme}_440_case_${kase}.png`);
          await screenshotIdentifierFields(page, r, shot);
          console.log(`  shot  ${shot}`);

          await fillRest(page, r, role);
          if (kase === 'a') {
            // (c) phone left empty -> inline error on the phone field, focus there, no request
            await page.locator(`button.btn-accent:has-text("${r.submit}")`).click();
            await page.waitForTimeout(700);
            const c = await page.evaluate(() => {
              const el = document.getElementById('signup-phone-input');
              const err = el.closest('.input-group').querySelector('.field-error-text');
              return { err: err ? err.textContent.trim() : '', cls: el.className, focused: document.activeElement === el };
            });
            check('(c) error shown on the Phone field', c.err.includes('Enter a valid 10-digit mobile number') && c.cls.includes('input-error'), JSON.stringify(c.err));
            check('(c) Phone field focused', c.focused === true);
            check('(c) no registration request sent', registerRequests.length === 0, registerRequests.length);
            await page.locator('#signup-phone-input').fill(NEW_PHONE);
            await submitAndExpectCreated(page, r, NEW_PHONE, EMAIL);
          } else {
            await page.locator('#signup-email-input').fill(PHONE_CASE_EMAIL);
            await submitAndExpectCreated(page, r, LOGIN_PHONE, PHONE_CASE_EMAIL);
          }
          check('no uncaught page errors', errors.length === 0, errors.join(' | '));
        } catch (e) {
          check('flow completed', false, e.message.split('\n')[0]);
        } finally {
          await ctx.close();
        }
      }
    }
  }
  await browser.close();
  console.log(failures === 0 ? '\nALL SIGN-UP IDENTIFIER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
