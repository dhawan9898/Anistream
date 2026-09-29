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

  // Shows a playback error inside the open player (stream resolution failed).
  fail(options: { message: string }): Promise<void>;

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
    eventName: 'progressUpdate',
    listenerFunc: (event: ProgressUpdateEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const ExoPlayerPlugin = registerPlugin<ExoPlayerPluginInterface>('ExoPlayerPlugin');
