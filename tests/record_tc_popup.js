const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForSplash } = require('./helpers.js');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/72d73806-c833-400b-952f-7c1b1aa2e4c8';

async function launchBrowser() {
  const options = { headless: true };
  try {
    return await chromium.launch(options);
  } catch (err) {
    try {
      return await chromium.launch({ ...options, channel: 'chrome' });
    } catch {
      return await chromium.launch({ ...options, channel: 'msedge' });
    }
  }
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 440, height: 900 },
    recordVideo: {
      dir: ARTIFACTS_DIR,
      size: { width: 440, height: 900 }
    }
  });

  const page = await context.newPage();

  console.log('Navigating to Customer App at 440px...');
  await page.goto('http://localhost:5173/?role=customer');
  await waitForSplash(page);
  await page.waitForTimeout(600);

  console.log('Clicking Sign Up (Customer)...');
  const signUpBtn = page.locator('button:has-text("Sign Up (Customer)"), button:has-text("साइन अप (ग्राहक)")').first();
  await signUpBtn.click();
  await page.waitForTimeout(600);

  // Fill in fields
  const phoneInput = page.locator('.phone-mockup input[placeholder*="9876543210"], .phone-mockup input[type="tel"]').first();
  await phoneInput.fill('9811119999');

  const nameInput = page.locator('.phone-mockup input[placeholder*="Joy Dev"]').first();
  await nameInput.fill('Stable User');

  const emailInput = page.locator('.phone-mockup input[placeholder*="example@beniffy.com"]').first();
  await emailInput.fill('stable@example.com');

  const regionSelect = page.locator('.phone-mockup select').first();
  await regionSelect.selectOption({ index: 1 });
  await page.waitForTimeout(400);

  console.log('Opening Terms & Conditions popup...');
  const tcLink = page.locator('span:has-text("Terms & Conditions"), span:has-text("नियम और शर्तें")').first();
  await tcLink.click();
  await page.waitForTimeout(500);

  const tcModal = page.locator('.modal-content:has-text("Terms & Conditions")').first();
  await tcModal.waitFor({ state: 'visible', timeout: 5000 });
  console.log('Terms & Conditions popup opened. Holding open for 5 seconds to capture video...');

  // Take screenshot as well
  const screenshotPath = path.join(ARTIFACTS_DIR, 'tc_popup_stable_440px.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`Saved screenshot to ${screenshotPath}`);

  // Hold open for 5.5 seconds
  await page.waitForTimeout(5500);

  console.log('Closing page to finalize video recording...');
  const videoObj = page.video();
  await page.close();
  await context.close();
  await browser.close();

  if (videoObj) {
    const videoPath = await videoObj.path();
    const finalVideoPath = path.join(ARTIFACTS_DIR, 'tc_popup_stable_5s.webm');
    try {
      fs.copyFileSync(videoPath, finalVideoPath);
      console.log(`✓ Video recording finalized and saved to: ${finalVideoPath}`);
    } catch {
      console.log(`✓ Video recorded at: ${videoPath}`);
    }
  }
}

main().catch(err => {
  console.error('Recording error:', err);
  process.exit(1);
});
