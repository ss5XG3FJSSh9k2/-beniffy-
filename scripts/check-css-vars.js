const fs = require('fs');
const path = require('path');

function collectDefinedVars(cssPath) {
  const css = fs.readFileSync(cssPath, 'utf8');
  const defined = new Set();
  
  // Collect from :root, [data-theme='light'], [data-theme='dark'] blocks
  const themeBlockRegex = /(?::root|\[data-theme=['"](?:light|dark)['"]\])[\s\S]*?\{([\s\S]*?)\}/g;
  let match;
  while ((match = themeBlockRegex.exec(css)) !== null) {
    const blockContent = match[1];
    const varDefRegex = /(--[a-zA-Z0-9_-]+)\s*:/g;
    let varMatch;
    while ((varMatch = varDefRegex.exec(blockContent)) !== null) {
      defined.add(varMatch[1]);
    }
  }

  return defined;
}

function collectUsedVars(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const used = [];

  lines.forEach((line, index) => {
    const varUsageRegex = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
    let match;
    while ((match = varUsageRegex.exec(line)) !== null) {
      used.push({
        file: filePath,
        line: index + 1,
        name: match[1]
      });
    }
  });

  return used;
}

function findRepoRoot(startDir) {
  let curr = startDir;
  while (curr && curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, 'frontend', 'src', 'index.css'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(startDir, '..');
}

function checkCssVars() {
  const rootDir = findRepoRoot(__dirname);
  const indexCssPath = path.join(rootDir, 'frontend', 'src', 'index.css');
  const appJsxPath = path.join(rootDir, 'frontend', 'src', 'App.jsx');

  const defined = collectDefinedVars(indexCssPath);
  const used = [
    ...collectUsedVars(indexCssPath),
    ...collectUsedVars(appJsxPath)
  ];

  const undefinedHits = [];
  for (const item of used) {
    if (!defined.has(item.name)) {
      undefinedHits.push(item);
    }
  }

  return { defined, used, undefinedHits };
}

if (require.main === module) {
  const { undefinedHits } = checkCssVars();
  if (undefinedHits.length > 0) {
    console.error(`Found ${undefinedHits.length} undefined CSS variable usage(s):`);
    for (const hit of undefinedHits) {
      // Normalize path to relative with forward slashes for clean output
      const relPath = hit.file.replace(/\\/g, '/').replace(/^.*?frontend\//, 'frontend/');
      console.log(`${relPath}:${hit.line} ${hit.name}`);
    }
    process.exit(1);
  } else {
    console.log('✓ check-css-vars: All CSS variables used in index.css and App.jsx are defined in theme blocks.');
    process.exit(0);
  }
}

module.exports = { checkCssVars };
