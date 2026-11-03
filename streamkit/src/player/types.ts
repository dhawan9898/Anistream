// types.ts - The minimal shapes the shared player UI needs. Each app's own
// models (StreamSource, EpisodeItem, ...) satisfy these structurally.
export interface PlayerSubtitleTrack {
  src: string;
  label: string;
  default?: boolean;
}

export interface PlayerQuality {
  quality: string;
  url: string;
}

export interface PlayerEpisode {
  id: string;
  number: string | number;
  title?: string;
}
