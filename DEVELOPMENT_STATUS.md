# VidFrame Development & Production Readiness Status

## 1. Implemented Capabilities Inventory

| Area | Status | Notes |
|---|---|---|
| **Auth Leak Fix (`GET /api/status`)** | Implemented | Requires auth (`401` unauth); Login Gate never shows bootstrap admin email. |
| **Telegram MTProto 401 Recovery** | Implemented | Classifies `AUTH_KEY_UNREGISTERED` -> `Login Required`, preserves encrypted backup, normalizes `-100` peer IDs, exposes diagnostics banner. |
| **Hardcoded DB ID Fix** | Implemented | `GeneralSettings.tsx` dynamically reads `status.firestoreDatabaseId` (`ai-studio-vidframe-db50028e-de29-4e0b-b309-1452c83534d0`). |
| **Zero-Trust Express RBAC & Audit** | Implemented | Firebase Bearer ID tokens + scoped SHA-256 API keys (`vf_live_...`), `admin`/`editor` roles, immutable `audit_logs`. |
| **Hardened Firestore Security Rules** | Deployed | Eight-Pillars `firestore.rules` linted cleanly with `@firebase/eslint-plugin-security-rules` and deployed via `fax.DeployRules`. |
| **Pluggable Object Storage** | Implemented | Supports `s3_r2` (AES-GCM encrypted credentials), `telegram`, and `local_dev` (with multi-node warning). |
| **Async HLS ABR Packaging** | Implemented | FFmpeg `ffprobe` inspection, non-upscaled ABR ladder, demuxed multi-audio playlists, thumbnails, and WebVTT extraction. |
| **Immutable Master Versioning** | Implemented | `media_versions` subcollection / collection, master uploads, activate/rollback endpoint, UI studio tab. |
| **Subtitles Studio** | Implemented | External `.srt`/`.ass`/`.vtt` upload conversion, `offsetMs` shifting, `isDefault`/`isForced` flags. |
| **AI Studio (Pluggable)** | Implemented | `gemini-3.5-transcribe` STT-to-WebVTT, `gemini-4-hydrogen` subtitle translation & chapter/intro proposal (approval gated), plus Whisper/Deepgram hooks. |
| **SSRF-Hardened URL Importer** | Implemented | Blocks loopback, RFC1918, IMDS (`169.254.169.254`), and private IPv6 across redirects. |
| **Signed CDN Playback & Player** | Implemented | HMAC-SHA256 `?token=` verification, manifest rewriting, Hls.js ABR level selector, demuxed audio switcher, chapters, auto-skip toggle, playback telemetry. |
| **Queue & Health Console** | Implemented | `/api/health`, `/api/ready`, `/api/telemetry`, p50/p95/5xx metrics, live QueueMonitor, Cancel/Retry/DLQ replay. |
| **Cursor-Paginated Media Library** | Implemented | `fetchMediaPaginated` with `limit` + `startAfter` cursor (`Load More Videos`) and composite indexes. |

## 2. External Environment Requirements for Multi-Region Production Scale

The codebase runs standalone in single-instance mode (using Firestore queue leasing and configured storage). To deploy horizontally across stateless Cloud Run / GKE replicas at million-to-billion scale, provision:

1. **External Object Storage + Edge CDN**:
   - Configure S3 or Cloudflare R2 in **Settings -> Storage** (or set `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_CDN_BASE_URL`). Do not use `local_dev` in multi-node clusters.
2. **Cluster-Wide Signing & Session Keys**:
   - `HMAC_SIGNING_SECRET`: Shared 32+ byte secret for signed HLS playback tokens (`/?token=`).
   - `MASTER_ENCRYPTION_KEY`: 32-byte key for AES-256-GCM encryption of stored credentials and Telegram sessions.
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (or workload identity on Cloud Run/GCP) so server-side Admin SDK calls authenticate cleanly in headless deployments.
3. **External Queue Dispatch (Optional)**:
   - Set `QUEUE_DRIVER=cloud_tasks` (with `CLOUD_TASKS_QUEUE_PATH`, `WORKER_TARGET_URL`, `WORKER_SHARED_SECRET`) or `QUEUE_DRIVER=pubsub` (`PUBSUB_TOPIC`) to offload heavy FFmpeg transcodes onto dedicated GPU/CPU worker pools.
4. **AI Provider Keys**:
   - `GEMINI_API_KEY`: Required for `gemini-3.5-transcribe` captions and `gemini-4-hydrogen` translation / intro detection.
   - `OPENAI_API_KEY` / `DEEPGRAM_API_KEY`: Optional overrides if routing STT through Whisper or Deepgram.
5. **Composite Firestore Indexes**:
   - Deploy `/firestore.indexes.json` via `firebase deploy --only firestore:indexes` in the target GCP/Firebase project (`proven-treat-9t8c4`).

## 3. Recommended Load & Resiliency Verification Plan

- **Chunk & URL Ingestion Concurrency**: Simulate 20 concurrent 500MB chunked uploads and verify temp cleanup + SHA-256 deduplication hits.
- **Origin & Segment Caching**: Put Cloudflare CDN / Cloud CDN in front of `GET /api/cdn/v1/hls/:mediaId/:versionId/*` honoring `Cache-Control: public, max-age=31536000, immutable` on `.ts`/`.m4s` segments and verifying signed token expiry enforcement (`403`) on `private` media.
- **DLQ & Worker Crash Recovery**: Kill an active transcoding process mid-job and confirm the 5-minute lease expires cleanly, retries up to `maxAttempts`, and lands in `dead_letter` for replay via `QueueMonitor`.
