import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
}

let cachedFirebaseConfig: FirebaseAppletConfig | null = null;

export function getFirebaseConfig(): FirebaseAppletConfig {
  if (cachedFirebaseConfig) return cachedFirebaseConfig;

  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('firebase-applet-config.json is missing from project root.');
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cachedFirebaseConfig = parsed as FirebaseAppletConfig;
  return cachedFirebaseConfig;
}

export type StorageBackendMode = 'telegram' | 's3_r2' | 'local_dev';
export type QueueDriverMode = 'firestore' | 'cloud_tasks' | 'pubsub';

export const APP_CONFIG = {
  isProduction: process.env.NODE_ENV === 'production',
  multiNodeMode: process.env.MULTI_NODE_MODE === 'true',
  bootstrapAdminEmail: (process.env.ADMIN_EMAIL || 'simoonabdulla@gmail.com').trim().toLowerCase(),
  appUrl: (process.env.APP_URL || '').trim(),

  // Storage defaults
  defaultStorageBackend: (process.env.STORAGE_BACKEND as StorageBackendMode) || 'telegram',

  // Queue driver defaults (firestore for local/single-node; cloud_tasks or pubsub for distributed)
  queueDriver: (process.env.JOB_QUEUE_DRIVER as QueueDriverMode) || 'firestore',

  // AI model configuration (aligned with @google/genai active model table)
  ai: {
    transcriptionModel: process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-3.5-transcribe',
    translationModel: process.env.GEMINI_TRANSLATION_MODEL || 'gemini-4-hydrogen',
    analysisModel: process.env.GEMINI_ANALYSIS_MODEL || 'gemini-4-hydrogen',
  },

  // Security & signed playback defaults
  signedPlaybackDefaultTtlSec: Number(process.env.SIGNED_URL_TTL_SECONDS || 3600),
  maxUrlImportBytes: Number(process.env.MAX_URL_IMPORT_BYTES || 4 * 1024 * 1024 * 1024), // 4GB
};

let ephemeralDevSigningSecret: string | null = null;

export function getSigningSecret(): { secret: string; keyId: string } {
  const envSecret = (process.env.HMAC_SIGNING_SECRET || process.env.ADMIN_SECRET_KEY || '').trim();
  const keyId = process.env.HMAC_SIGNING_KEY_ID || 'vf_k1';

  if (envSecret && envSecret !== 'super-secret-admin-session-signing-token' && envSecret.length >= 16) {
    return { secret: envSecret, keyId };
  }

  // Derive deterministic project-bound fallback in local dev if secret manager isn't configured,
  // or generate per-process ephemeral secret in production if misconfigured (never ship hardcoded static string).
  if (APP_CONFIG.isProduction && !ephemeralDevSigningSecret) {
    console.warn('[Security] HMAC_SIGNING_SECRET not set in production! Using ephemeral runtime key (signed URLs reset on restart).');
    ephemeralDevSigningSecret = crypto.randomBytes(32).toString('hex');
  }
  if (ephemeralDevSigningSecret) {
    return { secret: ephemeralDevSigningSecret, keyId };
  }

  const keyFile = path.resolve(process.cwd(), '.hmac_signing_key');
  if (fs.existsSync(keyFile)) {
    try {
      const saved = fs.readFileSync(keyFile, 'utf8').trim();
      if (saved.length >= 32) {
        return { secret: saved, keyId };
      }
    } catch {}
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, generated, { encoding: 'utf8', mode: 0o600 });
  } catch {}
  return { secret: generated, keyId };
}
