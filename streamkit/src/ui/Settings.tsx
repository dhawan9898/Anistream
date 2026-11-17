// Settings.tsx - The building blocks of the Settings screen, shared by AniStream and CineStream (and
// copied in Compose by Mangapill's ui/components/Kit.kt), so all three screens look and read alike:
// an upper-case section label, a rounded card, and rows of [icon] title / one-line hint [trailing].
import React from 'react';

export const SettingsSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section style={{ marginBottom: '26px' }}>
    <h2 style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', margin: '0 4px 10px' }}>
      {title}
    </h2>
    <div className="glass-panel" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      {children}
    </div>
  </section>
);

const divider: React.CSSProperties = { borderTop: '1px solid var(--border-subtle)' };

export const SettingsIcon: React.FC<{ danger?: boolean; children: React.ReactNode }> = ({ danger, children }) => (
  <div style={{
    width: '36px', height: '36px', borderRadius: 'var(--radius-sm)', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: danger ? 'var(--accent-danger-bg)' : 'var(--accent-soft, rgba(229, 9, 20, 0.14))',
    color: danger ? 'var(--accent-danger)' : 'var(--accent-primary)'
  }}>
    {children}
  </div>
);

export interface SettingsRowProps {
  icon: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Every row but the first in a card draws a line above itself. */
  first?: boolean;
}

/** One line of a card. With onClick it is a button; without, plain information. */
export const SettingsRow: React.FC<SettingsRowProps> = ({ icon, title, hint, trailing, onClick, danger, disabled, first }) => {
  const clickable = !!onClick && !disabled;
  return (
    <div
      className={clickable ? 'interactive' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      style={{
        ...(first ? {} : divider),
        display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px',
        userSelect: 'none', opacity: disabled ? 0.45 : 1
      }}
    >
      <SettingsIcon danger={danger}>{icon}</SettingsIcon>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h4 style={{ fontSize: '15px', fontWeight: 700, color: danger ? 'var(--accent-danger)' : 'var(--text-primary)', letterSpacing: '-0.2px' }}>{title}</h4>
        {hint != null && hint !== '' && (
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', lineHeight: 1.35 }}>{hint}</p>
        )}
      </div>
      {trailing}
    </div>
  );
};

/** The on/off switch shown at the end of a toggle row. */
export const Switch: React.FC<{ on: boolean; label: string }> = ({ on, label }) => (
  <div role="switch" aria-checked={on} aria-label={label} className={`toggle-switch ${on ? 'on' : ''}`} style={{ flexShrink: 0 }}>
    <div className="knob" />
  </div>
);

/** Text at the end of a row: a value ("720p", "12 items") or a size. */
export const RowValue: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({ children, accent }) => (
  <span style={{ fontSize: '13px', fontWeight: 600, color: accent ? 'var(--accent-primary)' : 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
    {children}
  </span>
);

export interface ChoiceRowProps<T extends string> {
  title: string;
  hint?: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onSelect: (id: T) => void;
  disabled?: boolean;
  first?: boolean;
}

/** A setting with a few fixed choices: its name, then a segmented control across the card. */
export function ChoiceRow<T extends string>({ title, hint, options, value, onSelect, disabled, first }: ChoiceRowProps<T>) {
  return (
    <div style={{ ...(first ? {} : divider), padding: '14px 16px 16px', opacity: disabled ? 0.45 : 1 }}>
      <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{title}</h4>
      {hint && <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', lineHeight: 1.35 }}>{hint}</p>}
      <div className="seg-track" style={{ marginTop: '12px' }}>
        {options.map(o => (
          <button
            key={o.id}
            disabled={disabled}
            onClick={() => onSelect(o.id)}
            className={`interactive seg-pill ${value === o.id ? 'active' : ''}`}
            style={{ padding: '8px 4px', fontSize: '13px' }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A short message under the rows of a card ("Backup saved", "Up to date"). */
export const SettingsNote: React.FC<{ children: React.ReactNode; tone?: 'accent' | 'danger' | 'plain' }> = ({ children, tone = 'accent' }) => (
  <div style={{
    ...divider, padding: '10px 16px', fontSize: '13px', fontWeight: 600, lineHeight: 1.4,
    background: tone === 'plain' ? 'transparent' : tone === 'danger' ? 'var(--accent-danger-bg)' : 'var(--accent-soft, rgba(229, 9, 20, 0.14))',
    color: tone === 'plain' ? 'var(--text-secondary)' : tone === 'danger' ? 'var(--accent-danger)' : 'var(--accent-primary)'
  }}>
    {children}
  </div>
);

export interface AvailableUpdate {
  version: string;
  apkUrl: string;
  size?: number;
  releaseNotes?: string;
  publishedAt?: string;
}

export interface UpdateRowsProps {
  appName: string;
  version: string;
  icon: React.ReactNode;
  installIcon: React.ReactNode;
  check: () => Promise<AvailableUpdate | null>;
  install: (apkUrl: string, onProgress: (pct: number) => void, size?: number) => Promise<void>;
  onTap?: () => void;
}

/** "Check for updates" as a row of the About card; a found update opens below it. */
export const UpdateRows: React.FC<UpdateRowsProps> = ({ appName, version, icon, installIcon, check, install, onTap }) => {
  const [info, setInfo] = React.useState<AvailableUpdate | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState<{ text: string; tone: 'accent' | 'danger' | 'plain' } | null>(null);

  const runCheck = async () => {
    if (checking || installing) return;
    onTap?.();
    setChecking(true);
    setStatus(null);
    try {
      const found = await check();
      setInfo(found);
      setStatus(found ? null : { text: `${appName} is up to date.`, tone: 'plain' });
    } catch (err) {
      setStatus({ text: `Could not check for updates: ${err instanceof Error ? err.message : 'network error'}`, tone: 'danger' });
    } finally {
      setChecking(false);
    }
  };

  const runInstall = async () => {
    if (!info || installing) return;
    onTap?.();
    setInstalling(true);
    setProgress(0);
    try {
      await install(info.apkUrl, pct => setProgress(pct), info.size);
      setStatus({ text: 'Update downloaded. Opening the installer…', tone: 'accent' });
    } catch (err) {
      setStatus({ text: `Update failed: ${err instanceof Error ? err.message : 'unknown error'}`, tone: 'danger' });
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  return (
    <>
      <SettingsRow
        icon={icon}
        title="Check for updates"
        hint={checking ? 'Checking…' : `Installed: v${version}`}
        onClick={runCheck}
        disabled={installing}
        trailing={info ? <RowValue accent>v{info.version} available</RowValue> : undefined}
      />
      {info && (
        <div style={{ ...divider, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-primary)' }}>Version {info.version}</span>
            {info.publishedAt && (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(info.publishedAt).toLocaleDateString()}</span>
            )}
          </div>
          {info.releaseNotes && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', maxHeight: '96px', overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
              {info.releaseNotes}
            </p>
          )}
          {progress !== null && (
            <div>
              <div style={{ height: '4px', background: 'var(--border-subtle)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent-primary)', transition: 'width 0.2s' }} />
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>Downloading: {progress.toFixed(0)}%</span>
            </div>
          )}
          <button
            className="interactive btn-primary"
            disabled={installing}
            onClick={runInstall}
            style={{ width: '100%', padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
          >
            {installIcon}
            {installing ? 'Downloading…' : 'Download & install'}
          </button>
        </div>
      )}
      {status && <SettingsNote tone={status.tone}>{status.text}</SettingsNote>}
    </>
  );
};
