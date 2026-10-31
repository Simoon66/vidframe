import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = path.resolve(process.cwd(), '.telegram_key');

// Get project-specific permanent deterministic seed from firebase-applet-config.json
function getProjectDeterministicSeed(): string {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.projectId && config.appId) {
        return `${config.projectId}:${config.appId}:vidframe-permanent-secure-salt-2026`;
      }
    }
  } catch {
    // ignore
  }
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

  // Persistent file key
  if (fs.existsSync(KEY_FILE)) {
    try {
      const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(saved)) {
        return Buffer.from(saved, 'hex');
      }
    } catch {
      // ignore
    }
  }

  // Deterministic fallback based on immutable project configuration
  const seed = getProjectDeterministicSeed();
  const deterministicKey = crypto.createHash('sha256').update(seed).digest();

  try {
    fs.writeFileSync(KEY_FILE, deterministicKey.toString('hex'), 'utf8');
  } catch {
    // ignore
  }
  return deterministicKey;
}

export function encryptSession(plainText: string): { encryptedSession: string; iv: string; authTag: string } {
  const key = getPrimaryEncryptionKey();
  const iv = crypto.randomBytes(12); // Standard 12-byte IV for AES-GCM
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

export function decryptSession(encryptedHex: string, ivHex: string, authTagHex: string): string {
  // If plain string session was somehow passed
  if (encryptedHex.startsWith('1Ap') || encryptedHex.startsWith('1B')) {
    return encryptedHex;
  }

  const keysToTry: Buffer[] = [];

  // 1. Primary key & key file
  keysToTry.push(getPrimaryEncryptionKey());

  // 2. Deterministic project seed key
  const seed = getProjectDeterministicSeed();
  keysToTry.push(crypto.createHash('sha256').update(seed).digest());

  // 3. Known key stored in file if any
  try {
    if (fs.existsSync(KEY_FILE)) {
      const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(saved)) {
        keysToTry.push(Buffer.from(saved, 'hex'));
      }
    }
  } catch {}

  // 4. Fallback project-derived seeds
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

  // 5. Historical seeds
  keysToTry.push(Buffer.from('2f098bc8fde9967bb8be7b7bfc6f0fd368a8ee5a64e2f54497bae26fb244dae4', 'hex'));
  keysToTry.push(crypto.createHash('sha256').update('vidframe-permanent-default-master-key-seed-2026').digest());
  keysToTry.push(crypto.createHash('sha256').update('telegram-session-secret-key-2026').digest());

  if (process.env.TELEGRAM_SESSION_ENCRYPTION_KEY) {
    keysToTry.push(crypto.createHash('sha256').update(process.env.TELEGRAM_SESSION_ENCRYPTION_KEY.trim()).digest());
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  let lastError: any = null;
  // Deduplicate keys by hex string
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
        return decrypted;
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('Unable to decrypt session data with any known keys.');
}
