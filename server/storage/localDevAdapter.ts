import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { APP_CONFIG } from '../config.ts';
import { ObjectStat, ObjectStorageAdapter } from './types.ts';

const DEFAULT_LOCAL_ROOT = path.resolve(process.cwd(), 'local_object_store');

function resolveSafeKey(rootDir: string, key: string): string {
  const normalized = key.replace(/^\/+/, '').replace(/\.\.+/g, '');
  const full = path.resolve(rootDir, normalized);
  if (!full.startsWith(rootDir)) {
    throw new Error(`Invalid storage key traversal rejected: ${key}`);
  }
  return full;
}

export class LocalDevStorageAdapter implements ObjectStorageAdapter {
  public readonly mode = 'local_dev' as const;
  public readonly isMultiNodeSafe = false;
  private readonly rootDir: string;

  constructor(rootDir = DEFAULT_LOCAL_ROOT) {
    if (APP_CONFIG.multiNodeMode) {
      throw new Error(
        'LocalDevStorageAdapter cannot be used when MULTI_NODE_MODE=true. Configure S3/Cloudflare R2 or Telegram storage for multi-instance deployments.'
      );
    }
    this.rootDir = rootDir;
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }

  public async putObject(key: string, body: Buffer | Readable | string): Promise<void> {
    const dest = resolveSafeKey(this.rootDir, key);
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
      body.on('error', reject);
    });
  }

  public async putFile(key: string, localFilePath: string): Promise<void> {
    const dest = resolveSafeKey(this.rootDir, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(localFilePath, dest);
  }

  public async getObjectStream(
    key: string,
    range?: { start: number; end?: number }
  ): Promise<{ stream: Readable; size: number; contentType?: string }> {
    const target = resolveSafeKey(this.rootDir, key);
    if (!fs.existsSync(target)) {
      throw new Error(`Object not found in local store: ${key}`);
    }
    const stat = await fs.promises.stat(target);
    const total = stat.size;
    if (range) {
      const start = Math.max(0, range.start);
      const end = range.end !== undefined ? Math.min(total - 1, range.end) : total - 1;
      return {
        stream: fs.createReadStream(target, { start, end }),
        size: total,
      };
    }
    return {
      stream: fs.createReadStream(target),
      size: total,
    };
  }

  public async getObjectText(key: string): Promise<string> {
    const target = resolveSafeKey(this.rootDir, key);
    return fs.promises.readFile(target, 'utf8');
  }

  public async headObject(key: string): Promise<ObjectStat | null> {
    const target = resolveSafeKey(this.rootDir, key);
    try {
      const stat = await fs.promises.stat(target);
      return { key, size: stat.size };
    } catch {
      return null;
    }
  }

  public async deletePrefix(prefix: string): Promise<number> {
    const target = resolveSafeKey(this.rootDir, prefix);
    if (!fs.existsSync(target)) return 0;
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) {
      await fs.promises.rm(target, { recursive: true, force: true });
      return 1;
    }
    await fs.promises.unlink(target);
    return 1;
  }

  public async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      fs.accessSync(this.rootDir, fs.constants.W_OK);
      return { ok: true, detail: `Local dev store writable (${this.rootDir})` };
    } catch (e: any) {
      return { ok: false, detail: e?.message || 'Local store not writable' };
    }
  }
}
