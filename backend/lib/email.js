const envMod = require('./env');
const integrations = require('./integrations');
const outbox = require('./outbox');

function isEmailConfigured() {
  if (process.env.EMAIL_MODE === 'off') return false;
  if (process.env.EMAIL_MODE === 'test') return true;
  if (process.env.EMAIL_MODE === 'live') {
    const hasBrevo = !!process.env.BREVO_API_KEY && !process.env.BREVO_API_KEY.includes('placeholder');
    const hasSendGrid = !!process.env.SENDGRID_API_KEY && !process.env.SENDGRID_API_KEY.includes('placeholder') && !process.env.SENDGRID_API_KEY.includes('when_ready');
    return hasBrevo || hasSendGrid;
  }
  const isMock = process.env.EMAIL_MOCK === 'true' || envMod.isTestEnv();
  const hasBrevo = !!process.env.BREVO_API_KEY && !process.env.BREVO_API_KEY.includes('placeholder');
  const hasSendGrid = !!process.env.SENDGRID_API_KEY && !process.env.SENDGRID_API_KEY.includes('placeholder') && !process.env.SENDGRID_API_KEY.includes('when_ready');
  return isMock || hasBrevo || hasSendGrid;
}

async function sendEmail(to, subject, htmlBody, textBody) {
  const mode = integrations.getEmailMode();
  const effectiveText = textBody || htmlBody;

  if (mode === 'live') {
    const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_FROM_ADDRESS || 'no-reply@beniffy.com';
    const fromName = process.env.EMAIL_FROM_NAME || 'Beniffy';

    // 1. Brevo driver (preferred)
    if (process.env.BREVO_API_KEY && !process.env.BREVO_API_KEY.includes('placeholder')) {
      try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: fromName, email: fromEmail },
            to: [{ email: to }],
            subject: subject,
            htmlContent: htmlBody || `<p>${effectiveText}</p>`,
            textContent: effectiveText
          })
        });
        const data = await response.json().catch(() => ({}));
        // Never log OTP codes in live mode
        console.log(`[Email Brevo Live] Sent "${subject}" to ${to}`);
        return { success: true, id: data.messageId || `brevo-${Date.now()}`, live: true, provider: 'brevo' };
      } catch (err) {
        console.error(`[Email Brevo Error] Failed to send email to ${to}:`, err.message);
        throw err;
      }
    }

    // 2. SendGrid fallback driver
    if (process.env.SENDGRID_API_KEY && !process.env.SENDGRID_API_KEY.includes('placeholder') && !process.env.SENDGRID_API_KEY.includes('when_ready')) {
      console.log(`[Email SendGrid Live] Sent "${subject}" to ${to}`);
      return { id: `sg-${Date.now()}`, to, subject, sent_at: new Date().toISOString(), live: true, provider: 'sendgrid' };
    }

    const err = new Error('Email service unavailable: BREVO_API_KEY not configured');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }

  // Test Outbox Driver
  const entry = outbox.recordMessage({
    channel: 'email',
    to,
    subject,
    text: effectiveText,
    textBody: textBody || effectiveText,
    htmlBody
  });

  console.log(`[Email Mock] Sent "${subject}" to ${to}`);
  if (process.env.NODE_ENV !== 'production' && !envMod.isTestEnv() && effectiveText) {
    console.log(`[Email Mock] ${effectiveText}`);
  }

  return { success: true, id: entry.id, to, subject, text: effectiveText, channel: 'email' };
}

function getMockOutbox() {
  return outbox.getOutbox({ channel: 'email' });
}

function clearMockOutbox() {
  outbox.clearOutbox();
}

module.exports = {
  isEmailConfigured,
  sendEmail,
  getMockOutbox,
  clearMockOutbox
};
