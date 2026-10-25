// ConfirmModal.tsx - Themed replacement for window.confirm()/alert(), so
// destructive-action confirmations and error messages stay inside the app's
// own glass UI instead of breaking out to a native browser dialog.
import React from 'react';
import { useBackHandler } from '../services/backStack';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel,
  danger,
  onConfirm,
  onCancel
}) => {
  useBackHandler(open, () => (onCancel ?? onConfirm)());

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px'
      }}
      onClick={onCancel}
    >
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} />
      <div
        className="glass-panel animate-pop-in"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '320px',
          borderRadius: 'var(--radius-lg)',
          padding: '22px'
        }}
      >
        <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px', textAlign: 'center' }}>
          {title}
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '20px', textAlign: 'center' }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          {cancelLabel && (
            <button
              onClick={onCancel}
              className="interactive glass-pill"
              style={{
                flex: 1,
                padding: '11px',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                color: 'var(--text-primary)',
                fontSize: '14px',
                fontWeight: 700
              }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            className="interactive"
            style={{
              flex: 1,
              padding: '11px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: danger ? 'var(--accent-danger)' : 'var(--accent-primary)',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 700
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
