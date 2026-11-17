# VidFrame Architecture & Scalability Design

## 1. High-Level Topology

```
[ Browser / Player / Embed ]
   |-- Auth: Firebase Auth (ID Token) / API Key (vf_live_...)
   |-- Public Stream: /watch/:id, /embed/:id -> GET /api/media/:id/playback
   |-- Signed HLS Origin: GET /api/cdn/v1/hls/:mediaId/:versionId/*?token=...
   |-- Legacy Fallback:   GET /api/media/:id/stream?audio=...
   v
[ Express Control & Delivery Plane (server.ts -> server/api.ts) ]
   |-- Auth & RBAC Middleware (server/middleware/auth.ts)
   |-- SSRF Guard & Domain Allowlist (server/security/ssrfGuard.ts)
   |-- HMAC-SHA256 Signed URL Engine (server/security/signedUrls.ts)
   |-- Rate Limiter + Telemetry Recorder (server/observability/telemetry.ts)
   |
   +--> [ Pluggable Storage Adapter (server/storage/storageRouter.ts) ]
   |       |-- s3_r2     : AWS S3 / Cloudflare R2 / GCS Interop (Signed V4)
   |       |-- telegram  : GramJS MTProto AES-256-GCM Session + Channel Pool
   |       |-- local_dev : Local filesystem object store (single-node dev only)
   |
   +--> [ Durable Job Queue (server/queue/queueManager.ts) ]
   |       |-- firestore   : Transactional lease + checkpoint worker loop
   |       |-- cloud_tasks : GCP Cloud Tasks webhook dispatcher
   |       |-- pubsub      : GCP Pub/Sub topic publisher
   |       v
   |    [ Media Pipeline Worker (server/workers/mediaPipeline.ts) ]
   |       |-- ffprobe codec/stream/HDR inspection
   |       |-- Non-upscaled HLS ABR Ladder (1080p/720p/480p/360p) + demuxed audio
   |       |-- Subtitle extraction & SRT/ASS/VTT normalization
   |       |-- Black-frame / silence detection for Intro/Outro/Chapters
   |
   +--> [ Pluggable AI Providers (server/ai/*) ]
   |       |-- gemini-3.5-transcribe : Audio speech-to-WebVTT
   |       |-- gemini-4-hydrogen   : Subtitle translation + chapter/intro refinement
   |       |-- whisper / deepgram    : External adapter hooks via env API keys
   |
   v
[ Firebase Firestore (ai-studio-vidframe-db50028e-de29-4e0b-b309-1452c83534d0) ]
   |-- Cursor-paginated collections (media, media_versions, processing_jobs)
   |-- Write-sharded view counters (views/{mediaId}_{0..9})
   |-- Hardened Security Rules (firestore.rules + Eight-Pillars RBAC)
```

## 2. Core Design Decisions

1. **Non-Blocking Ingestion & Immutable Master Versioning**:
   - File chunk uploads and SSRF-validated URL imports compute SHA-256 digests (`media/{id}/sha256Hash`) for duplicate awareness, persist a `MediaVersionRecord` (`v1`, `v2`, ...), set a playable baseline immediately, and enqueue a `transcode_hls` job.
   - Operators can upload replacement masters (`POST /api/media/:id/versions`) and roll back (`POST /api/media/:id/versions/:versionId/activate`) without mutating historical artifacts.
2. **Storage Adapter Decoupling & Legacy Compatibility**:
   - All HLS segments, variant playlists, thumbnails, and WebVTT files use object prefixes (`media/{mediaId}/{versionId}/...`) through `ObjectStorageAdapter`.
   - Legacy single-file Telegram items (`playbackMode: 'legacy_telegram'`) continue streaming transparently through `TelegramStorageService` (`/api/media/:id/stream`) with zero breaking changes.
3. **Zero-Trust Security**:
   - Unauthenticated `GET /api/status` returns `401` and never leaks operator email addresses.
   - Private assets enforce either an authenticated operator session or an HMAC-SHA256 timed grant (`?token=exp.sig`), and manifests rewrite nested variant/segment URIs to carry the grant.
   - URL ingestion enforces DNS resolution validation (`ssrfGuard.ts`) rejecting RFC1918, loopback, link-local (`169.254.169.254`), and carrier-grade NAT IPs prior to connect and across redirects.
4. **Scale Bottleneck Mitigation**:
   - Metadata listings use cursor pagination (`limit + startAfter`) paired with composite Firestore indexes (`firestore.indexes.json`).
   - Viral playback view counts distribute writes across 10 shards per media item (`views/{mediaId}_{shard}`) to respect Firestore's single-document write limits.
