
const db = require('../db');

const integrations = require('../lib/integrations');

function registerHealthConfigRoutes(app) {
app.get('/api/health', async (req, res) => {
  let dbStatus = 'connected';
  try {
    const alive = await db.query('SELECT 1 as alive').catch(() => null);
    if (!alive) {
      const users = await db.getTable('users');
      if (!Array.isArray(users)) dbStatus = 'error';
    }
  } catch (e) {
    dbStatus = 'error';
  }
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';
  res.json({
    status: 'ok',
    db: dbStatus,
    uptime_seconds: Math.floor(process.uptime()),
    version: process.env.APP_VERSION || 'unknown',
    dev_tools_enabled: isDevAllowed
  });
});

app.get('/api/config', async (req, res) => {
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';
  let supportPhone = null;
  let supportWhatsapp = null;
  let supportEmail = null;
  let supportHours = null;

  try {
    const list = await db.getTable('support_settings');
    const settings = (Array.isArray(list) ? list : []).find(s => s.id === 'default');
    if (settings) {
      supportPhone = settings.support_phone || null;
      supportWhatsapp = settings.support_whatsapp || null;
      supportEmail = settings.support_email || null;
      supportHours = settings.support_hours || null;
    }
  } catch (err) {
    // ignore
  }

  res.json({
    status: 'ok',
    version: process.env.APP_VERSION || 'unknown',
    dev_tools_enabled: isDevAllowed,
    payments_mode: integrations.getPaymentsMode(),
    payments: {
      mode: integrations.getPaymentsMode(),
      provider: 'Razorpay'
    },
    sms_mode: integrations.getSmsMode(),
    sms: {
      mode: integrations.getSmsMode(),
      provider: 'MSG91'
    },
    email_mode: integrations.getEmailMode(),
    email: {
      mode: integrations.getEmailMode(),
      provider: 'Brevo'
    },
    whatsapp_mode: integrations.getWhatsappMode(),
    whatsapp: {
      mode: integrations.getWhatsappMode(),
      provider: 'Meta Cloud API'
    },
    support_phone: supportPhone,
    support_whatsapp: supportWhatsapp,
    support_email: supportEmail,
    support_hours: supportHours,
    support: {
      phone: supportPhone,
      whatsapp: supportWhatsapp,
      email: supportEmail,
      hours: supportHours
    }
  });
});
}

function registerVapidConfigRoute(app, { VAPID_PUBLIC_KEY }) {
app.get('/api/config/vapid', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});
}

function registerPostErrorConfigRoutes(app) {
app.get('/api/config/otp-mode', (req, res) => {
  res.json({ demo: require('../lib/env').isDemoOtpMode() });
});

app.get('/api/config/calculator', async (req, res) => {
  try {
    const configs = await db.getTable('commission_config');
    const globalConfig = (configs || []).find(c => c.scope === 'GLOBAL');
    if (!globalConfig) {
      return res.status(503).json({ error: 'calculator_unavailable' });
    }
    const rPct = Number(globalConfig.stockist_reinvest_pct);
    const pPct = Number(globalConfig.points_from_pot_pct);
    if (!Number.isFinite(rPct) || rPct < 0 || rPct > 100 || !Number.isFinite(pPct) || pPct < 0 || pPct > 100) {
      return res.status(503).json({ error: 'calculator_unavailable' });
    }
    res.json({ stockist_reinvest_pct: rPct, points_from_pot_pct: pPct });
  } catch (err) {
    res.status(503).json({ error: 'calculator_unavailable' });
  }
});
}

module.exports = {
  registerHealthConfigRoutes,
  registerVapidConfigRoute,
  registerPostErrorConfigRoutes
};
