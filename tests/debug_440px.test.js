const { chromium } = require('playwright');
const fs = require('fs');

async function getTokens() {
  const custRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  }).then(r => r.json()).catch(() => ({}));
  return { customer: custRes };
}

async function run() {
  const tokens = await getTokens();
  const browser = await chromium.launch();
  
  try {
    const phonePage = await browser.newPage({ viewport: { width: 440, height: 800 } });
    await phonePage.goto('http://localhost:5173');
    await phonePage.evaluate(() => localStorage.clear());
    await phonePage.evaluate((auth) => {
        if(auth && auth.token && auth.user) {
            localStorage.setItem('token', auth.token);
            localStorage.setItem('currentUser', JSON.stringify(auth.user));
        }
    }, tokens.customer);
    await phonePage.goto('http://localhost:5173');
    await phonePage.waitForTimeout(1000);
    
    await phonePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.role-switcher button.role-tab'));
        const target = tabs.find(t => t.textContent.includes('Customer App'));
        if (target && !target.classList.contains('active')) target.click();
    });
    await phonePage.waitForTimeout(3000);
    
    // Check buttons available
    const buttons = await phonePage.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent));
    console.log("Buttons:", buttons);

    await phonePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button.phone-nav-btn'));
        const target = btns.find(b => b.textContent.includes('Profile') || b.textContent.includes('प्रोफ़ाइल') || b.textContent.includes('প্রোফাইল'));
        if (target) target.click();
    });
    await phonePage.waitForTimeout(1000);
    
    const profileButtons = await phonePage.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent));
    console.log("Profile Buttons:", profileButtons);

  } finally {
    await browser.close();
  }
}
run();
