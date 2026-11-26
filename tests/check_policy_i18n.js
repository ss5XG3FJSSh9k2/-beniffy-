const { chromium } = require('playwright');
const { waitForSplash, newLightPage } = require('./helpers.js');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

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
  console.log('=== RUNNING POLICY PAGES I18N PLAYWRIGHT TEST ===');
  const screenshotsDir = path.resolve(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await launchBrowser();

  try {
    const page = await newLightPage(browser);
    await page.goto('http://localhost:5173');
    await page.evaluate(() => {
      localStorage.setItem('beniffy_cookie_consent', 'accepted');
    });
    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(400);

    const modals = [
      {
        key: 'privacy',
        titleId: 'privacy-modal-title',
        footerBtn: {
          en: 'Privacy Policy',
          hi: 'गोपनीयता नीति',
          bn: 'গোপনীয়তা নীতি'
        }
      },
      {
        key: 'terms',
        titleId: 'terms-modal-title',
        footerBtn: {
          en: 'Terms & Conditions',
          hi: 'नियम एवं शर्तें',
          bn: 'শর্তাবলী'
        }
      },
      {
        key: 'refund',
        titleId: 'refund-modal-title',
        footerBtn: {
          en: 'Refund Policy',
          hi: 'रिफंड नीति',
          bn: 'রিফান্ড নীতি'
        }
      },
      {
        key: 'cookies',
        titleId: 'cookies-modal-title',
        footerBtn: {
          en: 'Cookies Policy',
          hi: 'कुकीज़ नीति',
          bn: 'কুকিজ নীতি'
        }
      }
    ];

    const englishAppliesLine = {
      en: 'In case of any difference, the English version of this policy applies.',
      hi: 'किसी भी अंतर की स्थिति में, इस नीति का अंग्रेजी संस्करण लागू होता है।',
      bn: 'কোনো পার্থক্যের ক্ষেত্রে, এই নীতির ইংরেজি সংস্করণ প্রযোজ্য হবে।'
    };

    for (const modal of modals) {
      console.log(`\n--- Testing modal: ${modal.key} ---`);
      const results = {};

      for (const lang of ['en', 'hi', 'bn']) {
        await page.evaluate((l) => {
          if (window.__fastnet_set_lang) window.__fastnet_set_lang(l);
        }, lang);
        await page.waitForTimeout(250);

        const footerBtn = page.locator(`footer button:has-text("${modal.footerBtn[lang]}")`).first();
        await footerBtn.scrollIntoViewIfNeeded();
        await footerBtn.click();
        await page.waitForTimeout(250);

        const dialog = page.locator(`[role="dialog"][aria-labelledby="${modal.titleId}"]`);
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        const titleText = (await dialog.locator(`#${modal.titleId}`).textContent()).trim();
        const firstHeadingText = (await dialog.locator('p strong').first().textContent()).trim();
        const bodyText = (await dialog.textContent()).trim();

        results[lang] = { titleText, firstHeadingText, bodyText };

        if (lang === 'en') {
          assert(!bodyText.includes(englishAppliesLine.en), `${modal.key} (en) must NOT show English-applies notice`);
          assert(!bodyText.includes(englishAppliesLine.hi), `${modal.key} (en) must NOT show Hindi notice`);
          assert(!bodyText.includes(englishAppliesLine.bn), `${modal.key} (en) must NOT show Bengali notice`);
        } else if (lang === 'hi') {
          assert(/[\u0900-\u097F]/.test(bodyText), `${modal.key} (hi) must contain Devanagari script`);
          assert(bodyText.includes(englishAppliesLine.hi), `${modal.key} (hi) must contain translated English-version-applies notice`);
        } else if (lang === 'bn') {
          assert(/[\u0980-\u09FF]/.test(bodyText), `${modal.key} (bn) must contain Bengali script`);
          assert(bodyText.includes(englishAppliesLine.bn), `${modal.key} (bn) must contain translated English-version-applies notice`);
        }

        await page.screenshot({ path: path.join(screenshotsDir, `policy_${modal.key}_${lang}.png`) });

        // Close modal
        await dialog.locator('button[aria-label="Close"]').click();
        await dialog.waitFor({ state: 'detached', timeout: 3000 });
      }

      // Assert title and first section heading differ across en, hi, bn
      assert.notStrictEqual(results.en.titleText, results.hi.titleText, `${modal.key}: en and hi titles must differ`);
      assert.notStrictEqual(results.en.titleText, results.bn.titleText, `${modal.key}: en and bn titles must differ`);
      assert.notStrictEqual(results.hi.titleText, results.bn.titleText, `${modal.key}: hi and bn titles must differ`);

      assert.notStrictEqual(results.en.firstHeadingText, results.hi.firstHeadingText, `${modal.key}: en and hi first heading must differ`);
      assert.notStrictEqual(results.en.firstHeadingText, results.bn.firstHeadingText, `${modal.key}: en and bn first heading must differ`);
      assert.notStrictEqual(results.hi.firstHeadingText, results.bn.firstHeadingText, `${modal.key}: hi and bn first heading must differ`);

      console.log(`  [PASS] ${modal.key}: en/hi/bn titles & headings differ, scripts valid, notice shown only in hi/bn`);
    }

    // Verify footer tagline translation across en, hi, bn
    console.log('\n--- Testing footer tagline ---');
    const footerTaglines = {};
    for (const lang of ['en', 'hi', 'bn']) {
      await page.evaluate((l) => {
        if (window.__fastnet_set_lang) window.__fastnet_set_lang(l);
      }, lang);
      await page.waitForTimeout(200);
      footerTaglines[lang] = (await page.locator('footer').last().textContent()).trim();
    }
    assert(/[\u0900-\u097F]/.test(footerTaglines.hi), 'Footer in hi must contain Devanagari');
    assert(/[\u0980-\u09FF]/.test(footerTaglines.bn), 'Footer in bn must contain Bengali');
    console.log('  [PASS] Footer tagline translated in hi and bn');

    console.log('\n=== ALL POLICY I18N PLAYWRIGHT CHECKS PASSED ===');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
