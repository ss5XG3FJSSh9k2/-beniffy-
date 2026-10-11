import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function getDeclaredIdentifiers(pattern) {
  const names = [];
  if (!pattern) return names;
  if (pattern.type === 'Identifier') {
    names.push({ name: pattern.name, loc: pattern.loc });
  } else if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach(el => {
      if (el) names.push(...getDeclaredIdentifiers(el));
    });
  } else if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach(prop => {
      if (prop.type === 'Property') {
        names.push(...getDeclaredIdentifiers(prop.value));
      } else if (prop.type === 'RestElement') {
        names.push(...getDeclaredIdentifiers(prop.argument));
      }
    });
  } else if (pattern.type === 'AssignmentPattern') {
    names.push(...getDeclaredIdentifiers(pattern.left));
  } else if (pattern.type === 'RestElement') {
    names.push(...getDeclaredIdentifiers(pattern.argument));
  }
  return names;
}

function getDepIdentifiers(node) {
  const names = [];
  function visit(n) {
    if (!n) return;
    if (n.type === 'Identifier') {
      names.push({ name: n.name, loc: n.loc });
    } else if (n.type === 'MemberExpression') {
      visit(n.object);
    } else if (n.type === 'ChainExpression') {
      visit(n.expression);
    } else if (n.type === 'UnaryExpression') {
      visit(n.argument);
    } else if (n.type === 'BinaryExpression' || n.type === 'LogicalExpression') {
      visit(n.left);
      visit(n.right);
    } else if (n.type === 'ConditionalExpression') {
      visit(n.test);
      visit(n.consequent);
      visit(n.alternate);
    } else if (n.type === 'CallExpression') {
      visit(n.callee);
      n.arguments.forEach(visit);
    }
  }
  visit(node);
  return names;
}

const violations = [];

function checkBlock(blockNode) {
  const decls = new Map();
  const hooks = [];

  blockNode.body.forEach((stmt, idx) => {
    if (stmt.type === 'VariableDeclaration') {
      stmt.declarations.forEach(d => {
        getDeclaredIdentifiers(d.id).forEach(ident => {
          if (!decls.has(ident.name)) {
            decls.set(ident.name, { index: idx, loc: ident.loc });
          }
        });
      });
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      if (!decls.has(stmt.id.name)) {
        decls.set(stmt.id.name, { index: idx, loc: stmt.id.loc });
      }
    }

    function findHooks(n) {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'CallExpression') {
        const callee = n.callee;
        const name = callee.type === 'Identifier' ? callee.name :
          (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' ? callee.property.name : null);
        if (['useEffect', 'useMemo', 'useCallback'].includes(name)) {
          const depArg = n.arguments[1];
          if (depArg && depArg.type === 'ArrayExpression') {
            hooks.push({ hookName: name, index: idx, loc: n.loc, depsNode: depArg });
          }
        }
      }
      for (const k in n) {
        if (k !== 'parent') {
          const child = n[k];
          if (Array.isArray(child)) child.forEach(findHooks);
          else findHooks(child);
        }
      }
    }
    findHooks(stmt);
  });

  hooks.forEach(hook => {
    hook.depsNode.elements.forEach(el => {
      getDepIdentifiers(el).forEach(dep => {
        const decl = decls.get(dep.name);
        if (decl && decl.index > hook.index) {
          violations.push({
            hook: hook.hookName,
            hookLine: hook.loc.start.line,
            dep: dep.name,
            depLine: dep.loc.start.line,
            declLine: decl.loc.start.line
          });
        }
      });
    });
  });
}

function walk(node) {
  if (!node || typeof node !== 'object') return;
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
      node.body && node.body.type === 'BlockStatement') {
    checkBlock(node.body);
  }
  for (const k in node) {
    if (k !== 'parent') {
      const child = node[k];
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  }
}

walk(ast);

if (violations.length > 0) {
  console.error(`\n❌ check-hook-deps FAILED: Found ${violations.length} hook dependency TDZ violation(s) in App.jsx:\n`);
  violations.forEach(v => {
    console.error(`  - ${v.hook} at line ${v.hookLine}: dependency '${v.dep}' (line ${v.depLine}) is declared later at line ${v.declLine}`);
  });
  process.exit(1);
}

console.log('✓ check-hook-deps: All hook dependencies in App.jsx are declared before use.');
process.exit(0);
