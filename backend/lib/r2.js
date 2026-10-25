const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const MOCK_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(MOCK_DIR)) fs.mkdirSync(MOCK_DIR, { recursive: true });

const mockStore = new Map();

function mockKeyToPath(key) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(MOCK_DIR, safe);
}

function mockPut(key, buffer, contentType) {
  const filePath = mockKeyToPath(key);
  fs.writeFileSync(filePath, buffer);
  const meta = { contentType, uploadedAt: new Date().toISOString(), filePath };
  mockStore.set(key, meta);
  return meta;
}

function mockGet(key) {
  let meta = mockStore.get(key);
  const filePath = mockKeyToPath(key);
  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath);
    const contentType = meta?.contentType || guessContentType(filePath);
    return { buffer, contentType };
  }
  if (meta && meta.buffer) return meta; // For seeded buffer
  return null;
}

function guessContentType(fp) {
  if (fp.endsWith('.png')) return 'image/png';
  if (fp.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

// Seed initial bill photo key for mock mode testing (valid 1x1 JPEG)
mockStore.set('bills/s1/1785518400112-d6ez17.jpg', {
  buffer: Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'),
  contentType: 'image/jpeg',
  uploadedAt: '2026-08-01T00:00:00.000Z'
});

function isR2Configured() {
  if (process.env.R2_MOCK === 'false') {
    return Boolean(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME
    );
  }
  return true;
}

function isMockMode() {
  if (process.env.R2_MOCK === 'false') return false;
  if (process.env.R2_MOCK === 'true') return true;
  return !Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

function getExt(contentType) {
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  return '.jpg';
}

function getS3Client() {
  if (!process.env.R2_ACCOUNT_ID) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

async function uploadBillPhoto(buffer, contentType, keyPrefix = 'bills') {
  if (!isR2Configured()) {
    throw new Error('R2 is not configured and R2_MOCK is not enabled');
  }

  const ext = getExt(contentType);
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now();
  const cleanPrefix = keyPrefix.replace(/^\/+|\/+$/g, '');
  const key = `${cleanPrefix}/${timestamp}-${randomSuffix}${ext}`;

  const publicBase = (process.env.R2_PUBLIC_URL_BASE || 'https://pub-mock.r2.dev').replace(/\/+$/, '');
  const publicUrl = `${publicBase}/${key}`;

  if (isMockMode()) {
    mockPut(key, buffer, contentType);
    return { key, publicUrl };
  }

  const s3 = getS3Client();
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3.send(command);
  return { key, publicUrl };
}

async function getSignedReadUrl(key, expirySeconds = 3600) {
  const publicBase = (process.env.R2_PUBLIC_URL_BASE || 'https://pub-mock.r2.dev').replace(/\/+$/, '');

  if (process.env.R2_MOCK === 'true' || !process.env.R2_ACCOUNT_ID) {
    const exp = Date.now() + expirySeconds * 1000;
    return `${publicBase}/${key}?signed=true&expires=${exp}`;
  }

  const s3 = getS3Client();
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key
  });

  return await getSignedUrl(s3, command, { expiresIn: expirySeconds });
}

module.exports = {
  isR2Configured,
  isMockMode,
  uploadBillPhoto,
  getSignedReadUrl,
  mockStore,
  mockGet,
  mockPut
};
