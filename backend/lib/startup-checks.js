
const db = require('../db');
const { normalizePhone } = require('./validation');

function assertNoDuplicateRoutes(appToTest, fallbackApp) {
  const targetApp = appToTest || fallbackApp;
  const router = targetApp._router || targetApp.router;
  if (!router || !router.stack) return;
  const seen = new Map();
  const dupes = [];
  router.stack.forEach(layer => {
    if (!layer.route) return;
    const routePath = layer.route.path;
    const paths = Array.isArray(routePath) ? routePath : [routePath];
    Object.keys(layer.route.methods).forEach(method => {
      paths.forEach(p => {
        const key = `${method.toUpperCase()} ${p}`;
        if (seen.has(key)) dupes.push(key);
        else seen.set(key, true);
      });
    });
  });
  if (dupes.length) {
    throw new Error(`Duplicate route registrations detected:\n  ${dupes.join('\n  ')}`);
  }
}

async function reportMalformedPhones() {
  const users = await db.getTable('users');
  const partnerLeads = await db.getTable('partner_leads');
  
  let adminCount = 0;
  let customerCount = 0;
  let stockistCount = 0;
  let partnerLeadCount = 0;

  for (const u of users) {
    if (u.phone) {
      const norm = normalizePhone(u.phone);
      if (norm.length !== 10) {
        if (u.role === 'ADMIN') adminCount++;
        else if (u.role === 'CUSTOMER') customerCount++;
        else if (u.role === 'STOCKIST') stockistCount++;
      }
    }
  }

  for (const l of partnerLeads) {
    if (l.phone) {
      const norm = normalizePhone(l.phone);
      if (norm.length !== 10) {
        partnerLeadCount++;
      }
    }
  }

  console.log(`[Diagnostic] Malformed phones found: Users(ADMIN: ${adminCount}, CUSTOMER: ${customerCount}, STOCKIST: ${stockistCount}), PartnerLeads(${partnerLeadCount})`);
}

function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const errors = [];
  if (require('./env').isTestEnv() || process.env.SEED_MODE === 'test') errors.push('SEED_MODE is test');
  if (process.env.SMS_MOCK === 'true') errors.push('SMS_MOCK is true');
  if (process.env.DEMO_OTP === 'true') errors.push('DEMO_OTP is true');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) errors.push('JWT_SECRET missing or too short');
  if (!process.env.DATABASE_URL) errors.push('DATABASE_URL missing');
  if (!process.env.MSG91_AUTH_KEY) errors.push('MSG91_AUTH_KEY missing');
  if (!process.env.CAPTCHA_SECRET) errors.push('CAPTCHA_SECRET missing');
  if (!process.env.CORS_ORIGINS) errors.push('CORS_ORIGINS missing');
  
  if (errors.length > 0) {
    errors.forEach(e => console.error(e));
    process.exit(1);
  }
}

module.exports = {
  assertNoDuplicateRoutes,
  reportMalformedPhones,
  assertProductionConfig
};
