

const emailHelper = require('../lib/email');

function registerTestRoutes(app) {
app.get('/api/test/mock-outbox', async (req, res) => {
  if (!require('../lib/env').isTestEnv()) return res.status(404).json({ error: 'Not found' });
  return res.json(emailHelper.getMockOutbox());
});

app.post('/api/test/clear-mock-outbox', async (req, res) => {
  if (!require('../lib/env').isTestEnv()) return res.status(404).json({ error: 'Not found' });
  emailHelper.clearMockOutbox();
  return res.json({ success: true });
});
}

module.exports = { registerTestRoutes };
