import { AsyncLocalStorage } from 'node:async_hooks';
import { getFirebaseConfig } from './config.ts';

export interface RequestAuthContext {
  uid: string;
  email: string;
  role: 'admin' | 'editor' | 'api_key';
  idToken?: string;
  scopes?: string[];
  keyId?: string;
}

const authStorage = new AsyncLocalStorage<RequestAuthContext>();

export class FirestoreHttpError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FirestoreHttpError';
    this.status = status;
  }
}

// Stores most recent valid admin ID token for background async jobs spawned by an admin session in sandbox mode
let latestAdminToken: { token: string; expMs: number } | null = null;

function extractJwtExpMs(token: string): number {
  try {
    const parts = token.split('.');
    if (parts.length === 3 && parts[1]) {
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (typeof decoded?.exp === 'number' && Number.isFinite(decoded.exp)) {
        // Expire 60s before actual Firebase ID token expiry so we never send stale tokens
        return decoded.exp * 1000 - 60_000;
      }
    }
  } catch {}
  return Date.now() + 10 * 60 * 1000;
}

export function clearCachedAdminToken(failedToken?: string): void {
  if (!latestAdminToken) return;
  if (!failedToken || latestAdminToken.token === failedToken) {
    latestAdminToken = null;
  }
}

export function runWithAuthContext<T>(ctx: RequestAuthContext, fn: () => T): T {
  if (ctx.idToken && ctx.role === 'admin') {
    const expMs = extractJwtExpMs(ctx.idToken);
    if (expMs > Date.now()) {
      latestAdminToken = {
        token: ctx.idToken,
        expMs,
      };
    }
  }
  return authStorage.run(ctx, fn);
}

export function getAuthContext(): RequestAuthContext | undefined {
  return authStorage.getStore();
}

export function getEffectiveBearerToken(): string | undefined {
  const ctx = authStorage.getStore();
  if (ctx?.idToken) return ctx.idToken;
  if (latestAdminToken) {
    if (Date.now() < latestAdminToken.expMs) {
      return latestAdminToken.token;
    }
    latestAdminToken = null;
  }
  return undefined;
}

function getFirestoreBaseUrl(): string {
  const cfg = getFirebaseConfig();
  const dbId = cfg.firestoreDatabaseId || '(default)';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${encodeURIComponent(dbId)}/documents`;
}

// Convert JS value to Firestore REST Value
export function toFirestoreValue(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.filter((v) => v !== undefined).map(toFirestoreValue),
      },
    };
  }
  if (typeof val === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

export function fromFirestoreValue(v: any): any {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return String(v.stringValue);
  if ('timestampValue' in v) return String(v.timestampValue);
  if ('arrayValue' in v) {
    const vals = v.arrayValue?.values || [];
    return vals.map(fromFirestoreValue);
  }
  if ('mapValue' in v) {
    const fields = v.mapValue?.fields || {};
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(val);
    }
    return out;
  }
  return null;
}

export function decodeDocument<T = any>(docJson: any): T | null {
  if (!docJson || !docJson.fields) return null;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(docJson.fields)) {
    out[k] = fromFirestoreValue(v);
  }
  return out as T;
}

function buildHeadersWithToken(token?: string): { headers: Record<string, string>; authToken?: string } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const authToken = token || getEffectiveBearerToken();
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return { headers, authToken };
}

export async function restGetDoc<T = any>(docPath: string, token?: string): Promise<T | null> {
  const cleanPath = docPath.replace(/^\/+/, '');
  const url = `${getFirestoreBaseUrl()}/${cleanPath}`;
  const { headers, authToken } = buildHeadersWithToken(token);
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 401) clearCachedAdminToken(authToken);
    const errText = await res.text().catch(() => '');
    throw new FirestoreHttpError(res.status, `Firestore REST GET ${cleanPath} failed (${res.status}): ${errText}`);
  }
  const json = await res.json();
  return decodeDocument<T>(json);
}

export async function restSetDoc(docPath: string, data: Record<string, any>, token?: string): Promise<void> {
  const cleanPath = docPath.replace(/^\/+/, '');
  const url = `${getFirestoreBaseUrl()}/${cleanPath}`;
  const fields: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }
  const { headers, authToken } = buildHeadersWithToken(token);
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 401) clearCachedAdminToken(authToken);
    const errText = await res.text().catch(() => '');
    throw new FirestoreHttpError(res.status, `Firestore REST PATCH ${cleanPath} failed (${res.status}): ${errText}`);
  }
}

export async function restDeleteDoc(docPath: string, token?: string): Promise<void> {
  const cleanPath = docPath.replace(/^\/+/, '');
  const url = `${getFirestoreBaseUrl()}/${cleanPath}`;
  const { headers, authToken } = buildHeadersWithToken(token);
  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return;
  if (!res.ok) {
    if (res.status === 401) clearCachedAdminToken(authToken);
    const errText = await res.text().catch(() => '');
    throw new FirestoreHttpError(res.status, `Firestore REST DELETE ${cleanPath} failed (${res.status}): ${errText}`);
  }
}

export async function restListCollection<T = any>(
  collectionPath: string,
  options: {
    pageSize?: number;
    orderByField?: string;
    direction?: 'ASCENDING' | 'DESCENDING';
    where?: Array<{ field: string; op: 'EQUAL' | 'IN' | 'GREATER_THAN' | 'LESS_THAN'; value: any }>;
    startAfterValues?: any[];
    token?: string;
  } = {}
): Promise<T[]> {
  const cleanCol = collectionPath.replace(/^\/+/, '');
  const parts = cleanCol.split('/');
  const collectionId = parts.pop()!;
  const parentPath = parts.length > 0 ? `${getFirestoreBaseUrl()}/${parts.join('/')}` : getFirestoreBaseUrl();

  const structuredQuery: any = {
    from: [{ collectionId }],
  };

  if (options.where && options.where.length > 0) {
    const filters = options.where.map((w) => ({
      fieldFilter: {
        field: { fieldPath: w.field },
        op: w.op,
        value: toFirestoreValue(w.value),
      },
    }));
    structuredQuery.where =
      filters.length === 1
        ? filters[0]
        : {
            compositeFilter: {
              op: 'AND',
              filters,
            },
          };
  }

  if (options.orderByField) {
    structuredQuery.orderBy = [
      {
        field: { fieldPath: options.orderByField },
        direction: options.direction || 'DESCENDING',
      },
      {
        field: { fieldPath: '__name__' },
        direction: options.direction || 'DESCENDING',
      },
    ];
  }

  if (options.startAfterValues && options.startAfterValues.length > 0) {
    const startValues = options.startAfterValues.map((v) => {
      if (v && typeof v === 'object' && typeof v.__refPath === 'string') {
        const cfg = getFirebaseConfig();
        const dbId = cfg.firestoreDatabaseId || '(default)';
        return {
          referenceValue: `projects/${cfg.projectId}/databases/${dbId}/documents/${v.__refPath.replace(/^\/+/, '')}`,
        };
      }
      return toFirestoreValue(v);
    });
    structuredQuery.startAt = {
      values: startValues,
      before: false,
    };
  }

  if (options.pageSize) {
    structuredQuery.limit = options.pageSize;
  }

  const { headers, authToken } = buildHeadersWithToken(options.token);
  const res = await fetch(`${parentPath}:runQuery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ structuredQuery }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 401) clearCachedAdminToken(authToken);
    const errText = await res.text().catch(() => '');
    throw new FirestoreHttpError(res.status, `Firestore REST runQuery ${cleanCol} failed (${res.status}): ${errText}`);
  }

  const rows = (await res.json()) as any[];
  const docs: T[] = [];
  for (const row of rows) {
    if (row.document) {
      const decoded = decodeDocument<T>(row.document);
      if (decoded) docs.push(decoded);
    }
  }
  return docs;
}
