import { Request, Response, NextFunction } from 'express';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, windowSeconds: number) {
    this.capacity = capacity;
    this.refillPerSec = capacity / Math.max(1, windowSeconds);

    // Periodic eviction of stale buckets
    setInterval(() => {
      const cutoff = Date.now() - Math.max(windowSeconds * 2000, 60000);
      for (const [k, b] of this.buckets.entries()) {
        if (b.lastRefillMs < cutoff) {
          this.buckets.delete(k);
        }
      }
    }, 60000).unref();
  }

  public consume(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity - 1, lastRefillMs: now };
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterSec: 0 };
    }

    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }

    const needed = 1 - bucket.tokens;
    return {
      allowed: false,
      retryAfterSec: Math.ceil(needed / this.refillPerSec),
    };
  }
}

const limiters = {
  auth: new TokenBucketLimiter(25, 60),
  upload: new TokenBucketLimiter(400, 60),
  ai: new TokenBucketLimiter(15, 60),
  urlImport: new TokenBucketLimiter(20, 60),
  general: new TokenBucketLimiter(300, 60),
};

export function rateLimit(tier: keyof typeof limiters = 'general') {
  const limiter = limiters[tier];
  return (req: Request, res: Response, next: NextFunction) => {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '127.0.0.1';
    const uid = req.authCtx?.uid || ip;
    const key = `${tier}:${uid}`;
    const result = limiter.consume(key);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        error: `Rate limit exceeded for ${tier} operations. Please wait ${result.retryAfterSec}s.`,
      });
    }
    return next();
  };
}
