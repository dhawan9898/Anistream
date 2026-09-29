import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SubtitleTrack } from '../core/aniCliCore';

export interface QualityOption {
  quality: string;
  url: string;
}

export interface ModeSwitchRequestedEvent {
  title: string;
  episode: string;
  mode: 'sub' | 'dub';
}

export interface NextEpisodeRequestedEvent {
  title: string;
  episode: string;
}

export interface EpisodeSelectedEvent {
  title: string;
  episode: string;
  selectedNumber: string;
}

export interface ProgressUpdateEvent {
  title: string;
  episode: string;
  mode: 'sub' | 'dub';
  positionMs: number;
  durationMs: number;
}

// The open stream failed in a way retrying it won't fix (e.g. the CDN
// returned 404 for a segment). JS should find another server for the same
// episode and play() it at positionMs, or fail({ retry: true }).
export interface StreamFailedEvent {
  title: string;
  episode: string;
  mode: 'sub' | 'dub';
  url: string;
  positionMs: number;
  message: string;
}

export interface PlayEpisodeOption {
  id: string;
  number: string;
}

export interface ExoPlayerPluginInterface {
  play(options: {
    url: string;
    title?: string;
    episode?: string;
    referer?: string;
    mode?: 'sub' | 'dub';
    subtitles?: SubtitleTrack[];
    qualities?: QualityOption[];
    episodes?: PlayEpisodeOption[];
    isFallback?: boolean;
    // Opening/ending chapter markers in seconds, from the stream's sources payload.
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
    // Where to start playing (resume), in ms.
    startPositionMs?: number;
  }): Promise<{ success: boolean }>;

  // Opens the player immediately in its loading state (title + spinner)
  // while the stream is being resolved; play() then hands it the stream.
  // If the player is already open it just shows its spinner again.
  open(options: { title?: string; episode?: string; mode?: 'sub' | 'dub' }): Promise<void>;

  // Shows a playback error inside the open player (stream resolution
  // failed). retry: offer "Retry" (replay the current stream) instead of
  // only "Go Back".
  fail(options: { message: string; retry?: boolean }): Promise<void>;

  addListener(
    eventName: 'playerClosed',
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'modeSwitchRequested',
    listenerFunc: (event: ModeSwitchRequestedEvent) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'nextEpisodeRequested',
    listenerFunc: (event: NextEpisodeRequestedEvent) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'episodeSelected',
    listenerFunc: (event: EpisodeSelectedEvent) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'streamFailed',
    listenerFunc: (event: StreamFailedEvent) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'progressUpdate',
    listenerFunc: (event: ProgressUpdateEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const ExoPlayerPlugin = registerPlugin<ExoPlayerPluginInterface>('ExoPlayerPlugin');
