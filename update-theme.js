const fs = require('fs');

// 1. Process index.css
let css = fs.readFileSync('frontend/src/index.css', 'utf8');

// Replace Root Variables
const themeVars = `
:root, [data-theme='light'] {
  --ui-scale: 1;
  --font-sans: 'Noto Sans', 'Noto Sans Bengali', 'Noto Sans Devanagari', system-ui, -apple-system, sans-serif;
  --font-display: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  
  --bg-main: #FDF0D5;
  --bg-surface: #F4E4C4;
  --bg-surface-elevated: #EBD6B0;
  --border-color: #DABF94;
  
  --z-modal: 1000;
  --z-toast: 2000;

  --primary: #61210F;
  --primary-glow: rgba(97, 33, 15, 0.15);
  --secondary: #61210F;
  --secondary-glow: rgba(97, 33, 15, 0.15);
  --accent: #10B981;
  --accent-glow: rgba(16, 185, 129, 0.15);
  --warning: #F59E0B;
  --warning-glow: rgba(245, 158, 11, 0.15);
  --danger: #EF4444;
  --success-color: #10B981;
  --danger-color: #EF4444;
  --success: #10B981;
  
  --text-main: #61210F;
  --text-muted: #8F5545;
  --text-dark: #FDF0D5;
  
  --transition-fast: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-normal: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

[data-theme='dark'] {
  --bg-main: #20201F;
  --bg-surface: #2A2A29;
  --bg-surface-elevated: #363635;
  --border-color: #4A4A49;
  
  --primary: #EE6E4D;
  --primary-glow: rgba(238, 110, 77, 0.15);
  --secondary: #EE6E4D;
  --secondary-glow: rgba(238, 110, 77, 0.15);
  --accent: #10B981;
  --accent-glow: rgba(16, 185, 129, 0.15);
  --warning: #F59E0B;
  --warning-glow: rgba(245, 158, 11, 0.15);
  --danger: #EF4444;
  --success-color: #10B981;
  --danger-color: #EF4444;
  --success: #10B981;
  
  --text-main: #FDF0D5;
  --text-muted: #C5BBA4;
  --text-dark: #20201F;
}
`;

// Replace the old :root with the new theme logic
css = css.replace(/:root\s*\{[\s\S]*?--transition-normal[^}]*\}/, themeVars);

// Remove gradients
css = css.replace(/background:\s*linear-gradient\([^;]*\);/g, 'background: var(--primary);');
css = css.replace(/background-image:\s*radial-gradient\([^;]*\);/g, 'background-image: none;');
css = css.replace(/background:\s*linear-gradient\(180deg, #22293F 0%, #151A29 100%\);/g, 'background: var(--bg-surface-elevated);');
css = css.replace(/background:\s*linear-gradient\(135deg, rgba\(99, 102, 241, 0\.1\) 0%, rgba\(236, 72, 153, 0\.1\) 100%\);/g, 'background: var(--bg-surface);');
css = css.replace(/background:\s*linear-gradient\(135deg, var\(--primary\), var\(--secondary\)\);/g, 'background: var(--primary);');

// Apply 8px border radii where specified
css = css.replace(/\.cookie-btn-accept\s*\{[^}]*border-radius:\s*6px/g, match => match.replace('6px', '8px'));
css = css.replace(/\.cookie-btn-decline\s*\{[^}]*border-radius:\s*6px/g, match => match.replace('6px', '8px'));
css = css.replace(/\.role-switcher\s*\{[^}]*border-radius:\s*2rem/g, match => match.replace('2rem', '8px'));
css = css.replace(/\.role-tab\s*\{[^}]*border-radius:\s*1\.5rem/g, match => match.replace('1.5rem', '8px'));
css = css.replace(/\.btn\s*\{[^}]*border-radius:\s*0\.5rem/g, match => match.replace('0.5rem', '8px'));
css = css.replace(/\.admin-nav-item\s*\{[^}]*border-radius:\s*0\.5rem/g, match => match.replace('0.5rem', '8px'));
css = css.replace(/\.net-btn\s*\{[^}]*border-radius:\s*4px/g, match => match.replace('4px', '8px'));

fs.writeFileSync('frontend/src/index.css', css, 'utf8');

// 2. Process App.jsx
let app = fs.readFileSync('frontend/src/App.jsx', 'utf8');

// Theme Toggle State
if (!app.includes('const [theme, setTheme]')) {
  app = app.replace('export default function App() {', `export default function App() {
  const [theme, setTheme] = React.useState(() => {
    try {
      const storedTheme = window.localStorage.getItem('theme');
      return storedTheme || 'light';
    } catch (e) {
      return 'light';
    }
  });
  
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('theme', theme);
    } catch (e) { }
  }, [theme]);
  
  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');
`);
}

// Add the Toggle Button
const headerToggle = `
            </div>
            <button 
              onClick={toggleTheme} 
              style={{ marginLeft: '1rem', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'var(--text-main)', padding: '0.25rem 0.5rem', borderRadius: '8px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'bold' }}
            >
              {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
            </button>
          </div>
`;
app = app.replace(/<\/div>\s*<\/div>\s*\{\/\*\s*Global Surface Switcher\s*\*\/\}/, headerToggle + '\n\n        {/* Global Surface Switcher */}');

// Remove hard-coded colors
app = app.replace(/#ec4899/gi, 'var(--primary)');
app = app.replace(/#6366F1/gi, 'var(--primary)');
app = app.replace(/#6366f1/gi, 'var(--primary)');
app = app.replace(/rgba\(236,\s*72,\s*153,\s*0\.15\)/g, 'var(--primary-glow)');

// Replace em-dashes (—)
// First, placeholder values
app = app.replace(/'—'/g, "'-'");
// Second, in user-visible sentence text
app = app.replace(/optional — you can add/g, "optional, you can add");
app = app.replace(/वैकल्पिक — आप इसे/g, "वैकल्पिक, आप इसे");
app = app.replace(/ঐচ্ছিক — আপনি/g, "ঐচ্ছিক, আপনি");
app = app.replace(/Not set — delivery off/g, "Not set. Delivery off");
app = app.replace(/Round P3 —/g, "Round P3 -");
app = app.replace(/configured — pass/g, "configured. Pass");

fs.writeFileSync('frontend/src/App.jsx', app, 'utf8');
console.log('Script done.');
