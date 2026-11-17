# VidFrame Firestore Security Specification

## 1. Data Invariants
1. **Default Deny Catch-All**: Every path defaults to `allow read, write: if false;` unless explicitly granted below.
2. **Verified Operator Identity**: No privileged read, list, create, update, or delete succeeds without `request.auth != null && request.auth.token.email_verified == true`.
3. **No Secret / PII Exposure**: `/settings/*`, `/admins/*`, `/api_keys/*`, `/audit_logs/*`, `/processing_jobs/*`, and `/telemetry_metrics/*` are strictly inaccessible to unauthenticated or unprivileged users.
4. **Private Media Protection**: Unauthenticated `get` on `/media/{mediaId}` is strictly limited to `visibility in ['public', 'unlisted']`. Collection `list` on `/media` is strictly restricted to verified admins/editors or matching `resource.data.ownerId == request.auth.uid`.
5. **Immutable Audit & Master Lineage**: `/audit_logs/*` cannot be updated or deleted once created; `media_versions` and `media` preserve `createdAt` immutability across updates.
6. **Bounded Resource Sizes & Regex IDs**: All document IDs (`isValidId`) match `^[a-zA-Z0-9_\-]+$` (max 128 chars), and all strings/arrays have explicit `.size()` ceilings.

## 2. The Dirty Dozen Malicious Payloads (All Must Yield PERMISSION_DENIED)
1. **Unauthenticated Settings Read**: `GET /settings/telegram` without auth -> **DENIED**.
2. **Unauthenticated Media List Scrape**: `LIST /media` without auth -> **DENIED**.
3. **Unverified Admin Email Spoof**: Signed in with `simoonabdulla@gmail.com` where `email_verified == false` -> **DENIED**.
4. **Privilege Self-Escalation**: Non-admin authenticated user writing `/admins/{uid}` with `role: 'admin'` -> **DENIED**.
5. **Private Media Leak**: Unauthenticated `GET /media/{id}` where `resource.data.visibility == 'private'` -> **DENIED**.
6. **ID Poisoning**: Creating `/media/../../etc/passwd` or 500-char ID -> **DENIED** by `isValidId`.
7. **Shadow Ghost Field Injection**: Creating `/media/{id}` with extra `isSystemVerified: true` field -> **DENIED** by `hasOnly(...)` / schema validation.
8. **Type Poisoning on Update**: Updating `/media/{id}` with `size: "huge"` or 50KB `title` -> **DENIED** by `isValidMediaItem(incoming())`.
9. **Owner Hijack Update**: Updating `/media/{id}` modifying immutable `createdAt` -> **DENIED** by `incoming().createdAt == existing().createdAt`.
10. **Audit Log Tampering**: Admin attempting `UPDATE` or `DELETE` on `/audit_logs/{logId}` -> **DENIED**.
11. **API Key Secret Listing by Non-Admin**: Editor or Viewer calling `LIST /api_keys` -> **DENIED**.
12. **Denial-of-Wallet Oversized Description/Report**: Submitting `/reports/{id}` with a 50,000-char `description` or invalid `status: 'resolved'` on create -> **DENIED**.
