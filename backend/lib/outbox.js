// Test Outbox for SMS, Email, and WhatsApp messages
const messages = [];
const MAX_OUTBOX = 200;

function recordMessage({ channel, to, text, subject, htmlBody, textBody, body, templateId, dltTemplateId }) {
  const content = String(text || textBody || body || htmlBody || '');
  const entry = {
    id: `outbox-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    channel: channel || 'sms',
    to: String(to || ''),
    phone: String(to || ''),
    text: content,
    textBody: textBody ? String(textBody) : content,
    htmlBody: htmlBody ? String(htmlBody) : content,
    body: body ? String(body) : content,
    subject: subject || null,
    templateId: templateId || null,
    dltTemplateId: dltTemplateId || null,
    sent_at: new Date().toISOString()
  };
  messages.unshift(entry);
  if (messages.length > MAX_OUTBOX) {
    messages.pop();
  }
  return entry;
}

function getOutbox({ channel, limit = 50 } = {}) {
  let list = messages;
  if (channel) {
    list = list.filter(m => m.channel === channel);
  }
  return list.slice(0, limit);
}

function clearOutbox() {
  messages.length = 0;
}

module.exports = {
  recordMessage,
  getOutbox,
  clearOutbox
};
