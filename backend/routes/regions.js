
const db = require('../db');

function registerRegionRoutes(app) {
app.get('/api/regions', async (req, res) => {
  const regions = await db.getTable('regions');
  const clean = regions
    .filter(r => !r.tenant_id || r.tenant_id === 't1')
    .map(r => ({ id: r.id, name: r.name, code: r.code, delivery_fee: r.delivery_fee }));
  res.json(clean);
});
}

module.exports = { registerRegionRoutes };
