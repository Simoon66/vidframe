# Security Specification for FRAME

## 1. Data Invariants
1. A Media record cannot be modified or deleted by non-administrators.
2. Sensitive Telegram session tokens and storage configurations cannot be accessed by public users or non-admins.
3. Media documents with `visibility == 'public'` or `visibility == 'unlisted'` can be read for watch and embed playback.
4. Updates to media metadata (intro/outro timestamps, title, description, visibility) can only be performed by authenticated admins.
5. All IDs must strictly match `^[a-zA-Z0-9_\-]+$` and have length constraints.

## 2. The "Dirty Dozen" Threat Scenarios
1. **Unauthenticated Delete of Media**: Attacker sends DELETE to `/media/{id}` -> Expect PERMISSION_DENIED.
2. **Unauthenticated Media Creation**: Attacker attempts to inject fake video record -> Expect PERMISSION_DENIED.
3. **Session Theft**: Attacker tries to GET `/settings/telegram` -> Expect PERMISSION_DENIED.
4. **Storage Hijacking**: Attacker tries to overwrite `/settings/storage` with their own chat ID -> Expect PERMISSION_DENIED.
5. **Private Video Snooping**: Attacker attempts to GET a video where `visibility == 'private'` without admin auth -> Expect PERMISSION_DENIED.
6. **Mass Media Scraping**: Attacker queries `/media` without authentication when private items exist -> Rules enforce only public/unlisted items or admin list.
7. **Privilege Escalation**: Non-admin attempts to write to `/admins/{uid}` -> Expect PERMISSION_DENIED.
8. **Field Injection (Shadow Update)**: User updates media with unauthorized ghost fields -> Expect PERMISSION_DENIED.
9. **Timestamp Spoofing**: Client attempts to forge `createdAt` with arbitrary past date -> Handled via validation rules.
10. **ID Poisoning**: Document ID with 2KB payload or directory traversal characters -> Rejected by `isValidId`.
11. **Negative Intro/Outro Seek Injection**: Invalid numerical ranges -> Handled by schema and frontend validators.
12. **MIME Spoofing / Malformed Data**: Payload with non-string title or non-number size -> Rejected by `isValidMediaItem`.
