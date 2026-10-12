const fs = require('fs');
let content = fs.readFileSync('backend/tests/regression.js', 'utf8');
content = content.replace(/'—'/g, "'-'");
content = content.replace(/render a — placeholder/g, 'render a - placeholder');
fs.writeFileSync('backend/tests/regression.js', content, 'utf8');
