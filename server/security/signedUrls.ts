import { APP_CONFIG, getSigningSecret } from '../config.ts';
import { hmacSha256Base64Url, timingSafeEqualStr } from '../crypto.ts';

export interface SignedPlaybackClaims {
  mediaId: string;
  versionId: string;
  prefix: string;
  exp: number;
  kid: string;
}

export function mintSignedPlaybackToken(
  mediaId: string,
  versionId: string,
  ttlSeconds = APP_CONFIG.signedPlaybackDefaultTtlSec
): string {
  const { secret, keyId } = getSigningSecret();
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(ttlSeconds, 86400));
  const payloadObj: SignedPlaybackClaims = {
    mediaId,
    versionId,
    prefix: `/api/cdn/v1/hls/${mediaId}/${versionId}/`,
    exp,
    kid: keyId,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = hmacSha256Base64Url(secret, encodedPayload);
  return `${encodedPayload}.${sig}`;
}

export function verifySignedPlaybackToken(
  token: string,
  expectedMediaId: string,
  expectedVersionId: string
): { valid: boolean; reason?: string; claims?: SignedPlaybackClaims } {
  if (!token || !token.includes('.')) {
    return { valid: false, reason: 'Missing or malformed playback token.' };
  }

  const [encodedPayload, sig] = token.split('.', 2);
  if (!encodedPayload || !sig) {
    return { valid: false, reason: 'Malformed playback token segments.' };
  }

  const { secret } = getSigningSecret();
  const expectedSig = hmacSha256Base64Url(secret, encodedPayload);
  if (!timingSafeEqualStr(sig, expectedSig)) {
    return { valid: false, reason: 'Invalid playback signature.' };
  }

  try {
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedPlaybackClaims;
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || claims.exp < now) {
      return { valid: false, reason: 'Playback token expired.' };
    }
    if (claims.mediaId !== expectedMediaId || claims.versionId !== expectedVersionId) {
      return { valid: false, reason: 'Token scope mismatch for media/version.' };
    }
    return { valid: true, claims };
  } catch {
    return { valid: false, reason: 'Corrupt playback token payload.' };
  }
}

// Rewrites HLS manifest relative URLs (variant playlists, audio renditions, segments, keys) to propagate token across entire stream tree
export function rewriteHlsManifestWithToken(
  manifestText: string,
  playlistSubdir: string,
  mediaId: string,
  versionId: string,
  token?: string
): string {
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  const cleanDir = playlistSubdir ? playlistSubdir.replace(/^\/+|\/+$/g, '') : '';

  const makeUrl = (relPath: string): string => {
    const trimmed = relPath.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/api/')) {
      return token && !trimmed.includes('token=') ? `${trimmed}${trimmed.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : trimmed;
    }
    const combined = cleanDir ? `${cleanDir}/${trimmed}` : trimmed;
    return `/api/cdn/v1/hls/${mediaId}/${versionId}/${combined}${tokenQuery}`;
  };

  return manifestText
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." inside #EXT-X-MEDIA, #EXT-X-MAP, #EXT-X-KEY
      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (_m, uriVal) => `URI="${makeUrl(uriVal)}"`);
        }
        return line;
      }

      // Segment or child playlist line
      return makeUrl(trimmed);
    })
    .join('\n');
}

export function getCdnCacheHeaders(visibility: 'public' | 'unlisted' | 'private', isPlaylist: boolean): string {
  if (visibility === 'public') {
    return isPlaylist
      ? 'public, max-age=300, s-maxage=600'
      : 'public, max-age=31536000, immutable';
  }
  // Private/unlisted streams must NEVER leak into shared CDN caches without edge token verification
  return 'private, no-store, no-cache, must-revalidate';
}
