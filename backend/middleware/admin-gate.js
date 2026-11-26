const { requireAuth, requireRole } = require('../lib/authz');

module.exports = (req, res, next) => {
  const p = req.path;
  const isDevAllowed = process.env.SEED_MODE === 'test' || process.env.NODE_ENV !== 'production';

  // reset-db is handled by its dedicated controller with strict auth and dev-mode checks.
  if (p === '/reset-db') {
    return next();
  }

  // override-table exists only in explicit test mode.
  if (p === '/override-table') {
    if (!require('../lib/env').isTestEnv()) return res.status(404).json({ error: 'Not found' });
    return next();
  }

  // Developer and Inspector endpoints gated in production
  if (p === '/insert-table' || p === '/inspector' || p.startsWith('/inspector/') || p.startsWith('/db-inspector')) {
    if (!isDevAllowed) return res.status(403).json({ error: 'Forbidden', message: 'Endpoint disabled in production' });
    if (require('../lib/env').isTestEnv()) return next();
  }

  if (p === '/clear-rate-limits' && require('../lib/env').isTestEnv()) {
    return next();
  }

  // Apply authentication
  requireAuth(req, res, (err) => {
    if (err) return next(err);

    // Partner admins may work the partner-leads queue. Everything else under
    // /api/admin (KYC documents, platform analytics, vendors, user accounts)
    // is admin-only.
    if (p.startsWith('/partner-leads')) {
      return requireRole('ADMIN', 'PARTNER_ADMIN')(req, res, next);
    }

    return requireRole('ADMIN')(req, res, next);
  });
};
