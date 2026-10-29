const envMod = require('./env');

function getPaymentsMode() {
  const envMode = (process.env.PAYMENTS_MODE || '').toLowerCase().trim();
  if (['off', 'test', 'live'].includes(envMode)) {
    return envMode;
  }
  if (process.env.NODE_ENV === 'production') {
    return 'off';
  }
  return 'test';
}

function getMissingPaymentsKeys() {
  const missing = [];
  if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.includes('placeholder')) {
    missing.push('RAZORPAY_KEY_ID not set');
  }
  if (!process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET.includes('placeholder')) {
    missing.push('RAZORPAY_KEY_SECRET not set');
  }
  if (!process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET.includes('placeholder')) {
    missing.push('RAZORPAY_WEBHOOK_SECRET not set');
  }
  return missing;
}

function getSmsMode() {
  const envMode = (process.env.SMS_MODE || '').toLowerCase().trim();
  if (['off', 'test', 'live'].includes(envMode)) {
    return envMode;
  }
  if (process.env.SMS_MOCK === 'true' || envMod.isTestEnv()) {
    return 'test';
  }
  const hasMsg91 = !!process.env.MSG91_AUTH_KEY && !process.env.MSG91_AUTH_KEY.includes('when_ready') && !process.env.MSG91_AUTH_KEY.includes('placeholder');
  const hasSmsApi = !!process.env.SMS_API_KEY && !process.env.SMS_API_KEY.includes('placeholder');
  if (hasMsg91 || hasSmsApi) {
    return 'live';
  }
  return 'test';
}

function getMissingSmsKeys() {
  const missing = [];
  if (!process.env.MSG91_AUTH_KEY && !process.env.SMS_API_KEY) {
    missing.push('MSG91_AUTH_KEY not set');
  }
  if (!process.env.SMS_SENDER_ID) {
    missing.push('SMS_SENDER_ID not set');
  }
  return missing;
}

function getEmailMode() {
  const envMode = (process.env.EMAIL_MODE || '').toLowerCase().trim();
  if (['off', 'test', 'live'].includes(envMode)) {
    return envMode;
  }
  if (process.env.EMAIL_MOCK === 'true' || envMod.isTestEnv()) {
    return 'test';
  }
  const hasSendGrid = !!process.env.SENDGRID_API_KEY && !process.env.SENDGRID_API_KEY.includes('when_ready') && !process.env.SENDGRID_API_KEY.includes('placeholder');
  if (hasSendGrid && process.env.EMAIL_MOCK === 'false') {
    return 'live';
  }
  return 'test';
}

function getMissingEmailKeys() {
  const missing = [];
  if (!process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY.includes('when_ready')) {
    missing.push('SENDGRID_API_KEY not set');
  }
  if (!process.env.EMAIL_FROM_ADDRESS) {
    missing.push('EMAIL_FROM_ADDRESS not set');
  }
  return missing;
}

function getWhatsappMode() {
  const envMode = (process.env.WHATSAPP_MODE || '').toLowerCase().trim();
  if (['off', 'test', 'live'].includes(envMode)) {
    return envMode;
  }
  if (process.env.WHATSAPP_MOCK === 'true') {
    return 'test';
  }
  const hasKey = !!process.env.WHATSAPP_API_KEY && !process.env.WHATSAPP_API_KEY.includes('placeholder');
  if (hasKey) {
    return 'live';
  }
  return 'off';
}

function getMissingWhatsappKeys() {
  const missing = [];
  if (!process.env.WHATSAPP_API_KEY) {
    missing.push('WHATSAPP_API_KEY not set');
  }
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
    missing.push('WHATSAPP_PHONE_NUMBER_ID not set');
  }
  return missing;
}

function getIntegrationsStatus() {
  const paymentsMode = getPaymentsMode();
  const smsMode = getSmsMode();
  const emailMode = getEmailMode();
  const whatsappMode = getWhatsappMode();

  return [
    {
      id: 'payments',
      name: 'Payments',
      provider: 'Razorpay',
      mode: paymentsMode,
      missing: getMissingPaymentsKeys()
    },
    {
      id: 'sms',
      name: 'SMS',
      provider: 'MSG91',
      mode: smsMode,
      missing: getMissingSmsKeys()
    },
    {
      id: 'email',
      name: 'Email',
      provider: 'SendGrid',
      mode: emailMode,
      missing: getMissingEmailKeys()
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp',
      provider: 'Meta Cloud API',
      mode: whatsappMode,
      missing: getMissingWhatsappKeys()
    }
  ];
}

module.exports = {
  getPaymentsMode,
  getMissingPaymentsKeys,
  getSmsMode,
  getMissingSmsKeys,
  getEmailMode,
  getMissingEmailKeys,
  getWhatsappMode,
  getMissingWhatsappKeys,
  getIntegrationsStatus
};
