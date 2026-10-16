// Sign-up buttons are always tappable: an empty required field shows one toast, marks every empty field
// (red border + "Required"), scrolls to and focuses the first one, and sends no request. Filled form submits.
// Runs stockist + customer, light + dark, 440px. Needs `npm run dev:seed` (in-memory test mode; reset-db is 404 elsewhere).
// Usage: node tests/check_signup_missing.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForSplash } = require('./helpers.js');

const APP = process.env.APP_URL || 'http://localhost:5173';
const API = process.env.API_URL || 'http://localhost:3001/api';
const LOGIN_PHONE = '9831000002';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TOAST = 'Fill all the details to confirm.';

const ROLES = {
  stockist: { tab: 'Stockist App', banner: 'Register Local Shop (KYC Required)', btn: '#signup-stockist-submit-btn', label: 'Submit for KYC Review', leaveEmpty: 'signup-doc-photo-input', fieldName: 'Document Photo' },
  customer: { tab: 'Customer App', banner: 'New Customer Registration', btn: '#signup-customer-submit-btn', label: 'Create Account', leaveEmpty: 'customer-terms-checkbox', fieldName: 'Terms checkbox' },
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

async function openSignup(page, r, theme) {
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
  await page.locator('input[placeholder*="mobile"]').first().fill(LOGIN_PHONE);
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

// Fill every required field except the one the case leaves empty.
async function fillAllBut(page, role, skipId) {
  await page.locator('#signup-email-input').fill(`${role}.missing@beniffy.test`);
  await page.locator('#signup-name-input').fill('Tapas Kundu');
  await page.locator('#signup-region-select').selectOption({ index: 1 });
  if (role === 'customer') {
    await page.locator('#signup-cable-select').selectOption('NOT_LISTED');
    await page.locator('button[aria-pressed]:text-is("No")').click();
    if (skipId !== 'customer-terms-checkbox') await page.locator('#customer-terms-checkbox').check();
  } else {
    await page.locator('#signup-shop-name-input').fill('Kundu Stores');
    await page.locator('#signup-id-number-input').fill('234567890123');
    if (skipId !== 'signup-doc-photo-input') await page.locator('#signup-doc-photo-input').setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('#signup-address-input').fill('Shop 5, Market Road');
  }
}

async function fieldState(page, id) {
  return page.evaluate((fid) => {
    const el = document.getElementById(fid);
    const group = el.closest('.input-group');
    // the Required line sits inside the field's group, or right after it (terms checkbox row)
    const inGroup = [...group.querySelectorAll('.field-error-text')].find(n => n.textContent.includes('Required'));
    const sib = group.nextElementSibling && group.nextElementSibling.classList.contains('field-error-text') && group.nextElementSibling.textContent.includes('Required') ? group.nextElementSibling : null;
    const req = inGroup || sib;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      required: !!req,
      requiredColor: req ? getComputedStyle(req).color : '',
      border: cs.borderTopColor, outline: cs.outlineColor, outlineStyle: cs.outlineStyle,
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
      focused: document.activeElement === el,
    };
  }, id);
}

async function run() {
  const browser = await launchBrowser();
  for (const theme of ['light', 'dark']) {
    for (const role of ['stockist', 'customer']) {
      const r = ROLES[role];
      console.log(`\n[${role} | ${theme} | 440px] leave ${r.fieldName} empty`);
      await resetDb();
      const ctx = await browser.newContext({ viewport: { width: 440, height: 900 }, colorScheme: theme });
      const page = await ctx.newPage();
      const errors = [];
      const registerRequests = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', req => { if (/\/auth\/register-|\/customer\/register-with-referral/.test(req.url())) registerRequests.push(req.url()); });
      try {
        const applied = await openSignup(page, r, theme);
        check(`theme applied (${theme})`, applied === theme, applied);
        const btn = page.locator(r.btn);
        check('button enabled on an empty form', await btn.isEnabled());

        // Tap on the untouched form: every empty field is marked.
        await btn.click();
        await page.waitForTimeout(800);
        const marks = await page.locator('.field-error-text:has-text("Required")').count();
        const expected = role === 'stockist' ? 6 : 5; // region is preselected; stockist: name,email,shop,id,photo,address; customer: name,email,cable,broadband,terms
        check(`every empty field marked (${expected})`, marks === expected, marks);
        check('first empty field (Name) focused', await page.evaluate(() => document.activeElement && document.activeElement.id) === 'signup-name-input');
        check('no request on empty form', registerRequests.length === 0, registerRequests.length);

        // (a) everything filled except one field
        await fillAllBut(page, role, r.leaveEmpty);
        await page.locator('.toast-msg').first().waitFor({ state: 'detached', timeout: 10000 });
        await page.evaluate(() => { const c = document.querySelector('.login-content-container'); if (c) c.scrollTop = 0; window.scrollTo(0, 0); });
        await page.waitForTimeout(300);
        const leftMarks = await page.locator('.field-error-text:has-text("Required")').count();
        check('marks cleared on filled fields (only the empty one left)', leftMarks === 1, leftMarks);
        await btn.click();
        await page.waitForTimeout(900);
        const toast = await page.evaluate(() => [...document.querySelectorAll('.toast-msg')].map(n => n.textContent).join(' | '));
        check(`(a) toast "${TOAST}"`, toast.includes(TOAST), JSON.stringify(toast));
        const s = await fieldState(page, r.leaveEmpty);
        check(`(a) ${r.fieldName} shows "Required"`, s.required);
        const redMark = role === 'customer' ? (s.outlineStyle !== 'none' && s.outline === s.requiredColor) : s.border === s.requiredColor;
        check(`(a) ${r.fieldName} red ${role === 'customer' ? 'outline' : 'border'} (= --danger-text)`, redMark, `${role === 'customer' ? s.outline : s.border} vs ${s.requiredColor}`);
        check(`(a) scrolled to ${r.fieldName}`, s.inViewport);
        check(`(a) ${r.fieldName} focused`, s.focused);
        check('(a) no registration request sent', registerRequests.length === 0, registerRequests.length);
        const shot = path.join(SHOT_DIR, `signup_missing_${role}_${theme}_440.png`);
        await page.screenshot({ path: shot });
        console.log(`  shot  ${shot}`);

        // fill it: the mark clears at once
        if (role === 'customer') await page.locator('#customer-terms-checkbox').check();
        else await page.locator('#signup-doc-photo-input').setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: PNG });
        await page.waitForTimeout(200);
        check(`${r.fieldName} mark clears once filled`, !(await fieldState(page, r.leaveEmpty)).required);

        // (b) full submit; slow the response so the in-flight state is visible
        await page.locator('.toast-msg').first().waitFor({ state: 'detached', timeout: 10000 });
        await page.route(/\/auth\/register-/, async route => { await new Promise(res => setTimeout(res, 1200)); await route.continue(); });
        const respP = page.waitForResponse(res => /\/auth\/register-/.test(res.url()) && res.request().method() === 'POST', { timeout: 10000 });
        respP.catch(() => {});
        await btn.click();
        await page.waitForTimeout(300);
        const inflight = await page.evaluate((sel) => { const b = document.querySelector(sel); return b ? { disabled: b.disabled, text: b.textContent.trim() } : null; }, r.btn);
        check('in flight: button disabled with "Submitting…"', inflight && inflight.disabled && inflight.text === 'Submitting…', JSON.stringify(inflight));
        await btn.click({ force: true, timeout: 500 }).catch(() => {});
        const resp = await respP;
        const body = await resp.json().catch(() => ({}));
        check('(b) server accepted registration (2xx)', resp.status() >= 200 && resp.status() < 300, `${resp.status()} ${body.error || ''}`.trim());
        await page.waitForTimeout(500);
        check('(b) exactly one request (double tap ignored)', registerRequests.length === 1, registerRequests.length);
        check('no uncaught page errors', errors.length === 0, errors.join(' | '));
      } catch (e) {
        check('flow completed', false, e.message.split('\n')[0]);
      } finally {
        await ctx.close();
      }
    }
  }
  await browser.close();
  console.log(failures === 0 ? '\nALL SIGN-UP MISSING-FIELD CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
