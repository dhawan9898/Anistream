// ErrorState.tsx - Inline "couldn't load" panel with a retry button, shown
// wherever content failed to load instead of placeholder or fake data.
import React from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry, compact }) => (
  <div
    role="alert"
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      padding: compact ? '20px 16px' : '48px 24px',
      textAlign: 'center',
      color: 'var(--text-muted)'
    }}
  >
    <WifiOff size={compact ? 24 : 32} />
    <p style={{ fontSize: '14px', lineHeight: 1.5, maxWidth: '320px', color: 'var(--text-primary)' }}>{message}</p>
    {onRetry && (
      <button
        onClick={onRetry}
        className="interactive"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '10px 20px',
          borderRadius: '999px',
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          fontSize: '13px',
          fontWeight: 700
        }}
      >
        <RefreshCw size={14} />
        Try again
      </button>
    )}
  </div>
);
