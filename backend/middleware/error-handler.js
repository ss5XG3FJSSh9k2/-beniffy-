module.exports = (err, req, res, next) => {
  console.error('[Unhandled]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
};
