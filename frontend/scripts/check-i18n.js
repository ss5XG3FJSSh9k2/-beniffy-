import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicit allowlist of strings that may be identical across en, hi, and bn
// (brand names, codes, numbers, symbols, emails, phones, URLs).
const ALLOWLIST = [
  'Beniffy',
  'FastNet',
  'KYC',
  'OTP',
  'GST',
  'UPI',
  'COD',
  'ISP',
  'PIN',
  'IFSC',
  'PAN',
  'ID',
  'OK',
  '₹',
  '%',
  '→',
  '•',
  '-',
  '—',
  'N/A'
];

const isAllowedIdentical = (str) => {
  const trimmed = str.trim();
  if (!trimmed) return true;
  if (ALLOWLIST.includes(trimmed)) return true;
  // Pure numbers, symbols, punctuation, or whitespace
  if (/^[\d\s₹%+\-.,:/()•→—]+$/.test(trimmed)) return true;
  // Email address
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  // URL
  if (/^https?:\/\/\S+$/.test(trimmed)) return true;
  // Phone number (e.g. +91... or 10-digit)
  if (/^\+?[\d\s\-()]{7,15}$/.test(trimmed)) return true;
  // Short uppercase code (2-6 chars)
  if (/^[A-Z0-9_-]{2,6}$/.test(trimmed)) return true;
  return false;
};

let espree;
try {
  espree = require('espree');
} catch {
  try {
    espree = require(path.join(__dirname, '../node_modules/espree'));
  } catch {
    espree = require(path.join(__dirname, '../../frontend/node_modules/espree'));
  }
}

const targetFile = path.resolve(__dirname, '../src/App.jsx');
if (!fs.existsSync(targetFile)) {
  console.error(`Target file not found: ${targetFile}`);
  process.exit(1);
}

const code = fs.readFileSync(targetFile, 'utf8');
const ast = espree.parse(code, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  ecmaFeatures: { jsx: true },
  loc: true,
  range: true
});

function getStaticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

const violations = [];

function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }

  if (
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 't' &&
    node.arguments.length >= 3
  ) {
    const en = getStaticString(node.arguments[0]);
    const hi = getStaticString(node.arguments[1]);
    const bn = getStaticString(node.arguments[2]);

    if (en !== null && hi !== null && bn !== null && en === hi && hi === bn) {
      if (!isAllowedIdentical(en)) {
        violations.push({
          line: node.loc.start.line,
          text: en
        });
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const val = node[key];
    if (val && typeof val === 'object') {
      walk(val);
    }
  }
}

walk(ast);

if (violations.length > 0) {
  console.error(`✗ check-i18n: Found ${violations.length} untranslated t() call(s) with identical en/hi/bn strings:`);
  for (const v of violations) {
    console.error(`  frontend/src/App.jsx:${v.line} — ${JSON.stringify(v.text)}`);
  }
  process.exit(1);
}

console.log('✓ check-i18n: 0 violations (all t() calls in App.jsx have distinct translations).');
