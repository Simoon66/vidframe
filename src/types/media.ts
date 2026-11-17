export type StorageBackendMode = 'telegram' | 's3_r2' | 'local_dev';

export interface AudioTrackInfo {
  index: number;
  language?: string;
  title?: string;
  codec?: string;
  channels?: number;
  isDefault?: boolean;
  isForced?: boolean;
  playlistKey?: string;
}

export interface SubtitleTrackInfo {
  index: number;
  language?: string;
  title?: string;
  format?: string;
  url?: string;
  objectKey?: string;
  isDefault?: boolean;
  isForced?: boolean;
  offsetMs?: number;
  source?: 'embedded' | 'uploaded' | 'ai_transcribed' | 'ai_translated';
}

export interface ChapterItem {
  id: string;
  title: string;
  startTime: number;
  endTime?: number;
}

export interface RenditionInfo {
  id: string;
  label: string;
  width: number;
  height: number;
  bandwidth: number;
  codec: string;
  playlistKey: string;
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
  telegramMessageIds?: number[];
  introStart?: number;
  introEnd?: number;
  outroStart?: number;
  outroEnd?: number;
  visibility: 'public' | 'unlisted' | 'private';
  processingStatus: 'ready' | 'processing' | 'failed';
  folder?: string;
  views?: number;
  ownerId?: string;
  playbackMode?: 'hls_v2' | 'legacy_telegram';
  storageBackend?: StorageBackendMode;
  activeVersionId?: string;
  sha256Hash?: string;
  allowedDomains?: string[];
  requireSignedPlayback?: boolean;
  posterUrl?: string;
  chapters?: ChapterItem[];
  audioTracks?: AudioTrackInfo[];
  subtitleTracks?: SubtitleTrackInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaVersionItem {
  id: string;
  mediaId: string;
  versionNumber: number;
  label: string;
  filename: string;
  mimeType: string;
  size: number;
  duration: number;
  sha256Hash: string;
  storageBackend: StorageBackendMode;
  objectPrefix: string;
  masterPlaylistKey?: string;
  posterKey?: string;
  renditions: RenditionInfo[];
  probeMetadata?: {
    width?: number;
    height?: number;
    fps?: number;
    videoCodec?: string;
    audioCodec?: string;
    bitrate?: number;
  };
  audioTracks?: AudioTrackInfo[];
  subtitleTracks?: SubtitleTrackInfo[];
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessingJobItem {
  id: string;
  idempotencyKey: string;
  queueShard: string;
  mediaId: string;
  versionId?: string;
  jobType: 'transcode_hls' | 'extract_tracks' | 'ai_transcribe' | 'ai_translate' | 'detect_intro' | 'import_url';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter' | 'cancelled';
  priority: number;
  attempts: number;
  maxAttempts: number;
  checkpoint: string;
  progressPercent: number;
  statusMessage?: string;
  leaseOwner?: string;
  cancelRequested?: boolean;
  result?: Record<string, any>;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntroSuggestionItem {
  id: string;
  mediaId: string;
  introStart: number;
  introEnd: number;
  outroStart: number;
  outroEnd: number;
  chapters: ChapterItem[];
  confidenceNote: string;
  provider: string;
  status: 'pending' | 'approved' | 'rejected';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybackDescriptor {
  media: MediaItem;
  playbackMode: 'hls_v2' | 'legacy_telegram';
  hlsManifestUrl?: string;
  legacyStreamUrl: string;
  signedToken?: string;
  posterUrl?: string;
  renditions: RenditionInfo[];
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
  chapters: ChapterItem[];
  versionsCount: number;
  activeVersionId?: string;
}

export interface PaginatedMediaResponse {
  items: MediaItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdminUserItem {
  uid: string;
  email: string;
  role: 'admin' | 'editor';
  active: boolean;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  role: 'admin' | 'editor' | 'playback';
  ownerUid: string;
  revokedAt?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface AuditLogItem {
  id: string;
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, any>;
  ip?: string;
  createdAt: string;
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
  id: string;
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

export interface TelegramDiagnostic {
  code: string;
  message: string;
  failedAt: string;
  chatIdTried?: string;
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
  lastDiagnostic?: TelegramDiagnostic | null;
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
  backend?: StorageBackendMode;
  chatId: string;
  chatTitle: string;
  canUpload: boolean;
  canRead: boolean;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3CdnBaseUrl?: string;
  s3ForcePathStyle?: boolean;
  s3Configured?: boolean;
  multiNodeMode?: boolean;
  updatedAt: string;
  configured?: boolean;
}

export interface AiProviderInfo {
  id: string;
  displayName: string;
  capabilities: string[];
  configured: boolean;
  notes: string;
}

export interface SystemStatus {
  telegram: TelegramState;
  storage: StorageConfig;
  appUrl: string;
  adminEmail: string;
  role?: 'admin' | 'editor';
  firestoreDatabaseId?: string;
  queueDriver?: string;
  aiProviders?: AiProviderInfo[];
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
