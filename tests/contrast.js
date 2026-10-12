const { chromium } = require('playwright');

function calculateLuminance(r, g, b) {
    var a = [r, g, b].map(function (v) {
        v /= 255;
        return v <= 0.03928
            ? v / 12.92
            : Math.pow( (v + 0.055) / 1.055, 2.4 );
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function getContrastRatio(l1, l2) {
    var brightest = Math.max(l1, l2);
    var darkest = Math.min(l1, l2);
    return (brightest + 0.05) / (darkest + 0.05);
}

function parseColor(str) {
    const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
        return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
    }
    return [0,0,0];
}

async function run() {
  const browser = await chromium.launch();
  
  const scenarios = [
    { name: 'marketing', url: 'http://localhost:5173/' },
    { name: 'customer', url: 'http://localhost:5173/' },
    { name: 'stockist', url: 'http://localhost:5173/' },
    { name: 'partner', url: 'http://localhost:5173/' },
    { name: 'admin', url: 'http://localhost:5173/' }
  ];

  const themes = ['light', 'dark'];
  let failures = [];

  const page = await browser.newPage();
  
  for (const scenario of scenarios) {
    for (const theme of themes) {
      await page.goto(scenario.url);
      
      // Setup theme
      await page.evaluate((t) => {
        window.localStorage.setItem('theme', t);
        document.documentElement.setAttribute('data-theme', t);
      }, theme);

      // Setup role
      if (scenario.name !== 'marketing') {
        const targetRole = scenario.name === 'customer' ? 'customer' : scenario.name;
        await page.evaluate((role) => {
          const btns = Array.from(document.querySelectorAll('.role-tab'));
          const btn = btns.find(b => b.textContent.toLowerCase().includes(role));
          if (btn) btn.click();
        }, targetRole);
      } else {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('.role-tab'));
          const btn = btns.find(b => b.textContent.toLowerCase().includes('marketing'));
          if (btn) btn.click();
        });
      }

      await page.waitForTimeout(1000); // render

      // Check contrast in the browser context
      const pageFailures = await page.evaluate(() => {
        const calculateLuminance = (r, g, b) => {
            var a = [r, g, b].map(function (v) {
                v /= 255;
                return v <= 0.03928 ? v / 12.92 : Math.pow( (v + 0.055) / 1.055, 2.4 );
            });
            return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
        };

        const getContrastRatio = (l1, l2) => {
            var brightest = Math.max(l1, l2);
            var darkest = Math.min(l1, l2);
            return (brightest + 0.05) / (darkest + 0.05);
        };

        const parseColor = (str) => {
            const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (match) {
                return { r: parseInt(match[1], 10), g: parseInt(match[2], 10), b: parseInt(match[3], 10), a: match[4] ? parseFloat(match[4]) : 1 };
            }
            return null;
        };

        // Simple alpha blending over solid background
        const blend = (fg, bg) => {
            const a = fg.a;
            return {
                r: Math.round(fg.r * a + bg.r * (1 - a)),
                g: Math.round(fg.g * a + bg.g * (1 - a)),
                b: Math.round(fg.b * a + bg.b * (1 - a)),
                a: 1
            };
        };

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        let fails = [];
        const baseBgColor = parseColor(window.getComputedStyle(document.body).backgroundColor);

        while (node = walker.nextNode()) {
            if (!node.nodeValue.trim()) continue; // skip whitespace
            const parent = node.parentElement;
            if (!parent) continue;
            
            // Skip hidden elements
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            const rect = parent.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            // Compute actual background by walking up
            let bgNode = parent;
            let bgColor = parseColor(window.getComputedStyle(bgNode).backgroundColor);
            let colorsStack = [];
            while (bgNode && bgNode !== document.documentElement) {
                const bgStyle = window.getComputedStyle(bgNode);
                let c = parseColor(bgStyle.backgroundColor);
                if (c && c.a > 0) {
                    colorsStack.push(c);
                }
                if (c && c.a === 1) break; // opaque
                bgNode = bgNode.parentElement;
            }

            // Start from base body background and blend upwards
            let finalBg = baseBgColor;
            for (let i = colorsStack.length - 1; i >= 0; i--) {
                finalBg = blend(colorsStack[i], finalBg);
            }

            const textColor = parseColor(style.color);
            if (!textColor || !finalBg) continue;

            const textLum = calculateLuminance(textColor.r, textColor.g, textColor.b);
            const bgLum = calculateLuminance(finalBg.r, finalBg.g, finalBg.b);
            const contrast = getContrastRatio(textLum, bgLum);

            if (contrast < 4.5) {
                fails.push({
                    text: node.nodeValue.trim().substring(0, 30),
                    nodeName: parent.nodeName,
                    contrast: contrast.toFixed(2),
                    textColor: style.color,
                    bgColor: "rgb(" + finalBg.r + ", " + finalBg.g + ", " + finalBg.b + ")"
                });
            }
        }
        return fails;
      });

      if (pageFailures.length > 0) {
        failures.push({ scenario: scenario.name, theme, fails: pageFailures });
      }
    }
  }

  await browser.close();
  console.log(JSON.stringify(failures, null, 2));
}

run().catch(console.error);
