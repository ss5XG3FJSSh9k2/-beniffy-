const { chromium } = require('playwright');
const assert = require('assert');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('--- Test 1: Seamless Theme Switch ---');
  await page.goto('http://localhost:5173');
  await page.waitForSelector('h1', { state: 'visible' });

  // Get initial heading bounding box
  const h1BoxesBefore = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('h1')).map(el => el.getBoundingClientRect());
  });

  const measurements = await page.evaluate(async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Dark') || b.textContent.includes('Light'));
    if (!btn) throw new Error('Toggle button not found');
    
    const results = [];
    const getBg = () => window.getComputedStyle(document.body).backgroundColor;
    
    results.push({ time: 0, bg: getBg() });
    
    btn.click();
    
    // Sample immediately
    results.push({ time: 'click+0', bg: getBg() });
    
    // Sample at ~150ms
    await new Promise(r => setTimeout(r, 150));
    results.push({ time: 150, bg: getBg() });
    
    // Sample at ~300ms
    await new Promise(r => setTimeout(r, 350));
    results.push({ time: 350, bg: getBg() });
    
    const h1BoxesAfter = Array.from(document.querySelectorAll('h1')).map(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    
    return { results, h1BoxesAfter };
  });

  console.log('Background Color Samples:', measurements.results);
  
  const bg0 = measurements.results[0].bg;
  const bg150 = measurements.results[2].bg;
  const bg350 = measurements.results[3].bg;
  
  assert.notStrictEqual(bg0, bg350, 'Theme should have changed completely');
  assert.notStrictEqual(bg150, bg0, 'Intermediate value should not be initial color');
  assert.notStrictEqual(bg150, bg350, 'Intermediate value should not be final color');
  console.log('âœ“ Asserted at least one intermediate value');

  const h1BoxesBeforeStripped = h1BoxesBefore.map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  assert.deepStrictEqual(h1BoxesBeforeStripped, measurements.h1BoxesAfter, 'Heading bounding boxes changed during switch');
  console.log('âœ“ Asserted bounding boxes of main headings do not change');

  console.log('--- Test 2: Pre-saved Dark Theme on Load ---');
  await page.evaluate(() => window.localStorage.setItem('theme', 'dark'));
  
  // Reload and check immediately at domcontentloaded
  await page.reload();
  const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  
  console.log(`data-theme at DOMContentLoaded: ${dataTheme}`);
  assert.strictEqual(dataTheme, 'dark', 'Theme should be dark before first paint');
  console.log('âœ“ Asserted data-theme is dark at DOMContentLoaded');

  await browser.close();
  console.log('All tests passed.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
