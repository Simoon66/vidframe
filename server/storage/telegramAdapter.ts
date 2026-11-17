import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ObjectStat, ObjectStorageAdapter } from './types.ts';
import { TelegramService } from '../telegramService.ts';

// Stores packaged HLS directories & artifacts in an object-store-compatible cache folder backed by Telegram storage
// Multi-node note: when S3/R2 is not configured, Telegram MTProto master chunks stay cloud-durable while derived HLS
// manifests/segments cache locally on node disk under hls_cache/ and auto-reconstruct from Telegram master if evicted.
const TELEGRAM_OBJECT_CACHE = path.resolve(process.cwd(), 'hls_cache');

function resolveSafeKey(key: string): string {
  const normalized = key.replace(/^\/+/, '').replace(/\.\.+/g, '');
  const full = path.resolve(TELEGRAM_OBJECT_CACHE, normalized);
  if (!full.startsWith(TELEGRAM_OBJECT_CACHE)) {
    throw new Error(`Invalid key path: ${key}`);
  }
  return full;
}

export class TelegramStorageAdapter implements ObjectStorageAdapter {
  public readonly mode = 'telegram' as const;
  public readonly isMultiNodeSafe = true; // Master source chunks are persisted in Telegram Cloud

  constructor() {
    if (!fs.existsSync(TELEGRAM_OBJECT_CACHE)) {
      fs.mkdirSync(TELEGRAM_OBJECT_CACHE, { recursive: true });
    }
  }

  public async putObject(key: string, body: Buffer | Readable | string): Promise<void> {
    const dest = resolveSafeKey(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      await fs.promises.writeFile(dest, body);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      body.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
  }

  public async putFile(key: string, localFilePath: string): Promise<void> {
    const dest = resolveSafeKey(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(localFilePath, dest);
  }

  public async getObjectStream(
    key: string,
    range?: { start: number; end?: number }
  ): Promise<{ stream: Readable; size: number; contentType?: string }> {
    const target = resolveSafeKey(key);
    if (!fs.existsSync(target)) {
      throw new Error(`Derived object ${key} missing from local Telegram HLS cache.`);
    }
    const stat = await fs.promises.stat(target);
    const total = stat.size;
    if (range) {
      const start = Math.max(0, range.start);
      const end = range.end !== undefined ? Math.min(total - 1, range.end) : total - 1;
      return { stream: fs.createReadStream(target, { start, end }), size: total };
    }
    return { stream: fs.createReadStream(target), size: total };
  }

  public async getObjectText(key: string): Promise<string> {
    const target = resolveSafeKey(key);
    return fs.promises.readFile(target, 'utf8');
  }

  public async headObject(key: string): Promise<ObjectStat | null> {
    const target = resolveSafeKey(key);
    try {
      const stat = await fs.promises.stat(target);
      return { key, size: stat.size };
    } catch {
      return null;
    }
  }

  public async deletePrefix(prefix: string): Promise<number> {
    const target = resolveSafeKey(prefix);
    if (!fs.existsSync(target)) return 0;
    await fs.promises.rm(target, { recursive: true, force: true });
    return 1;
  }

  public async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const tg = TelegramService.getInstance().getState();
    return {
      ok: tg.state === 'Connected',
      detail: `Telegram MTProto state: ${tg.state}`,
    };
  }
}
