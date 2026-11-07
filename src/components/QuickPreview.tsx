// QuickPreview.tsx - Card opened by long-pressing any poster: banner, type,
// genres and description of the title, with My List and More Info, so a title
// can be judged without leaving the screen. Sits over a blurred, dimmed page.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Check, Info, X } from 'lucide-react';
import { FadeImage } from 'streamkit/ui/FadeImage.tsx';
import { useBackHandler } from 'streamkit/core/backStack.ts';
import type { AnimeItem } from '../providers/aniCliCore';
import { getAnimeDetails, resolveAnime } from '../providers/catalogService';
import { getBookmarks, subscribeLibraryChanges, toggleBookmark } from '../services/historyService';
import { closePreview, getPreview, subscribePreview } from '../services/previewService';
import { hapticLight, hapticMedium, hapticSuccess } from '../services/hapticsService';

interface QuickPreviewProps {
  onOpenDetails: (anime: AnimeItem) => void;
}

export const QuickPreview: React.FC<QuickPreviewProps> = ({ onOpenDetails }) => {
  const anime = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  useBackHandler(anime !== null, closePreview);
  if (!anime) return null;
  // Keyed by title so each preview starts from fresh state.
  return <PreviewCard key={anime.id} anime={anime} onOpenDetails={onOpenDetails} />;
};

const PreviewCard: React.FC<{ anime: AnimeItem; onOpenDetails: (anime: AnimeItem) => void }> = ({ anime, onOpenDetails }) => {
  const [resolved, setResolved] = useState<AnimeItem>(anime);
  const [description, setDescription] = useState<string | undefined>(anime.description);
  const [genres, setGenres] = useState<string[]>(anime.genres ?? []);
  const [loadingDetails, setLoadingDetails] = useState(!anime.description);
  const [saved, setSaved] = useState(false);

  // Description and genres: the title's own, else looked up (best effort).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const site = await resolveAnime(anime);
        if (cancelled) return;
        setResolved(site);
        const details = await getAnimeDetails(site);
        if (cancelled) return;
        setDescription(prev => prev || details.description || site.description);
        setGenres(prev => (prev.length ? prev : details.genres.length ? details.genres : site.genres ?? []));
      } catch {
        // Offline or not found: the card shows what the tile already knew.
      } finally {
        if (!cancelled) setLoadingDetails(false);
      }
    })();
    return () => { cancelled = true; };
  }, [anime]);

  useEffect(() => {
    let cancelled = false;
    const sync = () => getBookmarks().then(list => { if (!cancelled) setSaved(list.some(b => b.id === resolved.id)); });
    void sync();
    const unsubscribe = subscribeLibraryChanges(sync);
    return () => { cancelled = true; unsubscribe(); };
  }, [resolved.id]);

  const meta = [resolved.type || anime.type || 'TV', ...genres.slice(0, 3)].filter(Boolean).join(' • ');

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={anime.title}
      data-modal-root="true"
      onClick={() => { hapticLight(); closePreview(); }}
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9400,
        backgroundColor: 'var(--picker-card-scrim, rgba(8, 8, 12, 0.7))',
        WebkitBackdropFilter: 'blur(18px) saturate(150%)',
        backdropFilter: 'blur(18px) saturate(150%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'calc(var(--safe-top) + 16px) 16px calc(var(--safe-bottom) + 16px) 16px'
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="animate-pop-in"
        style={{
          width: 'min(100%, 440px)',
          maxHeight: '70vh',
          overflowY: 'auto',
          backgroundColor: 'rgba(var(--bg-main-rgb), 0.9)',
          WebkitBackdropFilter: 'blur(24px) saturate(160%)',
          backdropFilter: 'blur(24px) saturate(160%)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl, 24px)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)'
        }}
      >
        <div style={{ position: 'relative', height: '170px' }}>
          <FadeImage src={resolved.banner || anime.banner || anime.poster} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 30%, rgba(var(--bg-main-rgb), 0.95) 100%)' }} />
          <button
            onClick={() => { hapticLight(); closePreview(); }}
            aria-label="Close preview"
            className="interactive glass-pill-dark"
            style={{ position: 'absolute', top: '12px', right: '12px', width: '34px', height: '34px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '0 20px 20px 20px' }}>
          <h2 style={{ fontSize: '21px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px', marginBottom: '6px' }}>{anime.title}</h2>
          <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '14px' }}>{meta}</p>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
            <button
              onClick={() => { hapticMedium(); closePreview(); onOpenDetails(resolved.id === anime.id ? anime : resolved); }}
              className="interactive"
              style={{ flex: 1, padding: '12px', borderRadius: 'var(--radius-md)', background: '#ffffff', color: '#000', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '14px', fontWeight: 800 }}
            >
              <Info size={18} /><span>More Info</span>
            </button>
            <button
              onClick={async () => { const now = await toggleBookmark(resolved); if (now) hapticSuccess(); else hapticLight(); }}
              className="interactive glass-pill"
              aria-pressed={saved}
              aria-label={saved ? 'Remove from My List' : 'Add to My List'}
              style={{ padding: '12px 18px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700 }}
            >
              {saved ? <Check size={18} /> : <Bookmark size={18} />}
              <span>My List</span>
            </button>
          </div>

          {description ? (
            <p style={{ fontSize: '14px', lineHeight: 1.5, color: 'var(--text-secondary)' }}>{description}</p>
          ) : (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              {loadingDetails ? 'Loading details…' : 'No description available.'}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
