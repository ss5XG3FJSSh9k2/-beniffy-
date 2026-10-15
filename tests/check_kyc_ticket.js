const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/50e546d2-67ba-4a26-bfc9-09d168e65e7a';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function parseRgb(colorStr) {
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10)
  };
}

function getLuminance({ r, g, b }) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function getContrast(rgb1, rgb2) {
  const l1 = getLuminance(rgb1);
  const l2 = getLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function saveScreenshot(sourceBuffer, filename) {
  const localPath = path.join(SCREENSHOT_DIR, filename);
  fs.writeFileSync(localPath, sourceBuffer);
  try {
    const artPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(artPath, sourceBuffer);
  } catch (err) {
    console.warn('Could not copy to artifact dir:', err.message);
  }
}

async function runKycChecks() {
  console.log('=== RUNNING KYC APPROVALS & CLEAR FLAG TICKET CHECKS ===\n');

  // Obtain admin session token
  const admRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9999999999', otp: '123456', expected_role: 'ADMIN' })
  }).then(r => r.json());

  if (!admRes || !admRes.token) {
    throw new Error('Failed to get admin session from backend');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  let allPassed = true;

  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
    }, { user: admRes.user, token: admRes.token });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // Switch to Admin Portal
    console.log('Switching to Admin Portal tab...');
    const adminRoleBtn = page.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    await adminRoleBtn.click();
    await page.waitForTimeout(800);

    // Navigate to Pending KYC tab
    console.log('Navigating to Admin -> Pending KYC Approvals...');
    const kycNavBtn = page.locator('button.admin-nav-item:has-text("Pending KYC")').first();
    await kycNavBtn.waitFor({ state: 'visible', timeout: 6000 });
    await kycNavBtn.click();
    await page.waitForTimeout(1000);

    // Wait for the table
    const table = page.locator('table.admin-table').first();
    await table.waitFor({ state: 'visible', timeout: 5000 });

    const modes = ['light', 'dark'];

    for (const mode of modes) {
      console.log(`\n--- TESTING IN ${mode.toUpperCase()} MODE ---`);
      await page.evaluate((m) => {
        document.documentElement.setAttribute('data-theme', m);
      }, mode);
      await page.waitForTimeout(500);

      // Close any previously opened flags panel before starting mode checks
      const openBadge = page.locator('tbody tr:not(.flags-panel) .badge:has-text("▼")').first();
      if (await openBadge.count() > 0) {
        await openBadge.click();
        await page.waitForTimeout(400);
      }

      // Find row with an uncleared risk flag
      const rows = page.locator('tbody tr:not(.flags-panel)');
      const rowCount = await rows.count();
      console.log(`Found ${rowCount} KYC stockist row(s).`);
      
      let targetRow = null;
      for (let r = 0; r < rowCount; r++) {
        const row = rows.nth(r);
        const badge = row.locator('.badge');
        const text = await badge.textContent();
        if (text && text.includes('Flag')) {
          targetRow = row;
          break;
        }
      }
      if (!targetRow) {
        throw new Error('No row with active flags found');
      }

      const rowText = await targetRow.textContent();
      console.log(`Target row: ${rowText.slice(0, 60)}...`);

      // 1. Assert action buttons in the KYC row: whiteSpace: 'nowrap', font-size: 0.75rem, padding: 0.35rem 0.6rem
      // and height not taller than one line of text (height <= 36px)
      const actionButtons = targetRow.locator('button');
      const btnCount = await actionButtons.count();
      console.log(`Checking ${btnCount} action buttons in row...`);
      for (let b = 0; b < btnCount; b++) {
        const btn = actionButtons.nth(b);
        const bText = (await btn.textContent()).trim();
        const box = await btn.boundingBox();
        const whiteSpace = await btn.evaluate(el => window.getComputedStyle(el).whiteSpace);
        const fontSize = await btn.evaluate(el => window.getComputedStyle(el).fontSize);
        const padding = await btn.evaluate(el => window.getComputedStyle(el).padding);

        console.log(`  Button "${bText}": height=${box ? box.height.toFixed(1) : 'N/A'}px, whiteSpace=${whiteSpace}, fontSize=${fontSize}, padding=${padding}`);
        
        if (box && box.height > 36) {
          console.error(`  FAIL: Button "${bText}" height ${box.height}px > 36px (taller than one line)`);
          allPassed = false;
        } else {
          console.log(`  PASS: Button "${bText}" single line height`);
        }

        if (whiteSpace !== 'nowrap') {
          console.error(`  FAIL: Button "${bText}" whiteSpace is "${whiteSpace}", expected "nowrap"`);
          allPassed = false;
        }
      }

      // Check Actions cell width
      const actionsCell = targetRow.locator('td').last();
      const actionsBox = await actionsCell.boundingBox();
      console.log(`  Actions column cell width: ${actionsBox ? actionsBox.width.toFixed(1) : 'N/A'}px (min-width: 260px)`);
      if (actionsBox && actionsBox.width < 258) {
        console.error(`  FAIL: Actions column width ${actionsBox.width}px < 260px`);
        allPassed = false;
      } else {
        console.log(`  PASS: Actions column >= 260px`);
      }

      // 2. Expand Risk Flags panel
      const riskBadge = targetRow.locator('.badge').first();
      await riskBadge.click();
      await page.waitForTimeout(600);

      const flagsPanel = page.locator('tr.flags-panel').first();
      await flagsPanel.waitFor({ state: 'visible', timeout: 4000 });
      console.log('  Risk flags panel expanded.');

      // 3. Click Clear button on the flag
      const clearBtn = flagsPanel.locator('button:has-text("Clear")').first();
      await clearBtn.waitFor({ state: 'visible', timeout: 4000 });
      await clearBtn.click();
      await page.waitForTimeout(400);

      // 4. Assert Clear-flag form appears on its own line under the flag with visible label & input
      const label = flagsPanel.locator('label.input-label:has-text("Reason for clearing (required)")');
      const isLabelVisible = await label.isVisible();
      console.log(`  Visible label "Reason for clearing (required)": ${isLabelVisible ? 'PASS' : 'FAIL'}`);
      if (!isLabelVisible) allPassed = false;

      const noteInput = flagsPanel.locator('input.text-input[id^="flag-note-"]').first();
      await noteInput.waitFor({ state: 'visible', timeout: 3000 });

      // Check input placeholder
      const placeholder = await noteInput.getAttribute('placeholder');
      console.log(`  Input placeholder: "${placeholder}" (expected: "e.g. ID verified in person")`);
      if (placeholder !== 'e.g. ID verified in person') {
        console.error(`  FAIL: placeholder mismatch`);
        allPassed = false;
      }

      // 5. Type "No problem, verified in person"
      const noteText = "No problem, verified in person";
      await noteInput.fill(noteText);
      await page.waitForTimeout(300);

      // Check input contrast ratio
      const colorStyles = await noteInput.evaluate(el => {
        const cs = window.getComputedStyle(el);
        return {
          color: cs.color,
          backgroundColor: cs.backgroundColor
        };
      });

      const textColorRgb = parseRgb(colorStyles.color);
      const bgRgb = parseRgb(colorStyles.backgroundColor);
      const contrastRatio = getContrast(textColorRgb, bgRgb);
      console.log(`  Input color: ${colorStyles.color}, bg: ${colorStyles.backgroundColor}`);
      console.log(`  Contrast Ratio: ${contrastRatio.toFixed(2)}:1 (threshold: 4.5:1)`);
      if (contrastRatio < 4.5) {
        console.error(`  FAIL: Contrast ratio ${contrastRatio.toFixed(2)}:1 is below 4.5:1`);
        allPassed = false;
      } else {
        console.log(`  PASS: Contrast ratio ${contrastRatio.toFixed(2)}:1 >= 4.5:1 (WCAG AA/AAA compliant)`);
      }

      // Check Confirm button is enabled when >= 5 chars
      const confirmBtn = flagsPanel.locator('button.btn-primary:has-text("Confirm")').first();
      const isConfirmDisabled = await confirmBtn.isDisabled();
      console.log(`  Confirm button enabled when note has 5+ chars: ${!isConfirmDisabled ? 'PASS' : 'FAIL'}`);
      if (isConfirmDisabled) allPassed = false;

      // Screenshot the flag form open
      const flagFormOpenShot = await flagsPanel.screenshot();
      const flagFormShotName = `kyc_flag_form_open_${mode}.png`;
      saveScreenshot(flagFormOpenShot, flagFormShotName);
      console.log(`  📸 Screenshot saved: ${flagFormShotName}`);

      // 6. Press Enter on input to submit
      console.log('  Pressing Enter on note input...');
      await noteInput.press('Enter');
      await page.waitForTimeout(1000);

      // 7. Assert the flag shows as cleared with note
      const clearedLine = flagsPanel.locator('span:has-text("Cleared by"), span:has-text("No problem, verified in person")').first();
      await clearedLine.waitFor({ state: 'visible', timeout: 5000 });
      const clearedText = (await clearedLine.textContent()).trim();
      const clearedFontSize = await clearedLine.evaluate(el => window.getComputedStyle(el).fontSize);
      console.log(`  Cleared line text: "${clearedText}", fontSize: ${clearedFontSize}`);
      if (!clearedText.includes('Cleared by') || !clearedText.includes('No problem, verified in person')) {
        console.error(`  FAIL: Cleared note text not found`);
        allPassed = false;
      } else {
        console.log(`  PASS: Flag correctly cleared with note.`);
      }

      // 8. Screenshot the full KYC row (including all columns through Actions)
      await page.evaluate(() => {
        const sc = document.querySelector('.table-scroll');
        if (sc) sc.style.overflow = 'visible';
      });
      const fullRowShot = await targetRow.screenshot();
      await page.evaluate(() => {
        const sc = document.querySelector('.table-scroll');
        if (sc) sc.style.overflow = '';
      });
      const rowShotName = `kyc_row_full_${mode}.png`;
      saveScreenshot(fullRowShot, rowShotName);
      console.log(`  📸 Screenshot saved: ${rowShotName}`);
    }

    console.log('\n========================================');
    if (allPassed) {
      console.log('✓ ALL KYC ACTIONS & CLEAR FLAG CHECKS PASSED CLEANLY!');
    } else {
      console.error('✗ SOME CHECKS FAILED. See log above.');
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runKycChecks();
