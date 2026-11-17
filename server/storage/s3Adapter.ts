import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ObjectStat, ObjectStorageAdapter } from './types.ts';

export interface S3CompatibleConfig {
  endpoint: string; // e.g. https://<accountid>.r2.cloudflarestorage.com or https://s3.us-east-1.amazonaws.com
  region: string;   // e.g. auto or us-east-1
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  cdnBaseUrl?: string;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function uriEncode(str: string, encodeSlash = false): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(encodeSlash ? /%2F/g : /^$/, '/');
}

export class S3CompatibleStorageAdapter implements ObjectStorageAdapter {
  public readonly mode = 's3_r2' as const;
  public readonly isMultiNodeSafe = true;
  private readonly cfg: S3CompatibleConfig;

  constructor(cfg: S3CompatibleConfig) {
    this.cfg = {
      ...cfg,
      endpoint: cfg.endpoint.replace(/\/+$/, ''),
      region: cfg.region || 'auto',
      forcePathStyle: cfg.forcePathStyle ?? true,
    };
  }

  private buildTargetUrl(key: string, queryParams: Record<string, string> = {}): {
    url: URL;
    canonicalUri: string;
    canonicalQuery: string;
  } {
    const base = new URL(this.cfg.endpoint);
    const cleanKey = key.replace(/^\/+/, '');
    let pathname = '';
    if (this.cfg.forcePathStyle) {
      pathname = cleanKey ? `/${this.cfg.bucket}/${cleanKey}` : `/${this.cfg.bucket}`;
    } else {
      base.hostname = `${this.cfg.bucket}.${base.hostname}`;
      pathname = cleanKey ? `/${cleanKey}` : '/';
    }
    const encodedPath = pathname
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');

    const entries = Object.entries(queryParams).sort(([a], [b]) => a.localeCompare(b));
    const canonicalQuery = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const fullUrl = new URL(`${base.origin}${encodedPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`);
    return {
      url: fullUrl,
      canonicalUri: encodedPath || '/',
      canonicalQuery,
    };
  }

  private signHeaders(
    method: string,
    canonicalUri: string,
    canonicalQuery: string,
    hostHeader: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {}
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 's3';
    const region = this.cfg.region || 'auto';

    const headersLower: Record<string, string> = {
      host: hostHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    for (const [k, v] of Object.entries(extraHeaders)) {
      headersLower[k.toLowerCase()] = v.trim();
    }

    const sortedKeys = Object.keys(headersLower).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headersLower[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const out: Record<string, string> = {
      ...extraHeaders,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authorization,
    };
    return out;
  }

  public async putObject(key: string, body: Buffer | Readable | string, contentType = 'application/octet-stream'): Promise<void> {
    let buffer: Buffer;
    if (typeof body === 'string') {
      buffer = Buffer.from(body, 'utf8');
    } else if (Buffer.isBuffer(body)) {
      buffer = body;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }

    const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl(key);
    const payloadHash = sha256Hex(buffer);
    const headers = this.signHeaders('PUT', canonicalUri, canonicalQuery, url.host, payloadHash, {
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
    });

    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers,
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`S3/R2 PUT ${key} failed (${res.status}): ${errText.slice(0, 300)}`);
    }
  }

  public async putFile(key: string, localFilePath: string, contentType = 'application/octet-stream'): Promise<void> {
    const stat = await fs.promises.stat(localFilePath);
    if (stat.size <= 32 * 1024 * 1024) {
      const buf = await fs.promises.readFile(localFilePath);
      return this.putObject(key, buf, contentType);
    }

    // Stream upload with UNSIGNED-PAYLOAD for larger files over HTTPS
    const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl(key);
    const headers = this.signHeaders('PUT', canonicalUri, canonicalQuery, url.host, 'UNSIGNED-PAYLOAD', {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
    });

    const fileStream = Readable.toWeb(fs.createReadStream(localFilePath)) as ReadableStream;
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers,
      body: fileStream,
      duplex: 'half',
    } as any);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`S3/R2 PUT stream ${key} failed (${res.status}): ${errText.slice(0, 300)}`);
    }
  }

  public async getObjectStream(
    key: string,
    range?: { start: number; end?: number }
  ): Promise<{ stream: Readable; size: number; contentType?: string }> {
    const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl(key);
    const extra: Record<string, string> = {};
    if (range) {
      extra.Range = range.end !== undefined ? `bytes=${range.start}-${range.end}` : `bytes=${range.start}-`;
    }
    const headers = this.signHeaders('GET', canonicalUri, canonicalQuery, url.host, 'UNSIGNED-PAYLOAD', extra);
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok && res.status !== 206) {
      throw new Error(`S3/R2 GET ${key} failed (${res.status})`);
    }
    const contentLength = Number(res.headers.get('content-length') || 0);
    const contentRange = res.headers.get('content-range');
    let totalSize = contentLength;
    if (contentRange) {
      const totalMatch = contentRange.match(/\/(\d+)$/);
      if (totalMatch?.[1]) totalSize = Number(totalMatch[1]);
    }
    const stream = res.body ? Readable.fromWeb(res.body as any) : Readable.from([]);
    return {
      stream,
      size: totalSize,
      contentType: res.headers.get('content-type') || undefined,
    };
  }

  public async getObjectText(key: string): Promise<string> {
    const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl(key);
    const headers = this.signHeaders('GET', canonicalUri, canonicalQuery, url.host, 'UNSIGNED-PAYLOAD');
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`S3/R2 GET ${key} failed (${res.status})`);
    }
    return res.text();
  }

  public async headObject(key: string): Promise<ObjectStat | null> {
    const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl(key);
    const headers = this.signHeaders('HEAD', canonicalUri, canonicalQuery, url.host, 'UNSIGNED-PAYLOAD');
    const res = await fetch(url.toString(), { method: 'HEAD', headers });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return {
      key,
      size: Number(res.headers.get('content-length') || 0),
      contentType: res.headers.get('content-type') || undefined,
    };
  }

  public async deletePrefix(prefix: string): Promise<number> {
    const cleanPrefix = prefix.replace(/^\/+/, '');
    const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl('', {
      'list-type': '2',
      prefix: cleanPrefix,
    });
    const listHeaders = this.signHeaders('GET', canonicalUri, canonicalQuery, url.host, 'UNSIGNED-PAYLOAD');
    const listRes = await fetch(url.toString(), { method: 'GET', headers: listHeaders });
    if (!listRes.ok) return 0;
    const xml = await listRes.text();
    const keys = Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g)).map((m) => m[1]!);

    let deleted = 0;
    for (const objKey of keys) {
      const del = this.buildTargetUrl(objKey);
      const delHeaders = this.signHeaders('DELETE', del.canonicalUri, del.canonicalQuery, del.url.host, 'UNSIGNED-PAYLOAD');
      const delRes = await fetch(del.url.toString(), { method: 'DELETE', headers: delHeaders });
      if (delRes.ok || delRes.status === 204) deleted++;
    }
    return deleted;
  }

  public async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { url, canonicalUri, canonicalQuery } = this.buildTargetUrl('', {
        'list-type': '2',
        'max-keys': '1',
      });
      const headers = this.signHeaders('GET', canonicalUri, canonicalQuery, url.host, 'UNSIGNED-PAYLOAD');
      const res = await fetch(url.toString(), { method: 'GET', headers });
      if (res.ok) {
        return { ok: true, detail: `Bucket '${this.cfg.bucket}' reachable (${this.cfg.endpoint})` };
      }
      const errText = await res.text().catch(() => '');
      return { ok: false, detail: `S3/R2 returned HTTP ${res.status}: ${errText.slice(0, 160)}` };
    } catch (e: any) {
      return { ok: false, detail: e?.message || 'S3/R2 bucket connection failed' };
    }
  }
}

void uriEncode;
