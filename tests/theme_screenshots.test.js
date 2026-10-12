const { chromium } = require('playwright');
const { waitForSplash } = require('./helpers.js');

async function ensureSetup() {
  const res = await fetch('http://localhost:3001/api/setup/status').then(r => r.json()).catch(() => null);
  if (res && res.needs_setup) {
    await fetch('http://localhost:3001/api/setup/create-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Super Admin', phone: '9999999999', email: 'admin@fastnet.test' })
    }).catch(() => null);
  }
}

async function getTokens() {
  await fetch('http://localhost:3001/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9876543210' }) }).catch(()=>{});
  const custRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.json()).catch(() => ({}));
  
  await fetch('http://localhost:3001/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '7654321098' }) }).catch(()=>{});
  const stockRes = await fetch('http://localhost:3001/api/stockist/auth/verify-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '7654321098', otp: '123456' })
  }).then(r => r.json()).catch(() => ({}));

  const partnerRes = await fetch('http://localhost:3001/api/partner/auth/login-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'adhya@partners.example', password: 'partner123' })
  }).then(r => r.json()).catch(() => ({}));

  return { customer: custRes, stockist: stockRes, partner: partnerRes };
}

async function run() {
  await ensureSetup();
  const tokens = await getTokens();
  const browser = await chromium.launch();
  
  const captureThemeToggle = async (page, appName, tabName) => {
    if (tabName) {
      await page.evaluate((name) => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes(name));
        if (target && !target.classList.contains('active')) target.click();
      }, tabName);
      await page.waitForTimeout(3000);
    }
    
    const toggle = page.locator('button[aria-label*="theme"]').first();
    await toggle.waitFor({ state: 'visible', timeout: 3000 });
    await toggle.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `tests/screenshot_1280px_${appName.replace(/\s+/g, '_')}.png` });
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.evaluate(() => localStorage.clear());
    await page.goto('http://localhost:5173');
    await waitForSplash(page);

    console.log('Capturing B2B Site...');
    await captureThemeToggle(page, 'B2B_Site', 'B2B Site');
    
    console.log('Capturing Customer...');
    await page.evaluate((auth) => {
        if(auth && auth.token && auth.user) {
            localStorage.setItem('token', auth.token);
            localStorage.setItem('currentUser', JSON.stringify(auth.user));
        }
    }, tokens.customer);
    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes('Customer App'));
        if (target && !target.classList.contains('active')) target.click();
    });
    await page.waitForTimeout(3000);
    
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button.phone-nav-btn'));
        const target = btns.find(b => b.textContent.includes('Profile') || b.textContent.includes('प्रोफ़ाइल') || b.textContent.includes('প্রোফাইল'));
        if (target) target.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.reverse().find(b => b.textContent.includes('Dark') || b.textContent.includes('अंधेरा') || b.textContent.includes('অন্ধকার'));
        if (target) target.click();
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tests/screenshot_1280px_Customer.png' });

    console.log('Capturing Stockist...');
    await page.evaluate(() => localStorage.clear());
    await page.evaluate((auth) => {
        if(auth && auth.token && auth.user) {
            localStorage.setItem('token', auth.token);
            localStorage.setItem('currentUser', JSON.stringify(auth.user));
        }
    }, tokens.stockist);
    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes('Stockist App'));
        if (target && !target.classList.contains('active')) target.click();
    });
    await page.waitForTimeout(3000);
    
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button.phone-nav-btn'));
        const target = btns.find(b => b.textContent.includes('Profile') || b.textContent.includes('प्रोफ़ाइल') || b.textContent.includes('প্রোফাইল'));
        if (target) target.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.reverse().find(b => b.textContent.includes('Dark') || b.textContent.includes('अंधेरा') || b.textContent.includes('অন্ধকার'));
        if (target) target.click();
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tests/screenshot_1280px_Stockist.png' });

    console.log('Capturing Admin...');
    await page.evaluate(() => localStorage.clear());
    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(1000);
    await captureThemeToggle(page, 'Admin', 'Admin Portal');

    console.log('Capturing Partner...');
    await page.evaluate(() => localStorage.clear());
    await page.evaluate((auth) => {
        if(auth && (auth.session_token || auth.token) && auth.user) {
            localStorage.setItem('token', auth.session_token || auth.token);
            localStorage.setItem('currentUser', JSON.stringify(auth.user));
        }
    }, tokens.partner);
    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes('Partner App'));
        if (target && !target.classList.contains('active')) target.click();
    });
    await page.waitForTimeout(3000);
    
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button.phone-nav-btn'));
        const target = btns.find(b => b.textContent.includes('Profile') || b.textContent.includes('प्रोफ़ाइल') || b.textContent.includes('প্রোফাইল'));
        if (target) target.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.reverse().find(b => b.textContent.includes('Dark') || b.textContent.includes('अंधेरा') || b.textContent.includes('অন্ধকার'));
        if (target) target.click();
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tests/screenshot_1280px_Partner.png' });
    
    console.log('Capturing Setup...');
    await page.evaluate(() => { localStorage.clear(); });
    await page.route('**/api/setup/status', route => route.fulfill({ json: { needs_setup: true } }));
    await page.goto('http://localhost:5173');
    await waitForSplash(page);
    await page.waitForTimeout(3000);
    await captureThemeToggle(page, 'Setup', null);
    
    // Now for 440px width tests
    const phonePage = await browser.newPage({ viewport: { width: 440, height: 800 } });
    await phonePage.goto('http://localhost:5173');
    await waitForSplash(phonePage);
    await phonePage.evaluate(() => localStorage.clear());
    await phonePage.goto('http://localhost:5173');
    await waitForSplash(phonePage);
    
    // B2B
    await phonePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes('B2B Site'));
        if (target && !target.classList.contains('active')) target.click();
    });
    await phonePage.waitForTimeout(3000);
    await phonePage.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    
    // Customer
    console.log('Navigating to Customer on phone');
    await phonePage.evaluate((auth) => {
        if(auth && auth.token && auth.user) {
            localStorage.setItem('token', auth.token);
            localStorage.setItem('currentUser', JSON.stringify(auth.user));
        }
    }, tokens.customer);
    await phonePage.goto('http://localhost:5173');
    await waitForSplash(phonePage);
    await phonePage.waitForTimeout(1000);
    await phonePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes('Customer App'));
        if (target && !target.classList.contains('active')) target.click();
    });
    await phonePage.waitForTimeout(3000);
    
    await phonePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button.phone-nav-btn'));
        const target = btns.find(b => b.textContent.includes('Profile') || b.textContent.includes('प्रोफ़ाइल') || b.textContent.includes('প্রোফাইল'));
        if (target) target.click();
    });
    await phonePage.waitForTimeout(1000);
    
    // Switch customer to dark
    await phonePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.reverse().find(b => b.textContent.includes('Dark') || b.textContent.includes('अंधेरा') || b.textContent.includes('অন্ধকার'));
        if (target) target.click();
    });
    await phonePage.waitForTimeout(3000);
    
    const htmlTheme = await phonePage.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const phoneTheme = await phonePage.evaluate(() => {
        const mockup = document.querySelector('.phone-mockup');
        if (!mockup) return 'NOT_FOUND';
        return mockup.getAttribute('data-theme');
    });
    
    console.log(`440px Customer Check: htmlTheme=${htmlTheme}, phoneTheme=${phoneTheme}`);
    if (htmlTheme !== 'light' || phoneTheme !== 'dark') {
      console.error('Theme isolation failed!');
      process.exit(1);
    } else {
      console.log('Theme isolation verified!');
    }
    await phonePage.screenshot({ path: 'tests/screenshot_440px_Customer_Isolated.png' });

  } catch (e) {
    console.error('Error during playwright run:', e);
  } finally {
    await browser.close();
  }
}
run();
