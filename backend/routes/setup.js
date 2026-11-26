
const db = require('../db');
const sessionHelper = require('../lib/session');
const { checkPhone, checkEmail, sanitizePlainText } = require('../lib/validation');
const { generateId , sanitizeUser } = require('../lib/misc');
const { appendAudit } = require('../lib/audit');

function registerSetupRoutes(app, { handleAdminSetupComplete }) {
app.get('/api/setup/status', async (req, res) => {
  try {
    const users = await db.getTable('users');
    const user_count = users.length;
    res.json({ needs_setup: user_count === 0, user_count });
  } catch (err) {
    console.error('Error checking setup status:', err);
    res.status(500).json({ error: 'Failed to check setup status' });
  }
});

// POST /api/setup/create-admin
app.post('/api/setup/create-admin', async (req, res) => {
  try {
    const users = await db.getTable('users');
    if (users.length > 0) {
      return res.status(403).json({ error: 'Setup has already been completed.' });
    }

    let { name, phone, email } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: 'Name is required (max 120 chars).' });
    }
    const validPhone = checkPhone(phone, res);
    if (!validPhone) return;
    phone = validPhone;
    const validEmail = await checkEmail(email, res);
    if (!validEmail) return;

    const cleanName = sanitizePlainText(name, 120);
    const cleanPhone = phone.trim();

    // Ensure tenant t1 exists
    const tenants = await db.getTable('tenants');
    if (!tenants.some(t => t.id === 't1')) {
      await db.insertRow('tenants', {
        id: 't1',
        name: 'Beniffy Cable & Broadband',
        code: 'fastnet',
        created_at: new Date().toISOString()
      });
    }

    // Ensure global commission config exists
    const commConfigs = await db.getTable('commission_config');
    if (!commConfigs.some(c => c.scope === 'GLOBAL')) {
      await db.insertRow('commission_config', {
        id: `ccfg-global-${Date.now()}`,
        scope: 'GLOBAL',
        stockist_id: null,
        stockist_reinvest_pct: 40.00,
        points_from_pot_pct: 12.00,
        partner_redemption_cut_pct: 50.00,
        created_at: new Date().toISOString()
      });
    }

    const adminUser = {
      id: `u-${generateId()}`,
      tenant_id: 't1',
      region_id: null,
      phone: cleanPhone,
      email: validEmail,
      name: cleanName,
      role: 'ADMIN',
      kyc_status: 'APPROVED',
      no_show_count: 0,
      address: '',
      created_at: new Date().toISOString(),
      is_active: true
    };

    await db.insertRow('users', adminUser);
    await appendAudit(req, 'SETUP_CREATE_ADMIN', 'users', adminUser.id, null, sanitizeUser(adminUser), 'Initial administrator setup');

    const token = sessionHelper.signSession(adminUser.id, adminUser.role);
    res.status(200).json({
      ...sanitizeUser(adminUser),
      token,
      user: sanitizeUser(adminUser),
      summary: {
        text: 'Administrator account created, platform initialized'
      }
    });
  } catch (err) {
    console.error('Error creating admin in setup:', err);
    res.status(500).json({ error: 'Failed to create administrator account.' });
  }
});

app.post('/api/setup/complete', handleAdminSetupComplete);
}

module.exports = { registerSetupRoutes };
