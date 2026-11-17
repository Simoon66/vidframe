import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_CONFIG } from './config.ts';

const KEY_FILE = path.resolve(process.cwd(), '.telegram_key');

// Legacy deterministic seed (only used for decrypting historical records during rotation)
function getLegacyDeterministicSeed(): string {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.projectId && config.appId) {
        return `${config.projectId}:${config.appId}:vidframe-permanent-secure-salt-2026`;
      }
    }
  } catch {}
  return 'vidframe-permanent-default-master-key-seed-2026';
}

export function getPrimaryEncryptionKey(): Buffer {
  const envKey = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  if (envKey && envKey.trim().length >= 32) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey.trim())) {
      return Buffer.from(envKey.trim(), 'hex');
    }
    return crypto.createHash('sha256').update(envKey.trim()).digest();
  }

  if (fs.existsSync(KEY_FILE)) {
    try {
      const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(saved)) {
        return Buffer.from(saved, 'hex');
      }
    } catch {}
  }

  // Generate strong random 256-bit local key (do not write static predictable seeds for new secrets in prod)
  if (APP_CONFIG.isProduction) {
    console.warn('[Crypto] TELEGRAM_SESSION_ENCRYPTION_KEY not set in production! Configure Secret Manager.');
  }

  const randomKey = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, randomKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch {}
  return randomKey;
}

export function encryptSession(plainText: string): { encryptedSession: string; iv: string; authTag: string } {
  const key = getPrimaryEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encryptedSession: encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decryptSession(encryptedHex: string, ivHex: string, authTagHex: string): {
  session: string;
  usedLegacyKey: boolean;
} {
  if (encryptedHex.startsWith('1Ap') || encryptedHex.startsWith('1B')) {
    return { session: encryptedHex, usedLegacyKey: true };
  }

  const primaryKey = getPrimaryEncryptionKey();
  const primaryHex = primaryKey.toString('hex');
  const keysToTry: Buffer[] = [primaryKey];

  if (fs.existsSync(KEY_FILE)) {
    try {
      const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(saved)) {
        keysToTry.push(Buffer.from(saved, 'hex'));
      }
    } catch {}
  }

  // Key-rotation compatibility chain for existing saved Telegram sessions
  keysToTry.push(crypto.createHash('sha256').update(getLegacyDeterministicSeed()).digest());
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.projectId) keysToTry.push(crypto.createHash('sha256').update(cfg.projectId).digest());
      if (cfg.apiKey) keysToTry.push(crypto.createHash('sha256').update(cfg.apiKey).digest());
      if (cfg.firestoreDatabaseId) keysToTry.push(crypto.createHash('sha256').update(cfg.firestoreDatabaseId).digest());
      if (cfg.appId) keysToTry.push(crypto.createHash('sha256').update(cfg.appId).digest());
    }
  } catch {}
  keysToTry.push(Buffer.from('2f098bc8fde9967bb8be7b7bfc6f0fd368a8ee5a64e2f54497bae26fb244dae4', 'hex'));
  keysToTry.push(crypto.createHash('sha256').update('vidframe-permanent-default-master-key-seed-2026').digest());
  keysToTry.push(crypto.createHash('sha256').update('telegram-session-secret-key-2026').digest());

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  let lastError: any = null;
  const seenHex = new Set<string>();
  for (const key of keysToTry) {
    const keyHex = key.toString('hex');
    if (seenHex.has(keyHex)) continue;
    seenHex.add(keyHex);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      if (decrypted && decrypted.length > 0) {
        return {
          session: decrypted,
          usedLegacyKey: keyHex !== primaryHex,
        };
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('Unable to decrypt session data with any known keys.');
}

export function encryptJsonSecret(data: unknown): { ciphertext: string; iv: string; authTag: string } {
  const res = encryptSession(JSON.stringify(data));
  return { ciphertext: res.encryptedSession, iv: res.iv, authTag: res.authTag };
}

export function decryptJsonSecret<T = any>(ciphertext: string, iv: string, authTag: string): T {
  const { session } = decryptSession(ciphertext, iv, authTag);
  return JSON.parse(session) as T;
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function hmacSha256Base64Url(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
