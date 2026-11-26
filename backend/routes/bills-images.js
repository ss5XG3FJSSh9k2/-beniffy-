
const db = require('../db');
const r2 = require('../lib/r2');
const { getCallerStockist } = require('../lib/access');
const { hasValidBillSignature } = require('../lib/bills');

function registerBillsImagesRoutes(app) {
app.get('/api/bills/*', async (req, res) => {
  const rawKey = req.params[0];
  if (!rawKey) return res.status(404).json({ error: 'Bill photo key required' });
  const key = decodeURIComponent(rawKey);

  // 1. Signature check
  const sigCheck = hasValidBillSignature(req);
  if (sigCheck.hasSig) {
    if (!sigCheck.valid) {
      return res.status(sigCheck.code || 401).json({ error: sigCheck.error || 'Invalid signature' });
    }
    // Signature is valid!
  } else {
    // 2. Auth check if no signature
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role !== 'ADMIN') {
      if (req.user.role !== 'STOCKIST') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const callerStockist = await getCallerStockist(req);
      if (!callerStockist) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const billPhotos = await db.getTable('product_bill_photos');
      const bill = billPhotos.find(b => b.r2_key === key || b.r2_key === rawKey || (b.public_url && b.public_url.includes(key)));
      let stockistId = bill ? bill.stockist_id : null;
      if (!stockistId) {
        const match = key.match(/^bills\/([^\/]+)\//);
        if (match) stockistId = match[1];
      }
      if (!stockistId || stockistId !== callerStockist.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
  }

  const isMock = process.env.R2_MOCK === 'true' || !process.env.R2_ACCOUNT_ID;
  if (isMock) {
    const item = r2.mockGet(key) || r2.mockGet(rawKey);
    if (!item) {
      return res.status(404).json({ error: 'Bill photo not found' });
    }
    res.setHeader('Content-Type', item.contentType || 'image/jpeg');
    return res.send(item.buffer);
  }

  try {
    const signedUrl = await r2.getSignedReadUrl(key, 3600);
    return res.redirect(signedUrl);
  } catch (err) {
    console.error('Failed to retrieve signed read URL for bill photo:', err);
    return res.status(404).json({ error: 'bill_not_found', message: 'Bill photo not found.' });
  }
});

// GET /api/images/* — serve mock product image or redirect to signed URL
app.get('/api/images/*', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const defaultPlaceholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1e293b"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="16">Product Image</text></svg>`;

  const rawKey = req.params[0];
  if (!rawKey) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(200).send(defaultPlaceholderSvg);
  }
  const key = decodeURIComponent(rawKey);

  const isMock = process.env.R2_MOCK === 'true' || !process.env.R2_ACCOUNT_ID;
  if (isMock) {
    const item = r2.mockGet(key) || r2.mockGet(rawKey);
    if (!item) {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.status(200).send(defaultPlaceholderSvg);
    }
    res.setHeader('Content-Type', item.contentType || 'image/jpeg');
    return res.send(item.buffer);
  }

  try {
    const signedUrl = await r2.getSignedReadUrl(key, 3600);
    return res.redirect(signedUrl);
  } catch (err) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(200).send(defaultPlaceholderSvg);
  }
});
}

module.exports = { registerBillsImagesRoutes };
