const { chromium } = require('playwright');
const fs = require('fs');

const TOKENS = [
  '--bg-main', '--bg-surface', '--bg-surface-elevated', '--border-color', 
  '--primary', '--primary-glow', '--secondary', '--secondary-glow', 
  '--accent', '--accent-glow', '--danger', '--danger-color', '--success', 
  '--text-main', '--text-muted', '--on-primary', '--badge-primary-bg', 
  '--badge-primary-text', '--surface-overlay', '--surface-glass',
  '--success-glow', '--warning', '--warning-glow', '--info', '--info-glow'
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  
  async function checkPageColors(page, name, theme) {
    const failures = await page.evaluate(({ tokens, name, theme }) => {
      const style = getComputedStyle(document.documentElement);
      
      const validColors = new Set();
      validColors.add('rgba(0, 0, 0, 0)');
      validColors.add('transparent');
      
      for (const t of tokens) {
        const val = style.getPropertyValue(t).trim();
        if (!val) continue;
        const dummy = document.createElement('div');
        dummy.style.color = `var(${t})`;
        dummy.style.backgroundColor = `var(${t})`;
        document.body.appendChild(dummy);
        const comp = getComputedStyle(dummy);
        validColors.add(comp.color);
        validColors.add(comp.backgroundColor);
        document.body.removeChild(dummy);
      }
      
      const allElements = document.querySelectorAll('*');
      const fails = [];
      const ignoredTags = ['html', 'head', 'script', 'meta', 'link', 'title', 'style', 'svg', 'path', 'circle', 'line', 'polyline', 'img'];
      
      for (const el of allElements) {
        if (ignoredTags.includes(el.tagName.toLowerCase())) continue;
        
        const comp = getComputedStyle(el);
        const bg = comp.backgroundColor;
        const color = comp.color;
        
        if (!validColors.has(bg)) {
          fails.push({ el: el.tagName + (el.className ? '.' + el.className : ''), type: 'background', val: bg });
        }
        if (!validColors.has(color)) {
          fails.push({ el: el.tagName + (el.className ? '.' + el.className : ''), type: 'color', val: color });
        }
      }
      return fails;
    }, { tokens: TOKENS, name, theme });
    
    return failures;
  }

  async function takeScreenshotsAndCheck(page, name) {
    let allFails = [];
    
    // Light
    await page.evaluate(() => {
      window.localStorage.setItem('theme', 'light');
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.waitForTimeout(500);
    
    let fails = await checkPageColors(page, name, 'light');
    allFails = allFails.concat(fails.map(f => `[Light] ${name}: ${f.el} has invalid ${f.type} ${f.val}`));
    
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: `screenshots/${name}_light_1280.png` });
    await page.setViewportSize({ width: 440, height: 800 });
    await page.screenshot({ path: `screenshots/${name}_light_440.png` });

    // Dark
    await page.evaluate(() => {
      window.localStorage.setItem('theme', 'dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await page.waitForTimeout(500);
    
    fails = await checkPageColors(page, name, 'dark');
    allFails = allFails.concat(fails.map(f => `[Dark] ${name}: ${f.el} has invalid ${f.type} ${f.val}`));
    
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: `screenshots/${name}_dark_1280.png` });
    await page.setViewportSize({ width: 440, height: 800 });
    await page.screenshot({ path: `screenshots/${name}_dark_440.png` });
    
    return allFails;
  }

  if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

  let totalFails = [];
  const context = await browser.newContext();
  const page = await context.newPage();

  const scenarios = [
    { name: 'marketing', clickRole: 'marketing' },
    { name: 'customer', clickRole: 'customer' },
    { name: 'stockist', clickRole: 'stockist' },
    { name: 'partner', clickRole: 'partner' },
    { name: 'admin', clickRole: 'admin' },
  ];

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000); // Wait for load

  for (const scenario of scenarios) {
    console.log(`Checking ${scenario.name}...`);
    // switch role
    await page.evaluate((role) => {
      const btns = Array.from(document.querySelectorAll('.role-tab'));
      const btn = btns.find(b => b.textContent.toLowerCase().includes(role));
      if (btn) btn.click();
    }, scenario.clickRole);
    await page.waitForTimeout(500);

    const fails = await takeScreenshotsAndCheck(page, scenario.name);
    totalFails = totalFails.concat(fails);
  }

  // To check login/OTP screen, we click "Reset & Log Out"
  console.log(`Checking login...`);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Reset & Log Out'));
    if (btn) btn.click();
  });
  await page.waitForTimeout(500);
  const loginFails = await takeScreenshotsAndCheck(page, 'login');
  totalFails = totalFails.concat(loginFails);

  await browser.close();
  
  if (totalFails.length > 0) {
    console.log('FAILURES:');
    const uniqueFails = [...new Set(totalFails)];
    console.log(uniqueFails.join('\n'));
  } else {
    console.log('0 failures');
  }
}

run().catch(console.error);
