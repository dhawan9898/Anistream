// DownloadButton.tsx - Small round button on an episode tile: download, progress, done, retry.
import React from 'react';
import { Download, Check, RotateCw } from 'lucide-react';
import type { DownloadRecord } from '../services/downloadService';

interface DownloadButtonProps {
  record?: DownloadRecord;
  onStart: () => void;
  onRemove: () => void;
}

const SIZE = 26;

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
        position: 'absolute',
        top: 4,
        right: 4,
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
        <svg width={SIZE} height={SIZE} viewBox="0 0 26 26" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx="13" cy="13" r="10" fill="none" stroke="var(--border-subtle)" strokeWidth="2.5" />
          <circle
            cx="13" cy="13" r="10" fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 10}
            strokeDashoffset={2 * Math.PI * 10 * (1 - (state === 'queued' ? 0.08 : pct / 100))}
            style={{ transition: 'stroke-dashoffset 0.4s linear' }}
          />
        </svg>
      )}
      {state === 'completed' ? <Check size={14} />
        : state === 'failed' ? <RotateCw size={13} />
        : active ? <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--text-primary)' }} />
        : <Download size={14} />}
    </button>
  );
};
