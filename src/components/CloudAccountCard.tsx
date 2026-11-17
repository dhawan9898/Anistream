// CloudAccountCard.tsx - Settings: sign in to sync history, My List and settings between devices.
import React, { useEffect, useState } from 'react';
import { Cloud, RefreshCw, LogOut } from 'lucide-react';
import { cloud } from '../services/cloudAccount.ts';
import type { CloudStatus } from '../services/cloudSync.ts';

const field: React.CSSProperties = {
  width: '100%', padding: '11px 12px', borderRadius: '10px', border: '1px solid var(--border-subtle)',
  background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', fontSize: '14px', outline: 'none'
};
const button = (primary: boolean): React.CSSProperties => ({
  flex: 1, padding: '11px 12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
  border: primary ? 'none' : '1px solid var(--border-subtle)',
  background: primary ? 'var(--accent-primary)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)'
});

function ago(at: number | null): string {
  if (!at) return 'not synced yet';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return 'synced just now';
  if (min < 60) return `synced ${min} min ago`;
  return `synced ${new Date(at).toLocaleString()}`;
}

/** `spacing`: space below the card, for screens whose sections carry their own bottom margin. */
export const CloudAccountCard: React.FC<{ spacing?: number }> = ({ spacing = 0 }) => {
  const [status, setStatus] = useState<CloudStatus>(cloud.getStatus());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => cloud.subscribe(setStatus), []);

  // Built without a sync server: nothing to offer.
  if (!status.configured) return null;

  const run = async (action: 'in' | 'up') => {
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setMessage('Enter your email address.'); return; }
    if (password.length < 6) { setMessage('The password needs at least 6 characters.'); return; }
    setBusy(true);
    setMessage(null);
    try {
      if (action === 'in') {
        await cloud.signIn(email, password);
      } else {
        const { needsConfirmation } = await cloud.signUp(email, password);
        if (needsConfirmation) setMessage('Account created. Open the confirmation email, then sign in here.');
      }
      setPassword('');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={spacing ? { marginBottom: `${spacing}px` } : undefined}>
      <h3 style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 4px 8px' }}>
        Account &amp; Sync
      </h3>
      <div className="glass-panel" style={{ borderRadius: 'var(--radius-lg)', padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          <Cloud size={18} color="var(--accent-primary)" />
          <div style={{ minWidth: 0 }}>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status.user ? status.user.email : 'Sync between devices'}
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {status.user
                ? (status.syncing ? 'Syncing…' : ago(status.lastSyncedAt))
                : 'Sign in to keep your history, My List and settings the same on every device.'}
            </p>
          </div>
        </div>

        {status.user ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="interactive" style={button(true)} disabled={status.syncing} onClick={() => void cloud.syncNow()}>
              <RefreshCw size={14} style={{ verticalAlign: '-2px', marginRight: '6px' }} />Sync now
            </button>
            <button className="interactive" style={button(false)} onClick={() => void cloud.signOut()}>
              <LogOut size={14} style={{ verticalAlign: '-2px', marginRight: '6px' }} />Sign out
            </button>
          </div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); void run('in'); }} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input style={field} type="email" autoComplete="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
            <input style={field} type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="interactive" style={button(true)} disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</button>
              <button type="button" className="interactive" style={button(false)} disabled={busy} onClick={() => void run('up')}>Create account</button>
            </div>
          </form>
        )}

        {(message || status.error) && (
          <p role="status" style={{ fontSize: '12px', color: message && !status.error ? 'var(--accent-primary)' : 'var(--accent-danger)', marginTop: '10px', lineHeight: 1.4 }}>
            {message ?? `Sync problem: ${status.error}`}
          </p>
        )}
      </div>
    </section>
  );
};
