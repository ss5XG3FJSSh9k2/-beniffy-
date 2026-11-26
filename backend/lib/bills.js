
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const uploadBillMiddleware = (req, res, next) => {
  upload.fields([
    { name: 'bill_photo', maxCount: 1 },
    { name: 'billFile', maxCount: 1 },
    { name: 'imageFile', maxCount: 1 },
    { name: 'image', maxCount: 1 },
    { name: 'image_file', maxCount: 1 },
    { name: 'documentPhoto', maxCount: 1 },
    { name: 'document_photo', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large', message: 'File exceeds size limit.' });
      }
      console.error('File upload error:', err);
      return res.status(400).json({ error: 'upload_error', message: 'Failed to upload file.' });
    }
    if (req.files) {
      const bFile = (req.files['bill_photo'] && req.files['bill_photo'][0]) ||
                    (req.files['billFile'] && req.files['billFile'][0]) ||
                    (req.files['documentPhoto'] && req.files['documentPhoto'][0]) ||
                    (req.files['document_photo'] && req.files['document_photo'][0]) ||
                    (req.files['imageFile'] && req.files['imageFile'][0]) ||
                    (req.files['image'] && req.files['image'][0]) ||
                    (req.files['image_file'] && req.files['image_file'][0]);
      if (bFile) req.file = bFile;
    }
    next();
  });
};

function hasValidKycSignature(req) {
  const { expires, sig } = req.query;
  if (!expires || !sig) return false;
  if (!/^\d+$/.test(expires)) return false;
  if (!/^[a-f0-9]{64}$/.test(sig)) return false;
  if (Date.now() > Number(expires)) return false;
  const crypto = require('crypto');
  const sessionHelper = require('./session');
  const expected = crypto.createHmac('sha256', sessionHelper.getSecret()).update(req.path + ':' + expires).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(sig, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function signBillUrl(r2KeyOrUrl, ttlSeconds = 3600) {
  if (!r2KeyOrUrl) return null;
  let raw = String(r2KeyOrUrl).trim();
  let billPath = raw;
  if (!billPath.startsWith('/')) {
    if (billPath.startsWith('http://') || billPath.startsWith('https://')) {
      try {
        const u = new URL(billPath);
        billPath = u.pathname;
      } catch (e) {}
    }
    if (!billPath.startsWith('/api/bills/')) {
      if (billPath.startsWith('/bills/')) {
        billPath = `/api${billPath}`;
      } else {
        billPath = `/api/bills/${billPath.replace(/^\/+/, '')}`;
      }
    }
  } else if (!billPath.startsWith('/api/bills/')) {
    if (billPath.startsWith('/bills/')) {
      billPath = `/api${billPath}`;
    } else {
      billPath = `/api/bills${billPath}`;
    }
  }

  const pathPart = billPath.split('?')[0];
  const crypto = require('crypto');
  const sessionHelper = require('./session');
  const expires = Date.now() + (ttlSeconds * 1000);
  const sig = crypto.createHmac('sha256', sessionHelper.getSecret()).update(pathPart + ':' + expires).digest('hex');
  return `${pathPart}?expires=${expires}&sig=${sig}`;
}

function signBillRow(b) {
  if (!b) return b;
  const signed = { ...b };
  const keyToSign = b.r2_key || b.public_url;
  signed.public_url = signBillUrl(keyToSign);
  return signed;
}

function hasValidBillSignature(req) {
  const { expires, sig } = req.query;
  if (!expires && !sig) return { hasSig: false, valid: false };
  if (!expires || !sig || !/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/.test(sig)) {
    return { hasSig: true, valid: false, error: 'invalid_signature', code: 401 };
  }
  if (Date.now() > Number(expires)) {
    return { hasSig: true, valid: false, error: 'signature_expired', code: 403 };
  }
  const crypto = require('crypto');
  const sessionHelper = require('./session');
  const pathPart = (req.path || req.originalUrl?.split('?')[0]);
  const expected = crypto.createHmac('sha256', sessionHelper.getSecret()).update(pathPart + ':' + expires).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(sig, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { hasSig: true, valid: false, error: 'invalid_signature', code: 401 };
  }
  return { hasSig: true, valid: true };
}

module.exports = {
  upload,
  uploadBillMiddleware,
  hasValidKycSignature,
  signBillUrl,
  signBillRow,
  hasValidBillSignature
};
