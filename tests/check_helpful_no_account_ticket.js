const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForSplash, newLightPage } = require('./helpers.js');

const ARTIFACTS_DIR = 'C:/Users/thari/.gemini/antigravity-ide/brain/50e546d2-67ba-4a26-bfc9-09d168e65e7a';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

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
  console.log('=== RUNNING HELPFUL "NO ACCOUNT FOUND" PLAYWRIGHT TESTS ===');
  const browser = await launchBrowser();
  let failures = 0;

  const roles = [
    {
      role: 'stockist',
      tabName: 'Stockist App',
      unregisteredPhone: '9111223344',
      en: {
        msg: 'No shop is registered with this number. New here? Register your shop.',
        btn: 'Open a Shop',
        formMarker: 'Register Local Shop (KYC Required)'
      },
      hi: {
        msg: 'इस नंबर से कोई दुकान पंजीकृत नहीं है। नए हैं? अपनी दुकान पंजीकृत करें।',
        btn: 'दुकान खोलें',
        formMarker: 'स्थानीय दुकान पंजीकरण (KYC आवश्यक)'
      }
    },
    {
      role: 'customer',
      tabName: 'Customer App',
      unregisteredPhone: '9122334455',
      en: {
        msg: 'No account with this number. New here? Create one in a minute.',
        btn: 'Sign Up',
        formMarker: 'New Customer Registration'
      },
      hi: {
        msg: 'इस नंबर से कोई खाता नहीं है। नए हैं? एक मिनट में खाता बनाएं।',
        btn: 'साइन अप करें',
        formMarker: 'नया ग्राहक पंजीकरण'
      }
    },
    {
      role: 'partner',
      tabName: 'Partner App',
      unregisteredPhone: '9133445566',
      en: {
        msg: 'No partner account with this number. Want to partner with Beniffy? Apply here.',
        btn: 'Apply',
        formMarker: 'Partner Application'
      },
      hi: {
        msg: 'इस नंबर से कोई पार्टनर खाता नहीं है। Beniffy के साथ जुड़ना चाहते हैं? यहाँ आवेदन करें।',
        btn: 'आवेदन करें',
        formMarker: 'पार्टनर आवेदन'
      }
    },
    {
      role: 'admin',
      tabName: 'Admin Portal',
      unregisteredPhone: '9144556677',
      en: {
        msg: 'No admin account with this number.',
        btn: null
      },
      hi: {
        msg: 'इस नंबर से कोई एडमिन खाता नहीं है।',
        btn: null
      }
    }
  ];

  for (const lang of ['en', 'hi']) {
    console.log(`\n--- TESTING LANGUAGE: ${lang.toUpperCase()} ---`);
    for (const r of roles) {
      console.log(`\nTesting Role: ${r.role} (${r.tabName}) in ${lang.toUpperCase()}...`);
      const unregisteredPhone = '91' + Math.floor(10000000 + Math.random() * 90000000);
      const page = await newLightPage(browser);
      try {
        await page.goto('http://localhost:5173');
        await page.evaluate((l) => {
          localStorage.clear();
          localStorage.setItem('fastnet_lang', l);
        }, lang);
        await page.goto('http://localhost:5173');
        await waitForSplash(page);

        // Ensure language is set in React state
        await page.evaluate((l) => {
          if (window.__fastnet_set_lang) window.__fastnet_set_lang(l);
        }, lang);
        await page.waitForTimeout(300);

        // Switch role
        const roleBtn = page.locator(`.role-switcher button.role-tab:has-text("${r.tabName}")`);
        await roleBtn.waitFor({ state: 'visible', timeout: 5000 });
        await roleBtn.click();
        await page.waitForTimeout(500);

        // Fill unregistered phone
        let phoneInput;
        if (r.role === 'partner') {
          phoneInput = page.locator('input[placeholder="10-digit mobile number"], input[placeholder*="mobile"]').first();
        } else {
          phoneInput = page.locator('input[placeholder*="mobile"], input[placeholder*="फ़ोन"], input[placeholder*="मोबाइल"]').first();
        }
        await phoneInput.waitFor({ state: 'visible', timeout: 5000 });
        await phoneInput.fill(unregisteredPhone);

        // Click Send OTP
        const sendOtpBtn = page.locator('button:has-text("Send One-Time Password"), button:has-text("Send OTP"), button:has-text("ओटीपी भेजें"), button:has-text("OTP भेजें")').first();
        await sendOtpBtn.click();
        await page.waitForTimeout(600);

        // Dismiss the "OTP sent" toast so we can cleanly test the error toast
        const otpSentToast = page.locator('.toast-msg');
        if (await otpSentToast.count() > 0) {
          const dismissBtn = otpSentToast.locator('.toast-dismiss-btn');
          if (await dismissBtn.count() > 0) await dismissBtn.click().catch(() => {});
          await otpSentToast.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
        }

        // Fill OTP
        const otpInput = page.locator('input.otp-input, input[placeholder*="OTP"], input[placeholder*="ओटीपी"]').first();
        await otpInput.waitFor({ state: 'visible', timeout: 5000 });
        await otpInput.fill('123456');

        // Click Verify & Login
        const verifyBtn = page.locator('button:has-text("Verify & Login"), button:has-text("Verify"), button:has-text("सत्यापित करें")').first();
        await verifyBtn.click();

        // Wait for error toast
        const toast = page.locator('.toast-msg');
        await toast.waitFor({ state: 'visible', timeout: 5000 });

        const toastText = await toast.textContent();
        const expected = r[lang];

        // 1. Assert message text
        const hasMsg = toastText.includes(expected.msg);
        console.log(`  - Message matches expected: ${hasMsg ? 'PASS' : 'FAIL'}`);
        if (!hasMsg) {
          console.error(`    Expected to include: "${expected.msg}"`);
          console.error(`    Actual toast text: "${toastText}"`);
          failures++;
        }

        // 2. Assert button
        const actionBtn = toast.locator('.toast-action-btn');
        const btnCount = await actionBtn.count();

        if (expected.btn) {
          const hasBtn = btnCount > 0;
          console.log(`  - Action button present: ${hasBtn ? 'PASS' : 'FAIL'}`);
          if (!hasBtn) {
            console.error(`    Expected action button with label: "${expected.btn}"`);
            failures++;
          } else {
            const btnText = (await actionBtn.textContent()).trim();
            const btnMatches = btnText === expected.btn;
            console.log(`  - Action button text "${btnText}" matches "${expected.btn}": ${btnMatches ? 'PASS' : 'FAIL'}`);
            if (!btnMatches) failures++;

            // Screenshot for stockist and customer
            if (r.role === 'stockist' || r.role === 'customer') {
              const shotName = `toast_${r.role}_no_account_${lang}.png`;
              const shotPath = path.join(SCREENSHOTS_DIR, shotName);
              await toast.screenshot({ path: shotPath });
              console.log(`  📸 Toast screenshot saved: ${shotName}`);
              try {
                fs.copyFileSync(shotPath, path.join(ARTIFACTS_DIR, shotName));
              } catch (e) {}
            }

            // Click the action button
            await actionBtn.click();
            await page.waitForTimeout(600);

            // 3. Assert sign-up form opens with prefilled phone and reset OTP step
            const content = await page.content();
            const formOpened = content.includes(expected.formMarker);
            console.log(`  - Sign-up form opened (${expected.formMarker}): ${formOpened ? 'PASS' : 'FAIL'}`);
            if (!formOpened) {
              console.error(`    Expected form marker "${expected.formMarker}" not found in page content`);
              failures++;
            }

            // Assert phone prefilled
            let prefilledVal = '';
            if (r.role === 'partner') {
              const pInput = page.locator('input[placeholder="10-digit mobile number"]').first();
              prefilledVal = await pInput.inputValue().catch(() => '');
            } else {
              const pInput = page.locator('input.text-input[placeholder*="9876543210"]').first();
              prefilledVal = await pInput.inputValue().catch(() => '');
            }
            const phoneMatches = prefilledVal.includes(unregisteredPhone);
            console.log(`  - Phone prefilled with "${prefilledVal}" (expected "${unregisteredPhone}"): ${phoneMatches ? 'PASS' : 'FAIL'}`);
            if (!phoneMatches) failures++;

            // Assert OTP input reset / gone
            const otpStillThere = (await page.locator('input.otp-input').count()) > 0;
            console.log(`  - OTP step reset: ${!otpStillThere ? 'PASS' : 'FAIL'}`);
            if (otpStillThere) failures++;
          }
        } else {
          // Admin: assert no button
          const noBtn = btnCount === 0;
          console.log(`  - No action button for Admin: ${noBtn ? 'PASS' : 'FAIL'}`);
          if (!noBtn) failures++;
        }

      } catch (err) {
        console.error(`  ❌ Error during test:`, err.message);
        failures++;
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
  console.log(`\n========================================`);
  if (failures === 0) {
    console.log(`✓ ALL HELPFUL NO ACCOUNT FOUND TESTS PASSED CLEANLY!`);
  } else {
    console.error(`❌ ${failures} CHECKS FAILED!`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
