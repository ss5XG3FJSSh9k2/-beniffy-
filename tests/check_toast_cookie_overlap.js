const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const screenshotsDir = path.resolve(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

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

async function run() {
  console.log('========================================================================');
  console.log('FASTNET PLAYWRIGHT CHECK: TOAST & COOKIE BANNER OVERLAP & TRANSLATION');
  console.log('========================================================================\n');

  // Clear rate limits before running
  await fetch('http://localhost:3001/api/admin/clear-rate-limits', { method: 'POST' }).catch(() => {});

  const browser = await launchBrowser();
  let allPassed = true;

  try {
    const viewports = [
      { width: 360, height: 740, name: 'mobile (360x740)' },
      { width: 768, height: 1024, name: 'tablet (768x1024)' },
      { width: 1280, height: 800, name: 'desktop (1280x800)' }
    ];
    const themes = ['light', 'dark'];

    // -------------------------------------------------------------------------
    // TEST 1: Toast sits above Cookie Banner with no overlap across viewports & themes
    // -------------------------------------------------------------------------
    for (const vp of viewports) {
      for (const theme of themes) {
        console.log(`\n--- [CHECK 1] Viewport: ${vp.name}, Theme: ${theme} ---`);
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: theme
        });
        const page = await context.newPage();

        // Fresh session - ensure NO cookie consent stored
        await page.goto('http://localhost:5173');
        await page.evaluate((t) => {
          localStorage.removeItem('beniffy_cookie_consent');
          localStorage.removeItem('fastnet_cookie_consent');
          const th = { marketing: t, customer: t, stockist: t, partner: t, admin: t };
          localStorage.setItem('fastnet.themes.v1', JSON.stringify(th));
        }, theme);
        await page.reload();
        await page.waitForTimeout(500);

        // Ensure splash screen dismissed
        const splash = page.locator('.cs-splash');
        if ((await splash.count()) > 0) {
          await splash.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
        }

        // Assert cookie banner is visible
        const banner = page.locator('.cookie-banner');
        await banner.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  Cookie banner visible.');

        // Trigger a toast
        await page.evaluate(() => {
          if (window.__fastnet_show_toast) {
            window.__fastnet_show_toast('Important system notification for all users', 'info');
          } else if (window.__beniffy_show_toast) {
            window.__beniffy_show_toast('Important system notification for all users', 'info');
          }
        });

        const toast = page.locator('.toast-msg');
        await toast.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300); // Allow layout transition
        console.log('  Toast message visible.');

        // Measure bounding boxes
        const bannerBox = await banner.boundingBox();
        const toastBox = await toast.boundingBox();
        assert(bannerBox, 'Cookie banner must have bounding box');
        assert(toastBox, 'Toast must have bounding box');

        console.log(`  Banner: top=${bannerBox.y.toFixed(1)}, bottom=${(bannerBox.y + bannerBox.height).toFixed(1)}, height=${bannerBox.height.toFixed(1)}`);
        console.log(`  Toast:  top=${toastBox.y.toFixed(1)}, bottom=${(toastBox.y + toastBox.height).toFixed(1)}, height=${toastBox.height.toFixed(1)}`);

        // Check for rectangle intersection
        const toastBottom = toastBox.y + toastBox.height;
        const bannerTop = bannerBox.y;
        const gap = bannerTop - toastBottom;
        console.log(`  Vertical gap between toast bottom and banner top: ${gap.toFixed(1)}px (Expected >= 10px)`);

        const intersects = (
          toastBox.x < bannerBox.x + bannerBox.width &&
          toastBox.x + toastBox.width > bannerBox.x &&
          toastBox.y < bannerBox.y + bannerBox.height &&
          toastBottom > bannerBox.y
        );

        if (intersects) {
          console.error(`  FAIL: Toast and banner intersect!`);
          allPassed = false;
        } else {
          console.log(`  PASS: Toast and banner do NOT intersect.`);
        }

        if (gap < 10) {
          console.error(`  FAIL: Gap ${gap}px is less than 10px.`);
          allPassed = false;
        } else {
          console.log(`  PASS: Toast sits fully above banner with a ${gap.toFixed(1)}px gap.`);
        }

        // Save screenshot of toast above banner
        const shotOverlap = `toast_cookie_above_${vp.width}x${vp.height}_${theme}.png`;
        await page.screenshot({ path: path.join(screenshotsDir, shotOverlap) });
        console.log(`  Saved screenshot: ${shotOverlap}`);

        // Click Accept on cookie banner while toast is visible
        console.log('  Clicking Accept on cookie banner while toast is visible...');
        const acceptBtn = banner.locator('.cookie-btn-accept');
        await acceptBtn.click();

        // Assert cookie consent saved under beniffy_cookie_consent
        await page.waitForTimeout(200);
        const storedConsent = await page.evaluate(() => localStorage.getItem('beniffy_cookie_consent'));
        console.log(`  Stored consent in localStorage: "${storedConsent}" (Expected "accepted")`);
        if (storedConsent !== 'accepted') {
          console.error(`  FAIL: beniffy_cookie_consent was not saved as "accepted"`);
          allPassed = false;
        } else {
          console.log('  PASS: beniffy_cookie_consent correctly written.');
        }

        // Assert banner dismissed
        await banner.waitFor({ state: 'detached', timeout: 3000 });
        console.log('  Cookie banner dismissed.');

        // Wait for toast slide-down transition
        await page.waitForTimeout(400);

        // Assert toast returns to bottom 28px (±2px)
        const windowHeight = await page.evaluate(() => window.innerHeight);
        const newToastBox = await toast.boundingBox();
        assert(newToastBox, 'Toast must still be visible after banner dismissal');
        const bottomDist = windowHeight - (newToastBox.y + newToastBox.height);
        console.log(`  Toast bottom distance after dismissal: ${bottomDist.toFixed(1)}px (Expected 28px ± 2px)`);

        if (Math.abs(bottomDist - 28) > 2) {
          console.error(`  FAIL: Toast bottom distance ${bottomDist.toFixed(1)}px is not within 28px ± 2px`);
          allPassed = false;
        } else {
          console.log(`  PASS: Toast returned to bottom ${bottomDist.toFixed(1)}px (within ±2px).`);
        }

        // Save screenshot after dismissal
        const shotDismissed = `toast_cookie_dismissed_${vp.width}x${vp.height}_${theme}.png`;
        await page.screenshot({ path: path.join(screenshotsDir, shotDismissed) });
        console.log(`  Saved screenshot: ${shotDismissed}`);

        await context.close();
      }
    }

    // -------------------------------------------------------------------------
    // TEST 2: Cookie Banner Translations (Hindi & Bengali)
    // -------------------------------------------------------------------------
    console.log('\n--- [CHECK 2] Cookie Banner Translations (Hindi & Bengali) ---');
    {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
      });
      const page = await context.newPage();
      await page.goto('http://localhost:5173');
      await page.evaluate(() => {
        localStorage.removeItem('beniffy_cookie_consent');
        localStorage.removeItem('fastnet_cookie_consent');
      });
      await page.reload();
      await page.waitForTimeout(500);

      const banner = page.locator('.cookie-banner');
      await banner.waitFor({ state: 'visible', timeout: 5000 });

      // Test Hindi translation
      console.log('  Testing Hindi translation (lang=hi)...');
      await page.evaluate(() => {
        if (window.__fastnet_set_lang) window.__fastnet_set_lang('hi');
        else if (window.__beniffy_set_lang) window.__beniffy_set_lang('hi');
      });
      await page.waitForTimeout(400);

      const hiText = await banner.locator('.cookie-banner-text').textContent();
      const hiAccept = await banner.locator('.cookie-btn-accept').textContent();
      const hiDecline = await banner.locator('.cookie-btn-decline').textContent();
      console.log(`    Hindi banner text: "${hiText.trim()}"`);
      console.log(`    Hindi Accept button: "${hiAccept.trim()}"`);
      console.log(`    Hindi Decline button: "${hiDecline.trim()}"`);

      const hasHiBannerText = hiText.includes('हम अपने प्लेटफ़ॉर्म पर आपके अनुभव को बेहतर बनाने के लिए कुकीज़ का उपयोग करते हैं।');
      const hasHiPolicyLink = hiText.includes('कुकीज़ नीति');
      const hasHiAccept = hiAccept.includes('स्वीकार करें');
      const hasHiDecline = hiDecline.includes('अस्वीकार करें');

      if (!hasHiBannerText || !hasHiPolicyLink || !hasHiAccept || !hasHiDecline) {
        console.error('  FAIL: Hindi translation missing or incomplete in cookie banner!');
        allPassed = false;
      } else {
        console.log('  PASS: Hindi translation verified on cookie banner.');
      }
      await page.screenshot({ path: path.join(screenshotsDir, 'toast_cookie_banner_hi.png') });

      // Test Bengali translation
      console.log('  Testing Bengali translation (lang=bn)...');
      await page.evaluate(() => {
        if (window.__fastnet_set_lang) window.__fastnet_set_lang('bn');
        else if (window.__beniffy_set_lang) window.__beniffy_set_lang('bn');
      });
      await page.waitForTimeout(400);

      const bnText = await banner.locator('.cookie-banner-text').textContent();
      const bnAccept = await banner.locator('.cookie-btn-accept').textContent();
      const bnDecline = await banner.locator('.cookie-btn-decline').textContent();
      console.log(`    Bengali banner text: "${bnText.trim()}"`);
      console.log(`    Bengali Accept button: "${bnAccept.trim()}"`);
      console.log(`    Bengali Decline button: "${bnDecline.trim()}"`);

      const hasBnBannerText = bnText.includes('আমাদের প্ল্যাটফর্মে আপনার অভিজ্ঞতা উন্নত করতে আমরা কুকিজ ব্যবহার করি।');
      const hasBnPolicyLink = bnText.includes('কুকিজ নীতি');
      const hasBnAccept = bnAccept.includes('গ্রহণ করুন');
      const hasBnDecline = bnDecline.includes('প্রত্যাখ্যান করুন');

      if (!hasBnBannerText || !hasBnPolicyLink || !hasBnAccept || !hasBnDecline) {
        console.error('  FAIL: Bengali translation missing or incomplete in cookie banner!');
        allPassed = false;
      } else {
        console.log('  PASS: Bengali translation verified on cookie banner.');
      }
      await page.screenshot({ path: path.join(screenshotsDir, 'toast_cookie_banner_bn.png') });

      await context.close();
    }

    if (!allPassed) {
      throw new Error('One or more checks failed!');
    }

    console.log('\n========================================================================');
    console.log('FINAL STATUS: ALL TOAST & COOKIE BANNER CHECKS PASSED');
    console.log('========================================================================\n');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
