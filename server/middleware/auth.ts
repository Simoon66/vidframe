import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { APP_CONFIG } from '../config.ts';
import {
  getFirebaseAdminAuth,
  getAdminUser,
  findApiKeyByHash,
  saveApiKeyRecord,
  writeAuditLog,
  AuditLogRecord,
} from '../db.ts';
import { runWithAuthContext, RequestAuthContext } from '../firestoreRest.ts';
import { sha256Hex } from '../crypto.ts';

declare global {
  namespace Express {
    interface Request {
      authCtx?: RequestAuthContext;
    }
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  return null;
}

export async function authenticateRequest(req: Request): Promise<RequestAuthContext | null> {
  const token = extractBearerToken(req);
  if (!token) return null;

  // 1. Scoped API Key check (prefixed with vf_live_)
  if (token.startsWith('vf_live_')) {
    const hashed = sha256Hex(token);
    const keyRecord = await findApiKeyByHash(hashed);
    if (!keyRecord || keyRecord.revokedAt) {
      return null;
    }
    if (keyRecord.expiresAt && new Date(keyRecord.expiresAt).getTime() < Date.now()) {
      return null;
    }

    // Touch lastUsedAt asynchronously
    saveApiKeyRecord({ ...keyRecord, lastUsedAt: new Date().toISOString() }).catch(() => {});

    return {
      uid: keyRecord.ownerUid,
      email: `apikey:${keyRecord.name}`,
      role: keyRecord.role === 'playback' ? 'api_key' : keyRecord.role,
      scopes: keyRecord.scopes || [],
      keyId: keyRecord.id,
    };
  }

  // 2. Firebase ID Token verification via firebase-admin/auth
  try {
    const decoded = await getFirebaseAdminAuth().verifyIdToken(token);
    const email = (decoded.email || '').trim().toLowerCase();
    const emailVerified = Boolean(decoded.email_verified);

    if (!email || !emailVerified) {
      return null;
    }

    // Bootstrap primary admin OR check admins collection using the caller's own verified ID token
    let role: 'admin' | 'editor' | null = null;
    if (email === APP_CONFIG.bootstrapAdminEmail) {
      role = 'admin';
    } else {
      const adminDoc = await runWithAuthContext(
        { uid: decoded.uid, email, role: 'editor', idToken: token },
        () => getAdminUser(decoded.uid)
      );
      if (adminDoc && adminDoc.active !== false) {
        role = adminDoc.role === 'admin' ? 'admin' : 'editor';
      }
    }

    if (!role) {
      return null;
    }

    return {
      uid: decoded.uid,
      email,
      role,
      idToken: token,
      scopes: role === 'admin' ? ['*'] : ['media:read', 'media:write', 'jobs:write', 'ai:run'],
    };
  } catch (err: any) {
    return null;
  }
}

export function attachOptionalAuth(req: Request, _res: Response, next: NextFunction): void {
  authenticateRequest(req)
    .then((ctx) => {
      if (ctx) {
        req.authCtx = ctx;
        runWithAuthContext(ctx, () => next());
      } else {
        next();
      }
    })
    .catch(() => next());
}

export function requireAuth(allowedRoles: Array<'admin' | 'editor' | 'api_key'> = ['admin', 'editor']) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = req.authCtx || (await authenticateRequest(req));
      if (!ctx) {
        return res.status(401).json({
          error: 'Authentication required. Sign in with an authorized Google account or provide a valid API key.',
        });
      }
      if (!allowedRoles.includes(ctx.role)) {
        return res.status(403).json({
          error: `Forbidden: role '${ctx.role}' is not permitted for this operation.`,
        });
      }
      req.authCtx = ctx;
      runWithAuthContext(ctx, () => next());
    } catch (err: any) {
      return res.status(401).json({ error: err?.message || 'Unauthorized request' });
    }
  };
}

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.authCtx;
    if (!ctx) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (ctx.role === 'admin' || ctx.scopes?.includes('*') || ctx.scopes?.includes(scope)) {
      return next();
    }
    return res.status(403).json({ error: `Missing required scope '${scope}'.` });
  };
}

export async function recordAudit(
  req: Request,
  action: string,
  resourceType: string,
  resourceId: string,
  details?: Record<string, any>
): Promise<void> {
  const ctx = req.authCtx;
  const entry: AuditLogRecord = {
    id: `aud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    actorUid: ctx?.uid || 'anonymous',
    actorEmail: ctx?.email || 'anonymous',
    actorRole: ctx?.role || 'public',
    action,
    resourceType,
    resourceId,
    details,
    ip:
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '127.0.0.1',
    createdAt: new Date().toISOString(),
  };
  await writeAuditLog(entry);
}
