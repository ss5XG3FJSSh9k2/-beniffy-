const { chromium } = require('playwright');
const { newLightContext, newLightPage } = require('./helpers.js');
const fs = require('fs');

async function run() {
  const browser = await chromium.launch();
  
  const scenarios = [
    { name: 'customer', url: 'http://localhost:5173/' },
    { name: 'stockist', url: 'http://localhost:5173/' },
    { name: 'partner', url: 'http://localhost:5173/' },
    { name: 'admin', url: 'http://localhost:5173/' }
  ];

  const viewports = [
    { width: 1280, height: 800 },
    { width: 440, height: 800 }
  ];

  const themes = ['light', 'dark'];

  const page = await newLightPage(browser);
  
  for (const scenario of scenarios) {
    for (const theme of themes) {
      for (const vp of viewports) {
        await page.setViewportSize(vp);
        await page.goto(scenario.url);
        
        // Ensure the theme is set correctly (the toggle script uses localStorage)
        await page.evaluate((t) => {
          window.localStorage.setItem('theme', t);
          document.documentElement.setAttribute('data-theme', t);
        }, theme);

        // Switch to the correct role
        if (scenario.name === 'admin') {
          // Admin has a special login bypass or we click the role switch
          // In App.jsx, role switcher is customer, stockist, admin, partner?
          // Wait, role-switcher in App.jsx has: marketing, customer, stockist, partner, admin
          await page.evaluate((role) => {
            const btns = Array.from(document.querySelectorAll('.role-tab'));
            const btn = btns.find(b => b.textContent.toLowerCase().includes(role));
            if (btn) btn.click();
          }, scenario.name === 'customer' ? 'customer' : scenario.name);
        } else {
          await page.evaluate((role) => {
            const btns = Array.from(document.querySelectorAll('.role-tab'));
            const btn = btns.find(b => b.textContent.toLowerCase().includes(role));
            if (btn) btn.click();
          }, scenario.name);
        }

        // Wait a bit for render
        await page.waitForTimeout(500);

        const filename = `x:/app/scratch/${scenario.name}_${theme}_${vp.width}.png`;
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`Saved ${filename}`);
      }
    }
  }

  await browser.close();
}

run().catch(console.error);
