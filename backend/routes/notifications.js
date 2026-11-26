
const db = require('../db');
const { requireAuth } = require('../lib/authz');

function registerNotificationRoutes(app) {
app.get('/api/notifications', requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const notifications = await db.getTable('notifications');
  const userNotifs = (notifications || [])
    .filter(n => n.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  return res.json(userNotifs);
});

app.patch('/api/notifications/read-all', requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const notifications = await db.getTable('notifications');
  const now = new Date().toISOString();
  for (const n of notifications) {
    if (n.user_id === userId && !n.read_at) {
      n.read_at = now;
      await db.updateRow('notifications', n.id, { read_at: now });
    }
  }
  return res.json({ success: true });
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  const { id } = req.params;
  const notifications = await db.getTable('notifications');
  const target = notifications.find(n => n.id === id);
  if (!target) return res.status(404).json({ error: 'Notification not found' });
  if (target.user_id !== req.user.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!target.read_at) {
    target.read_at = new Date().toISOString();
    await db.updateRow('notifications', target.id, { read_at: target.read_at });
  }
  return res.json({ success: true, notification: target });
});
}

module.exports = { registerNotificationRoutes };
