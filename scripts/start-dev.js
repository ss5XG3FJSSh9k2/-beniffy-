const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const mode = process.argv[2] || 'dev';

if (mode === 'dev:seed') {
  process.env.SEED_MODE = 'test';
  process.env.TEST_SUITE = 'true';
} else {
  process.env.SEED_MODE = 'production';
  process.env.DEV_LAUNCHER = 'true';
}

process.env.EMAIL_MOCK = 'true';
process.env.SMS_MOCK = 'true';
process.env.R2_MOCK = 'true';
delete process.env.DATABASE_URL;

console.log('====================================================');
console.log('                 FASTNET LOYALTY                    ');
console.log('              DEV MODE INITIALIZED                  ');
console.log('====================================================');

if (mode === 'dev:seed') {
  console.log('Seeded accounts (OTP is always 123456):');
  console.log('- Admin: 9999999999');
  console.log('- Customer: 9876543210 (Amit Sen, region Garia, 50 points)');
  console.log('- Customer: 8765432109 (Radha Roy, region Bishnupur, 30 points)');
  console.log('- Stockist: 7654321098 (Madan Grocers, Garia)');
  console.log('- Stockist: 6543210987 (Sarkar Daily Store, Bishnupur)');
  console.log('- Stockist: 9432109876 (Banerjee Corner Store, Garia)');
  console.log('- Stockist (KYC pending): 8432109876 (Joy Kirana)');
  console.log('- Stockist (KYC pending): 8432109999 (Ramesh Store)');
  console.log('- Partner: 9876500000 (adhya@partners.example, password partner123)');
  console.log('- Partner: 9876500001 (jio@partners.example, password partner123)');
} else {
  const dbFile = path.join(__dirname, '../backend/data/dev-db.json');
  const secretFile = path.join(__dirname, '../backend/data/dev-jwt-secret');
  if (mode === 'dev:fresh') {
    if (fs.existsSync(dbFile)) {
      fs.unlinkSync(dbFile);
    }
    if (fs.existsSync(secretFile)) {
      fs.unlinkSync(secretFile);
    }
    console.log('Empty start. Open the app and create the administrator.');
    // Testers log in with the demo OTP 123456. Remove this line to use the
    // random codes printed in this console instead.
    process.env.DEMO_OTP = 'true';
  } else {
    if (fs.existsSync(dbFile)) {
      console.log('Loaded saved data.');
    } else {
      console.log('Empty start. Open the app and create the administrator.');
    }
  }
  console.log(process.env.DEMO_OTP === 'true'
    ? 'Login OTP is always 123456 (demo mode).'
    : 'Login OTPs are random; the mock SMS/email lines below show each code.');
}
console.log('====================================================');

if (mode === 'backend') {
  require('../backend/server.js');
} else {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const backend = spawn(process.execPath, [path.join(__dirname, '../backend/server.js')], { stdio: 'inherit', env: process.env });
  const frontend = spawn(npmCmd, ['run', 'frontend'], { stdio: 'inherit', env: process.env, cwd: path.join(__dirname, '..'), shell: process.platform === 'win32' });

  const shutdown = () => {
    backend.kill();
    frontend.kill();
    process.exit();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
