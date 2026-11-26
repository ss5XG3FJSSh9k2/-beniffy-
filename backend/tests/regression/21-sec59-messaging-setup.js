const {
  fs, path, dbModule, loginAs, clearLogin, post, patch, get, state, assert
} = require('../lib/harness.js');

module.exports = async function section(ctx) {
  // ==============================================================================
  console.log('\n--- Section 59: Messaging Connector & Notifications ---');

  const messageTemplatesMod = require('../../lib/message-templates.js');
  const outboxMod = require('../../lib/outbox.js');
  const smsModRef = require('../../lib/sms.js');
  const _emailModRef = require('../../lib/email.js');
  const whatsappModRef = require('../../lib/whatsapp.js');

  // 1. Template Registry & Trilingual rendering
  const allTemplates = messageTemplatesMod.getAllTemplates();
  const templateKeys = Object.keys(allTemplates);
  assert(templateKeys.length >= 11, `Template registry has all required templates (found ${templateKeys.length})`);
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Template registry contains all 11 required message templates`);

  for (const tKey of templateKeys) {
    for (const lang of ['en', 'hi', 'bn']) {
      const rendered = messageTemplatesMod.renderTemplate(tKey, lang, {
        otp: '654321',
        orderId: 'o-test123',
        shopName: 'Green Grocery',
        amount: '250',
        pin: '4321',
        points: '25',
        reason: 'Missing documents'
      });
      assert(typeof rendered === 'string' && rendered.length > 10, `Template ${tKey} renders in ${lang}`);
      assert(!rendered.includes('{{'), `Template ${tKey} in ${lang} has no unreplaced placeholders`);
    }
  }
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: All message templates render successfully in English, Hindi, and Bengali`);

  // 2. Live SMS mode refuses to send without DLT template ID
  const origSmsMode = process.env.SMS_MODE;
  const origAuthKey = process.env.MSG91_AUTH_KEY;
  try {
    process.env.SMS_MODE = 'live';
    process.env.MSG91_AUTH_KEY = 'live_msg91_dummy_key';
    delete process.env.DLT_TEMPLATE_LOGIN_OTP;

    let dltErrorCaught = false;
    try {
      await smsModRef.sendTemplateSms('9876543210', 'LOGIN_OTP', { otp: '123456' });
    } catch (err) {
      if (err.code === 'DLT_TEMPLATE_MISSING') {
        dltErrorCaught = true;
      }
    }
    assert(dltErrorCaught === true, 'Live SMS mode refuses to send template without DLT template ID');
    state.testCount++; state.passedCount++;
    console.log(`[PASS] Test #${state.testCount}: Live SMS mode strictly refuses to send without DLT template ID`);
  } finally {
    if (origSmsMode !== undefined) process.env.SMS_MODE = origSmsMode;
    else delete process.env.SMS_MODE;
    if (origAuthKey !== undefined) process.env.MSG91_AUTH_KEY = origAuthKey;
    else delete process.env.MSG91_AUTH_KEY;
  }

  // 3. Email OTP login flow end-to-end
  outboxMod.clearOutbox();
  const s59OtpSendRes = await post('http://localhost:3001/api/auth/send-otp', {
    phone: '9876543210',
    channel: 'email'
  });
  assert(s59OtpSendRes.status === 200, `POST /api/auth/send-otp with channel: email returns 200, got ${s59OtpSendRes.status}`);
  assert(s59OtpSendRes.body.channel === 'email', 'send-otp reports channel === "email"');
  assert(typeof s59OtpSendRes.body.destination === 'string' && s59OtpSendRes.body.destination.includes('@'), 'send-otp returns destination email');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Email OTP successfully requested for customer account`);

  const s59EmailOutbox = outboxMod.getOutbox({ channel: 'email' });
  assert(s59EmailOutbox.length > 0, 'Outbox recorded email OTP message');
  const s59LatestEmail = s59EmailOutbox[0];
  const s59OtpMatch = s59LatestEmail.text.match(/\b\d{6}\b/);
  assert(s59OtpMatch !== null, 'Email text contains 6-digit OTP code');
  const s59ExtractedOtp = s59OtpMatch[0];

  const s59VerifyRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: '9876543210',
    otp: s59ExtractedOtp
  });
  assert(s59VerifyRes.status === 200, `POST /api/auth/verify-otp with email OTP code succeeds, got ${s59VerifyRes.status}`);
  assert(typeof s59VerifyRes.body.token === 'string' && s59VerifyRes.body.token.length > 10, 'Login response contains session token');
  assert(s59VerifyRes.body.user && s59VerifyRes.body.user.phone === '9876543210', 'Login response returns customer user object');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer logs in end-to-end using OTP delivered by email`);

  // 4. Admin Outbox API & Dev-tools
  loginAs('u-admin', 'ADMIN');
  const s59AdminOutboxRes = await get('http://localhost:3001/api/admin/outbox');
  assert(s59AdminOutboxRes.status === 200, `Admin GET /api/admin/outbox returns 200, got ${s59AdminOutboxRes.status}`);
  assert(Array.isArray(s59AdminOutboxRes.body.messages), 'Admin outbox response contains messages array');
  assert(s59AdminOutboxRes.body.messages.some(m => m.channel === 'email'), 'Outbox messages include recent email message');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin can view Message Outbox via API`);

  const s59AdminOutboxFilterRes = await get('http://localhost:3001/api/admin/outbox?channel=email');
  assert(s59AdminOutboxFilterRes.status === 200, 'Admin can filter outbox by channel');
  assert(s59AdminOutboxFilterRes.body.messages.every(m => m.channel === 'email'), 'Filtered outbox contains only email messages');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin outbox channel filtering works`);

  loginAs('u-cust1', 'CUSTOMER');
  const s59CustOutboxRes = await get('http://localhost:3001/api/admin/outbox');
  assert(s59CustOutboxRes.status === 403, 'Non-admin user cannot access admin outbox');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Non-admin user access to outbox is forbidden (403)`);

  loginAs('u-admin', 'ADMIN');
  const s59ClearOutboxRes = await post('http://localhost:3001/api/admin/outbox/clear', {});
  assert(s59ClearOutboxRes.status === 200, 'Admin can clear outbox');
  assert(outboxMod.getOutbox().length === 0, 'Outbox is completely cleared');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Admin outbox clearing works`);

  // 5. WhatsApp Opt-in Profile Toggle
  loginAs('u-cust1', 'CUSTOMER');
  const s59OptInRes = await post('http://localhost:3001/api/customer/u-cust1/profile', {
    whatsapp_opt_in: true
  });
  assert(s59OptInRes.status === 200, 'Customer toggles WhatsApp opt-in to true');
  let s59CustUser = (await dbModule.getTable('users')).find(u => u.id === 'u-cust1');
  assert(s59CustUser.whatsapp_opt_in === true, 'Customer user record has whatsapp_opt_in === true');
  assert(typeof s59CustUser.whatsapp_opt_in_at === 'string', 'Customer user record has whatsapp_opt_in_at timestamp');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer can opt into WhatsApp updates with timestamp`);

  const s59OptOutRes = await post('http://localhost:3001/api/customer/u-cust1/profile', {
    whatsapp_opt_in: false
  });
  assert(s59OptOutRes.status === 200, 'Customer toggles WhatsApp opt-in to false');
  s59CustUser = (await dbModule.getTable('users')).find(u => u.id === 'u-cust1');
  assert(s59CustUser.whatsapp_opt_in === false, 'Customer user record has whatsapp_opt_in === false');
  assert(s59CustUser.whatsapp_opt_in_at === null, 'Customer user record clears whatsapp_opt_in_at upon opt-out');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Customer can opt out of WhatsApp updates`);

  // 6. WhatsApp Notifications on Order Lifecycle (Opted-in vs Opted-out)
  await post('http://localhost:3001/api/customer/u-cust1/profile', { whatsapp_opt_in: true });
  outboxMod.clearOutbox();

  // Create order
  const s59Tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const s59Slot = `${s59Tomorrow.getFullYear()}-${String(s59Tomorrow.getMonth() + 1).padStart(2, '0')}-${String(s59Tomorrow.getDate()).padStart(2, '0')}T17:00`;
  const s59CreateOrderRes = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    items: [{ productId: 'p1', quantity: 1, price: 100 }],
    fulfillmentType: 'PICKUP',
    pickupSlot: s59Slot,
    paymentMethod: 'PAY_AT_HANDOVER'
  });
  assert(s59CreateOrderRes.status === 200, `Order created for opted-in customer, got ${s59CreateOrderRes.status}`);
  const s59OrderId = s59CreateOrderRes.body.orderId;
  const s59Order = (await dbModule.getTable('orders')).find(o => o.id === s59OrderId);
  assert(s59Order !== undefined, 'Found created order in database');

  // Check ORDER_PLACED in WhatsApp outbox
  const s59WaOrderPlaced = outboxMod.getOutbox({ channel: 'whatsapp' }).find(m => m.templateId === 'ORDER_PLACED');
  assert(s59WaOrderPlaced !== undefined, 'Opted-in customer receives ORDER_PLACED WhatsApp update');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Opted-in customer receives ORDER_PLACED WhatsApp message`);

  // Stockist sets to READY_FOR_PICKUP
  loginAs('u-stk1', 'STOCKIST');
  await patch(`http://localhost:3001/api/orders/${s59OrderId}/status`, { status: 'READY_FOR_PICKUP' });
  const s59WaReady = outboxMod.getOutbox({ channel: 'whatsapp' }).find(m => m.templateId === 'READY_FOR_PICKUP');
  assert(s59WaReady !== undefined, 'Opted-in customer receives READY_FOR_PICKUP WhatsApp update');
  assert(s59WaReady.text.includes(s59Order.pickup_pin || '----'), 'READY_FOR_PICKUP WhatsApp update includes pickup PIN');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Opted-in customer receives READY_FOR_PICKUP WhatsApp message with PIN`);

  // Stockist sets to OUT_FOR_DELIVERY
  await patch(`http://localhost:3001/api/orders/${s59OrderId}/status`, { status: 'OUT_FOR_DELIVERY' });
  const s59WaOut = outboxMod.getOutbox({ channel: 'whatsapp' }).find(m => m.templateId === 'OUT_FOR_DELIVERY');
  assert(s59WaOut !== undefined, 'Opted-in customer receives OUT_FOR_DELIVERY WhatsApp update');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Opted-in customer receives OUT_FOR_DELIVERY WhatsApp message`);

  // Stockist sets to DELIVERED
  await patch(`http://localhost:3001/api/orders/${s59OrderId}/status`, { status: 'DELIVERED', pin: s59Order.pickup_pin, payment_received_method: 'CASH' });
  const s59WaDelivered = outboxMod.getOutbox({ channel: 'whatsapp' }).find(m => m.templateId === 'ORDER_DELIVERED');
  assert(s59WaDelivered !== undefined, 'Opted-in customer receives ORDER_DELIVERED WhatsApp update');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Opted-in customer receives ORDER_DELIVERED WhatsApp message`);

  // Now opt-out customer and test another order (cancellation)
  loginAs('u-cust1', 'CUSTOMER');
  await post('http://localhost:3001/api/customer/u-cust1/profile', { whatsapp_opt_in: false });
  outboxMod.clearOutbox();

  const s59Order2Res = await post('http://localhost:3001/api/orders', {
    customerId: 'u-cust1',
    stockistId: 's1',
    items: [{ productId: 'p1', quantity: 1, price: 100 }],
    fulfillmentType: 'PICKUP',
    pickupSlot: s59Slot,
    paymentMethod: 'PAY_AT_HANDOVER'
  });
  assert(s59Order2Res.status === 200, 'Second order created for opted-out customer');
  const s59OrderId2 = s59Order2Res.body.orderId;
  const s59WaOptedOutMessages = outboxMod.getOutbox({ channel: 'whatsapp' });
  assert(s59WaOptedOutMessages.length === 0, 'Opted-out customer receives NO WhatsApp messages on order creation');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Opted-out customer receives NO WhatsApp messages`);

  // Cancel order -> opted-out customer still receives no WhatsApp messages
  await post(`http://localhost:3001/api/orders/${s59OrderId2}/cancel`);
  assert(outboxMod.getOutbox({ channel: 'whatsapp' }).length === 0, 'Opted-out customer receives NO WhatsApp messages on cancel');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: Cancellation for opted-out customer skips WhatsApp message`);

  // 7. WhatsApp send failure does not block order status update
  const origSendWhatsApp = whatsappModRef.sendWhatsAppUpdate;
  try {
    whatsappModRef.sendWhatsAppUpdate = async () => {
      throw new Error('Simulated Meta API network failure');
    };
    loginAs('u-cust1', 'CUSTOMER');
    const s59Order3Res = await post('http://localhost:3001/api/orders', {
      customerId: 'u-cust1',
      stockistId: 's1',
      items: [{ productId: 'p1', quantity: 1, price: 100 }],
      fulfillmentType: 'PICKUP',
      pickupSlot: s59Slot,
      paymentMethod: 'PAY_AT_HANDOVER'
    });
    assert(s59Order3Res.status === 200, 'Order created successfully even when WhatsApp fails');
    const s59OrderId3 = s59Order3Res.body.orderId;
    loginAs('u-stk1', 'STOCKIST');
    const s59FailStatusRes = await patch(`http://localhost:3001/api/orders/${s59OrderId3}/status`, { status: 'READY_FOR_PICKUP' });
    assert(s59FailStatusRes.status === 200, 'Order status updated to READY_FOR_PICKUP even when WhatsApp throws');
    state.testCount++; state.passedCount++;
    console.log(`[PASS] Test #${state.testCount}: WhatsApp send failure does not block order status update`);
  } finally {
    whatsappModRef.sendWhatsAppUpdate = origSendWhatsApp;
  }

  // 8. Meta WhatsApp Cloud API driver creates parameterized components for templates
  const origFetch = global.fetch;
  let interceptedPayload = null;
  try {
    global.fetch = async (url, opts) => {
      if (url.includes('graph.facebook.com')) {
        interceptedPayload = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.test123' }] }) };
      }
      return origFetch(url, opts);
    };
    process.env.WHATSAPP_MODE = 'live';
    process.env.WHATSAPP_TOKEN = 'test_meta_token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
    
    const liveRes = await whatsappModRef.sendWhatsAppUpdate({
      phone: '9876543210',
      templateKey: 'ORDER_PLACED',
      params: { orderId: 'o-test1', shopName: 'Test Shop', amount: 500 },
      user: { whatsapp_opt_in: true }
    });
    assert(liveRes.success === true && liveRes.live === true, 'WhatsApp live driver sends template successfully');
    assert(interceptedPayload && interceptedPayload.template && interceptedPayload.template.components, 'Payload includes template components');
    assert(interceptedPayload.template.components[0].parameters.some(p => p.text === 'o-test1'), 'Components include orderId parameter');
    state.testCount++; state.passedCount++;
    console.log(`[PASS] Test #${state.testCount}: Meta WhatsApp Cloud API driver generates template parameters in components`);
  } finally {
    global.fetch = origFetch;
    delete process.env.WHATSAPP_MODE;
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  console.log('\n--- Round BF-SETUP: Admin Setup Confirmation & Landing ---');
  clearLogin();

  // Test: POST /api/admin/setup-complete without auth returns 401
  const noAuthSetupRes = await post('http://localhost:3001/api/admin/setup-complete', {});
  assert(noAuthSetupRes.status === 401, 'POST /api/admin/setup-complete without auth returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/admin/setup-complete without auth returns 401`);

  // Test: POST /api/admin/setup-complete with customer token returns 401
  const custSetupLogin = await post('http://localhost:3001/api/auth/verify-otp', { phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' });
  ctx.custToken = custSetupLogin.body.token;
  const custAuthSetupRes = await post('http://localhost:3001/api/admin/setup-complete', {}, {
    headers: { Authorization: `Bearer ${ctx.custToken}` }
  });
  assert(custAuthSetupRes.status === 401, 'POST /api/admin/setup-complete with customer token returns 401');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/admin/setup-complete with customer token returns 401`);

  // Test: POST /api/admin/setup-complete with admin token returns 200 with numeric counts and no prose string
  loginAs('u-admin', 'ADMIN');
  const admAuthSetupRes = await post('http://localhost:3001/api/admin/setup-complete', { admin_id: 'u-admin' });
  assert(admAuthSetupRes.status === 200 && admAuthSetupRes.body.success === true, 'POST /api/admin/setup-complete with admin token returns 200 and success: true');
  assert(admAuthSetupRes.body.summary && typeof admAuthSetupRes.body.summary === 'object', 'POST /api/admin/setup-complete response includes summary object');
  assert(typeof admAuthSetupRes.body.summary.regions === 'number', 'summary includes numeric regions count');
  assert(typeof admAuthSetupRes.body.summary.stockists === 'number', 'summary includes numeric stockists count');
  assert(typeof admAuthSetupRes.body.summary.wholesalers === 'number', 'summary includes numeric wholesalers count');
  assert(typeof admAuthSetupRes.body.summary.customers === 'number', 'summary includes numeric customers count');
  assert(admAuthSetupRes.body.summary.text === undefined, 'summary contains counts only and NO prose string');
  assert(!Object.values(admAuthSetupRes.body.summary).some(v => typeof v === 'string'), 'summary contains no prose strings');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/admin/setup-complete returns numeric counts only and no prose string`);

  // Test: POST /api/setup/complete alias returns 200
  const aliasSetupRes = await post('http://localhost:3001/api/setup/complete', { admin_id: 'u-admin' });
  assert(aliasSetupRes.status === 200 && aliasSetupRes.body.success === true, 'POST /api/setup/complete alias returns 200');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: POST /api/setup/complete alias returns 200 with success: true`);

  // Test: App.jsx handleCreateAdminSetup does not prematurely set needsSetup(false)
  const setupAppJsxContent = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(!setupAppJsxContent.includes('setSetupSuccessAdmin(data);\n        setNeedsSetup(false);'), 'handleCreateAdminSetup does not immediately dismiss setup screen on success');
  state.testCount++; state.passedCount++;
  console.log(`[PASS] Test #${state.testCount}: App.jsx handleCreateAdminSetup retains setup confirmation screen until user proceeds`);

};
