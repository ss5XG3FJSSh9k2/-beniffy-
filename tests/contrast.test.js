const { chromium } = require('playwright');
const { waitForSplash, newLightPage } = require('./helpers.js');

async function launchBrowser() {
  const options = { headless: true };
  try {
    return await chromium.launch(options);
  } catch (err) {
    try {
      return await chromium.launch({ ...options, channel: 'chrome' });
    } catch {
      return await chromium.launch({ ...options, channel: 'msedge' });
    }
  }
}

async function ensureSetup() {
  const regions = await fetch('http://localhost:3001/api/regions').then(r => r.json()).catch(() => []);
  if (!Array.isArray(regions) || regions.length === 0) {
    await fetch('http://localhost:3001/api/setup/create-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Super Admin', phone: '9999999999', email: 'admin@fastnet.test' })
    }).catch(() => null);

    const admLogin = await fetch('http://localhost:3001/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
    }).then(r => r.json()).catch(() => null);

    if (admLogin && admLogin.token) {
      const admToken = admLogin.token;

      const reg = await fetch('http://localhost:3001/api/admin/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` },
        body: JSON.stringify({ name: 'Kolkata South (Garia)', code: 'r1', delivery_fee: 25 })
      }).then(r => r.json()).catch(() => null);

      const regionId = reg?.id || 'r1';

      await fetch('http://localhost:3001/api/auth/register-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Amit Sen', phone: '9876543210', email: 'amit@fastnet.test', region_id: regionId, address: '12 Park Street, Garia', termsAgreed: true })
      }).catch(() => null);

      await fetch('http://localhost:3001/api/auth/register-stockist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Madan Shaw',
          phone: '7654321098',
          email: 'madan@fastnet.test',
          shop_name: 'Madan Grocers',
          region_id: regionId,
          id_type: 'Aadhaar',
          id_number: '123456789012',
          address: 'Garia Market'
        })
      }).catch(() => null);

      const kycQueue = await fetch('http://localhost:3001/api/admin/kyc-queue', {
        headers: { 'Authorization': `Bearer ${admToken}` }
      }).then(r => r.json()).catch(() => []);
      const pendingStk = Array.isArray(kycQueue) ? kycQueue.find(s => s.phone === '7654321098') : null;
      if (pendingStk && pendingStk.id) {
        await fetch(`http://localhost:3001/api/admin/kyc/${pendingStk.id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` },
          body: JSON.stringify({ vendorId: 'v1' })
        }).catch(() => null);
      }

      await fetch('http://localhost:3001/api/admin/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` },
        body: JSON.stringify({
          legal_name: 'Adhya Cable Services Pvt Ltd',
          display_name: 'Adhya Cable',
          contact_phone: '9876500000',
          contact_email: 'adhya@partners.example',
          password: 'partner123',
          service_types: ['CABLE']
        })
      }).catch(() => null);

      const allUsers = await fetch('http://localhost:3001/api/admin/customers', {
        headers: { 'Authorization': `Bearer ${admToken}` }
      }).then(r => r.json()).catch(() => []);
      const ptnUser = allUsers.find(u => u.phone === '9876500000');
      if (ptnUser) {
        await fetch(`http://localhost:3001/api/admin/kyc/${ptnUser.id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admToken}` }
        }).catch(() => null);
      }
    }
  }
}

async function getSessions() {
  const custRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.json()).catch(() => null);

  const stkRes = await fetch('http://localhost:3001/api/stockist/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '7654321098', otp: '123456' })
  }).then(r => r.json()).catch(() => null);

  const admRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
  }).then(r => r.json()).catch(() => null);

  const ptnRes = await fetch('http://localhost:3001/api/partner/auth/login-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'adhya@partners.example', password: 'partner123' })
  }).then(r => r.json()).catch(() => null);

  return {
    customer: custRes,
    stockist: stkRes,
    admin: admRes,
    partner: ptnRes
  };
}

// In-page evaluator that measures contrast of all visible text elements
async function evaluatePageContrast(page, appName, screenName, theme) {
  return await page.evaluate(({ app, screen, th }) => {
    function parseRgba(str) {
      if (!str) return [0, 0, 0, 0];
      const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (m) {
        return [
          parseInt(m[1], 10),
          parseInt(m[2], 10),
          parseInt(m[3], 10),
          m[4] !== undefined ? parseFloat(m[4]) : 1.0
        ];
      }
      return [0, 0, 0, 0];
    }

    function blend(fg, bg) {
      const aFg = fg[3];
      const aBg = bg[3];
      const outA = aFg + aBg * (1 - aFg);
      if (outA === 0) return [0, 0, 0, 0];
      const r = (fg[0] * aFg + bg[0] * aBg * (1 - aFg)) / outA;
      const g = (fg[1] * aFg + bg[1] * aBg * (1 - aFg)) / outA;
      const b = (fg[2] * aFg + bg[2] * aBg * (1 - aFg)) / outA;
      return [Math.round(r), Math.round(g), Math.round(b), outA];
    }

    function sRGBtoLinear(c) {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(r, g, b) {
      return 0.2126 * sRGBtoLinear(r) + 0.7152 * sRGBtoLinear(g) + 0.0722 * sRGBtoLinear(b);
    }

    function getContrastRatio(rgb1, rgb2) {
      const l1 = relativeLuminance(rgb1[0], rgb1[1], rgb1[2]);
      const l2 = relativeLuminance(rgb2[0], rgb2[1], rgb2[2]);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function getEffectiveBackground(el, defaultBase) {
      const layers = [];
      let curr = el;
      while (curr && curr.nodeType === Node.ELEMENT_NODE) {
        const style = window.getComputedStyle(curr);
        const bg = parseRgba(style.backgroundColor);
        if (bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 0.99) break; // effectively opaque
        }
        curr = curr.parentElement;
      }

      let composite = defaultBase;
      for (let i = layers.length - 1; i >= 0; i--) {
        composite = blend(layers[i], composite);
      }
      return composite;
    }

    function getSelector(el) {
      let sel = el.tagName.toLowerCase();
      if (el.id) {
        sel += `#${el.id}`;
      } else if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass) sel += `.${firstClass}`;
      }
      return sel;
    }

    const defaultBase = th === 'dark' ? [32, 32, 31, 1] : [253, 240, 213, 1];
    const elements = document.querySelectorAll('*');
    const failures = [];
    let countChecked = 0;

    for (const el of elements) {
      if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'NOSCRIPT', 'BR', 'HR', 'IMG'].includes(el.tagName)) continue;
      // Skip inactive/disabled elements per WCAG 1.4.3
      if (el.closest(':disabled, [disabled], [aria-disabled="true"]')) continue;

      let directText = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
          directText += ' ' + node.textContent.trim();
        }
      }
      directText = directText.trim();
      if (!directText) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      countChecked++;
      const color = parseRgba(style.color);
      const bg = getEffectiveBackground(el, defaultBase);
      const effectiveText = color[3] < 1 ? blend(color, bg) : color;
      const ratio = getContrastRatio(effectiveText, bg);

      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const threshold = isLarge ? 3.0 : 4.5;

      if (ratio < threshold) {
        const cleanText = directText.replace(/\s+/g, ' ').slice(0, 30);
        failures.push({
          app,
          screen,
          theme: th,
          selector: getSelector(el),
          text: cleanText,
          ratio: ratio.toFixed(2),
          required: threshold
        });
      }
    }

    return { failures, countChecked };
  }, { app: appName, screen: screenName, th: theme });
}

async function setAppTheme(page, theme) {
  await page.evaluate((th) => {
    document.documentElement.setAttribute('data-theme', th);
    const mockups = document.querySelectorAll('.phone-mockup');
    mockups.forEach(m => m.setAttribute('data-theme', th));
    try {
      const themes = { marketing: th, customer: th, stockist: th, admin: th, partner: th };
      localStorage.setItem('fastnet.themes.v1', JSON.stringify(themes));
    } catch {}
  }, theme);
  await page.waitForTimeout(150);
}

async function runContrastTests() {
  console.log('=== RUNNING FULL-APP CONTRAST TEST ===');
  await ensureSetup();
  const sessions = await getSessions();
  const browser = await launchBrowser();
  const themes = ['light', 'dark'];
  const allFailures = [];
  let totalChecked = 0;

  try {
    // 1. SETUP SCREEN (both themes)
    for (const theme of themes) {
      const page = await newLightPage(browser);
      await page.route('**/api/setup/status', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ needs_setup: true })
        });
      });
      await page.goto('http://localhost:5173');
      await waitForSplash(page);
      await setAppTheme(page, theme);
      await page.waitForSelector('.glass-card', { timeout: 4000 });

      const res = await evaluatePageContrast(page, 'Setup', 'setup screen', theme);
      totalChecked += res.countChecked;
      allFailures.push(...res.failures);
      await page.close();
    }

    // 2. B2B SITE (marketing view, both themes)
    for (const theme of themes) {
      const page = await newLightPage(browser);
      await page.goto('http://localhost:5173');
      await waitForSplash(page);
      await page.evaluate(() => localStorage.clear());
      await page.goto('http://localhost:5173');
      await waitForSplash(page);
      await setAppTheme(page, theme);

      const b2bTab = page.locator('.role-switcher button.role-tab:has-text("B2B Site")');
      await b2bTab.click();
      await page.waitForTimeout(300);

      const res = await evaluatePageContrast(page, 'B2B Site', 'landing', theme);
      totalChecked += res.countChecked;
      allFailures.push(...res.failures);
      await page.close();
    }

    // 3. CUSTOMER APP (signed out & signed in, both themes)
    for (const theme of themes) {
      // Signed out
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await page.evaluate(() => localStorage.clear());
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const custTab = page.locator('.role-switcher button.role-tab:has-text("Customer App")');
        await custTab.click();
        await page.waitForTimeout(300);

        const res = await evaluatePageContrast(page, 'Customer', 'signed out', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);
        await page.close();
      }

      // Signed in: store, cart, rewards, ledger, orders, profile
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await page.evaluate(({ user, token }) => {
          localStorage.setItem('currentUser', JSON.stringify(user));
          localStorage.setItem('token', token);
        }, { user: sessions.customer.user, token: sessions.customer.token });
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const custTab = page.locator('.role-switcher button.role-tab:has-text("Customer App")');
        await custTab.click();
        await page.waitForTimeout(400);

        // Store
        const navBtns = page.locator('.phone-screen .phone-nav-btn');
        await navBtns.nth(0).click(); // Store
        await page.waitForTimeout(300);
        let res = await evaluatePageContrast(page, 'Customer', 'store', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Add item to cart to test cart screen
        const addBtn = page.locator('.phone-screen button:has-text("+"), .phone-screen button:has-text("Add")').first();
        if (await addBtn.count() > 0) {
          await addBtn.click();
          await page.waitForTimeout(300);
        }

        // Cart
        const viewCartBar = page.locator('.phone-screen div:has-text("View Cart"), .phone-screen div:has-text("कार्ट देखें")').first();
        if (await viewCartBar.count() > 0) {
          await viewCartBar.click();
          await page.waitForTimeout(300);
          res = await evaluatePageContrast(page, 'Customer', 'cart', theme);
          totalChecked += res.countChecked;
          allFailures.push(...res.failures);
        }

        // Rewards / Pointshop
        const rewardsBtn = page.locator('#nav-pointshop');
        if (await rewardsBtn.count() > 0) {
          await rewardsBtn.click();
        } else {
          await navBtns.nth(2).click();
        }
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Customer', 'rewards', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Ledger / Points
        await navBtns.nth(1).click(); // Ledger / Points
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Customer', 'ledger', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Orders
        await navBtns.nth(3).click(); // Orders
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Customer', 'orders', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Profile
        await navBtns.nth(4).click(); // Profile
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Customer', 'profile', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        await page.close();
      }
    }

    // 4. STOCKIST APP (signed out & signed in, both themes)
    for (const theme of themes) {
      // Signed out
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await page.evaluate(() => localStorage.clear());
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const stkTab = page.locator('.role-switcher button.role-tab:has-text("Stockist App")');
        await stkTab.click();
        await page.waitForTimeout(300);

        const res = await evaluatePageContrast(page, 'Stockist', 'signed out', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);
        await page.close();
      }

      // Signed in: orders, inventory, analytics, settings
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await page.evaluate(({ user, token }) => {
          localStorage.setItem('currentUser', JSON.stringify(user));
          localStorage.setItem('token', token);
        }, { user: sessions.stockist.user, token: sessions.stockist.token });
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const stkTab = page.locator('.role-switcher button.role-tab:has-text("Stockist App")');
        await stkTab.click();
        await page.waitForTimeout(400);

        const stkNavBtns = page.locator('.phone-screen .phone-nav-btn');

        // Orders
        await stkNavBtns.nth(0).click();
        await page.waitForTimeout(300);
        let res = await evaluatePageContrast(page, 'Stockist', 'orders', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Inventory
        await stkNavBtns.nth(1).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Stockist', 'inventory', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Analytics
        await stkNavBtns.nth(2).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Stockist', 'analytics', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Settings
        await stkNavBtns.nth(3).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Stockist', 'settings', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        await page.close();
      }
    }

    // 5. PARTNER APP (signed out & signed in, both themes)
    for (const theme of themes) {
      // Signed out
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await page.evaluate(() => localStorage.clear());
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const ptnTab = page.locator('.role-switcher button.role-tab:has-text("Partner App")');
        await ptnTab.click();
        await page.waitForTimeout(300);

        const res = await evaluatePageContrast(page, 'Partner', 'signed out', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);
        await page.close();
      }

      // Signed in: dashboard, queue, packages, regions, feedback, profile
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await page.evaluate(({ user, token }) => {
          localStorage.setItem('currentUser', JSON.stringify(user));
          localStorage.setItem('token', token);
          localStorage.setItem('fastnet_partner_session', token);
        }, { user: sessions.partner.user, token: sessions.partner.token });
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const ptnTab = page.locator('.role-switcher button.role-tab:has-text("Partner App")');
        await ptnTab.click();
        await page.waitForTimeout(400);

        const ptnNavBtns = page.locator('.phone-screen .phone-nav-btn');

        // Dashboard
        await ptnNavBtns.nth(0).click();
        await page.waitForTimeout(300);
        let res = await evaluatePageContrast(page, 'Partner', 'dashboard', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Queue
        await ptnNavBtns.nth(1).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Partner', 'queue', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Packages
        await ptnNavBtns.nth(2).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Partner', 'packages', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Regions
        await ptnNavBtns.nth(3).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Partner', 'regions', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Feedback
        await ptnNavBtns.nth(4).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Partner', 'feedback', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        // Profile
        await ptnNavBtns.nth(5).click();
        await page.waitForTimeout(300);
        res = await evaluatePageContrast(page, 'Partner', 'profile', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);

        await page.close();
      }
    }

    // 6. ADMIN PORTAL (signed out & signed in tabs, both themes)
    for (const theme of themes) {
      // Signed out
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await page.evaluate(() => localStorage.clear());
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const admTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
        await admTab.click();
        await page.waitForTimeout(300);

        const res = await evaluatePageContrast(page, 'Admin', 'signed out', theme);
        totalChecked += res.countChecked;
        allFailures.push(...res.failures);
        await page.close();
      }

      // Signed in
      {
        const page = await newLightPage(browser);
        await page.goto('http://localhost:5173');
        await page.evaluate(({ user, token }) => {
          localStorage.setItem('currentUser', JSON.stringify(user));
          localStorage.setItem('token', token);
        }, { user: sessions.admin.user, token: sessions.admin.token });
        await page.goto('http://localhost:5173');
        await waitForSplash(page);
        await setAppTheme(page, theme);

        const admTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
        await admTab.click();
        await page.waitForTimeout(500);

        // Open Advanced if not already open
        const advBtn = page.locator('.admin-sidebar button:has-text("Advanced")');
        if (await advBtn.count() > 0) {
          const advText = await advBtn.textContent();
          if (advText.includes('▸')) {
            await advBtn.click();
            await page.waitForTimeout(200);
          }
        }

        // Get all admin nav buttons
        const navItems = await page.locator('.admin-sidebar .admin-nav-item').all();
        for (let i = 0; i < navItems.length; i++) {
          const btn = navItems[i];
          const text = (await btn.textContent()).trim().split('\n')[0].trim();
          if (text.includes('Advanced')) continue;

          await btn.click();
          await page.waitForTimeout(250);

          const res = await evaluatePageContrast(page, 'Admin', text, theme);
          totalChecked += res.countChecked;
          allFailures.push(...res.failures);
        }

        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nContrast testing complete. Total elements checked: ${totalChecked}`);
  if (allFailures.length > 0) {
    console.log(`FAILURES DETECTED: ${allFailures.length}\n`);
    for (const f of allFailures) {
      console.log(`${f.app} / ${f.screen} / ${f.theme} / ${f.selector} / ${f.text} / ${f.ratio}`);
    }
    process.exit(1);
  } else {
    console.log(`✓ ALL SCREENS PASSED CONTRAST REQUIREMENTS (0 failures)`);
    process.exit(0);
  }
}

runContrastTests().catch(err => {
  console.error('Contrast test crashed:', err);
  process.exit(1);
});
