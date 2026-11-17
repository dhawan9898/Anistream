// CloudAccountCard.tsx - Settings & Profile: sign in to sync history, My List and settings between devices.
import React, { useEffect, useState } from 'react';
import { Cloud, RefreshCw, LogOut, KeyRound, ArrowLeft, Send } from 'lucide-react';
import { cloud } from '../services/cloudAccount.ts';
import type { CloudStatus } from '../services/cloudSync.ts';

const field: React.CSSProperties = {
  width: '100%',
  padding: '11px 12px',
  borderRadius: '10px',
  border: '1px solid var(--border-subtle)',
  background: 'rgba(255,255,255,0.06)',
  color: 'var(--text-primary)',
  fontSize: '14px',
  outline: 'none'
};

const button = (primary: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '11px 12px',
  borderRadius: '10px',
  fontSize: '13px',
  fontWeight: 700,
  cursor: 'pointer',
  border: primary ? 'none' : '1px solid var(--border-subtle)',
  background: primary ? 'var(--accent-primary)' : 'rgba(255,255,255,0.08)',
  color: primary ? '#fff' : 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px'
});

function ago(at: number | null): string {
  if (!at) return 'not synced yet';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return 'synced just now';
  if (min < 60) return `synced ${min} min ago`;
  return `synced ${new Date(at).toLocaleString()}`;
}

/** `spacing`: space below the card, for screens whose sections carry their own bottom margin. */
export const CloudAccountCard: React.FC<{ spacing?: number; embedded?: boolean }> = ({ spacing = 0, embedded = false }) => {
  const [status, setStatus] = useState<CloudStatus>(cloud.getStatus());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [showOtp, setShowOtp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => cloud.subscribe(setStatus), []);

  if (!status.configured) return null;

  const run = async (action: 'in' | 'up') => {
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setMessage('Enter a valid email address.'); return; }
    if (password.length < 6) { setMessage('The password needs at least 6 characters.'); return; }
    setBusy(true);
    setMessage(null);
    try {
      if (action === 'in') {
        await cloud.signIn(email, password);
        setPassword('');
      } else {
        const { needsConfirmation } = await cloud.signUp(email, password);
        if (needsConfirmation) {
          setShowOtp(true);
          setMessage('Confirmation email sent! Enter the 6-digit code or paste it below.');
        } else {
          setPassword('');
        }
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setMessage('Enter your email address.'); return; }
    if (!otpCode.trim()) { setMessage('Enter the 6-digit code from your email.'); return; }
    setBusy(true);
    setMessage(null);
    try {
      await cloud.verifyOtp(email, otpCode.trim());
      setShowOtp(false);
      setOtpCode('');
      setPassword('');
      setMessage(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Invalid or expired code. Try again or resend.');
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setMessage('Enter your email address.'); return; }
    setBusy(true);
    setMessage(null);
    try {
      await cloud.resendOtp(email);
      setMessage('A new confirmation code has been sent to your email.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not resend code. Try again later.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={spacing ? { marginBottom: `${spacing}px` } : undefined}>
      {!embedded && (
        <h3 style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 4px 8px' }}>
          Account &amp; Sync
        </h3>
      )}
      <div className={embedded ? '' : 'glass-panel'} style={{ borderRadius: 'var(--radius-lg)', padding: embedded ? '4px 0' : '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            background: status.user ? 'linear-gradient(135deg, #e50914, #b81d24)' : 'rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 800,
            fontSize: status.user ? '17px' : '14px',
            flexShrink: 0
          }}>
            {status.user ? status.user.email.charAt(0).toUpperCase() : <Cloud size={19} color="var(--accent-primary)" />}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status.user ? status.user.email : 'Sync between devices'}
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {status.user
                ? (status.syncing ? 'Syncing now…' : ago(status.lastSyncedAt))
                : 'Sign in to keep your history, My List and preferences in sync across your devices.'}
            </p>
          </div>
        </div>

        {status.user ? (
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button className="interactive" style={button(true)} disabled={status.syncing} onClick={() => void cloud.syncNow()}>
              <RefreshCw size={14} className={status.syncing ? 'animate-spin' : ''} />
              {status.syncing ? 'Syncing...' : 'Sync now'}
            </button>
            <button className="interactive" style={button(false)} onClick={() => void cloud.signOut()}>
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        ) : showOtp ? (
          <form onSubmit={e => { e.preventDefault(); void handleVerifyOtp(); }} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              Enter the 6-digit verification code sent to <strong>{email}</strong>:
            </p>
            <input
              style={{ ...field, textAlign: 'center', letterSpacing: '4px', fontSize: '18px', fontWeight: 700 }}
              type="text"
              autoFocus
              maxLength={8}
              placeholder="123456"
              value={otpCode}
              onChange={e => setOtpCode(e.target.value)}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="interactive" style={button(true)} disabled={busy}>
                <KeyRound size={14} />
                {busy ? 'Verifying…' : 'Verify & Sign In'}
              </button>
              <button type="button" className="interactive" style={button(false)} disabled={busy} onClick={() => void handleResend()}>
                <Send size={14} />
                Resend
              </button>
            </div>
            <button
              type="button"
              className="interactive"
              onClick={() => { setShowOtp(false); setMessage(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', padding: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
            >
              <ArrowLeft size={13} /> Back to Sign In
            </button>
          </form>
        ) : (
          <form onSubmit={e => { e.preventDefault(); void run('in'); }} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input style={field} type="email" autoComplete="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
            <input style={field} type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="interactive" style={button(true)} disabled={busy}>
                {busy ? 'Please wait…' : 'Sign in'}
              </button>
              <button type="button" className="interactive" style={button(false)} disabled={busy} onClick={() => void run('up')}>
                Create account
              </button>
            </div>
            <button
              type="button"
              className="interactive"
              onClick={() => { setShowOtp(true); setMessage(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', padding: '4px', textAlign: 'center', cursor: 'pointer', marginTop: '2px' }}
            >
              Have a confirmation code? Verify here
            </button>
          </form>
        )}

        {(message || status.error) && (
          <p role="status" style={{ fontSize: '12px', color: message && !status.error ? 'var(--accent-primary)' : 'var(--accent-danger)', marginTop: '10px', lineHeight: 1.4 }}>
            {message ?? `Sync notice: ${status.error}`}
          </p>
        )}
      </div>
    </div>
  );
};
