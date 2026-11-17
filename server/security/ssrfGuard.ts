import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { APP_CONFIG } from '../config.ts';

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr4(ip: string, base: string, maskBits: number): boolean {
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

export function isBlockedIpAddress(rawIp: string): { blocked: boolean; reason?: string } {
  const ip = rawIp.split('%')[0]!.trim().toLowerCase();

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:169.254.169.254)
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (net.isIPv4(mapped)) {
      return isBlockedIpAddress(mapped);
    }
    // Hex form ::ffff:7f00:1
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isBlockedIpAddress(v4);
    }
  }

  if (net.isIPv4(ip)) {
    const blockedRanges4: Array<[string, number, string]> = [
      ['0.0.0.0', 8, 'unspecified/this-network'],
      ['10.0.0.0', 8, 'RFC1918 private network'],
      ['100.64.0.0', 10, 'RFC6598 CGNAT shared address space'],
      ['127.0.0.0', 8, 'loopback'],
      ['169.254.0.0', 16, 'link-local / cloud metadata'],
      ['172.16.0.0', 12, 'RFC1918 private network'],
      ['192.0.0.0', 24, 'IETF protocol assignments'],
      ['192.0.2.0', 24, 'TEST-NET-1'],
      ['192.168.0.0', 16, 'RFC1918 private network'],
      ['198.18.0.0', 15, 'benchmarking network'],
      ['198.51.100.0', 24, 'TEST-NET-2'],
      ['203.0.113.0', 24, 'TEST-NET-3'],
      ['224.0.0.0', 4, 'multicast'],
      ['240.0.0.0', 4, 'reserved'],
    ];
    for (const [base, bits, reason] of blockedRanges4) {
      if (inCidr4(ip, base, bits)) {
        return { blocked: true, reason };
      }
    }
    return { blocked: false };
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') {
      return { blocked: true, reason: 'IPv6 loopback/unspecified' };
    }
    // Unique local fc00::/7 (fc.. or fd..), link-local fe80::/10, multicast ff00::/8
    if (ip.startsWith('fc') || ip.startsWith('fd')) {
      return { blocked: true, reason: 'IPv6 ULA private network' };
    }
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return { blocked: true, reason: 'IPv6 link-local' };
    }
    if (ip.startsWith('ff')) {
      return { blocked: true, reason: 'IPv6 multicast' };
    }
    return { blocked: false };
  }

  return { blocked: true, reason: 'Unrecognized IP format' };
}

export async function resolveAndValidateUrl(rawUrl: string): Promise<{
  parsedUrl: URL;
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
}> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked protocol '${parsed.protocol}'. Only http: and https: are allowed.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not permitted.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`Blocked restricted hostname '${hostname}'.`);
  }

  // Literal IP hostname check
  if (net.isIP(hostname)) {
    const check = isBlockedIpAddress(hostname);
    if (check.blocked) {
      throw new Error(`SSRF Guard blocked address ${hostname} (${check.reason}).`);
    }
    return {
      parsedUrl: parsed,
      pinnedAddress: hostname,
      pinnedFamily: net.isIPv6(hostname) ? 6 : 4,
    };
  }

  // Resolve ALL DNS records before connecting
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error(`DNS resolution returned no addresses for '${hostname}'.`);
  }

  for (const rec of records) {
    const check = isBlockedIpAddress(rec.address);
    if (check.blocked) {
      throw new Error(`SSRF Guard blocked resolved IP ${rec.address} for '${hostname}' (${check.reason}).`);
    }
  }

  const chosen = records[0]!;
  return {
    parsedUrl: parsed,
    pinnedAddress: chosen.address,
    pinnedFamily: chosen.family === 6 ? 6 : 4,
  };
}

export interface SsrfFetchResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  stream: http.IncomingMessage;
  destroy: () => void;
}

// Performs HTTP/HTTPS request directly against DNS-pinned IP with manual redirect re-validation
export async function openSafePinnedRequest(
  targetUrl: string,
  options: {
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    connectTimeoutMs?: number;
    maxRedirects?: number;
  } = {}
): Promise<SsrfFetchResponse> {
  const maxRedirects = options.maxRedirects ?? 3;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  let currentUrl = targetUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { parsedUrl, pinnedAddress, pinnedFamily } = await resolveAndValidateUrl(currentUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const port = parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80;

    const reqOptions: https.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'VidFrame-Importer/2.0',
        Host: parsedUrl.host,
        ...(options.headers || {}),
      },
      // Custom lookup guarantees socket connects strictly to pre-validated IP (prevents TOCTOU DNS rebinding)
      lookup: (_host, _opts, cb) => {
        cb(null, pinnedAddress, pinnedFamily);
      },
      ...(isHttps ? { servername: parsedUrl.hostname } : {}),
    };

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const mod = isHttps ? https : http;
      const req = mod.request(reqOptions, resolve);
      req.setTimeout(connectTimeoutMs, () => {
        req.destroy(new Error(`Connection timed out after ${connectTimeoutMs}ms`));
      });
      req.on('error', reject);
      req.end();
    });

    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume(); // drain redirect response
      if (hop >= maxRedirects) {
        throw new Error(`Exceeded maximum redirect hops (${maxRedirects}).`);
      }
      const nextUrl = new URL(res.headers.location, parsedUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    return {
      statusCode: status,
      headers: res.headers,
      finalUrl: currentUrl,
      stream: res,
      destroy: () => res.destroy(),
    };
  }

  throw new Error('Failed to resolve safe remote endpoint.');
}

const ALLOWED_MEDIA_MIME_PREFIXES = ['video/', 'audio/', 'application/octet-stream', 'application/x-matroska', 'application/mp4'];

export function isAllowedMediaContentType(ct: string | undefined): boolean {
  if (!ct) return true; // fallback checked by magic bytes / extension
  const clean = ct.split(';')[0]!.trim().toLowerCase();
  return ALLOWED_MEDIA_MIME_PREFIXES.some((p) => clean.startsWith(p));
}

export async function safeProbeMediaUrl(rawUrl: string): Promise<{
  url: string;
  valid: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  fileName?: string;
  error?: string;
}> {
  try {
    let resp = await openSafePinnedRequest(rawUrl, { method: 'HEAD', connectTimeoutMs: 10000 });
    if (resp.statusCode === 405 || resp.statusCode === 403 || resp.statusCode === 501) {
      resp.destroy();
      resp = await openSafePinnedRequest(rawUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-1024' },
        connectTimeoutMs: 10000,
      });
    }

    const ok = (resp.statusCode >= 200 && resp.statusCode < 300) || resp.statusCode === 206;
    const contentType = String(resp.headers['content-type'] || 'application/octet-stream');
    const contentLength = Number(resp.headers['content-length'] || 0);
    const disposition = String(resp.headers['content-disposition'] || '');
    const finalUrl = resp.finalUrl;
    resp.destroy();

    if (!ok) {
      return { url: rawUrl, valid: false, status: resp.statusCode, error: `Link returned HTTP ${resp.statusCode}` };
    }

    if (!isAllowedMediaContentType(contentType) && contentType.includes('text/html')) {
      return {
        url: rawUrl,
        valid: false,
        status: resp.statusCode,
        error: `Rejected HTML webpage (${contentType}); direct media stream required.`,
      };
    }

    if (contentLength > APP_CONFIG.maxUrlImportBytes) {
      return {
        url: rawUrl,
        valid: false,
        status: resp.statusCode,
        error: `Remote file exceeds maximum import limit (${Math.round(APP_CONFIG.maxUrlImportBytes / (1024 ** 3))} GB).`,
      };
    }

    let fileName = '';
    if (disposition.includes('filename=')) {
      const m = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (m?.[1]) fileName = m[1].replace(/['"]/g, '').trim();
    }
    if (!fileName) {
      try {
        fileName = path.basename(new URL(finalUrl).pathname);
      } catch {}
    }
    if (!fileName || fileName === '/' || !fileName.includes('.')) {
      fileName = 'video.mp4';
    }

    return {
      url: rawUrl,
      valid: true,
      status: resp.statusCode,
      contentType,
      contentLength,
      fileName,
    };
  } catch (err: any) {
    return {
      url: rawUrl,
      valid: false,
      error: err?.message || 'SSRF validation or connection failed.',
    };
  }
}

export async function safeDownloadUrlToTempFile(
  rawUrl: string,
  destPath: string,
  options: { maxBytes?: number; totalTimeoutMs?: number; stallTimeoutMs?: number } = {}
): Promise<{ fileName: string; mimeType: string; size: number; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? APP_CONFIG.maxUrlImportBytes;
  const totalTimeoutMs = options.totalTimeoutMs ?? 15 * 60 * 1000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 30 * 1000;

  const resp = await openSafePinnedRequest(rawUrl, { method: 'GET', connectTimeoutMs: 10000 });
  const ok = (resp.statusCode >= 200 && resp.statusCode < 300) || resp.statusCode === 206;
  if (!ok) {
    resp.destroy();
    throw new Error(`Remote server returned HTTP ${resp.statusCode}`);
  }

  const headerType = String(resp.headers['content-type'] || '');
  if (!isAllowedMediaContentType(headerType) && headerType.toLowerCase().includes('text/html')) {
    resp.destroy();
    throw new Error(`Rejected non-media content type: ${headerType}`);
  }

  const contentLength = Number(resp.headers['content-length'] || 0);
  if (contentLength > maxBytes) {
    resp.destroy();
    throw new Error(`File size (${contentLength} bytes) exceeds allowed import limit.`);
  }

  let fileName = '';
  const disposition = String(resp.headers['content-disposition'] || '');
  if (disposition.includes('filename=')) {
    const m = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (m?.[1]) fileName = m[1].replace(/['"]/g, '').trim();
  }
  if (!fileName) {
    try {
      fileName = path.basename(new URL(resp.finalUrl).pathname);
    } catch {}
  }
  if (!fileName || fileName === '/' || !fileName.includes('.')) {
    fileName = `video_${Date.now()}.mp4`;
  }
  fileName = fileName.replace(/[^\w\s.-]/gi, '_');

  const writeStream = fs.createWriteStream(destPath);
  let downloadedBytes = 0;
  let stallTimer: NodeJS.Timeout | null = null;
  let totalTimer: NodeJS.Timeout | null = null;

  await new Promise<void>((resolve, reject) => {
    const cleanupTimers = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (totalTimer) clearTimeout(totalTimer);
    };

    const fail = (err: Error) => {
      cleanupTimers();
      resp.destroy();
      writeStream.destroy();
      reject(err);
    };

    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail(new Error('Remote download stalled (idle timeout exceeded).')), stallTimeoutMs);
    };

    totalTimer = setTimeout(() => fail(new Error('Remote download exceeded maximum duration.')), totalTimeoutMs);
    resetStall();

    resp.stream.on('data', (chunk: Buffer) => {
      resetStall();
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxBytes) {
        fail(new Error(`Downloaded bytes exceeded maximum import limit (${maxBytes} bytes).`));
        return;
      }
      if (!writeStream.write(chunk)) {
        resp.stream.pause();
        writeStream.once('drain', () => resp.stream.resume());
      }
    });

    resp.stream.on('end', () => {
      cleanupTimers();
      writeStream.end(() => resolve());
    });

    resp.stream.on('error', (err) => fail(err));
    writeStream.on('error', (err) => fail(err));
  });

  const mimeType = fileName.toLowerCase().endsWith('.mkv')
    ? 'video/x-matroska'
    : headerType.startsWith('video/')
    ? headerType.split(';')[0]!.trim()
    : 'video/mp4';

  return {
    fileName,
    mimeType,
    size: downloadedBytes,
    finalUrl: resp.finalUrl,
  };
}
