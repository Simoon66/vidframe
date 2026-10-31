import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  orderBy,
  Firestore,
} from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';

let dbInstance: Firestore | null = null;

export function getDb(): Firestore {
  if (dbInstance) return dbInstance;

  let config: any = null;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse firebase-applet-config.json:', e);
    }
  }

  if (!config) {
    throw new Error('Firebase configuration file firebase-applet-config.json not found');
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  dbInstance = getFirestore(app, config.firestoreDatabaseId);
  return dbInstance;
}

export interface StoredTelegramSession {
  encryptedSession: string;
  iv: string;
  authTag: string;
  phoneMasked?: string;
  userId?: string;
  username?: string;
  firstName?: string;
  connectedAt: string;
  updatedAt: string;
}

export interface StorageConfig {
  chatId: string;
  chatTitle: string;
  canUpload: boolean;
  canRead: boolean;
  updatedAt: string;
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
  audioTracks?: Array<{
    index: number;
    language?: string;
    title?: string;
    codec?: string;
    channels?: number;
  }>;
  subtitleTracks?: Array<{
    index: number;
    language?: string;
    title?: string;
    format?: string;
    url?: string;
  }>;
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

// Telegram Session Firestore Ops
export async function getSavedTelegramSession(): Promise<StoredTelegramSession | null> {
  try {
    const db = getDb();
    const docRef = doc(db, 'settings', 'telegram');
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as StoredTelegramSession;
    }
    return null;
  } catch (error) {
    console.error('Error fetching telegram session from Firestore:', error);
    return null;
  }
}

export async function saveTelegramSession(data: StoredTelegramSession): Promise<void> {
  const db = getDb();
  const docRef = doc(db, 'settings', 'telegram');
  await setDoc(docRef, sanitizeFirestoreData(data));
}

export async function deleteTelegramSession(): Promise<void> {
  const db = getDb();
  const docRef = doc(db, 'settings', 'telegram');
  await deleteDoc(docRef);
}

// Storage Config Firestore Ops
export async function getStorageConfig(): Promise<StorageConfig | null> {
  try {
    const db = getDb();
    const docRef = doc(db, 'settings', 'storage');
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as StorageConfig;
    }
    return null;
  } catch (error) {
    console.error('Error fetching storage config:', error);
    return null;
  }
}

export async function saveStorageConfig(data: StorageConfig): Promise<void> {
  const db = getDb();
  const docRef = doc(db, 'settings', 'storage');
  await setDoc(docRef, sanitizeFirestoreData(data));
}

// Media Records Firestore Ops
export async function getMediaItems(): Promise<MediaRecord[]> {
  try {
    const db = getDb();
    const colRef = collection(db, 'media');
    const q = query(colRef, orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as MediaRecord);
  } catch (error) {
    try {
      const db = getDb();
      const colRef = collection(db, 'media');
      const snap = await getDocs(colRef);
      return snap.docs.map((d) => d.data() as MediaRecord);
    } catch (innerError) {
      console.error('Error fetching media items:', innerError);
      return [];
    }
  }
}

export async function getMediaItem(id: string): Promise<MediaRecord | null> {
  try {
    const db = getDb();
    const docRef = doc(db, 'media', id);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as MediaRecord;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching media item ${id}:`, error);
    return null;
  }
}

export async function saveMediaItem(data: MediaRecord): Promise<void> {
  const db = getDb();
  const docRef = doc(db, 'media', data.id);
  const cleanPayload = sanitizeFirestoreData({
    ...data,
    duration: typeof data.duration === 'number' && !isNaN(data.duration) ? data.duration : 0,
    introStart: data.introStart || 0,
    introEnd: data.introEnd || 0,
    outroStart: data.outroStart || 0,
    outroEnd: data.outroEnd || 0,
    description: data.description || '',
  });
  await setDoc(docRef, cleanPayload);
}

export async function updateMediaItem(id: string, updates: Partial<MediaRecord>): Promise<MediaRecord | null> {
  const existing = await getMediaItem(id);
  if (!existing) return null;
  const updated: MediaRecord = {
    ...existing,
    ...updates,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  };
  await saveMediaItem(updated);
  return updated;
}

export async function deleteMediaItem(id: string): Promise<boolean> {
  const db = getDb();
  const docRef = doc(db, 'media', id);
  await deleteDoc(docRef);
  return true;
}

// Series & Projects Firestore Ops
export async function getSeriesItems(): Promise<SeriesRecord[]> {
  try {
    const db = getDb();
    const colRef = collection(db, 'series');
    const q = query(colRef, orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as SeriesRecord);
  } catch (error) {
    try {
      const db = getDb();
      const colRef = collection(db, 'series');
      const snap = await getDocs(colRef);
      return snap.docs.map((d) => d.data() as SeriesRecord);
    } catch (innerError) {
      console.error('Error fetching series items:', innerError);
      return [];
    }
  }
}

export async function getSeriesItem(id: string): Promise<SeriesRecord | null> {
  try {
    const db = getDb();
    const docRef = doc(db, 'series', id);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as SeriesRecord;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching series ${id}:`, error);
    return null;
  }
}

export async function saveSeriesItem(data: SeriesRecord): Promise<void> {
  const db = getDb();
  const docRef = doc(db, 'series', data.id);
  await setDoc(docRef, sanitizeFirestoreData(data));
}

export async function deleteSeriesItem(id: string): Promise<boolean> {
  const db = getDb();
  const docRef = doc(db, 'series', id);
  await deleteDoc(docRef);
  return true;
}

// Analytics Firestore Ops
export async function recordViewEvent(event: AnalyticsEvent): Promise<void> {
  try {
    const db = getDb();
    const docRef = doc(db, 'views', event.id);
    await setDoc(docRef, sanitizeFirestoreData(event));
  } catch (error) {
    console.error('Error recording view event:', error);
  }
}

export async function getAnalyticsEvents(mediaId?: string): Promise<AnalyticsEvent[]> {
  try {
    const db = getDb();
    const colRef = collection(db, 'views');
    const q = query(colRef, orderBy('timestamp', 'desc'));
    const snap = await getDocs(q);
    const all = snap.docs.map((d) => d.data() as AnalyticsEvent);
    if (mediaId && mediaId !== 'all') {
      return all.filter((e) => e.mediaId === mediaId);
    }
    return all;
  } catch (error) {
    console.error('Error fetching analytics events:', error);
    return [];
  }
}

// Issue Reports Firestore Ops
export async function getReports(): Promise<ReportRecord[]> {
  try {
    const db = getDb();
    const colRef = collection(db, 'reports');
    const q = query(colRef, orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as ReportRecord);
  } catch (error) {
    try {
      const db = getDb();
      const colRef = collection(db, 'reports');
      const snap = await getDocs(colRef);
      return snap.docs.map((d) => d.data() as ReportRecord);
    } catch (inner) {
      console.error('Error fetching reports:', inner);
      return [];
    }
  }
}

export async function saveReport(data: ReportRecord): Promise<void> {
  const db = getDb();
  const docRef = doc(db, 'reports', data.id);
  await setDoc(docRef, sanitizeFirestoreData(data));
}

export async function updateReportStatus(id: string, status: 'open' | 'investigating' | 'resolved'): Promise<ReportRecord | null> {
  const db = getDb();
  const docRef = doc(db, 'reports', id);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  const updated: ReportRecord = {
    ...(snap.data() as ReportRecord),
    status,
  };
  await setDoc(docRef, sanitizeFirestoreData(updated));
  return updated;
}

export async function deleteReport(id: string): Promise<boolean> {
  const db = getDb();
  const docRef = doc(db, 'reports', id);
  await deleteDoc(docRef);
  return true;
}

