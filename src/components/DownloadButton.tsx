// DownloadButton.tsx - Small round button on an episode tile: download, progress, done, retry.
import React from 'react';
import { Download, Check, RotateCw } from 'lucide-react';
import type { DownloadRecord } from '../services/downloadService';

interface DownloadButtonProps {
  record?: DownloadRecord;
  onStart: () => void;
  onRemove: () => void;
}

const SIZE = 36;

export const DownloadButton: React.FC<DownloadButtonProps> = ({ record, onStart, onRemove }) => {
  const state = record?.state;
  const active = state === 'queued' || state === 'downloading' || state === 'stopped';
  const pct = Math.max(0, Math.min(100, record?.percent ?? 0));

  const label = !record ? 'Download episode'
    : state === 'completed' ? 'Downloaded - tap to delete'
    : state === 'failed' ? 'Download failed - tap to retry'
    : `Downloading ${Math.round(pct)}% - tap to cancel`;

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!record || state === 'failed') onStart();
    else onRemove(); // completed: delete; in progress: cancel
  };

  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        position: 'relative',
        flexShrink: 0,
        width: SIZE,
        height: SIZE,
        borderRadius: '50%',
        border: 'none',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: state === 'completed' ? 'var(--accent-primary)' : 'var(--track-bg)',
        color: state === 'completed' ? '#fff' : state === 'failed' ? 'var(--accent-danger)' : 'var(--text-secondary)',
        cursor: 'pointer'
      }}
    >
      {active && (
        <svg width={SIZE} height={SIZE} viewBox="0 0 36 36" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--border-subtle)" strokeWidth="2.5" />
          <circle
            cx="18" cy="18" r="14" fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 14}
            strokeDashoffset={2 * Math.PI * 14 * (1 - (state === 'queued' ? 0.08 : pct / 100))}
            style={{ transition: 'stroke-dashoffset 0.4s linear' }}
          />
        </svg>
      )}
      {state === 'completed' ? <Check size={17} />
        : state === 'failed' ? <RotateCw size={16} />
        : active ? <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--text-primary)' }} />
        : <Download size={18} />}
    </button>
  );
};
