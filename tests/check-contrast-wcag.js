const { chromium } = require('playwright');
const fs = require('fs');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  async function checkContrastOnScreen(page, name, theme) {
    const failures = await page.evaluate(({ name, theme }) => {
      const fails = [];

      function parseRGBA(str) {
        if (!str) return [0,0,0,0];
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return [0,0,0,0];
        return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), m[4] !== undefined ? parseFloat(m[4]) : 1];
      }

      function getLuminance(r, g, b) {
        const a = [r, g, b].map(function (v) {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }

      function getContrast(bg, fg) {
        const l1 = getLuminance(bg[0], bg[1], bg[2]);
        const l2 = getLuminance(fg[0], fg[1], fg[2]);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }

      function blend(fg, bg) {
        const alpha = fg[3];
        return [
          Math.round((1 - alpha) * bg[0] + alpha * fg[0]),
          Math.round((1 - alpha) * bg[1] + alpha * fg[1]),
          Math.round((1 - alpha) * bg[2] + alpha * fg[2]),
          1
        ];
      }

      function getEffectiveBackground(el) {
        let current = el;
        let layers = [];
        while (current && current.tagName !== 'HTML') {
          const style = window.getComputedStyle(current);
          const bg = parseRGBA(style.backgroundColor);
          if (bg[3] > 0) {
            layers.push(bg);
            if (bg[3] === 1) break; // opaque
          }
          current = current.parentElement;
        }
        
        let base = [253, 240, 213, 1]; // Default light body
        if (document.documentElement.getAttribute('data-theme') === 'dark') {
          base = [32, 32, 31, 1]; // Default dark body
        }
        
        for (let i = layers.length - 1; i >= 0; i--) {
          base = blend(layers[i], base);
        }
        return base;
      }

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        const parent = node.parentElement;
        if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue;
        
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const fg = parseRGBA(style.color);
        const bg = getEffectiveBackground(parent);
        const ratio = getContrast(bg, fg);

        const weight = style.fontWeight;
        const isBold = weight === 'bold' || parseInt(weight) >= 600;
        const sizePx = parseFloat(style.fontSize);
        const isLarge = sizePx >= 24 || (isBold && sizePx >= 18.66);
        const threshold = isLarge ? 3 : 4.5;

        if (ratio < threshold) {
          const textExcerpt = node.nodeValue.trim().substring(0, 20).replace(/\n/g, ' ');
          fails.push(`[FAIL] [${theme}] ${name} - "${textExcerpt}" (size: ${sizePx}px, bold: ${isBold}). Ratio: ${ratio.toFixed(2)}:1 (req ${threshold}:1). fg:${style.color}, bg:rgba(${bg.join(',')})`);
        }
      }
      return fails;
    }, { name, theme });

    return failures;
  }

  const scenarios = [
    { name: 'marketing', clickRole: 'marketing' },
    { name: 'customer', clickRole: 'customer' },
    { name: 'stockist', clickRole: 'stockist' },
    { name: 'partner', clickRole: 'partner' },
    { name: 'admin', clickRole: 'admin' },
  ];

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);

  let totalFails = [];
  
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      window.localStorage.setItem('theme', t);
      document.documentElement.setAttribute('data-theme', t);
      // Trigger App re-render (if App reads from localStorage/data-theme)
      // Normally we click the theme switch, but this works for CSS tests.
    }, theme);
    // Actually it's better to just click the toggle.
    await page.evaluate((t) => {
       const btn = document.querySelector('.theme-toggle');
       if (btn && document.documentElement.getAttribute('data-theme') !== t) {
          btn.click();
       }
    }, theme);
    await page.waitForTimeout(1000);

    for (const scenario of scenarios) {
      await page.evaluate((role) => {
        const btns = Array.from(document.querySelectorAll('.role-tab'));
        const btn = btns.find(b => b.textContent.toLowerCase().includes(role));
        if (btn) btn.click();
      }, scenario.clickRole);
      await page.waitForTimeout(500);

      const fails = await checkContrastOnScreen(page, scenario.name, theme);
      totalFails = totalFails.concat(fails);
    }

    // Checking setup screen 
    // Wait, the setup screen is not accessible from the roles if they exist.
    // In dev mode with mocked API it is.
  }
  
  // also check setup and login specifically if we can?
  // Let's just output the fails.
  if (totalFails.length > 0) {
    const unique = [...new Set(totalFails)];
    console.log(unique.join('\\n'));
  } else {
    console.log('All contrast checks passed!');
  }

  await browser.close();
}

run().catch(console.error);
