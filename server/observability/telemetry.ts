import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveTelemetrySample, listTelemetrySamples, checkFirestoreConnectivity } from '../db.ts';

interface LatencyEntry {
  route: string;
  statusCode: number;
  durationMs: number;
  timestamp: string;
}

const latencyRing: LatencyEntry[] = [];
const MAX_RING = 300;

let playbackErrorsCount = 0;
let playbackBuffersCount = 0;
let totalRequestsCount = 0;
let serverErrorCount = 0;
const processStartedAt = new Date().toISOString();

export function telemetryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - start);
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.originalUrl.split('?')[0]!;
    const statusCode = res.statusCode;

    // Exclude high-frequency static/segment streaming from distorting control-plane latency metrics
    if (route.includes('/cdn/v1/hls/') || route.endsWith('/stream')) {
      return;
    }

    totalRequestsCount++;
    if (statusCode >= 500) serverErrorCount++;

    latencyRing.push({
      route,
      statusCode,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    if (latencyRing.length > MAX_RING) {
      latencyRing.shift();
    }

    // Head-sampled Firestore metric write: 100% of errors & slow (>1000ms) calls, 5% normal calls
    const shouldSample = statusCode >= 500 || durationMs > 1000 || Math.random() < 0.05;
    if (shouldSample) {
      saveTelemetrySample({
        id: `met_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        kind: 'api_latency',
        routeOrMediaId: route.slice(0, 120),
        statusCode,
        durationMs,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  });
  next();
}

export function recordClientPlaybackTelemetry(
  mediaId: string,
  kind: 'playback_error' | 'playback_buffer',
  detail?: string
): void {
  if (kind === 'playback_error') playbackErrorsCount++;
  else playbackBuffersCount++;

  saveTelemetrySample({
    id: `play_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    kind,
    routeOrMediaId: mediaId,
    detail: detail ? detail.slice(0, 240) : undefined,
    createdAt: new Date().toISOString(),
  }).catch(() => {});
}

export function getTelemetrySummary() {
  const durations = latencyRing.map((e) => e.durationMs).sort((a, b) => a - b);
  const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : 0;
  const p95 = durations.length > 0 ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;
  const avg = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0;

  return {
    startedAt: processStartedAt,
    uptimeSeconds: Math.round(process.uptime()),
    totalRequests: totalRequestsCount,
    serverErrors: serverErrorCount,
    errorRatePercent: totalRequestsCount > 0 ? Number(((serverErrorCount / totalRequestsCount) * 100).toFixed(2)) : 0,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    avgLatencyMs: avg,
    playbackErrors: playbackErrorsCount,
    playbackBuffers: playbackBuffersCount,
    memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    recentLatencies: latencyRing.slice(-30).reverse(),
  };
}

let cachedFfmpegVersion: string | null = null;
export function checkFfmpegAvailable(): { available: boolean; version: string } {
  if (cachedFfmpegVersion !== null) {
    return { available: cachedFfmpegVersion !== 'unavailable', version: cachedFfmpegVersion };
  }
  try {
    const res = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 3000 });
    if (res.status === 0 && res.stdout) {
      const firstLine = res.stdout.split('\n')[0] || 'ffmpeg available';
      cachedFfmpegVersion = firstLine.trim();
      return { available: true, version: cachedFfmpegVersion };
    }
  } catch {}
  cachedFfmpegVersion = 'unavailable';
  return { available: false, version: 'unavailable' };
}

export async function getReadinessReport() {
  const firestore = await checkFirestoreConnectivity();
  const ffmpeg = checkFfmpegAvailable();
  const tempWritable = (() => {
    try {
      const probe = path.resolve(process.cwd(), 'temp_uploads');
      if (!fs.existsSync(probe)) fs.mkdirSync(probe, { recursive: true });
      fs.accessSync(probe, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  const recentStoredSamples = await listTelemetrySamples(25).catch(() => []);

  return {
    ready: firestore.ok && tempWritable,
    checks: {
      firestore,
      ffmpeg,
      tempDirWritable: tempWritable,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      hmacSigningConfigured: Boolean(process.env.HMAC_SIGNING_SECRET || process.env.ADMIN_SECRET_KEY),
    },
    telemetry: getTelemetrySummary(),
    recentStoredSamples,
  };
}
