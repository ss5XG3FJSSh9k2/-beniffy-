const { spawn } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'dev';

process.env.SEED_MODE = 'test';
process.env.TEST_SUITE = 'true';
process.env.EMAIL_MOCK = 'true';
process.env.SMS_MOCK = 'true';
process.env.R2_MOCK = 'true';
delete process.env.DATABASE_URL;

console.log('====================================================');
console.log('                     BENIFFY                        ');
console.log('              TEST MODE INITIALIZED                 ');
console.log('====================================================');
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
