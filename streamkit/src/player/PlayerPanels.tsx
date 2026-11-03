// PlayerPanels.tsx - Presentational overlay panels of the web player (playback
// speed, audio / subtitles / quality, episode picker). They hold no playback
// state of their own: VideoPlayer owns it and passes values and callbacks in.
import React from 'react';
import { Check, X } from 'lucide-react';
import type { PlayerSubtitleTrack, PlayerQuality, PlayerEpisode } from './types.ts';
import { PLAYBACK_SPEEDS } from './playerUtils.ts';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

interface SpeedPanelProps {
  playbackRate: number;
  onChange: (rate: number) => void;
  onClose: () => void;
}

export const SpeedPanel: React.FC<SpeedPanelProps> = ({ playbackRate, onChange, onClose }) => (
  <div
    className="nf-panel"
    onClick={(e) => { e.stopPropagation(); onClose(); }}
    onTouchStart={stop}
    onTouchMove={stop}
  >
    <button onClick={onClose} className="interactive nf-panel-close" aria-label="Close">
      <X size={28} />
    </button>
    <div className="nf-speed" onClick={stop}>
      <h3>Playback Speed</h3>
      <div className="nf-speed-line">
        <div className="nf-speed-rail" />
        {PLAYBACK_SPEEDS.map(rate => (
          <button
            key={rate}
            onClick={() => onChange(rate)}
            className={`nf-speed-stop ${rate === playbackRate ? 'active' : ''}`}
          >
            <span className="nf-speed-dot" />
            <span className="nf-speed-label">{rate}x{rate === 1 ? ' (Normal)' : ''}</span>
          </button>
        ))}
      </div>
    </div>
  </div>
);

interface OptionProps {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const Option: React.FC<OptionProps> = ({ active, disabled, onClick, children }) => (
  <button disabled={disabled} onClick={onClick} className={`nf-option ${active ? 'active' : ''}`}>
    <span className="nf-check">{active && <Check size={18} />}</span>
    {children}
  </button>
);

interface AudioPanelProps {
  mode: 'sub' | 'dub';
  canSwitchMode: boolean;
  onSwitchMode: (mode: 'sub' | 'dub') => void;
  subtitles: PlayerSubtitleTrack[];
  activeSubtitle: string | null;
  onSubtitle: (label: string | null) => void;
  // null when the source has no genuinely different qualities to choose from.
  qualityOptions: PlayerQuality[] | null;
  selectedQuality: string;
  onQuality: (item: PlayerQuality) => void;
  onClose: () => void;
}

export const AudioPanel: React.FC<AudioPanelProps> = ({
  mode, canSwitchMode, onSwitchMode, subtitles, activeSubtitle, onSubtitle,
  qualityOptions, selectedQuality, onQuality, onClose
}) => (
  <div className="nf-panel" onClick={stop} onTouchStart={stop} onTouchMove={stop}>
    <button onClick={onClose} className="interactive nf-panel-close" aria-label="Close">
      <X size={28} />
    </button>
    <div className="nf-columns">
      <div className="nf-column">
        <h3>Audio</h3>
        {(['sub', 'dub'] as const).map(m => {
          const active = m === mode;
          return (
            <Option
              key={m}
              active={active}
              disabled={!active && !canSwitchMode}
              onClick={() => { if (!active && canSwitchMode) onSwitchMode(m); }}
            >
              {m === 'sub' ? 'Japanese [Original]' : 'English (Dub)'}
            </Option>
          );
        })}
      </div>
      <div className="nf-column">
        <h3>Subtitles</h3>
        <Option active={activeSubtitle === null} onClick={() => onSubtitle(null)}>Off</Option>
        {subtitles.map(track => (
          <Option key={track.label} active={activeSubtitle === track.label} onClick={() => onSubtitle(track.label)}>
            {track.label}
          </Option>
        ))}
      </div>
      {qualityOptions && (
        <div className="nf-column">
          <h3>Video Quality</h3>
          {qualityOptions.map(item => (
            <Option key={item.quality} active={selectedQuality === item.quality} onClick={() => onQuality(item)}>
              {item.quality}
            </Option>
          ))}
        </div>
      )}
    </div>
  </div>
);

interface EpisodePanelProps<E extends PlayerEpisode> {
  animeTitle: string;
  episodes: E[];
  currentId: string;
  gridRef: React.RefObject<HTMLDivElement | null>;
  // Not called for the episode that is already playing.
  onSelect: (episode: E) => void;
  onClose: () => void;
}

export function EpisodePanel<E extends PlayerEpisode>({
  animeTitle, episodes, currentId, gridRef, onSelect, onClose
}: EpisodePanelProps<E>) {
  return (
  <div
    className="nf-panel nf-panel-center"
    onClick={(e) => { e.stopPropagation(); onClose(); }}
    onTouchStart={stop}
    onTouchMove={stop}
  >
    <div className="nf-episodes animate-pop-in" onClick={stop}>
      <div className="nf-episodes-head">
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800 }}>Episodes</div>
          <div style={{ fontSize: '12px', color: '#b3b3b3', marginTop: '2px' }}>
            {animeTitle} · {episodes.length} episodes
          </div>
        </div>
        <button onClick={onClose} className="interactive nf-icon-btn" aria-label="Close episode list">
          <X size={24} />
        </button>
      </div>
      <div ref={gridRef} className="nf-episodes-grid">
        {episodes.map(ep => {
          const isCurrent = ep.id === currentId;
          return (
            <button
              key={ep.id}
              data-current={isCurrent || undefined}
              title={ep.title}
              onClick={() => (isCurrent ? onClose() : onSelect(ep))}
              className={`interactive nf-ep ${isCurrent ? 'active' : ''}`}
            >
              {ep.number}
            </button>
          );
        })}
      </div>
    </div>
  </div>
);
}
