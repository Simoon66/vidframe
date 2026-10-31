export interface AudioTrackInfo {
  index: number;
  language?: string;
  title?: string;
  codec?: string;
  channels?: number;
}

export interface SubtitleTrackInfo {
  index: number;
  language?: string;
  title?: string;
  format?: string;
  url?: string;
}

export interface MediaItem {
  id: string;
  title: string;
  description?: string;
  filename: string;
  mimeType: string;
  size: number;
  duration?: number;
  telegramChatId: string;
  telegramMessageId: number;
  telegramMessageIds?: number[]; // For multi-part 2GB+ uploaded files
  introStart?: number;
  introEnd?: number;
  outroStart?: number;
  outroEnd?: number;
  visibility: 'public' | 'unlisted' | 'private';
  processingStatus: 'ready' | 'processing' | 'failed';
  folder?: string;
  views?: number;
  ownerId?: string;
  audioTracks?: AudioTrackInfo[];
  subtitleTracks?: SubtitleTrackInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeItem {
  episodeNumber: number;
  title: string;
  description?: string;
  thumbnail?: string;
  mediaId?: string;
  duration?: number;
}

export interface SeasonItem {
  seasonNumber: number;
  title: string;
  episodes: EpisodeItem[];
}

export interface SeriesRecord {
  id: string; // e.g. tmdb_12345, anilist_67890, iddb_1, etc.
  source: 'iddb' | 'tmdb' | 'anilist' | 'mal' | 'custom';
  sourceId: string;
  title: string;
  japaneseTitle?: string;
  description?: string;
  coverImage?: string;
  bannerImage?: string;
  logoImage?: string;
  seasons: SeasonItem[];
  createdAt: string;
  updatedAt: string;
}

export interface TelegramState {
  state:
    | 'Not Connected'
    | 'Waiting for Code'
    | 'Waiting for Two-Step Verification'
    | 'Connecting'
    | 'Connected'
    | 'Reconnecting'
    | 'Login Required'
    | 'Connection Error';
  errorMessage: string | null;
  user: {
    id: string;
    username: string | null;
    firstName: string;
    lastName: string;
    phone: string | null;
  } | null;
  hasCredentials: boolean;
  apiIdConfigured: boolean;
  apiHashConfigured: boolean;
  hasPendingAuth: boolean;
  pendingPhone: string | null;
}

export interface StorageConfig {
  chatId: string;
  chatTitle: string;
  canUpload: boolean;
  canRead: boolean;
  updatedAt: string;
  configured?: boolean;
}

export interface SystemStatus {
  telegram: TelegramState;
  storage: StorageConfig;
  appUrl: string;
  adminEmail: string;
}

export interface AnalyticsEvent {
  id: string;
  mediaId: string;
  mediaTitle: string;
  timestamp: string;
  country: string;
  device: 'Mobile' | 'Desktop' | 'Tablet' | 'Other';
  os: 'Windows' | 'Android' | 'iOS' | 'macOS' | 'Linux' | 'Other';
  browser: string;
  ip?: string;
}

export interface ReportRecord {
  id: string;
  mediaId?: string;
  mediaTitle?: string;
  issueType: 'Video not playing' | 'Audio issue' | 'Subtitle issue' | 'Buffering or slow playback' | 'other';
  description?: string;
  status: 'open' | 'investigating' | 'resolved';
  createdAt: string;
}

export interface IDDBMedia {
  id: string;
  type: 'anime' | 'movie' | 'tv';
  titles: {
    english?: string;
    romaji?: string;
    native?: string;
    canonical?: string;
  };
  synopsis?: string;
  posterUrl?: string;
  backdropUrl?: string;
  logoUrl?: string;
  releaseYear?: number;
  rating?: number;
  externalIds?: {
    tmdb?: string | number;
    imdb?: string;
    anilist?: string | number;
    mal?: string | number;
  };
  seasons?: {
    seasonNumber: number;
    title?: string;
    episodes?: {
      episodeNumber: number;
      title: string;
      thumbnail?: string;
      overview?: string;
    }[];
  }[];
}
