const TEST_PORT = process.env.TEST_PORT || '3002';
process.env.PORT = TEST_PORT;
process.env.POSTGRES_MODE = 'mem';
process.env.SEED_MODE = 'test';
process.env.ALLOW_DB_RESET = 'true';
const fs = require('fs');
const path = require('path');
const http = require('http');
const dbModule = require('../../db.js');
const sessionHelper = require('../../lib/session.js');

function resolveUrl(url) {
  const parsed = new URL(url);
  if (parsed.port === '3001' && TEST_PORT !== '3001') {
    parsed.port = TEST_PORT;
  }
  return parsed;
}

const origHttpGet = http.get;
http.get = function(url, options, cb) {
  if (typeof url === 'string') {
    return origHttpGet.call(http, resolveUrl(url).toString(), options, cb);
  }
  return origHttpGet.apply(http, arguments);
};

let currentToken = null;
function loginAs(userId, role) {
  currentToken = sessionHelper.signSession(userId, role);
}
function clearLogin() {
  currentToken = null;
}
function getCurrentToken() {
  return currentToken;
}
function setCurrentToken(token) {
  currentToken = token;
}

function postMultipart(url, fields, fileObj = { fieldName: 'bill_photo', filename: 'bill.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock jpeg data') }, method = 'POST', options = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const parsed = resolveUrl(url);

    let body = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        body.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
      }
    }

    if (fileObj) {
      body.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileObj.fieldName || 'bill_photo'}"; filename="${fileObj.filename || 'bill.jpg'}"\r\nContent-Type: ${fileObj.mime || 'image/jpeg'}\r\n\r\n`));
      body.push(Buffer.isBuffer(fileObj.buffer) ? fileObj.buffer : Buffer.from(fileObj.buffer || 'mock bill content'));
      body.push(Buffer.from('\r\n'));
    }

    body.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(body);

    const headers = Object.assign({
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': payload.length
    }, options.headers || {});
    if (currentToken && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + currentToken;

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: method,
      headers: headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function post(url, body, options = {}) {
  if (options.asMultipart || (url.includes('/api/products') && !options.rawJson)) {
    return postMultipart(url, body, options.fileObj || { fieldName: 'bill_photo', filename: 'bill.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock bill photo data') }, 'POST', options);
  }
  return new Promise((resolve, reject) => {
    const parsed = resolveUrl(url);
    const data = JSON.stringify(body || {});
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }, options.headers || {});
    if (currentToken && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + currentToken;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function patch(url, body, options = {}) {
  if (options.asMultipart || (url.includes('/api/products') && !options.rawJson && (body.price !== undefined || body.costPrice !== undefined || body.cost_price !== undefined))) {
    return postMultipart(url, body, options.fileObj || { fieldName: 'bill_photo', filename: 'bill.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock bill photo data') }, 'PATCH', options);
  }
  return new Promise((resolve, reject) => {
    const parsed = resolveUrl(url);
    const data = JSON.stringify(body || {});
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }, options.headers || {});
    if (currentToken && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + currentToken;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'PATCH',
      headers: headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = resolveUrl(url);
    const headers = Object.assign({}, options.headers || {});
    if (currentToken && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + currentToken;
    if (currentToken && !headers['Authorization']) headers['Authorization'] = `Bearer ${currentToken}`;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function del(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = resolveUrl(url);
    const headers = Object.assign({}, options.headers || {});
    if (currentToken && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + currentToken;
    if (currentToken && !headers['Authorization']) headers['Authorization'] = `Bearer ${currentToken}`;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'DELETE',
      headers: headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const state = {
  testCount: 0,
  passedCount: 0
};

function assert(condition, message) {
  state.testCount++;
  if (condition) {
    state.passedCount++;
    console.log(`[PASS] Test #${state.testCount}: ${message}`);
  } else {
    console.error(`[FAIL] Test #${state.testCount}: ${message}`);
    process.exit(1);
  }
}

function getCounts() {
  return { testCount: state.testCount, passedCount: state.passedCount };
}

function readBackendSource() {
  const backendRoot = path.resolve(__dirname, '../..');
  const files = [path.join(backendRoot, 'server.js')];
  const walkDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  };
  for (const sub of ['routes', 'middleware', 'services']) {
    walkDir(path.join(backendRoot, sub));
  }
  return files.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

module.exports = {
  TEST_PORT,
  fs,
  path,
  http,
  dbModule,
  sessionHelper,
  resolveUrl,
  loginAs,
  clearLogin,
  getCurrentToken,
  setCurrentToken,
  postMultipart,
  post,
  patch,
  get,
  del,
  state,
  assert,
  getCounts,
  readBackendSource
};
