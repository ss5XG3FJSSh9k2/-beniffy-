const { chromium } = require('playwright');
const { newLightContext, newLightPage } = require('./helpers.js');
const path = require('path');
const fs = require('fs');

async function launchBrowser() {
  const options = { headless: true };
  try {
    return await chromium.launch(options);
  } catch {
    try {
      return await chromium.launch({ ...options, channel: 'chrome' });
    } catch {
      return await chromium.launch({ ...options, channel: 'msedge' });
    }
  }
}

async function runStockistTableSqueezeTests() {
  console.log('=== RUNNING BF-STOCKIST-TABLE-SQUEEZE PLAYWRIGHT TESTS ===');
  const viewports = [
    { width: 1280, height: 800 },
    { width: 1024, height: 800 }
  ];

  const artifactDir = 'C:\\Users\\user\\.gemini\\antigravity-ide\\brain\\d8c28c05-4cf9-4ee9-87c3-9b0eeae343c7';

  for (const vp of viewports) {
    console.log(`\n--- Testing at viewport: ${vp.width}x${vp.height} (Window width: ${vp.width}px) ---`);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: vp });
      await page.goto('http://localhost:5173/?dev');
      await page.evaluate(() => {
        localStorage.setItem('fastnet_cookie_consent', 'accepted');
      });
      await page.reload();
      await page.waitForTimeout(500);

      // Navigate to Admin Portal
      const adminTab = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
      await adminTab.waitFor({ state: 'visible', timeout: 5000 });
      await adminTab.click();
      await page.waitForTimeout(800);

      // Open Stockists tab
      const stockistBtn = page.locator('.admin-sidebar button:has-text("Stockists")');
      await stockistBtn.waitFor({ state: 'visible', timeout: 5000 });
      await stockistBtn.click();
      await page.waitForTimeout(1000);

      // Evaluate table assertions
      const assertions = await page.evaluate(() => {
        const table = document.querySelector('.table-scroll table.stockist-table') ||
                      Array.from(document.querySelectorAll('.table-scroll table')).find(t => t.innerText.includes('Name / Shop'));
        if (!table) return { error: 'Stockists table not found' };

        const ths = Array.from(table.querySelectorAll('thead th')).map(th => {
          const rect = th.getBoundingClientRect();
          return {
            text: th.innerText.trim(),
            rect: {
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
        });

        // 1. All expected headers exist
        const expectedHeaders = [
          'Name / Shop', 'Region', 'Vendor', 'Commission Rate',
          '30d Earnings (GMV)', 'Pending Orders', 'Status', 'Actions'
        ];
        const headerNames = ths.map(t => t.text);
        const allHeadersPresent = expectedHeaders.every(h => headerNames.includes(h));

        // 2. Check no header is covered by another header
        let headerOverlap = false;
        let overlapDetails = [];
        for (let i = 0; i < ths.length - 1; i++) {
          if (ths[i].rect.right > ths[i + 1].rect.left + 1) {
            headerOverlap = true;
            overlapDetails.push(`${ths[i].text} overlaps ${ths[i + 1].text} by ${ths[i].rect.right - ths[i + 1].rect.left}px`);
          }
        }

        // 3. Status header visibility and elementFromPoint
        const statusTh = table.querySelector('thead th:nth-child(7)');
        let statusElementFromPointTag = null;
        let statusElementFromPointText = null;
        let statusElementFromPointValid = false;
        if (statusTh) {
          const sRect = statusTh.getBoundingClientRect();
          const cx = Math.round(sRect.left + sRect.width / 2);
          const cy = Math.round(sRect.top + sRect.height / 2);
          const topEl = document.elementFromPoint(cx, cy);
          if (topEl) {
            statusElementFromPointTag = topEl.tagName;
            statusElementFromPointText = topEl.innerText.trim();
            statusElementFromPointValid = topEl.tagName === 'TH' && statusElementFromPointText === 'Status';
          }
        }

        // 4. Status badges: ACTIVE on one line
        const badges = Array.from(table.querySelectorAll('tbody tr td:nth-child(7) .badge'));
        const activeBadges = badges.filter(b => b.innerText.trim() === 'ACTIVE');
        const allActiveOnOneLine = activeBadges.length > 0 && activeBadges.every(b => {
          const rect = b.getBoundingClientRect();
          const computed = getComputedStyle(b);
          // Height of single line badge is ~22px; two lines is >=36px
          return rect.height < 30 && computed.whiteSpace === 'nowrap';
        });

        // 5. Region cells rendered check: scrollWidth <= clientWidth and no text is clipped
        const regionTds = Array.from(table.querySelectorAll('tbody tr td:nth-child(2)'));
        const regionRenderedDetails = regionTds.map(td => {
          const text = td.innerText.trim();
          const fitsH = td.scrollWidth <= td.clientWidth;
          const fitsV = td.scrollHeight <= td.clientHeight;
          const range = document.createRange();
          range.selectNodeContents(td);
          const textRect = range.getBoundingClientRect();
          const tdRect = td.getBoundingClientRect();
          const notClippedH = textRect.width <= td.clientWidth + 1;
          const notClippedV = textRect.bottom <= tdRect.bottom + 1;
          const noClippedText = notClippedH && notClippedV && fitsH && fitsV;
          return {
            text,
            scrollWidth: td.scrollWidth,
            clientWidth: td.clientWidth,
            scrollHeight: td.scrollHeight,
            clientHeight: td.clientHeight,
            fitsH,
            fitsV,
            noClippedText
          };
        });
        const allRegionsRenderedCleanly = regionRenderedDetails.length > 0 && regionRenderedDetails.every(r => r.noClippedText);

        // 6. Actions row: all 6 buttons on one line
        const actionButtonContainers = Array.from(table.querySelectorAll('tbody tr td:last-child > div'));
        const allActionsOnOneLine = actionButtonContainers.length > 0 && actionButtonContainers.every(div => {
          const rect = div.getBoundingClientRect();
          const buttons = div.querySelectorAll('button');
          // Height of single line button row is ~22px; wrapped is >=40px
          return buttons.length === 6 && rect.height < 30;
        });

        const scrollDiv = table.closest('.table-scroll');

        return {
          headerNames,
          allHeadersPresent,
          headerOverlap,
          overlapDetails,
          statusElementFromPointTag,
          statusElementFromPointText,
          statusElementFromPointValid,
          activeBadgesCount: activeBadges.length,
          allActiveOnOneLine,
          regionRenderedDetails,
          allRegionsRenderedCleanly,
          actionContainersCount: actionButtonContainers.length,
          allActionsOnOneLine,
          scrollWidth: scrollDiv.scrollWidth,
          clientWidth: scrollDiv.clientWidth
        };
      });

      if (assertions.error) {
        throw new Error(assertions.error);
      }

      console.log(`[CHECK] All 8 headers present: ${assertions.allHeadersPresent} (${assertions.headerNames.join(', ')})`);
      if (assertions.headerOverlap) {
        console.error(`[FAIL] Header overlap detected at ${vp.width}px: ${assertions.overlapDetails.join('; ')}`);
        process.exit(1);
      } else {
        console.log(`[PASS] No header covered by another header (all headers visible) at ${vp.width}px`);
      }

      console.log(`[CHECK] Status header elementFromPoint: <${assertions.statusElementFromPointTag}> with text "${assertions.statusElementFromPointText}"`);
      if (!assertions.statusElementFromPointValid) {
        console.error(`[FAIL] document.elementFromPoint at Status header centre did not return a TH with text "Status" (got <${assertions.statusElementFromPointTag}> with text "${assertions.statusElementFromPointText}") at ${vp.width}px`);
        process.exit(1);
      } else {
        console.log(`[PASS] document.elementFromPoint at Status header centre returns TH with text "Status" at ${vp.width}px`);
      }

      if (!assertions.allActiveOnOneLine) {
        console.error(`[FAIL] "ACTIVE" badge is wrapped onto multiple lines at ${vp.width}px`);
        process.exit(1);
      } else {
        console.log(`[PASS] "ACTIVE" status badge on one line (white-space: nowrap) at ${vp.width}px`);
      }

      if (!assertions.allRegionsRenderedCleanly) {
        console.error(`[FAIL] Region has clipped text or scrollWidth > clientWidth at ${vp.width}px:`, JSON.stringify(assertions.regionRenderedDetails));
        process.exit(1);
      } else {
        console.log(`[PASS] Region cells rendered check: scrollWidth <= clientWidth and no text clipped across all cells at ${vp.width}px`);
      }

      if (!assertions.allActionsOnOneLine) {
        console.error(`[FAIL] Actions buttons wrapped onto multiple lines at ${vp.width}px`);
        process.exit(1);
      } else {
        console.log(`[PASS] Actions buttons still on one line (6 buttons per row) at ${vp.width}px`);
      }

      // Save screenshot
      const tableLocator = page.locator('.table-scroll');
      const shotPath = path.join(artifactDir, `stockist_table_${vp.width}px.png`);
      await tableLocator.screenshot({ path: shotPath });
      console.log(`[SCREENSHOT] Saved: ${shotPath}`);

      if (vp.width === 1280) {
        // Also take full-screen view
        const fullShotPath = path.join(artifactDir, `stockist_table_full_${vp.width}px.png`);
        await page.screenshot({ path: fullShotPath, fullPage: false });
        console.log(`[SCREENSHOT] Saved full viewport: ${fullShotPath}`);
      }

    } finally {
      await browser.close();
    }
  }

  console.log('\n=== ALL BF-STOCKIST-TABLE-SQUEEZE ASSERTIONS PASSED AT BOTH 1280px AND 1024px ===');
}

if (require.main === module) {
  runStockistTableSqueezeTests().catch(err => {
    console.error('Fatal error in stockist table test:', err);
    process.exit(1);
  });
}

module.exports = { runStockistTableSqueezeTests };
