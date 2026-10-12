const { chromium } = require('playwright');
const { newLightContext, newLightPage } = require('./helpers.js');
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
      // Get all computed valid colors for the current theme
      const style = getComputedStyle(document.documentElement);
      
      const validColors = new Set();
      validColors.add('rgba(0, 0, 0, 0)'); // transparent
      validColors.add('transparent');
      
      for (const t of tokens) {
        const val = style.getPropertyValue(t).trim();
        if (!val) continue;
        // Need to parse if it's a hex, but getPropertyValue might return hex.
        // Actually, we can create a dummy element to get the computed rgb/rgba
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
      for (const el of allElements) {
        const comp = getComputedStyle(el);
        const bg = comp.backgroundColor;
        const color = comp.color;
        
        // Skip SVG elements like path, line, polyline etc as they use fill/stroke
        if (el.tagName.toLowerCase() === 'svg' || el.tagName.toLowerCase() === 'path' || el.tagName.toLowerCase() === 'circle' || el.tagName.toLowerCase() === 'line' || el.tagName.toLowerCase() === 'polyline') continue;
        
        // Skip images
        if (el.tagName.toLowerCase() === 'img') continue;
        
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
    await page.waitForTimeout(500); // Wait for transition
    
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
    await page.waitForTimeout(500); // Wait for transition
    
    fails = await checkPageColors(page, name, 'dark');
    allFails = allFails.concat(fails.map(f => `[Dark] ${name}: ${f.el} has invalid ${f.type} ${f.val}`));
    
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: `screenshots/${name}_dark_1280.png` });
    await page.setViewportSize({ width: 440, height: 800 });
    await page.screenshot({ path: `screenshots/${name}_dark_440.png` });
    
    return allFails;
  }

  if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots');
  }

  let totalFails = [];
  const context = await newLightContext(browser);
  const page = await context.newPage();

  // 1. Setup Screen
  console.log('Capturing Setup Screen...');
  await page.goto('http://localhost:5173');
  await page.waitForSelector('.simulator-shell', { state: 'visible' });
  const setupFails = await takeScreenshotsAndCheck(page, 'setup');
  totalFails = totalFails.concat(setupFails);

  await browser.close();
  
  if (totalFails.length > 0) {
    console.log('FAILURES:');
    // Group unique failures
    const uniqueFails = [...new Set(totalFails)];
    console.log(uniqueFails.join('\n'));
  } else {
    console.log('0 failures');
  }
}

run().catch(console.error);
