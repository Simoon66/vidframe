import { APP_CONFIG, StorageBackendMode } from '../config.ts';
import { getStorageConfig, saveStorageConfig, StorageConfig } from '../db.ts';
import { encryptJsonSecret, decryptJsonSecret } from '../crypto.ts';
import { ObjectStorageAdapter } from './types.ts';
import { S3CompatibleStorageAdapter } from './s3Adapter.ts';
import { TelegramStorageAdapter } from './telegramAdapter.ts';
import { LocalDevStorageAdapter } from './localDevAdapter.ts';

function buildS3AdapterFromEnvOrConfig(cfg: StorageConfig | null): S3CompatibleStorageAdapter | null {
  const endpoint = process.env.S3_ENDPOINT || cfg?.s3Endpoint || '';
  const bucket = process.env.S3_BUCKET || cfg?.s3Bucket || '';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || cfg?.s3AccessKeyId || '';
  const region = process.env.S3_REGION || cfg?.s3Region || 'auto';
  const cdnBaseUrl = process.env.S3_CDN_BASE_URL || cfg?.s3CdnBaseUrl || '';
  const forcePathStyle = cfg?.s3ForcePathStyle ?? true;

  let secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '';
  if (!secretAccessKey && cfg?.s3EncryptedSecret) {
    try {
      const decrypted = decryptJsonSecret<{ secretAccessKey: string }>(
        cfg.s3EncryptedSecret.ciphertext,
        cfg.s3EncryptedSecret.iv,
        cfg.s3EncryptedSecret.authTag
      );
      secretAccessKey = decrypted.secretAccessKey || '';
    } catch {}
  }

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3CompatibleStorageAdapter({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    cdnBaseUrl,
  });
}

export async function getStorageAdapter(preferredBackend?: StorageBackendMode): Promise<ObjectStorageAdapter> {
  const cfg = await getStorageConfig().catch(() => null);
  const mode: StorageBackendMode =
    preferredBackend || cfg?.backend || APP_CONFIG.defaultStorageBackend || 'telegram';

  if (mode === 's3_r2') {
    const s3 = buildS3AdapterFromEnvOrConfig(cfg);
    if (!s3) {
      throw new Error('S3 / Cloudflare R2 backend is selected but credentials/bucket are incomplete.');
    }
    return s3;
  }

  if (mode === 'local_dev') {
    return new LocalDevStorageAdapter();
  }

  return new TelegramStorageAdapter();
}

export async function testAndSaveS3Config(input: {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string;
  cdnBaseUrl?: string;
  forcePathStyle?: boolean;
  activateAsDefault?: boolean;
}): Promise<{ ok: boolean; detail: string; sanitizedConfig: any }> {
  const existing = await getStorageConfig().catch(() => null);

  let effectiveSecret = (input.secretAccessKey || '').trim();
  if (!effectiveSecret && existing?.s3EncryptedSecret) {
    const decrypted = decryptJsonSecret<{ secretAccessKey: string }>(
      existing.s3EncryptedSecret.ciphertext,
      existing.s3EncryptedSecret.iv,
      existing.s3EncryptedSecret.authTag
    );
    effectiveSecret = decrypted.secretAccessKey;
  }

  if (!effectiveSecret) {
    throw new Error('S3/R2 Secret Access Key is required.');
  }

  const adapter = new S3CompatibleStorageAdapter({
    endpoint: input.endpoint.trim(),
    region: (input.region || 'auto').trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey: effectiveSecret,
    cdnBaseUrl: input.cdnBaseUrl?.trim(),
    forcePathStyle: input.forcePathStyle ?? true,
  });

  const health = await adapter.healthCheck();
  if (!health.ok) {
    throw new Error(health.detail);
  }

  const encryptedSecret = encryptJsonSecret({ secretAccessKey: effectiveSecret });
  const nextConfig: StorageConfig = {
    backend: input.activateAsDefault ? 's3_r2' : existing?.backend || 's3_r2',
    chatId: existing?.chatId || '',
    chatTitle: existing?.chatTitle || '',
    canUpload: existing?.canUpload ?? false,
    canRead: existing?.canRead ?? false,
    s3Endpoint: input.endpoint.trim(),
    s3Region: (input.region || 'auto').trim(),
    s3Bucket: input.bucket.trim(),
    s3AccessKeyId: input.accessKeyId.trim(),
    s3EncryptedSecret: encryptedSecret,
    s3CdnBaseUrl: input.cdnBaseUrl?.trim() || '',
    s3ForcePathStyle: input.forcePathStyle ?? true,
    updatedAt: new Date().toISOString(),
  };

  await saveStorageConfig(nextConfig);

  return {
    ok: true,
    detail: health.detail,
    sanitizedConfig: sanitizeStorageConfigForClient(nextConfig),
  };
}

export async function switchActiveStorageBackend(backend: StorageBackendMode): Promise<any> {
  if (backend === 'local_dev' && APP_CONFIG.multiNodeMode) {
    throw new Error('Local dev storage cannot be enabled when MULTI_NODE_MODE=true.');
  }
  const existing = await getStorageConfig().catch(() => null);
  if (backend === 's3_r2') {
    const s3 = buildS3AdapterFromEnvOrConfig(existing);
    if (!s3) {
      throw new Error('Configure S3 / R2 credentials before switching active backend to s3_r2.');
    }
  }
  const next: StorageConfig = {
    backend,
    chatId: existing?.chatId || '',
    chatTitle: existing?.chatTitle || '',
    canUpload: existing?.canUpload ?? false,
    canRead: existing?.canRead ?? false,
    s3Endpoint: existing?.s3Endpoint,
    s3Region: existing?.s3Region,
    s3Bucket: existing?.s3Bucket,
    s3AccessKeyId: existing?.s3AccessKeyId,
    s3EncryptedSecret: existing?.s3EncryptedSecret,
    s3CdnBaseUrl: existing?.s3CdnBaseUrl,
    s3ForcePathStyle: existing?.s3ForcePathStyle,
    updatedAt: new Date().toISOString(),
  };
  await saveStorageConfig(next);
  return sanitizeStorageConfigForClient(next);
}

// Never leak ciphertext/iv/authTag or secrets to frontend responses
export function sanitizeStorageConfigForClient(cfg: StorageConfig | null) {
  if (!cfg) {
    return {
      configured: false,
      backend: APP_CONFIG.defaultStorageBackend,
      multiNodeMode: APP_CONFIG.multiNodeMode,
    };
  }
  const { s3EncryptedSecret, ...rest } = cfg;
  return {
    ...rest,
    backend: cfg.backend || (cfg.chatId ? 'telegram' : APP_CONFIG.defaultStorageBackend),
    s3Configured: Boolean(cfg.s3Endpoint && cfg.s3Bucket && cfg.s3AccessKeyId && s3EncryptedSecret),
    configured: Boolean(cfg.chatId || (cfg.s3Endpoint && cfg.s3Bucket && s3EncryptedSecret) || cfg.backend === 'local_dev'),
    multiNodeMode: APP_CONFIG.multiNodeMode,
  };
}
