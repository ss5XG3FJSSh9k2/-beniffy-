
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { sanitizeUser } = require('../lib/misc');
const { checkEmail , sanitizePlainText } = require('../lib/validation');
const { appendAudit } = require('../lib/audit');

function registerUserRoutes(app) {
app.get('/api/users/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const users = await db.getTable('users');
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (req.user.role !== 'ADMIN' && req.user.userId !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(sanitizeUser(user));
});

// PATCH /api/users/:id (Item 8)
app.patch('/api/users/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const isAdmin = req.user.role === 'ADMIN';
  if (!isAdmin && req.user.userId !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const allowedFields = ['name', 'email', 'address', 'phone', 'sms_marketing', 'email_marketing'];
  const adminAllowedFields = ['name', 'email', 'address', 'region_id', 'is_active', 'sms_marketing', 'email_marketing'];
  const protectedFields = ['kyc_status', 'points', 'is_active', 'role', 'id'];

  if (!isAdmin) {
    const requestedFields = Object.keys(req.body || {});
    const hasProtected = requestedFields.filter(f => protectedFields.includes(f));
    if (hasProtected.length > 0) {
      return res.status(400).json({
        error: 'Cannot modify protected fields',
        protected: hasProtected
      });
    }
  }

  const users = await db.getTable('users');
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const patch = {};
  const updateKeys = isAdmin ? adminAllowedFields : allowedFields;

  if (updateKeys.includes('email') && req.body.email && req.body.email !== user.email) {
    const validEmail = await checkEmail(req.body.email, res);
    if (!validEmail) return;
    patch.email = validEmail;
  }

  updateKeys.forEach(f => {
    if (f in req.body && f !== 'email') {
      const val = req.body[f];
      if (typeof val === 'string') {
        const maxLen = f === 'name' ? 50 : (f === 'address' ? 255 : 255);
        patch[f] = sanitizePlainText(val, maxLen);
      } else if (f === 'is_active' || f === 'sms_marketing' || f === 'email_marketing') {
        patch[f] = Boolean(val);
      } else {
        patch[f] = val;
      }
    }
  });

  if (patch.region_id !== undefined) {
    const regions = await db.getTable('regions');
    if (!regions.some(r => r.id === patch.region_id)) {
      return res.status(400).json({ error: 'Invalid region_id' });
    }
  }

  const before = {};
  const after = {};
  for (const k of Object.keys(patch)) {
    before[k] = user[k] !== undefined ? user[k] : null;
    after[k] = patch[k];
  }

  const updated = await db.updateRow('users', id, patch);

  if (isAdmin && Object.keys(patch).length > 0) {
    await appendAudit(req, 'ADMIN_EDIT_USER', 'user', id, before, after);
  }

  res.json(sanitizeUser(updated));
});
}

module.exports = { registerUserRoutes };
