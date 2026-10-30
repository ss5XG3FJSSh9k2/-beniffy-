const envMod = require('./env');
const integrations = require('./integrations');
const templates = require('./message-templates');
const outbox = require('./outbox');

function isSmsConfigured() {
  if (process.env.SMS_MODE === 'off') return false;
  if (process.env.SMS_MODE === 'test') return true;
  if (process.env.SMS_MODE === 'live') {
    return !!process.env.MSG91_AUTH_KEY && !process.env.MSG91_AUTH_KEY.includes('placeholder') && !process.env.MSG91_AUTH_KEY.includes('when_ready');
  }
  const isMock = process.env.SMS_MOCK === 'true' || envMod.isTestEnv();
  const hasMsg91 = !!process.env.MSG91_AUTH_KEY && !process.env.MSG91_AUTH_KEY.includes('placeholder') && !process.env.MSG91_AUTH_KEY.includes('when_ready');
  return isMock || hasMsg91;
}

async function sendTemplateSms(phone, templateKey, params = {}, { lang = 'en' } = {}) {
  const mode = integrations.getSmsMode();
  const dltTemplateId = templates.getDltTemplateId(templateKey);
  const text = templates.renderTemplate(templateKey, lang, params);

  if (mode === 'live') {
    if (!dltTemplateId) {
      console.warn(`[SMS Live Refusal] Template ${templateKey} has no DLT template ID configured. Refusing to send.`);
      const err = new Error(`DLT template ID missing for ${templateKey}`);
      err.code = 'DLT_TEMPLATE_MISSING';
      throw err;
    }

    if (!process.env.MSG91_AUTH_KEY || process.env.MSG91_AUTH_KEY.includes('placeholder') || process.env.MSG91_AUTH_KEY.includes('when_ready')) {
      const err = new Error('MSG91_AUTH_KEY not set');
      err.code = 'SMS_NOT_CONFIGURED';
      throw err;
    }

    const senderId = process.env.MSG91_SENDER_ID || process.env.SMS_SENDER_ID || 'BNIFFY';

    // Call live MSG91 API
    try {
      const response = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
          'authkey': process.env.MSG91_AUTH_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          template_id: dltTemplateId,
          sender: senderId,
          mobiles: phone.startsWith('91') ? phone : ('91' + phone),
          ...params
        })
      });
      const result = await response.json().catch(() => ({}));
      // Never log OTP codes in live mode
      console.log(`[SMS MSG91 Live] Sent template ${templateKey} to ${phone}`);
      return { success: true, id: result.message || `msg91-${Date.now()}`, live: true, result };
    } catch (err) {
      console.error(`[SMS MSG91 Error] Failed to send template ${templateKey} to ${phone}:`, err.message);
      throw err;
    }
  }

  // Test Outbox Driver
  const entry = outbox.recordMessage({
    channel: 'sms',
    to: phone,
    text,
    templateId: templateKey,
    dltTemplateId
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log(envMod.isTestEnv() ? `[SMS Mock] Sent to ${phone}` : `[SMS Mock] Sent to ${phone}: ${text}`);
  }

  return { success: true, id: entry.id, text, channel: 'sms' };
}

async function sendSms(phone, body, options = {}) {
  const mode = integrations.getSmsMode();

  if (options && options.templateKey) {
    return sendTemplateSms(phone, options.templateKey, options.params || {}, { lang: options.lang || 'en' });
  }

  if (mode === 'live') {
    console.warn(`[SMS Live Refusal] Raw SMS sent without DLT template ID to ${phone}. Indian telecom DLT mandates template approval.`);
    const err = new Error('Raw SMS without DLT template ID is rejected in live mode');
    err.code = 'DLT_TEMPLATE_MISSING';
    throw err;
  }

  // Test Outbox Driver
  const entry = outbox.recordMessage({
    channel: 'sms',
    to: phone,
    text: body
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log(envMod.isTestEnv() ? `[SMS Mock] Sent to ${phone}` : `[SMS Mock] Sent to ${phone}: ${body}`);
  }

  return { success: true, id: entry.id, text: body, channel: 'sms' };
}

function getMockOutbox() {
  return outbox.getOutbox({ channel: 'sms' });
}

function clearMockOutbox() {
  outbox.clearOutbox();
}

module.exports = {
  isSmsConfigured,
  sendSms,
  sendTemplateSms,
  getMockOutbox,
  clearMockOutbox
};
