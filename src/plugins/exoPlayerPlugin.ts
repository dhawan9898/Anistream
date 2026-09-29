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
  }): Promise<{ success: boolean }>;

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
