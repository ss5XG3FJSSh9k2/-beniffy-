const envMod = require('./env');
const integrations = require('./integrations');
const templates = require('./message-templates');
const outbox = require('./outbox');

function isWhatsAppConfigured() {
  const mode = integrations.getWhatsappMode();
  if (mode === 'live') {
    const hasToken = !!process.env.WHATSAPP_TOKEN || !!process.env.WHATSAPP_API_KEY;
    const hasPhoneId = !!process.env.WHATSAPP_PHONE_NUMBER_ID;
    return hasToken && hasPhoneId;
  }
  return mode === 'test';
}

async function sendWhatsAppUpdate({ phone, templateKey, params = {}, lang = 'en', user = null }) {
  // §CONSENT: Never message someone who hasn't opted in
  if (user && user.whatsapp_opt_in !== true) {
    return { skipped: true, reason: 'opted_out' };
  }

  const mode = integrations.getWhatsappMode();
  if (mode === 'off') {
    return { skipped: true, reason: 'whatsapp_mode_off' };
  }

  const text = templates.renderTemplate(templateKey, lang, params);
  const metaTemplateName = templates.getMetaTemplateName ? templates.getMetaTemplateName(templateKey) : templateKey.toLowerCase();

  if (mode === 'live') {
    const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_API_KEY;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneId) {
      console.warn(`[WhatsApp Live] Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID. Skipping message.`);
      return { skipped: true, reason: 'unconfigured' };
    }

    try {
      const cleanPhone = phone.replace(/\D/g, '');
      const recipientPhone = cleanPhone.startsWith('91') ? cleanPhone : ('91' + cleanPhone);

      const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipientPhone,
          type: 'template',
          template: {
            name: metaTemplateName,
            language: { code: lang === 'hi' ? 'hi' : (lang === 'bn' ? 'bn' : 'en_US') }
          }
        })
      });
      const data = await res.json().catch(() => ({}));
      // Never log sensitive data in live mode
      console.log(`[WhatsApp Live] Sent template ${templateKey} to ${phone}`);
      return { success: true, live: true, id: data?.messages?.[0]?.id };
    } catch (err) {
      // Failure never blocks the order; log it
      console.error(`[WhatsApp Error] Failed sending ${templateKey} to ${phone}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  // Test Outbox Driver
  const entry = outbox.recordMessage({
    channel: 'whatsapp',
    to: phone,
    text,
    templateId: templateKey
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log(envMod.isTestEnv() ? `[WhatsApp Mock] Sent to ${phone}` : `[WhatsApp Mock] Sent to ${phone}: ${text}`);
  }

  return { success: true, id: entry.id, text, channel: 'whatsapp' };
}

module.exports = {
  isWhatsAppConfigured,
  sendWhatsAppUpdate
};
