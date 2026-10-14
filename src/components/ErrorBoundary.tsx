// ErrorBoundary.tsx - Last line of defence: a render error anywhere shows a
// recoverable screen instead of a blank WebView.
import React from 'react';

interface State { failed: boolean }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[ErrorBoundary] render failed:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '32px',
        textAlign: 'center', background: 'var(--bg-main)', color: 'var(--text-primary)'
      }}>
        <h1 style={{ fontSize: '20px', fontWeight: 800 }}>Something went wrong</h1>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '300px', lineHeight: 1.5 }}>
          AniStream hit an unexpected problem. Your history and My List are safe.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '12px 28px', borderRadius: '6px', border: 'none',
            background: '#fff', color: '#000', fontSize: '15px', fontWeight: 800
          }}
        >
          Restart
        </button>
      </div>
    );
  }
}
