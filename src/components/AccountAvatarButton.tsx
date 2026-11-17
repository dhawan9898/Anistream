// AccountAvatarButton.tsx - Small YouTube-style profile / login button that opens the Account & Cloud Sync modal.
import React, { useEffect, useState } from 'react';
import { User, X } from 'lucide-react';
import { cloud } from '../services/cloudAccount.ts';
import type { CloudStatus } from '../services/cloudSync.ts';
import { CloudAccountCard } from './CloudAccountCard.tsx';
import { hapticLight } from '../services/hapticsService.ts';

export const AccountAvatarButton: React.FC<{ size?: number; className?: string }> = ({ size = 36, className = '' }) => {
  const [status, setStatus] = useState<CloudStatus>(cloud.getStatus());
  const [open, setOpen] = useState(false);

  useEffect(() => cloud.subscribe(setStatus), []);

  if (!status.configured) return null;

  const emailInitial = status.user?.email ? status.user.email.charAt(0).toUpperCase() : null;

  return (
    <>
      <button
        onClick={() => { hapticLight(); setOpen(true); }}
        className={`interactive glass-pill-dark ${className}`}
        aria-label={status.user ? `Account (${status.user.email})` : 'Sign In'}
        title={status.user ? `Account: ${status.user.email}` : 'Sign In'}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          padding: 0,
          background: status.user ? 'linear-gradient(135deg, #e50914, #b81d24)' : undefined,
          border: status.user ? '1.5px solid rgba(255,255,255,0.4)' : undefined,
          boxShadow: status.user ? '0 2px 8px rgba(229,9,20,0.4)' : undefined,
          flexShrink: 0
        }}
      >
        {status.user ? (
          <span style={{ fontSize: '15px', fontWeight: 800, lineHeight: 1 }}>{emailInitial}</span>
        ) : (
          <User size={18} />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            animation: 'fadeIn 0.2s ease-out'
          }}
          onClick={e => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '400px',
              borderRadius: 'var(--radius-xl, 20px)',
              padding: '22px',
              border: '1px solid var(--border-subtle)',
              boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
              animation: 'popIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <h3 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                {status.user ? 'Account & Sync' : 'Sign In'}
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="interactive"
                aria-label="Close"
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.08)',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer'
                }}
              >
                <X size={16} />
              </button>
            </div>

            <CloudAccountCard embedded />
          </div>
        </div>
      )}
    </>
  );
};
