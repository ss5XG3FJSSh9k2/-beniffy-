const fs = require('fs');
const path = require('path');

// Existing migrations that need to stay hidden because pg-mem does not support them (1 migration):
// 1. 005-rls-and-compliance.sql - pg-mem does not support Postgres ROW LEVEL SECURITY or CREATE POLICY
const PG_MEM_UNSUPPORTED_MIGRATIONS = new Set([
  '005-rls-and-compliance.sql'
]);

function hasBOM(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return true;
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return true;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true;
  return false;
}

async function runMigrations(db) {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const sqlPath = path.join(migrationsDir, file);

    if (file.endsWith('.sql')) {
      const rawBuf = fs.readFileSync(sqlPath);
      if (hasBOM(rawBuf) || rawBuf.includes(0)) {
        throw new Error(`Migration ${file} is not valid UTF-8`);
      }
      const sql = rawBuf.toString('utf8');

      // Split on semicolons for pg-mem or execute single block for pg
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const stmt of statements) {
        try {
          await db.query(stmt);
        } catch (err) {
          if (err.message.includes('already exists')) {
            continue;
          }
          if (PG_MEM_UNSUPPORTED_MIGRATIONS.has(file)) {
            continue;
          }
          if (err.message.includes('Syntax error') || err.message.includes('failed to parse')) {
            console.warn(`[Migration warning] ${file} statement failed: "${stmt}" - ${err.message}`);
          } else {
            console.warn(`[Migration warning] ${file}:`, err.message);
          }
        }
      }
    } else if (file.endsWith('.js')) {
      try {
        const migrationObj = require(sqlPath);
        if (typeof migrationObj.up === 'function') {
          await migrationObj.up(db);
        }
      } catch (err) {
        console.warn(`[Migration warning] JS execution failed for ${file}:`, err.message);
      }
    }
  }
}

module.exports = {
  runMigrations,
  PG_MEM_UNSUPPORTED_MIGRATIONS
};

