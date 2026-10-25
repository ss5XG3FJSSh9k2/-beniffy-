import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import React from 'react'

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    const lastCrash = (() => {
      try {
        const stored = sessionStorage.getItem('beniffy_last_crash') || sessionStorage.getItem('fastnet_last_crash');
        return stored ? JSON.parse(stored) : null;
      } catch { return null; }
    })();
    this.state = { hasError: !!lastCrash, errorMsg: lastCrash?.errorMsg || '', stackLines: lastCrash?.stackLines || [] };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true };
  }
  componentDidCatch(error, errorInfo) {
    console.error("RootErrorBoundary caught an error:", error, errorInfo);
    
    const stackStr = (error && error.stack) ? error.stack : '';
    const stackLines = stackStr.split('\n').slice(0, 8);
    const errorMsg = error ? error.toString() : 'Unknown error';

    try {
      sessionStorage.setItem('beniffy_last_crash', JSON.stringify({ errorMsg, stackLines }));
    } catch {}

    this.setState({ errorMsg, stackLines });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif' }}>
          <div className="glass-card" style={{ maxWidth: '600px', margin: '2rem auto', padding: '2rem', borderRadius: '12px', textAlign: 'left' }}>
            <h2 style={{ color: 'var(--danger)', marginBottom: '1rem' }}>Something went wrong</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>A critical error occurred while rendering the application.</p>
            
            <details style={{ marginBottom: '2rem', padding: '1rem', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 'bold' }}>Show details</summary>
              <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#ff8888', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                <p><strong>{this.state.errorMsg}</strong></p>
                {this.state.stackLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </details>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <button className="btn btn-primary" onClick={() => {
                sessionStorage.removeItem('beniffy_last_crash');
                sessionStorage.removeItem('fastnet_last_crash');
                window.location.reload();
              }} style={{ padding: '0.75rem' }}>
                Reload
              </button>
              <button className="btn btn-secondary" onClick={() => {
                localStorage.removeItem('currentUser');
                localStorage.removeItem('token');
                localStorage.removeItem('beniffy_partner_session');
                localStorage.removeItem('fastnet_partner_session');
                localStorage.removeItem('beniffy_carts');
                localStorage.removeItem('fastnet_carts');
                sessionStorage.removeItem('beniffy_last_crash');
                sessionStorage.removeItem('fastnet_last_crash');
                window.location.reload();
              }} style={{ padding: '0.75rem' }}>
                Reset session and reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
