# One-Video Recovery Procedure (run after deployment is confirmed)

**Nothing here has been executed.** This is a prepared procedure awaiting approval.
Every step is scoped to exactly ONE video. Nothing is deleted, and no bulk operation
is performed.

> **Revision note.** This document was corrected after a read-only audit. Three
> earlier instructions were wrong and have been removed, not merely reordered:
>
> 1. The manual `UPDATE ... SET "gumletAssetId" = NULL` is **gone**. The approved
>    `replaceFailedAsset()` workflow clears the dead id itself, inside a
>    triple-gated check. Pre-clearing bypassed that gate.
> 2. The manual `SET "status" = 'READY'` / `"drmProvider" = 'gumlet'` step is
>    **gone**. `sync()` owns the `READY` transition and grants it **only** after
>    the DASH manifest is confirmed CENC-encrypted. Forcing `READY` by hand would
>    have marked the video playable *without* the DRM proof this document exists
>    to enforce.
> 3. Rollback is now guarded and complete (`gumletWorkspaceId`, `gumletError`,
>    `gumletUpdatedAt` restored, plus a drift guard).

---

## 0. Preconditions

| # | Check | How | Status |
|---|---|---|---|
| 1 | Worker redeployed from `main` | `docker ps` → `edu-worker-rel-99c0bb1` | DONE |
| 2 | Worker runs the fixed code | `presignIngestionUrl` present, `signMediaUrl` absent | DONE |
| 3 | API has DRM env loaded | `DRM_ENABLED`/`DRM_PROVIDER`/`GUMLET_ORG_ID`/`GUMLET_SIGN_SECRET` | see §0.1 |
| 4 | Target R2 source reachable | `sourceKey` present in DB | DONE |
| 5 | **Strict-DRM migration applied** | `drmVerifiedAt` column exists | **NOT DONE — BLOCKER, §0.2** |

### 0.1 API-side DRM configuration

The signing path needs four values, all read at **API process boot**:

| Variable | Read by | Needed for |
|---|---|---|
| `DRM_ENABLED` | `playback.service.ts:595` | refuse to serve a DRM video when DRM is off |
| `DRM_PROVIDER` | `playback.service.ts:603` | select the Gumlet playback path |
| `GUMLET_ORG_ID` | `gumlet-drm.service.ts:157,193` | license URL path + FairPlay certificate URL |
| `GUMLET_SIGN_SECRET` | `gumlet-drm.service.ts:167` | HMAC-SHA1 token on every license URL |

These live on the **Render API service only**. The worker does **not** read any of
them: its only DRM touchpoints are `isAssetApiConfigured()` (needs
`GUMLET_API_KEY` + `GUMLET_WORKSPACE_ID`, already present) and `assetHasDrm()`
(a regex over manifest text, no config).

### 0.2 BLOCKER: the migration must be applied first

`adopt()` and `replaceFailedAsset()` in the current worktree source both read and
write `drmRequested` / `drmVerifiedAt` / `drmBlockedReason`. Those columns do not
yet exist in Production, so the CLI would fail with `P2022: column t0.drmVerifiedAt
does not exist`.

The migration is **purely additive** — one nullable column and two indexes, no
`UPDATE`, no `DELETE`, no backfill:

```sql
ALTER TABLE "videos" ADD COLUMN "drmVerifiedAt" TIMESTAMP(3);
CREATE INDEX "videos_drmVerifiedAt_idx" ON "videos" ("drmVerifiedAt");
CREATE INDEX "videos_drmProvider_drmVerifiedAt_idx" ON "videos" ("drmProvider", "drmVerifiedAt");
```

Applying it **while the API still runs current `main`** changes no behaviour,
because deployed code does not read those columns. It is a separate approval and
is NOT part of this recovery.

---

## 1. Selected video

```
videoId : cmv1jekin002deh01ixfuam3u
lessonId: cmv1je1rb0029eh01vgb6sjr9
courseId: cmv1jb4tn001beh01gu8yuljx
```

---

## 2. Record the "before" state (read-only)

```
videoId            : cmv1jekin002deh01ixfuam3u
status             : READY
drmProvider        : null            <- legacy, plays unprotected today
gumletAssetId      : 6acbc644689a80cf2e475744
gumletWorkspaceId  : 6ac7f59d5990b730fc3f3c92      <- NOT null; adopt() overwrites it
gumletStatus       : errored
gumletError        : "The uploaded video duration exceeds the storage minutes quota..."
gumletUpdatedAt    : 2026-10-11 17:24:34 UTC
processedAt        : 2026-10-11 17:24:51 UTC
processingStartedAt: null
processingJobId    : null
sourceKey          : PRESENT
masterPlaylistKey  : PRESENT
durationSeconds    : 2849
updatedAt          : 2026-10-11 17:24:51 UTC
```

`updatedAt` is the decisive rollback guard: if it has moved from the value above,
something else touched the row and the rollback below will not apply.

**Note the error class.** This is a **quota** failure timestamped 20:24, *before*
the account upgrade — not the Worker-403 class (`"We had trouble downloading the
input video/audio file..."`, seen 22:14–23:10). Current account state is Growth,
180000 min quota, **0 min used**, `drm: true`. The quota blocker is already gone,
so this video may simply succeed now.

**Preserved throughout:** `sourceKey`, `masterPlaylistKey`, `lessonId`, `courseId`,
`processedAt`, and every existing Gumlet asset.

---

## 3. No manual pre-clearing — `replaceFailedAsset()` handles it

The stale id is cleared **by the approved workflow**, not by hand. It is gated four
ways (`gumlet-migration.plan.ts:137-143`):

| Gate | Required | This video |
|---|---|---|
| `--replace-errored-assets` passed | yes | will pass |
| `drmProvider !== 'gumlet'` | yes | `null` ✅ |
| `status === 'READY'` | yes | `READY` ✅ |
| `gumletStatus ∈ {errored, failed}` | yes | `errored` ✅ |

If any gate fails, the plan returns `action: 'verify'` and **no asset is created**.
`replaceFailedAsset()` additionally refuses outright if `drmProvider === 'gumlet'`.

`adopt()` then writes `drmProvider: 'gumlet'`, `status: PROCESSING`, the new
`gumletAssetId`, `gumletWorkspaceId`, and clears `processingStartedAt` /
`processingJobId` so the stranded-video sweeper cannot fail the row.

---

## 4. Trigger adoption — the exact command

```powershell
cd C:\Users\mahmoud\AppData\Local\Temp\opencode\wt-gumlet-migration

# The CLI's ConfigModule.forRoot() does NOT load a .env file, and the worktree
# has none. Every value below must be exported into the process first, or
# preflight aborts with:
#   BLOCKER: Gumlet asset API is not configured ...
#   BLOCKER: Gumlet signing is not configured ...
#   BLOCKER: DRM_PROVIDER is "none", not "gumlet" ...
#   BLOCKER: DRM_ENABLED is false ...
$src = 'C:\Users\mahmoud\Desktop\edu-backend\.env'
foreach ($k in 'DATABASE_URL','GUMLET_API_KEY','GUMLET_WORKSPACE_ID',
               'GUMLET_ORG_ID','GUMLET_SIGN_SECRET','DRM_ENABLED','DRM_PROVIDER') {
  $v = (Get-Content $src | Where-Object { $_ -match "^\s*$k\s*=" } | Select-Object -First 1)
  if ($v) { Set-Item -Path "env:$k" -Value (($v -split '=',2)[1]).Trim('"') }
}

npm run gumlet:migrate:apply -- `
  --confirm-migration I-HAVE-READ-THE-RUNBOOK `
  --replace-errored-assets `
  --video-id cmv1jekin002deh01ixfuam3u
```

**Preflight must report zero BLOCKERs before this is run.** `DRM_ENABLED=false` in
the CLI process would mean migrating a working lesson into a state
`resolvePlaybackTarget()` refuses to serve (`playback.service.ts:595-601`).

Expected: exactly one `createAsset` call with `enable_drm: true` and an input URL
hosted on `*.r2.cloudflarestorage.com`.

**Abort if the input host is `workers.dev`** — that means the image is stale.

---

## 5. Verify — all three must pass, no manual writes

### 5a. Input came from R2, not the CDN Worker
Read `input.source_url` **without ever printing it** — it carries
`X-Amz-Signature` and `X-Amz-Credential`:

```powershell
$ws = <GUMLET_WORKSPACE_ID>; $ak = <GUMLET_API_KEY>
$a = Invoke-RestMethod "https://api.gumlet.com/v1/video/workspaces/$ws/list?type=videos&size=100" `
      -Headers @{ authorization = "Bearer $ak" }
$newest = $a.all_assets | Sort-Object created_at -Descending | Select-Object -First 1
$uri = [uri]$newest.input.source_url        # parse only
"{0}  asset={1}" -f $uri.Host, $newest.asset_id   # print HOST ONLY
$uri = $null; $newest = $null               # drop the signed URL from memory
```
Assert the host matches `*.r2.cloudflarestorage.com`.

### 5b. Processing reached `ready`
Poll `GET /v1/video/assets/{newAssetId}` until `status = "ready"`. Poll — do not
re-submit; re-submitting would create a duplicate asset.

### 5c. DRM genuinely applied — and `sync()` proved it independently
```
GET https://video.gumlet.io/{ws}/{asset}/main.mpd
→ must contain  schemeIdUri="urn:mpeg:dash:mp4protection:2011"
               cenc:default_KID="…"
```
`sync()` runs exactly this check via `assetHasDrm()` and, on success, is the only
thing that sets `status = READY`, `gumletError = null`, `processedAt = now()`.
If the manifest is not CENC it sets `status = FAILED` instead — fail-closed.

**Do not set `status` or `drmProvider` by hand.** Read them instead:

```sql
SELECT "drmProvider", "gumletStatus", "status", "gumletError",
       "gumletAssetId", "gumletWorkspaceId", "processedAt"
FROM videos WHERE id = 'cmv1jekin002deh01ixfuam3u';
```
Expected: `drmProvider = gumlet`, `gumletStatus = ready`, `status = READY`,
`gumletError` null.

---

## 6. Rollback — guarded and complete

Restore every field `adopt()`/`sync()` can write. The guard makes it a no-op if the
row has already moved on.

```sql
UPDATE videos
SET    "drmProvider"       = NULL,
       "status"            = 'READY',
       "gumletAssetId"     = '6acbc644689a80cf2e475744',
       "gumletWorkspaceId" = '6ac7f59d5990b730fc3f3c92',
       "gumletStatus"      = 'errored',
       "gumletError"       = 'The uploaded video duration exceeds the storage minutes quota for your account. Please consider upgrading your account to increase storage minutes quota.',
       "gumletUpdatedAt"   = TIMESTAMP '2026-10-11 17:24:34.253Z',
       "processedAt"       = TIMESTAMP '2026-10-11 17:24:51.141Z',
       "processingStartedAt" = NULL,
       "processingJobId"   = NULL
WHERE  id = 'cmv1jekin002deh01ixfuam3u'
  AND  "deletedAt" IS NULL
  AND  "updatedAt"      = TIMESTAMP '2026-10-11 17:24:51.144Z'   -- drift guard
  AND  "gumletStatus" IN ('errored', 'failed', 'processing', 'queued')
  AND  "gumletAssetId" IS DISTINCT FROM '6acbc644689a80cf2e475744';
```

- `"updatedAt" = …` is the primary guard: **any** write to this row — by this
  procedure or anyone else — bumps it, so the statement becomes a no-op and a
  successful outcome can never be clobbered.
- `gumletWorkspaceId` is restored to its recorded value `6ac7f59d5990b730fc3f3c92`
  (**not** null — it was already set before the failure), because `adopt()`
  overwrites it (`:124`).
- `processingStartedAt` / `processingJobId` are reset to `null`, which is both
  their pre-existing value and the permanent guard against `recoverStrandedVideos()`
  failing a healthy Gumlet asset (`:144-145`).
- The lesson is playable on legacy again within one request. The failed asset stays
  at Gumlet (inert, no storage cost) and is **not** deleted.

---

## 7. Rollback triggers

| Trigger | Action |
|---|---|
| Wrong input host (`workers.dev`) | Abort. Image stale. Roll back. |
| `P2022 drmVerifiedAt does not exist` | Migration not applied (§0.2). Roll back. |
| Asset `errored` / `failed` | Roll back; report the provider's message. |
| Asset `ready` but manifest not CENC | `sync()` already set `FAILED`. Roll back. |
| Ambiguous | Leave as-is, report, do not proceed to other videos. |

---

## 8. Scope

- **0** manual SQL in the happy path — the CLI performs the single guarded write.
- **1** SQL statement exists, in rollback only, guarded, to **1 row**.
- Creates **1** new Gumlet asset.
- Deletes **nothing** — no R2 object, no HLS rendition, no existing Gumlet asset.
- Touches **1** video; no bulk operation.
- Leaves `lessonId` / `courseId` / `sourceKey` / `masterPlaylistKey` untouched.

Awaiting explicit approval before execution.
