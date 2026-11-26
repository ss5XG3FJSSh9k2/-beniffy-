
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../lib/authz');
const { hasValidKycSignature } = require('../lib/bills');

function registerKycRoutes(app) {
app.get('/api/kyc/documents/:filename', async (req, res, next) => {
  if (hasValidKycSignature(req)) {
    req.kycSigned = true;
    return next();
  }
  requireAuth(req, res, next);
}, async (req, res) => {
  const filename = req.params.filename;
  
  // Verify ownership
  if (!req.kycSigned) {
    let ownerId = null;
    const match = filename.match(/^kyc_([^_]+)_/);
    if (match) {
      ownerId = match[1];
    } else {
      const users = await db.getTable('users');
      const owner = users.find(u => {
        if (u.kyc_details && typeof u.kyc_details === 'string') {
          return u.kyc_details.includes(filename);
        } else if (u.kyc_details && u.kyc_details.document_photo_url) {
          return u.kyc_details.document_photo_url.includes(filename);
        } else if (u.document_photo_url) {
          return u.document_photo_url.includes(filename);
        }
        return false;
      });
      if (owner) ownerId = owner.id;
    }

    if (req.user.role !== 'ADMIN' && req.user.userId !== ownerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ext === '.pdf' ? 'application/pdf' : 'image/jpeg';
  const filepath = path.join(__dirname, '..', 'uploads', 'kyc', filename);
  if (fs.existsSync(filepath)) {
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(filepath);
  }
  const tmpPath = path.join('/tmp/kyc-uploads', filename);
  if (fs.existsSync(tmpPath)) {
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(tmpPath);
  }
  return res.status(404).json({ error: 'KYC document photo not found' });
});
}

module.exports = { registerKycRoutes };
