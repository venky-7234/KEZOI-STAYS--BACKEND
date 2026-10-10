const crypto = require('crypto');

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = (req, res, next) => {
  const configured = process.env.N8N_SERVICE_TOKEN;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!configured || !safeEqual(supplied, configured)) {
    return res.status(401).json({ success: false, message: 'Invalid service credential' });
  }
  req.service = { name: 'n8n', scopes: ['availability:read', 'enquiries:create'] };
  next();
};
