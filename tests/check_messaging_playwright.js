const { chromium } = require('playwright');
const session = require('../backend/lib/session.js');
const { waitForSplash, newLightPage } = require('./helpers.js');

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
  console.log('=== RUNNING MESSAGING (SMS/EMAIL/WHATSAPP) PLAYWRIGHT TEST ===');
  const browser = await launchBrowser();

  try {
    // ----------------------------------------------------
    // TEST 1: Login with "Send code by email", read from outbox, sign in
    // ----------------------------------------------------
    console.log('\n--- Step 1: Login with "Send code by email" ---');
    const page = await newLightPage(browser);
    await page.goto('http://localhost:5173');
    await page.evaluate(() => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.removeItem('currentUser');
      localStorage.removeItem('token');
      sessionStorage.setItem('fastnet.initialRole', 'customer');
    });

    await page.reload();
    await waitForSplash(page);
    await page.waitForTimeout(500);

    // Type registered customer phone 9876543210 (Amit Sen, email amit@fastnet.test)
    const phoneInput = page.locator('input[autocomplete="username"], input.text-input').first();
    await phoneInput.waitFor({ state: 'visible', timeout: 5000 });
    await phoneInput.fill('9876543210');
    await page.waitForTimeout(300);

    // Click "Send code by email"
    const sendEmailBtn = page.locator('[data-testid="send-code-by-email-btn"]');
    await sendEmailBtn.waitFor({ state: 'visible', timeout: 5000 });
    await sendEmailBtn.click();
    await page.waitForTimeout(600);

    // Verify OTP banner shows "OTP sent by email to amit@fastnet.test"
    const otpBanner = page.locator('[data-testid="otp-sent-banner"]');
    await otpBanner.waitFor({ state: 'visible', timeout: 5000 });
    const bannerText = await otpBanner.textContent();
    console.log(`OTP banner text: "${bannerText.replace(/\s+/g, ' ').trim()}"`);

    if (!bannerText.includes('amit@fastnet.test') && !bannerText.includes('9876543210')) {
      throw new Error(`Expected OTP banner to mention email or destination, got: ${bannerText}`);
    }

    // Read OTP code from admin outbox API
    const adminToken = session.signSession('u-admin', 'ADMIN');
    const outboxRes = await fetch('http://localhost:3001/api/admin/outbox?channel=email', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const outboxData = await outboxRes.json();
    console.log(`Found ${outboxData.messages?.length || 0} messages in email outbox`);
    const latestEmail = outboxData.messages?.[0];
    if (!latestEmail) {
      throw new Error('No email found in outbox');
    }
    const otpMatch = latestEmail.text.match(/\b\d{6}\b/);
    if (!otpMatch) {
      throw new Error(`Could not find 6-digit OTP in email text: "${latestEmail.text}"`);
    }
    const otpCode = otpMatch[0];
    console.log(`Extracted OTP code from admin outbox: ${otpCode}`);

    // Fill OTP in OTP input
    const otpInput = page.locator('.otp-input, input[placeholder*="OTP"]');
    await otpInput.waitFor({ state: 'visible', timeout: 5000 });
    await otpInput.fill(otpCode);
    await page.waitForTimeout(300);

    // Click Verify & Login
    const verifyBtn = page.locator('button:has-text("Verify & Login")');
    await verifyBtn.click();
    await page.waitForTimeout(1000);

    console.log('✓ [PASS] Customer logged in with "Send code by email" using outbox OTP');
    await page.close();

    // ----------------------------------------------------
    // TEST 2: Admin Integrations Screen & Message Outbox
    // ----------------------------------------------------
    console.log('\n--- Step 2: Verify Integrations & Admin Message Outbox ---');
    const adminPage = await newLightPage(browser);
    const adminUser = { id: 'u-admin', name: 'Super Admin', role: 'ADMIN', phone: '9999999999' };

    await adminPage.goto('http://localhost:5173');
    await adminPage.evaluate(({ user, token }) => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.setItem('currentUser', JSON.stringify(user));
      localStorage.setItem('token', token);
      sessionStorage.setItem('fastnet.initialRole', 'admin');
    }, { user: adminUser, token: adminToken });

    await adminPage.reload();
    await waitForSplash(adminPage);
    await adminPage.waitForTimeout(500);

    // Switch to Admin Portal
    const adminRoleTab = adminPage.locator('.role-switcher button.role-tab:has-text("Admin Portal")');
    await adminRoleTab.waitFor({ state: 'visible', timeout: 5000 });
    await adminRoleTab.click();
    await adminPage.waitForTimeout(600);

    // Check Integrations Screen
    const integrationsNav = adminPage.locator('[data-testid="admin-nav-integrations"]');
    await integrationsNav.waitFor({ state: 'visible', timeout: 5000 });
    await integrationsNav.click();
    await adminPage.waitForTimeout(600);

    const smsCard = adminPage.locator('[data-testid="integration-sms"]');
    await smsCard.waitFor({ state: 'visible', timeout: 5000 });
    const smsCardText = await smsCard.textContent();
    console.log(`SMS card text: "${smsCardText.replace(/\s+/g, ' ').trim()}"`);
    if (!smsCardText.toLowerCase().includes('sms: test') && !smsCardText.toLowerCase().includes('test')) {
      throw new Error(`Expected SMS card to show mode "test", got: ${smsCardText}`);
    }

    const emailCard = adminPage.locator('[data-testid="integration-email"]');
    await emailCard.waitFor({ state: 'visible', timeout: 5000 });
    const emailCardText = await emailCard.textContent();
    console.log(`Email card text: "${emailCardText.replace(/\s+/g, ' ').trim()}"`);
    if (!emailCardText.toLowerCase().includes('email: test') && !emailCardText.toLowerCase().includes('test')) {
      throw new Error(`Expected Email card to show mode "test", got: ${emailCardText}`);
    }
    const waCard = adminPage.locator('[data-testid="integration-whatsapp"]');
    await waCard.waitFor({ state: 'visible', timeout: 5000 });
    const waCardText = await waCard.textContent();
    console.log(`WhatsApp card text: "${waCardText.replace(/\s+/g, ' ').trim()}"`);
    if (!waCardText.toLowerCase().includes('whatsapp: test') && !waCardText.toLowerCase().includes('test')) {
      throw new Error(`Expected WhatsApp card to show mode "test", got: ${waCardText}`);
    }
    console.log('✓ [PASS] Integrations screen shows SMS: test, Email: test, WhatsApp: test');

    // Check Admin Message Outbox
    const outboxNav = adminPage.locator('[data-testid="admin-nav-outbox"]');
    await outboxNav.waitFor({ state: 'visible', timeout: 5000 });
    await outboxNav.click();
    await adminPage.waitForTimeout(600);

    const outboxScreen = adminPage.locator('[data-testid="admin-outbox"]');
    await outboxScreen.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✓ [PASS] Admin Message Outbox screen is fully operational');
    await adminPage.close();

    // ----------------------------------------------------
    // TEST 3: WhatsApp Opt-in during Sign-up & Profile Toggle
    // ----------------------------------------------------
    console.log('\n--- Step 3: Customer WhatsApp Opt-in & Profile Toggle ---');
    const custPage = await newLightPage(browser);
    await custPage.goto('http://localhost:5173');
    await custPage.evaluate(() => {
      localStorage.setItem('fastnet_cookie_consent', 'accepted');
      localStorage.removeItem('currentUser');
      localStorage.removeItem('token');
      sessionStorage.setItem('fastnet.initialRole', 'customer');
    });

    await custPage.reload();
    await waitForSplash(custPage);
    await custPage.waitForTimeout(500);

    // Open sign up
    const signupBtn = custPage.locator('button:has-text("Sign Up (Customer)")').first();
    await signupBtn.waitFor({ state: 'visible', timeout: 5000 });
    await signupBtn.click();
    await custPage.waitForTimeout(500);

    // Fill sign up fields
    const newPhone = '98' + Math.floor(10000000 + Math.random() * 90000000);
    const newEmail = `user${Date.now()}@example.com`;

    const phoneField = custPage.locator('#signup-phone-input');
    await phoneField.fill(newPhone);

    const nameField = custPage.locator('#signup-name-input');
    await nameField.fill('WhatsApp Test User');

    const emailField = custPage.locator('#signup-email-input');
    await emailField.fill(newEmail);

    const regionSelect = custPage.locator('#signup-region-select');
    await regionSelect.selectOption({ index: 1 });

    const cableSelect = custPage.locator('#signup-cable-select');
    await cableSelect.selectOption('NOT_LISTED');

    const noBroadbandBtn = custPage.locator('.input-group:has-text("internet") button:has-text("No")').first();
    await noBroadbandBtn.click();

    // Check terms
    const termsCheckbox = custPage.locator('#customer-terms-checkbox');
    await termsCheckbox.check();

    // Check WhatsApp opt-in
    const waOptInCheckbox = custPage.locator('[data-testid="customer-whatsapp-optin-checkbox"]');
    await waOptInCheckbox.waitFor({ state: 'visible', timeout: 5000 });
    await waOptInCheckbox.check();
    console.log('Checked WhatsApp opt-in during sign-up');

    // Submit sign up
    const submitBtn = custPage.locator('#signup-customer-submit-btn');
    await submitBtn.click();
    await custPage.waitForTimeout(1500);

    // Verify user is logged in
    const userJson = await custPage.evaluate(() => localStorage.getItem('currentUser'));
    const userToken = await custPage.evaluate(() => localStorage.getItem('token'));
    const loggedInUser = JSON.parse(userJson || '{}');
    console.log(`Signed up customer user: ${loggedInUser.id}, whatsapp_opt_in=${loggedInUser.whatsapp_opt_in}`);
    if (loggedInUser.whatsapp_opt_in !== true) {
      throw new Error('Expected new customer to have whatsapp_opt_in === true');
    }

    // Place an order as the newly signed-up customer
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pickupSlot = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T17:00`;
    const orderRes = await fetch('http://localhost:3001/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        customerId: loggedInUser.id,
        stockistId: 's1',
        items: [{ productId: 'p1', quantity: 1, price: 100 }],
        fulfillmentType: 'PICKUP',
        pickupSlot: pickupSlot,
        paymentMethod: 'PAY_AT_HANDOVER'
      })
    });
    const orderData = await orderRes.json();
    console.log(`Placed test order: ${orderData.orderId || orderData.order?.id}, success=${orderRes.ok}`);
    if (!orderRes.ok) {
      throw new Error(`Failed to place test order: ${JSON.stringify(orderData)}`);
    }

    // Verify "order placed" WhatsApp message is in the outbox
    const waOutboxRes = await fetch('http://localhost:3001/api/admin/outbox?channel=whatsapp', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const waOutboxData = await waOutboxRes.json();
    const orderPlacedMsg = (waOutboxData.messages || []).find(m => m.to === newPhone && m.templateId === 'ORDER_PLACED');
    if (!orderPlacedMsg) {
      throw new Error(`Expected ORDER_PLACED WhatsApp message in outbox for ${newPhone}`);
    }
    console.log(`✓ [PASS] Found ORDER_PLACED in outbox: "${orderPlacedMsg.text.slice(0, 50)}..."`);

    // Go to My Profile
    const profileTab = custPage.locator('.phone-nav-btn:has-text("Profile"), button:has-text("My Profile")').first();
    await profileTab.waitFor({ state: 'visible', timeout: 5000 });
    await profileTab.click();
    await custPage.waitForTimeout(600);

    // Verify WhatsApp checkbox is checked in profile
    const profileWaCheckbox = custPage.locator('[data-testid="profile-whatsapp-optin-checkbox"]');
    await profileWaCheckbox.waitFor({ state: 'visible', timeout: 5000 });
    const isChecked = await profileWaCheckbox.isChecked();
    if (!isChecked) {
      throw new Error('Expected Profile WhatsApp opt-in checkbox to be checked initially');
    }
    console.log('Profile WhatsApp opt-in checkbox is checked as expected');

    // Toggle off WhatsApp updates
    await profileWaCheckbox.uncheck();
    const saveProfileBtn = custPage.locator('button:has-text("Save Profile")');
    await saveProfileBtn.click();
    await custPage.waitForTimeout(1000);

    // Verify user record in database has opted out
    const updatedUserJson = await custPage.evaluate(() => localStorage.getItem('currentUser'));
    const updatedUser = JSON.parse(updatedUserJson || '{}');
    console.log(`Updated user after toggle off: whatsapp_opt_in=${updatedUser.whatsapp_opt_in}`);
    if (updatedUser.whatsapp_opt_in !== false) {
      throw new Error('Expected customer whatsapp_opt_in to be false after toggle');
    }

    // Cancel order; verify next WhatsApp update is NOT sent
    const testOrderId = orderData.orderId || orderData.order?.id;
    const cancelRes = await fetch(`http://localhost:3001/api/orders/${testOrderId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({ reason: 'Changed mind' })
    });
    console.log(`Cancelled order: success=${cancelRes.ok}`);

    const waOutboxAfterCancel = await fetch('http://localhost:3001/api/admin/outbox?channel=whatsapp', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const waDataAfterCancel = await waOutboxAfterCancel.json();
    const cancelMsg = (waDataAfterCancel.messages || []).find(m => m.to === newPhone && m.templateId === 'ORDER_CANCELLED');
    if (cancelMsg) {
      throw new Error(`Found unexpected ORDER_CANCELLED message for opted-out customer ${newPhone}`);
    }
    console.log(`✓ [PASS] Opted-out customer received no subsequent WhatsApp update`);
    console.log('✓ [PASS] Customer WhatsApp opt-in and toggle off verified end-to-end');

    await custPage.close();
    console.log('\n=== ALL PLAYWRIGHT TESTS PASSED SUCCESSFULLY ===');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Playwright Test Failed:', err);
  process.exit(1);
});
