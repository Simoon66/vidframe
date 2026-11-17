import { initializeApp as initializeClientApp, getApps as getClientApps, getApp as getClientApp } from 'firebase/app';
import {
  getFirestore as getClientFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  orderBy,
  limit as firestoreLimit,
  Firestore as ClientFirestore,
} from 'firebase/firestore';
import { initializeApp as initializeAdminApp, getApps as getAdminApps, applicationDefault, cert, App as AdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, Firestore as AdminFirestore } from 'firebase-admin/firestore';
import { getAuth as getAdminAuth, Auth as AdminAuth } from 'firebase-admin/auth';
import crypto from 'node:crypto';
import { getFirebaseConfig, StorageBackendMode } from './config.ts';
import {
  restGetDoc,
  restSetDoc,
  restDeleteDoc,
  restListCollection,
  getEffectiveBearerToken,
} from './firestoreRest.ts';

let clientDbInstance: ClientFirestore | null = null;
let adminAppInstance: AdminApp | null = null;
let adminDbInstance: AdminFirestore | null = null;
let adminDbVerified: boolean | null = null;

export function getAdminApp(): AdminApp {
  if (adminAppInstance) return adminAppInstance;
  const cfg = getFirebaseConfig();
  if (getAdminApps().length > 0) {
    adminAppInstance = getAdminApps()[0]!;
    return adminAppInstance;
  }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson && saJson.trim().startsWith('{')) {
    const parsed = JSON.parse(saJson);
    adminAppInstance = initializeAdminApp({
      projectId: cfg.projectId,
      credential: cert(parsed),
    });
    return adminAppInstance;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    adminAppInstance = initializeAdminApp({
      projectId: cfg.projectId,
      credential: applicationDefault(),
    });
    return adminAppInstance;
  }

  adminAppInstance = initializeAdminApp({
    projectId: cfg.projectId,
  });
  return adminAppInstance;
}

export function getFirebaseAdminAuth(): AdminAuth {
  return getAdminAuth(getAdminApp());
}

export function getClientDb(): ClientFirestore {
  if (clientDbInstance) return clientDbInstance;
  const cfg = getFirebaseConfig();
  const app = getClientApps().length > 0 ? getClientApp() : initializeClientApp(cfg);
  clientDbInstance = getClientFirestore(app, cfg.firestoreDatabaseId);
  return clientDbInstance;
}

// Keep getDb alias for existing callers
export const getDb = getClientDb;

async function getAdminFirestoreIfPermitted(): Promise<AdminFirestore | null> {
  if (adminDbVerified === false) return null;
  if (adminDbVerified === true && adminDbInstance) return adminDbInstance;

  // Only attempt privileged Admin Firestore when explicit credentials exist or in Cloud Run
  const hasExplicitCreds = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!hasExplicitCreds) {
    adminDbVerified = false;
    return null;
  }

  try {
    const cfg = getFirebaseConfig();
    const app = getAdminApp();
    adminDbInstance = getAdminFirestore(app, cfg.firestoreDatabaseId);
    await adminDbInstance.collection('test').doc('connection').get();
    adminDbVerified = true;
    return adminDbInstance;
  } catch (err: any) {
    console.warn('[DB] Admin Firestore unavailable, falling back to authenticated REST/Client SDK:', err?.message || err);
    adminDbVerified = false;
    return null;
  }
}

export function isValidFirestoreId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

export function computeTimeBucket(isoDate = new Date().toISOString()): string {
  return isoDate.slice(0, 7); // YYYY-MM
}

export function computeShard(key: string, shardCount = 16): number {
  const hash = crypto.createHash('md5').update(key).digest();
  return hash[0] % shardCount;
}

// ==================== DOMAIN INTERFACES ====================

export interface StoredTelegramSession {
  encryptedSession: string;
  iv: string;
  authTag: string;
  phoneMasked?: string;
  userId?: string;
  username?: string;
  firstName?: string;
  sessionStatus?: 'active' | 'revoked_or_unregistered';
  lastAuthError?: string;
  lastFailedAt?: string;
  lastChatIdTried?: string;
  connectedAt: string;
  updatedAt: string;
}

export interface StorageConfig {
  backend?: StorageBackendMode;
  chatId: string;
  chatTitle: string;
  canUpload: boolean;
  canRead: boolean;
  // S3 / Cloudflare R2 / GCS Interop config (secret is encrypted at rest)
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3EncryptedSecret?: { ciphertext: string; iv: string; authTag: string };
  s3CdnBaseUrl?: string;
  s3ForcePathStyle?: boolean;
  updatedAt: string;
}

export interface AudioTrackMeta {
  index: number;
  language?: string;
  title?: string;
  codec?: string;
  channels?: number;
  isDefault?: boolean;
  isForced?: boolean;
  playlistKey?: string;
}

export interface SubtitleTrackMeta {
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

export interface RenditionMeta {
  id: string;
  label: string;
  width: number;
  height: number;
  bandwidth: number;
  codec: string;
  playlistKey: string;
}

export interface MediaRecord {
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
  tenantId?: string;
  tenantShard?: string;
  timeBucket?: string;
  playbackMode?: 'hls_v2' | 'legacy_telegram';
  storageBackend?: StorageBackendMode;
  activeVersionId?: string;
  sha256Hash?: string;
  allowedDomains?: string[];
  requireSignedPlayback?: boolean;
  posterUrl?: string;
  storyboardUrl?: string;
  chapters?: ChapterItem[];
  audioTracks?: AudioTrackMeta[];
  subtitleTracks?: SubtitleTrackMeta[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaVersionRecord {
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
  storyboardKey?: string;
  renditions: RenditionMeta[];
  probeMetadata?: {
    width?: number;
    height?: number;
    fps?: number;
    videoCodec?: string;
    audioCodec?: string;
    bitrate?: number;
  };
  audioTracks?: AudioTrackMeta[];
  subtitleTracks?: SubtitleTrackMeta[];
  telegramChatId?: string;
  telegramMessageId?: number;
  telegramMessageIds?: number[];
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type JobType = 'transcode_hls' | 'extract_tracks' | 'ai_transcribe' | 'ai_translate' | 'detect_intro' | 'import_url';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter' | 'cancelled';

export interface ProcessingJobRecord {
  id: string;
  idempotencyKey: string;
  queueShard: string;
  mediaId: string;
  versionId?: string;
  jobType: JobType;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  checkpoint: string;
  progressPercent: number;
  statusMessage?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  cancelRequested?: boolean;
  payload?: Record<string, any>;
  result?: Record<string, any>;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntroSuggestionRecord {
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

export interface AdminUserRecord {
  uid: string;
  email: string;
  role: 'admin' | 'editor';
  active: boolean;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  role: 'admin' | 'editor' | 'playback';
  ownerUid: string;
  revokedAt?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface AuditLogRecord {
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

export interface TelemetrySampleRecord {
  id: string;
  kind: 'api_latency' | 'playback_error' | 'playback_buffer' | 'worker_metric';
  routeOrMediaId: string;
  statusCode?: number;
  durationMs?: number;
  detail?: string;
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

export function sanitizeFirestoreData<T extends Record<string, any>>(obj: T): T {
  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        sanitized[key] = sanitizeFirestoreData(value);
      } else {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

// ==================== UNIFIED PRIMITIVES (Admin SDK > Authenticated REST > Client SDK) ====================

async function docGet<T = any>(colName: string, docId: string, allowUnauthClient = false): Promise<T | null> {
  if (!isValidFirestoreId(docId)) return null;
  const adminDb = await getAdminFirestoreIfPermitted();
  if (adminDb) {
    const snap = await adminDb.collection(colName).doc(docId).get();
    return snap.exists ? (snap.data() as T) : null;
  }

  const token = getEffectiveBearerToken();
  if (token) {
    return restGetDoc<T>(`${colName}/${docId}`, token);
  }

  if (allowUnauthClient) {
    const db = getClientDb();
    const snap = await getDoc(doc(db, colName, docId));
    return snap.exists() ? (snap.data() as T) : null;
  }

  return null;
}

async function docSet(colName: string, docId: string, payload: Record<string, any>, allowUnauthClient = false): Promise<void> {
  if (!isValidFirestoreId(docId)) {
    throw new Error(`Invalid Firestore document ID: ${docId}`);
  }
  const clean = sanitizeFirestoreData(payload);
  const adminDb = await getAdminFirestoreIfPermitted();
  if (adminDb) {
    await adminDb.collection(colName).doc(docId).set(clean);
    return;
  }

  const token = getEffectiveBearerToken();
  if (token) {
    await restSetDoc(`${colName}/${docId}`, clean, token);
    return;
  }

  if (allowUnauthClient) {
    const db = getClientDb();
    await setDoc(doc(db, colName, docId), clean);
    return;
  }

  throw new Error(`Authentication required to write ${colName}/${docId}`);
}

async function docDelete(colName: string, docId: string): Promise<void> {
  if (!isValidFirestoreId(docId)) return;
  const adminDb = await getAdminFirestoreIfPermitted();
  if (adminDb) {
    await adminDb.collection(colName).doc(docId).delete();
    return;
  }

  const token = getEffectiveBearerToken();
  if (token) {
    await restDeleteDoc(`${colName}/${docId}`, token);
    return;
  }

  throw new Error(`Authentication required to delete ${colName}/${docId}`);
}

async function colList<T = any>(
  colName: string,
  options: {
    orderByField?: string;
    direction?: 'ASCENDING' | 'DESCENDING';
    limit?: number;
    where?: Array<{ field: string; op: 'EQUAL' | 'IN' | 'GREATER_THAN' | 'LESS_THAN'; value: any }>;
    startAfterValues?: any[];
  } = {}
): Promise<T[]> {
  const adminDb = await getAdminFirestoreIfPermitted();
  if (adminDb) {
    let q: FirebaseFirestore.Query = adminDb.collection(colName);
    if (options.where) {
      for (const w of options.where) {
        const opMap: Record<string, FirebaseFirestore.WhereFilterOp> = {
          EQUAL: '==',
          IN: 'in',
          GREATER_THAN: '>',
          LESS_THAN: '<',
        };
        q = q.where(w.field, opMap[w.op] || '==', w.value);
      }
    }
    if (options.orderByField) {
      q = q.orderBy(options.orderByField, options.direction === 'ASCENDING' ? 'asc' : 'desc');
    }
    if (options.startAfterValues && options.startAfterValues.length > 0) {
      q = q.startAfter(options.startAfterValues[0]);
    }
    if (options.limit) {
      q = q.limit(options.limit);
    }
    const snap = await q.get();
    return snap.docs.map((d) => d.data() as T);
  }

  const token = getEffectiveBearerToken();
  if (token) {
    return restListCollection<T>(colName, {
      pageSize: options.limit,
      orderByField: options.orderByField,
      direction: options.direction,
      where: options.where,
      startAfterValues: options.startAfterValues,
      token,
    });
  }

  return [];
}

// ==================== CONNECTIVITY CHECK ====================

export async function checkFirestoreConnectivity(): Promise<{ ok: boolean; mode: string; error?: string }> {
  try {
    const adminDb = await getAdminFirestoreIfPermitted();
    if (adminDb) {
      await adminDb.collection('test').doc('connection').get();
      return { ok: true, mode: 'firebase_admin' };
    }
    const db = getClientDb();
    await getDoc(doc(db, 'test', 'connection'));
    return { ok: true, mode: getEffectiveBearerToken() ? 'authenticated_rest' : 'client_sdk' };
  } catch (err: any) {
    return { ok: false, mode: 'error', error: err?.message || String(err) };
  }
}

// ==================== TELEGRAM SESSION & STORAGE SETTINGS ====================

export async function getSavedTelegramSession(): Promise<StoredTelegramSession | null> {
  try {
    return await docGet<StoredTelegramSession>('settings', 'telegram', false);
  } catch (error) {
    console.error('Error fetching telegram session from Firestore:', error);
    return null;
  }
}

export async function saveTelegramSession(data: StoredTelegramSession): Promise<void> {
  await docSet('settings', 'telegram', data, false);
}

export async function deleteTelegramSession(): Promise<void> {
  await docDelete('settings', 'telegram');
}

export async function getStorageConfig(): Promise<StorageConfig | null> {
  try {
    return await docGet<StorageConfig>('settings', 'storage', false);
  } catch (error) {
    console.error('Error fetching storage config:', error);
    return null;
  }
}

export async function saveStorageConfig(data: StorageConfig): Promise<void> {
  await docSet('settings', 'storage', data, false);
}

// ==================== MEDIA ITEMS + CURSOR PAGINATION ====================

export async function getMediaItems(maxLimit = 200): Promise<MediaRecord[]> {
  try {
    return await colList<MediaRecord>('media', {
      orderByField: 'createdAt',
      direction: 'DESCENDING',
      limit: maxLimit,
    });
  } catch (error) {
    console.error('Error fetching media items:', error);
    return [];
  }
}

export interface MediaPaginationOptions {
  limit?: number;
  cursor?: string; // base64url JSON { createdAt, id }
  visibility?: string;
  folder?: string;
  status?: string;
  search?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function listMediaPaginated(opts: MediaPaginationOptions = {}): Promise<PaginatedResult<MediaRecord>> {
  const pageLimit = Math.min(Math.max(Number(opts.limit) || 24, 1), 100);
  const where: Array<{ field: string; op: 'EQUAL'; value: any }> = [];

  if (opts.visibility && opts.visibility !== 'all') {
    where.push({ field: 'visibility', op: 'EQUAL', value: opts.visibility });
  }
  if (opts.status && opts.status !== 'all') {
    where.push({ field: 'processingStatus', op: 'EQUAL', value: opts.status });
  }
  if (opts.folder && opts.folder !== 'all' && opts.folder !== 'unfiled') {
    where.push({ field: 'folder', op: 'EQUAL', value: opts.folder });
  }

  let startAfterValues: any[] | undefined;
  if (opts.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
      if (parsed?.createdAt && parsed?.id) {
        startAfterValues = [parsed.createdAt, { __refPath: `media/${parsed.id}` }];
      }
    } catch {}
  }

  // Fetch pageLimit + 1 (or larger window if client-side substring search/unfiled filter is requested)
  const needsFilterWindow = Boolean(opts.search?.trim() || opts.folder === 'unfiled');
  const fetchLimit = needsFilterWindow ? Math.min(pageLimit * 4, 200) : pageLimit + 1;

  let rawDocs: MediaRecord[] = [];
  try {
    rawDocs = await colList<MediaRecord>('media', {
      orderByField: 'createdAt',
      direction: 'DESCENDING',
      limit: fetchLimit,
      where: where.length > 0 ? where : undefined,
      startAfterValues,
    });
  } catch (err) {
    // Fallback if composite index is still building during rollout
    rawDocs = await colList<MediaRecord>('media', {
      orderByField: 'createdAt',
      direction: 'DESCENDING',
      limit: 150,
    });
    if (opts.visibility && opts.visibility !== 'all') {
      rawDocs = rawDocs.filter((m) => m.visibility === opts.visibility);
    }
    if (opts.status && opts.status !== 'all') {
      rawDocs = rawDocs.filter((m) => m.processingStatus === opts.status);
    }
    if (opts.folder && opts.folder !== 'all' && opts.folder !== 'unfiled') {
      rawDocs = rawDocs.filter((m) => m.folder === opts.folder);
    }
  }

  if (opts.folder === 'unfiled') {
    rawDocs = rawDocs.filter((m) => !m.folder);
  }
  if (opts.search?.trim()) {
    const q = opts.search.trim().toLowerCase();
    rawDocs = rawDocs.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.filename.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
    );
  }

  const hasMore = rawDocs.length > pageLimit;
  const items = hasMore ? rawDocs.slice(0, pageLimit) : rawDocs;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id }), 'utf8').toString('base64url')
      : null;

  return { items, nextCursor, hasMore };
}

export async function findMediaBySha256(sha256Hash: string): Promise<MediaRecord | null> {
  if (!sha256Hash) return null;
  try {
    const rows = await colList<MediaRecord>('media', {
      where: [{ field: 'sha256Hash', op: 'EQUAL', value: sha256Hash }],
      limit: 1,
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function getMediaItem(id: string): Promise<MediaRecord | null> {
  try {
    return await docGet<MediaRecord>('media', id, true);
  } catch (error) {
    console.error(`Error fetching media item ${id}:`, error);
    return null;
  }
}

export async function saveMediaItem(data: MediaRecord): Promise<void> {
  const now = new Date().toISOString();
  const createdAt = data.createdAt || now;
  const cleanPayload = sanitizeFirestoreData({
    ...data,
    duration: typeof data.duration === 'number' && !isNaN(data.duration) ? data.duration : 0,
    introStart: data.introStart || 0,
    introEnd: data.introEnd || 0,
    outroStart: data.outroStart || 0,
    outroEnd: data.outroEnd || 0,
    description: data.description || '',
    tenantId: data.tenantId || data.ownerId || 'default',
    timeBucket: data.timeBucket || computeTimeBucket(createdAt),
    tenantShard: data.tenantShard || `${data.tenantId || 'default'}_${computeShard(data.id, 8)}`,
    playbackMode: data.playbackMode || 'legacy_telegram',
    storageBackend: data.storageBackend || 'telegram',
    createdAt,
    updatedAt: data.updatedAt || now,
  });
  await docSet('media', data.id, cleanPayload, false);
}

export async function updateMediaItem(id: string, updates: Partial<MediaRecord>): Promise<MediaRecord | null> {
  const existing = await getMediaItem(id);
  if (!existing) return null;
  const updated: MediaRecord = {
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await saveMediaItem(updated);
  return updated;
}

export async function deleteMediaItem(id: string): Promise<boolean> {
  await docDelete('media', id);
  return true;
}

// ==================== IMMUTABLE MASTER VERSIONS ====================

export async function listMediaVersions(mediaId: string): Promise<MediaVersionRecord[]> {
  try {
    return await colList<MediaVersionRecord>('media_versions', {
      where: [{ field: 'mediaId', op: 'EQUAL', value: mediaId }],
      orderByField: 'versionNumber',
      direction: 'DESCENDING',
      limit: 50,
    });
  } catch {
    const fallback = await colList<MediaVersionRecord>('media_versions', {
      where: [{ field: 'mediaId', op: 'EQUAL', value: mediaId }],
      limit: 50,
    });
    return fallback.sort((a, b) => b.versionNumber - a.versionNumber);
  }
}

export async function getMediaVersion(versionId: string): Promise<MediaVersionRecord | null> {
  try {
    return await docGet<MediaVersionRecord>('media_versions', versionId, true);
  } catch {
    return null;
  }
}

export async function saveMediaVersion(version: MediaVersionRecord): Promise<void> {
  await docSet('media_versions', version.id, version, false);
}

export async function updateMediaVersion(
  versionId: string,
  updates: Partial<MediaVersionRecord>
): Promise<MediaVersionRecord | null> {
  const existing = await getMediaVersion(versionId);
  if (!existing) return null;
  const next: MediaVersionRecord = {
    ...existing,
    ...updates,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  };
  await saveMediaVersion(next);
  return next;
}

// ==================== DURABLE PROCESSING JOBS ====================

export async function saveProcessingJob(job: ProcessingJobRecord): Promise<void> {
  await docSet('processing_jobs', job.id, job, false);
}

export async function getProcessingJob(jobId: string): Promise<ProcessingJobRecord | null> {
  try {
    return await docGet<ProcessingJobRecord>('processing_jobs', jobId, false);
  } catch {
    return null;
  }
}

export async function findJobByIdempotencyKey(idempotencyKey: string): Promise<ProcessingJobRecord | null> {
  try {
    const rows = await colList<ProcessingJobRecord>('processing_jobs', {
      where: [{ field: 'idempotencyKey', op: 'EQUAL', value: idempotencyKey }],
      limit: 1,
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listProcessingJobs(opts: { status?: string; limit?: number } = {}): Promise<ProcessingJobRecord[]> {
  const lim = Math.min(opts.limit || 50, 200);
  try {
    return await colList<ProcessingJobRecord>('processing_jobs', {
      where: opts.status && opts.status !== 'all' ? [{ field: 'status', op: 'EQUAL', value: opts.status }] : undefined,
      orderByField: 'createdAt',
      direction: 'DESCENDING',
      limit: lim,
    });
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403 || String(err?.message || '').includes('(401)')) {
      throw err;
    }
    const all = await colList<ProcessingJobRecord>('processing_jobs', { limit: lim });
    const filtered = opts.status && opts.status !== 'all' ? all.filter((j) => j.status === opts.status) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

// ==================== INTRO / CHAPTER SUGGESTIONS ====================

export async function saveIntroSuggestion(record: IntroSuggestionRecord): Promise<void> {
  await docSet('intro_suggestions', record.id, record, false);
}

export async function listIntroSuggestions(mediaId: string): Promise<IntroSuggestionRecord[]> {
  try {
    return await colList<IntroSuggestionRecord>('intro_suggestions', {
      where: [{ field: 'mediaId', op: 'EQUAL', value: mediaId }],
      limit: 20,
    });
  } catch {
    return [];
  }
}

export async function getIntroSuggestion(id: string): Promise<IntroSuggestionRecord | null> {
  return docGet<IntroSuggestionRecord>('intro_suggestions', id, false);
}

// ==================== RBAC ADMINS, API KEYS, AUDIT LOGS & TELEMETRY ====================

export async function getAdminUser(uid: string): Promise<AdminUserRecord | null> {
  try {
    return await docGet<AdminUserRecord>('admins', uid, false);
  } catch {
    return null;
  }
}

export async function listAdminUsers(): Promise<AdminUserRecord[]> {
  return colList<AdminUserRecord>('admins', { limit: 100 });
}

export async function saveAdminUser(record: AdminUserRecord): Promise<void> {
  await docSet('admins', record.uid, record, false);
}

export async function deleteAdminUser(uid: string): Promise<void> {
  await docDelete('admins', uid);
}

export async function saveApiKeyRecord(record: ApiKeyRecord): Promise<void> {
  await docSet('api_keys', record.id, record, false);
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
  try {
    const rows = await colList<ApiKeyRecord>('api_keys', {
      where: [{ field: 'keyHash', op: 'EQUAL', value: keyHash }],
      limit: 1,
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  return colList<ApiKeyRecord>('api_keys', { orderByField: 'createdAt', direction: 'DESCENDING', limit: 100 }).catch(() =>
    colList<ApiKeyRecord>('api_keys', { limit: 100 })
  );
}

export async function revokeApiKey(id: string): Promise<void> {
  const existing = await docGet<ApiKeyRecord>('api_keys', id, false);
  if (!existing) return;
  await saveApiKeyRecord({ ...existing, revokedAt: new Date().toISOString() });
}

export async function writeAuditLog(entry: AuditLogRecord): Promise<void> {
  try {
    await docSet('audit_logs', entry.id, entry, false);
  } catch (err) {
    console.warn('[AuditLog] Failed to persist audit entry:', err);
  }
}

export async function listAuditLogs(limit = 50): Promise<AuditLogRecord[]> {
  return colList<AuditLogRecord>('audit_logs', { orderByField: 'createdAt', direction: 'DESCENDING', limit }).catch(() =>
    colList<AuditLogRecord>('audit_logs', { limit })
  );
}

export async function saveTelemetrySample(sample: TelemetrySampleRecord): Promise<void> {
  try {
    await docSet('telemetry_metrics', sample.id, sample, false);
  } catch {}
}

export async function listTelemetrySamples(limit = 100): Promise<TelemetrySampleRecord[]> {
  return colList<TelemetrySampleRecord>('telemetry_metrics', {
    orderByField: 'createdAt',
    direction: 'DESCENDING',
    limit,
  }).catch(() => colList<TelemetrySampleRecord>('telemetry_metrics', { limit }));
}

// ==================== SERIES & PROJECTS ====================

export async function getSeriesItems(): Promise<SeriesRecord[]> {
  try {
    return await colList<SeriesRecord>('series', { orderByField: 'createdAt', direction: 'DESCENDING', limit: 200 });
  } catch {
    return [];
  }
}

export async function getSeriesItem(id: string): Promise<SeriesRecord | null> {
  try {
    return await docGet<SeriesRecord>('series', id, true);
  } catch (error) {
    console.error(`Error fetching series ${id}:`, error);
    return null;
  }
}

export async function saveSeriesItem(data: SeriesRecord): Promise<void> {
  await docSet('series', data.id, data, false);
}

export async function deleteSeriesItem(id: string): Promise<boolean> {
  await docDelete('series', id);
  return true;
}

// ==================== WRITE-SHARDED VIEWS & ANALYTICS ====================

export async function incrementShardedView(mediaId: string): Promise<void> {
  if (!isValidFirestoreId(mediaId)) return;
  const shardId = `shard_${Math.floor(Math.random() * 10)}`;
  const adminDb = await getAdminFirestoreIfPermitted();
  try {
    if (adminDb) {
      const ref = adminDb.collection('media').doc(mediaId).collection('view_shards').doc(shardId);
      const { FieldValue } = await import('firebase-admin/firestore');
      await ref.set({ count: FieldValue.increment(1), updatedAt: new Date().toISOString() }, { merge: true });
      return;
    }

    const db = getClientDb();
    const { increment } = await import('firebase/firestore');
    const ref = doc(db, 'media', mediaId, 'view_shards', shardId);
    await setDoc(ref, { count: increment(1), updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    // Non-fatal view shard error
  }
}

export async function getShardedViewTotal(mediaId: string): Promise<number> {
  if (!isValidFirestoreId(mediaId)) return 0;
  try {
    const shards = await colList<{ count?: number }>(`media/${mediaId}/view_shards`, { limit: 20 });
    return shards.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
  } catch {
    return 0;
  }
}

export async function recordViewEvent(event: AnalyticsEvent): Promise<void> {
  try {
    await docSet('views', event.id, event, true);
  } catch (error) {
    console.error('Error recording view event:', error);
  }
}

export async function getAnalyticsEvents(mediaId?: string, maxLimit = 500): Promise<AnalyticsEvent[]> {
  try {
    const where =
      mediaId && mediaId !== 'all' ? [{ field: 'mediaId', op: 'EQUAL' as const, value: mediaId }] : undefined;
    return await colList<AnalyticsEvent>('views', {
      where,
      orderByField: 'timestamp',
      direction: 'DESCENDING',
      limit: maxLimit,
    });
  } catch {
    try {
      const all = await colList<AnalyticsEvent>('views', {
        orderByField: 'timestamp',
        direction: 'DESCENDING',
        limit: maxLimit,
      });
      return mediaId && mediaId !== 'all' ? all.filter((e) => e.mediaId === mediaId) : all;
    } catch {
      return [];
    }
  }
}

// ==================== ISSUE REPORTS ====================

export async function getReports(): Promise<ReportRecord[]> {
  try {
    return await colList<ReportRecord>('reports', { orderByField: 'createdAt', direction: 'DESCENDING', limit: 200 });
  } catch {
    return [];
  }
}

export async function saveReport(data: ReportRecord): Promise<void> {
  await docSet('reports', data.id, data, true);
}

export async function updateReportStatus(
  id: string,
  status: 'open' | 'investigating' | 'resolved'
): Promise<ReportRecord | null> {
  const existing = await docGet<ReportRecord>('reports', id, false);
  if (!existing) return null;
  const updated: ReportRecord = { ...existing, status };
  await docSet('reports', id, updated, false);
  return updated;
}

export async function deleteReport(id: string): Promise<boolean> {
  await docDelete('reports', id);
  return true;
}

// Keep unused imports clean for TypeScript
void firestoreLimit;
void collection;
void getDocs;
void query;
void orderBy;
void deleteDoc;
