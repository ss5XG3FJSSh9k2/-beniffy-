
const db = require('../db');

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  const s = typeof str === 'string' ? str : String(str);
  return s.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return m;
    }
  });
}

function unescapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function sanitizePlainText(val, maxLength = 255) {
  if (val === undefined || val === null) return '';
  const str = typeof val === 'string' ? val : String(val);
  const cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function normalizePhone(phone) {
  if (!phone) return phone;
  let cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
    cleanPhone = cleanPhone.slice(2);
  }
  return cleanPhone;
}

function checkTermsAgreed(req, res, isTest) {
  if (!req.body.termsAgreed && !isTest) {
    res.status(400).json({ error: 'You must agree to Terms and Privacy Policy' });
    return false;
  }
  return true;
}

function checkPhone(phone, res) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    if (res) {
      res.status(400).json({ error: 'invalid_phone', message: 'Enter a valid 10-digit mobile number.' });
    }
    return null;
  }
  return cleanPhone;
}

// Input validation helper (Item 16)
function validateUserInput({ phone, email, name }) {
  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
      return 'invalid_phone';
    }
  }
  if (email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return 'Invalid email format';
    }
  }
  if (name) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
      return 'Name must be 2-50 letters';
    }
  }
  return null;
}

async function checkEmail(email, res, expectNew = true) {
  if (!email || typeof email !== 'string' || !email.trim()) {
    res.status(400).json({ error: 'Email is required' });
    return null;
  }
  const clean = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(clean)) {
    res.status(400).json({ error: 'Invalid email format' });
    return null;
  }
  if (expectNew) {
    const users = await db.getTable('users');
    const partners = await db.getTable('partners');
    const uDup = users.some(u => u.kyc_status !== 'RELEASED' && u.email && u.email.trim().toLowerCase() === clean);
    const pDup = partners.some(p => p.contact_email && p.contact_email.trim().toLowerCase() === clean);
    if (uDup || pDup) {
      res.status(400).json({ error: 'This email is already registered.' });
      return null;
    }
  }
  return clean;
}

function maskIdNumber(idNum) {
  if (!idNum) return 'XXXX-XXXX-XXXX';
  const clean = String(idNum).replace(/\D/g, '');
  if (clean.length === 12) {
    return 'XXXX-XXXX-' + clean.slice(8);
  }
  if (String(idNum).length > 4) {
    return 'X'.repeat(String(idNum).length - 4) + String(idNum).slice(-4);
  }
  return 'XXXX-XXXX-XXXX';
}

function validateSupportPhone(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, message: 'Support phone is required.' };
  const cleaned = raw.trim().replace(/[\s\-\(\)\.]/g, '');
  if (/^(\+91)?1800\d{6,7}$/.test(cleaned)) {
    return { valid: true, normalized: cleaned.replace(/^\+91/, '') };
  }
  let norm = cleaned.replace(/^\+91/, '').replace(/^0/, '');
  if (norm.length === 12 && norm.startsWith('91')) norm = norm.slice(2);
  if (/^[6-9]\d{9}$/.test(norm)) {
    return { valid: true, normalized: norm };
  }
  return { valid: false, message: 'Support phone must be a 10-digit Indian number or a 1800 toll-free number.' };
}

function validateSupportWhatsapp(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return { valid: true, normalized: null };
  const cleaned = raw.trim().replace(/[\s\-\(\)\.]/g, '');
  let norm = cleaned.replace(/^\+91/, '').replace(/^0/, '');
  if (norm.length === 12 && norm.startsWith('91')) norm = norm.slice(2);
  if (/^[6-9]\d{9}$/.test(norm)) {
    return { valid: true, normalized: norm };
  }
  return { valid: false, message: 'WhatsApp number must be a valid 10-digit Indian mobile number.' };
}

function validateSupportEmail(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return { valid: true, normalized: null };
  const trimmed = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { valid: true, normalized: trimmed.toLowerCase() };
  }
  return { valid: false, message: 'Please enter a valid email address.' };
}

module.exports = {
  escapeHtml,
  unescapeHtml,
  sanitizePlainText,
  normalizePhone,
  checkTermsAgreed,
  checkPhone,
  validateUserInput,
  checkEmail,
  maskIdNumber,
  validateSupportPhone,
  validateSupportWhatsapp,
  validateSupportEmail
};
