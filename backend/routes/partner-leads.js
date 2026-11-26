
const db = require('../db');
const { generateId } = require('../lib/misc');
const { checkPhone } = require('../lib/validation');

function registerPartnerLeadRoutes(app) {
app.post('/api/partner-leads', async (req, res) => {
  let { name, contact_name, phone, email, service_type, service_types, region_id } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }
  const validPhone = checkPhone(phone, res);
  if (!validPhone) return;
  phone = validPhone;
  let finalServiceTypes = service_types;
  if (!finalServiceTypes || !Array.isArray(finalServiceTypes) || finalServiceTypes.length === 0) {
    if (service_type === 'BOTH') {
      finalServiceTypes = ['CABLE', 'BROADBAND'];
    } else if (service_type) {
      finalServiceTypes = [service_type];
    } else {
      finalServiceTypes = ['CABLE'];
    }
  }
  const leads = await db.getTable('partner_leads');
  const newLead = {
    id: 'lead-' + generateId(),
    name: name.trim(),
    contact_name: contact_name ? contact_name.trim() : null,
    phone: phone.trim(),
    email: email ? email.trim() : null,
    service_type: finalServiceTypes[0] || service_type || 'CABLE',
    service_types: finalServiceTypes,
    region_id: region_id || null,
    created_at: new Date().toISOString(),
    status: 'NEW',
    notes: []
  };
  leads.push(newLead);
  await db.saveTable('partner_leads', leads);
  return res.json({ success: true, lead: newLead });
});
}

module.exports = { registerPartnerLeadRoutes };
