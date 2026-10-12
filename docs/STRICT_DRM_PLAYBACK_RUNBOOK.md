# Strict DRM-Only Playback — Operations Runbook

Implements: students can only play **verifiably DRM-protected** video; every upload is
automatically submitted to Gumlet with DRM.

> **NOT APPLIED TO PRODUCTION.** The migration below is prepared and reviewed but has
> not been run. No environment variable has been changed. No deployment has occurred.

---

## 1. What "verified DRM" actually means

A video is playable only when **all** of these hold, checked server-side:

| # | Condition | Checked by |
|---|---|---|
| 1 | Platform has DRM enabled and `DRM_PROVIDER=gumlet` | `evaluate()` |
| 2 | Signing configured (`GUMLET_ORG_ID` + `GUMLET_SIGN_SECRET`) | `evaluate()` |
| 3 | A Gumlet asset exists (`gumletAssetId`) | `evaluate()` |
| 4 | DRM was **requested** at ingest (`drmRequested`) | `evaluate()` |
| 5 | Provider reports the asset `ready` | `evaluate()` |
| 6 | The DASH manifest is **genuinely CENC-encrypted** | `verify()` — live |
| 7 | That check is fresher than `DRM_VERIFICATION_TTL_SECONDS` (default 6h) | `evaluate()` |

Conditions 1–5, 7 are judged from stored state (no latency).
Condition 6 is the only one that requires a network call, and it happens **only** in
`verify()`, which writes `drmVerifiedAt`. Playback never calls the provider.

**A database flag is never sufficient.** `drmProvider` records intent; `drmVerifiedAt`
records proof, and only `verify()` can set it. A stale `drmVerifiedAt` is **cleared**
whenever verification stops succeeding, so a broken asset cannot keep playing.

## 2. Fail-closed enforcement points

| Endpoint | Behaviour |
|---|---|
| `POST /playback/videos/:videoId/ticket` | Throws; **no fallback to HLS, R2 or MP4** |
| `GET /playback/manifest/:ticketId/master.m3u8` | Refuses non-verified videos |
| `GET /playback/manifest/:ticketId/:height.m3u8` | Same |
| `GET /playback/keys/:ticketId` | Same |
| `GET /playback/media/*key` | Refuses `uploads/` and `/source/` prefixes outright |

The manifest routes re-check on **every request**, so a ticket issued before the gate
shipped stops at the next segment fetch rather than at expiry.

Student-facing statuses: `VIDEO_NOT_READY` (409) while processing → the app can show
*"الفيديو غير متاح حاليًا، برجاء المحاولة لاحقًا"*; `VIDEO_UNAVAILABLE` (404) otherwise.

## 3. Automatic ingestion

`POST /videos/:id/complete` → enqueues the existing transcode job → worker calls
`GumletIngestService.processFromJob()` → `adopt()` → `POST /v1/video/assets` with
`enable_drm: true`.

- **Idempotent**: if `gumletAssetId` exists, `adopt()` re-syncs instead of creating a
  second asset. Duplicate jobs cannot double-bill.
- **Asynchronous**: the upload returns as soon as the job is enqueued. Gumlet latency or
  failure never rolls back the student's upload.
- **Fails closed**: a missing credential refuses the upload outright rather than
  creating a lesson that could never be delivered.

The bucket stays private. Gumlet fetches the source via a short-lived SigV4 presign
(`presignIngestionUrl`, 1h), never a viewer-bound URL.

## 4. Required environment variables

```bash
DRM_ENABLED=true
DRM_PROVIDER=gumlet
GUMLET_API_KEY=…
GUMLET_WORKSPACE_ID=…
GUMLET_ORG_ID=…
GUMLET_SIGN_SECRET=…

# New
GUMLET_WEBHOOK_SECRET=…          # optional; see §5
DRM_VERIFICATION_TTL_SECONDS=21600  # optional, 300..604800
```

All remain server-side. No `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` equivalent exists or is needed.

## 5. Webhook setup (manual, one-time)

Endpoint: `POST {API_BASE}/webhooks/gumlet/assets`
Header: `X-Gumlet-Signature: <hex HMAC-SHA256 of the raw body>`

1. Generate a secret: `openssl rand -hex 32`
2. Set the same value as `GUMLET_WEBHOOK_SECRET` on the API.
3. Configure the URL + secret in the Gumlet dashboard webhook settings.

**If `GUMLET_WEBHOOK_SECRET` is blank the endpoint refuses every event** rather than
trusting unsigned payloads. Without a webhook the platform still works — the dashboard's
existing poll finishes the job — so this is an optimisation, not a dependency.

Duplicate and out-of-order deliveries are safe: each event re-reads the provider instead
of trusting the payload, so a forged `"ready"` cannot make an unverified video playable.

## 6. Migration (prepared, NOT applied)

`prisma/migrations/20261012090000_strict_drm_playback/` adds three nullable columns
plus two indexes. Purely additive.

**Applying it makes every existing video fail closed** (`drmVerifiedAt` is NULL) until
each is verified. That is intended, but it means **the two unmigrated legacy lessons stop
playing immediately** — and they cannot currently be migrated, because the Gumlet account
has only 10 of 60 storage minutes free.

**Recommended order:**
1. Upgrade the Gumlet plan (Creator = 1,000 min) **first**.
2. Apply the migration.
3. Run the reconciliation tool below.

### Reconciliation

```bash
# Read-only. Reports every video by DRM state. Safe to run any time.
npm run gumlet:migrate:dry-run

# Verify live DRM for already-migrated videos (no asset creation).
npm run gumlet:migrate:apply -- --confirm-migration I-HAVE-READ-THE-RUNBOOK --limit 1
```

## 7. Admin visibility

`GET /videos/:videoId/gumlet/status` now returns a derived `drmState`:

`PENDING_SUBMISSION` · `PROCESSING` · `READY_DRM_VERIFIED` · `FAILED` · `DRM_NOT_VERIFIABLE`

`playable` is **derived from the same verifier the playback path uses**, so the dashboard
can never show "ready" for a video a student would be refused.

New: `POST /videos/:videoId/gumlet/verify` — re-checks DRM against the provider.
There is deliberately **no** "mark as protected" endpoint; an admin action cannot grant
playback the backend has not verified.

## 8. Known limitations

- **Phase 0 verdict remains NO-GO** — Widevine L1 on Windows is unverified; desktop
  Chromium is L3, so screen capture may still succeed. Strict DRM enforcement does not
  change that.
- Mobile iOS FairPlay still receives `contentType: 'dash'` while the backend serves
  `main.m3u8` (pre-existing bug, untouched here).
- Webhooks need manual dashboard configuration (§5).