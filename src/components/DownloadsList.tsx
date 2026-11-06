// DownloadsList.tsx - Library "Downloads" tab: saved episodes grouped by title.
import React, { useEffect, useMemo, useState } from 'react';
import { Download, Play, Trash2, RotateCw, WifiOff } from 'lucide-react';
import { FadeImage } from 'streamkit/ui/FadeImage.tsx';
import { ConfirmModal } from 'streamkit/ui/ConfirmModal.tsx';
import {
  downloadsSupported, formatBytes, getOfflinePoster, removeAllDownloads, removeDownload, startDownload,
  type DownloadRecord
} from '../services/downloadService';
import { useDownloads } from '../services/useDownloads';
import { hapticLight, hapticMedium, hapticSuccess, hapticWarning } from '../services/hapticsService';

interface DownloadsListProps {
  onPlay: (record: DownloadRecord) => void;
}

interface Group {
  animeId: string;
  title: string;
  poster?: string;
  items: DownloadRecord[];
}

export const DownloadsList: React.FC<DownloadsListProps> = ({ onPlay }) => {
  const downloads = useDownloads();
  const [posters, setPosters] = useState<Record<string, string>>({});
  const [confirmingClear, setConfirmingClear] = useState(false);

  const groups = useMemo<Group[]>(() => {
    const byAnime = new Map<string, Group>();
    for (const rec of downloads) {
      let g = byAnime.get(rec.anime.id);
      if (!g) {
        g = { animeId: rec.anime.id, title: rec.anime.title, poster: rec.anime.poster, items: [] };
        byAnime.set(rec.anime.id, g);
      }
      g.items.push(rec);
    }
    for (const g of byAnime.values()) {
      g.items.sort((a, b) => parseFloat(a.episode.number) - parseFloat(b.episode.number));
    }
    return [...byAnime.values()];
  }, [downloads]);

  // Cover art saved with the download keeps showing offline.
  useEffect(() => {
    let cancelled = false;
    for (const g of groups) {
      if (posters[g.animeId]) continue;
      getOfflinePoster(g.animeId).then(p => {
        if (p && !cancelled) setPosters(prev => (prev[g.animeId] ? prev : { ...prev, [g.animeId]: p }));
      });
    }
    return () => { cancelled = true; };
  }, [groups, posters]);

  if (!downloadsSupported()) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
        <WifiOff size={40} color="var(--accent-primary)" style={{ margin: '0 auto 12px auto', opacity: 0.8 }} />
        <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>Downloads need the Android app</p>
        <p style={{ fontSize: '13px' }}>Install the AniStream APK to save episodes and watch them offline.</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
        <Download size={40} color="var(--accent-primary)" style={{ margin: '0 auto 12px auto', opacity: 0.8 }} />
        <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>No downloads yet</p>
        <p style={{ fontSize: '13px' }}>Tap the download button on an episode to watch it without internet.</p>
      </div>
    );
  }

  const total = downloads.reduce((sum, r) => sum + (r.state === 'completed' ? r.bytes : 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: '12px' }}>
        <span>{formatBytes(total)} used</span>
        <button
          onClick={() => { hapticWarning(); setConfirmingClear(true); }}
          className="interactive"
          style={{ background: 'none', border: 'none', color: 'var(--accent-danger)', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <Trash2 size={15} /><span>Delete all</span>
        </button>
      </div>

      <ConfirmModal
        open={confirmingClear}
        title="Delete all downloads"
        message="Every downloaded episode will be removed from this device."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={async () => { setConfirmingClear(false); await removeAllDownloads(); hapticSuccess(); }}
        onCancel={() => setConfirmingClear(false)}
      />

      {groups.map(g => (
        <div key={g.animeId} className="glass-panel" style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden', padding: '12px' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ width: '48px', height: '68px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0, background: 'var(--track-bg)' }}>
              <FadeImage src={posters[g.animeId] || g.poster} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</h3>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {g.items.length} episode{g.items.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          {g.items.map(rec => <EpisodeRow key={rec.id} rec={rec} onPlay={onPlay} />)}
        </div>
      ))}
    </div>
  );
};

const EpisodeRow: React.FC<{ rec: DownloadRecord; onPlay: (r: DownloadRecord) => void }> = ({ rec, onPlay }) => {
  const done = rec.state === 'completed';
  const failed = rec.state === 'failed';
  const pct = Math.round(rec.percent);
  const status = done ? formatBytes(rec.bytes)
    : failed ? 'Failed - tap retry'
    : rec.state === 'queued' ? 'Waiting…'
    : `${pct}%`;

  return (
    <div
      onClick={() => { if (done) { hapticMedium(); onPlay(rec); } }}
      className={done ? 'interactive' : undefined}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 4px', borderTop: '1px solid var(--border-subtle)', cursor: done ? 'pointer' : 'default' }}
    >
      <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: done ? 'var(--accent-primary)' : 'var(--track-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {done ? <Play size={13} fill="#fff" color="#fff" style={{ marginLeft: '1px' }} /> : <Download size={14} color="var(--text-secondary)" />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
          Episode {rec.episode.number}{rec.mode === 'dub' ? ' · Dub' : ''}
        </p>
        <p style={{ fontSize: '12px', color: failed ? 'var(--accent-danger)' : 'var(--text-secondary)', marginTop: '1px' }}>{status}</p>
      </div>
      {failed && (
        <button
          onClick={e => { e.stopPropagation(); hapticLight(); startDownload(rec.anime, rec.episode, rec.mode).catch(() => undefined); }}
          aria-label={`Retry episode ${rec.episode.number}`}
          className="interactive glass-pill"
          style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}
        >
          <RotateCw size={15} />
        </button>
      )}
      <button
        onClick={e => { e.stopPropagation(); hapticLight(); void removeDownload(rec.id); }}
        aria-label={done ? `Delete episode ${rec.episode.number}` : `Cancel episode ${rec.episode.number}`}
        className="interactive glass-pill"
        style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}
      >
        <Trash2 size={15} />
      </button>
      {!done && !failed && (
        <span style={{ position: 'absolute', left: 0, bottom: 0, height: 2, width: `${pct}%`, background: 'var(--accent-primary)', transition: 'width 0.4s linear' }} />
      )}
    </div>
  );
};
