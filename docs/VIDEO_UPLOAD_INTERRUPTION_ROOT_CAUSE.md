# Interrupted Video Upload — Root Cause, Fix and Recovery

**Date:** 2026-10-21
**Scope:** read-only investigation, then a fix. No production record, video or
storage object was deleted, and no production upload was triggered.

---

## 1. Headline

A lecture upload failed in the Student Center dashboard with
`Storage refused the upload (500).` The file **was** in Cloudflare R2 the whole
time, byte-exact and playable. The platform never went back to look, so the
video was stranded at `UPLOADING` forever and the dashboard told the
administrator that "Gumlet is packaging this video" when the DRM provider had
never heard of it.

| | |
|---|---|
| **Reported by** | dashboard, "Lecture video" panel, file `1000857477.mp4` |
| **Reported id** | `cmvhppd33000ffo01gtzh7mvl` (the screenshot reads `ffo`; the real id is `cmvhppd33000fio01gtzh7mvl`) |
| **Where the 500 came from** | the browser's direct PUT to R2 — **not** the dashboard, **not** this API, **not** Gumlet |
| **Why R2 answered 500** | `InternalError` (Cloudflare R2 error 10001). Cloudflare documents it as *"Retry the request. If persistent, check Cloudflare Status."* |
| **What was actually true** | the object was committed (522,940,365 bytes, `ftyp`+`mdat`+`moov`, single-part MD5 ETag, `video/mp4`) |
| **What the row said** | `status=UPLOADING`, `sourceSizeBytes=NULL`, `processingJobId=NULL`, `gumletAssetId=NULL` |
| **What Gumlet knew** | nothing. No asset was ever created for this video |
| **Outcome** | recovered at 10:02 UTC from the object already in R2 — no re-upload. Now `READY`, DRM-verified, 975 s |

---

## 2. The failure, traced end to end

### The request that returned 500

The dashboard uploads lecture videos **directly to R2**; the bytes never pass
through the API or the Next.js app (`src/features/videos/upload.ts`):

```
POST /api/v1/videos/uploads/init   ->  presigned PUT, private `edu-uploads` bucket
PUT  <presigned R2 URL>            ->  browser -> R2            <-- 500 came from HERE
POST /api/v1/videos/:id/complete   ->  HEAD the object, queue the job
```

The string `Storage refused the upload (500).` is produced by the dashboard's
own `putToStorage()` helper, from the HTTP status of that PUT. It is not an
API response, and `messageFor()` in `src/lib/errors.ts` can never produce that
text — so the error was, unambiguously, the object store's answer to the PUT.

### The evidence

**R2 (read via the bucket credentials in the API's own environment):**

```
key    source/videos/cmvhppd33000fio01gtzh7mvl/8ebc0e1e-…-8be36f91c202.mp4
size   522,940,365 bytes
etag   "03a9be23e5c7f98f9fb2132bbc21b272"   (single-part MD5 -> one PUT, not multipart)
type   video/mp4
stored 2026-10-21T09:20:13Z
```

The file is **complete**: `ftyp`(32) + `free`(8) + `mdat`(522,110,610) +
`moov`(829,715) = 522,940,365 exactly, and the `moov` box ends precisely at the
end of the object. A truncated upload cannot produce that.

**The database row (`cmvhppd33000fio01gtzh7mvl`, lesson "Example 2"):**

```
status                UPLOADING
sourceKey             source/videos/cmvhppd33000fio01gtzh7mvl/8ebc0e1e-….mp4
sourceSizeBytes       NULL          <- `complete` never ran
processingJobId       NULL          <- nothing was ever queued
gumletAssetId         NULL          <- no provider asset exists
gumletStatus          NULL
drmRequested          false
```

**The audit trail** (`audit_logs`, entity `video`) shows **five** upload
attempts against this one video between 06:09 and 09:02 UTC, each minting a
fresh `sourceKey`:

| # | time (UTC) | source key | object in R2 |
|---|---|---|---|
| 1 | 06:09:22 | `a0d40ee3-…` | no |
| 2 | 06:15:17 | `8b609a6e-…` | no |
| 3 | 08:20:35 | `ff66997e-…` | no |
| 4 | 09:02:13 | `ad20cee6-…` | no |
| 5 | 09:02:42 | `8ebc0e1e-…` | **yes, 522,940,365 bytes** |

Only the last one reached the bucket, and it landed at **09:20:13Z — 17½
minutes after `init`**. The row was still `UPLOADING` with a NULL size when
this investigation began.

### What was ruled out

| Candidate | Verdict | Evidence |
|---|---|---|
| Gumlet | **not involved** | `gumletAssetId` is NULL — no asset was ever created. The panel was showing the platform video id, not a Gumlet asset id. |
| Gumlet quota | **not a factor** | `GET /v1/org/data`: plan `businessVideoMay26`, `unpaid=false`, storage usage **232,612 / 900,000 minutes**, DRM + FairPlay enabled. |
| Expired signature | **no** | `init` mints a 6-hour presign (`expiresIn: 6*3600`); attempt 5 was 17 minutes old. A rejected signature is a **403**, not a 500. |
| Wrong bucket / endpoint / credentials | **no** | the object landed in the right private bucket with the right content type. `R2_ENDPOINT` is empty by design and falls back to `https://<account>.r2.cloudflarestorage.com`. |
| CORS | **no** | a refused preflight produces **no status at all** (`onerror`), which is a different message and a different code path. |
| Size limit | **no** | 522 MB is far under R2's 5 GiB single-PUT ceiling. 800 MB and 1.97 GB uploads have succeeded from this same account. |
| Cloudflare incident | **none found** | the Cloudflare status history for 2026-10-21 lists only colo maintenance, no R2 incident. |
| The dashboard or the API returning 500 | **no** | the message is generated by the dashboard's own PUT helper; the API's error vocabulary has no such string. |

### The root cause

> **A transient provider-side error at the object store (`InternalError`, HTTP
> 500) was treated by the platform as a terminal verdict on the upload, even
> though the object had been committed and the store's own documentation says
> to retry. The workflow stopped at step 2 of 3, so `complete` was never
> called and no part of the pipeline — size, job, provider asset — was ever
> created.**

Two things made the outcome unrecoverable:

1. **Nothing ever went back and looked.** `complete` was the only place that
   HEADs the object, and only the browser could call it.
2. **The panel lied about the provider.** `GumletPanel` said "Gumlet is
   packaging this video" for any video on the Gumlet path that was not READY
   and not failed — including a video that had never reached the provider.

---

## 3. The fix

### Backend (`edu-backend`)

| File | Change |
|---|---|
| `src/modules/videos/videos.service.ts` | `completeUpload` is now **idempotent** (a second call on a queued/processing video returns the current state instead of enqueuing a second job), **recovers** a stranded `UPLOADING` row whose object is already stored, **verifies the length** against the client's declared `sizeBytes`, and **prunes** the source objects earlier attempts left behind. It never writes `READY`. |
| `src/modules/videos/videos.service.ts` | `status()` now returns `uploadConfirmed` — true only once the bytes have been confirmed in storage. |
| `src/modules/videos/videos.service.ts` | `remove()` purges the whole `source/videos/<id>/` prefix, not just the key the row points at. |
| `src/modules/videos/videos.controller.ts` | `POST /videos/:id/complete` accepts an optional `{ sizeBytes }`. The body stays optional so the endpoint is still callable by a client that never got an answer. |
| `src/modules/storage/storage.service.ts` | new `pruneSupersededSources(videoId, keepObjectKey)`: deletes every object under this video's own source prefix except the one that is current. |

### Dashboard (`edu-dashboard`)

| File | Change |
|---|---|
| `src/features/videos/upload.ts` | a failed PUT is now a **question, not a verdict**: the dashboard asks the API whether the object is really there (`complete`), and only re-sends the file when the API confirms it is not. A 5xx is retried (bounded, with backoff); a 403 gets a fresh signature. Failures carry the HTTP status so the message can be specific. |
| `src/features/videos/upload.ts` | the upload state gains a `checking` phase and a `recovered` flag, so "it failed" and "it actually worked" can both be reported. |
| `src/features/videos/lesson-video-panel.tsx` | the Gumlet panel states what is true: "Gumlet is packaging this video" only when an asset exists, "Queued for DRM packaging" when the video is queued, and **"Nothing has been sent for DRM packaging yet"** when it was not. |
| `src/features/videos/lesson-video-panel.tsx` | a video stuck at `UPLOADING` with no confirmed file gets a **"Check whether the file arrived"** button, which asks the server whether the bytes are there. It never re-uploads. |
| `src/features/videos/hooks.ts` | new `useCompleteVideoUpload()` for that action. |

### What was deliberately NOT changed

* No secret, presigned URL or signing key is exposed to the browser.
* Signed uploads, `@StaffOnly()`, course-ownership checks and the private
  `edu-uploads` bucket are untouched.
* Gumlet DRM is untouched: the ingest still runs in the worker, `enable_drm` is
  still true, and `adopt()` remains idempotent, so a retry still cannot mint a
  second (separately billed) asset.
* `READY` is still set only by the worker, after the provider reports the asset
  ready **and** the DASH manifest is confirmed CENC-encrypted.

---

## 4. Recovery of the affected video

**It has already been recovered, and the 522 MB file was never sent again.**

As of 10:20 UTC the row reads:

```
status                READY
sourceKey             source/videos/cmvhppd33000fio01gtzh7mvl/8ebc0e1e-….mp4   (the SAME key)
sourceSizeBytes       522940365
gumletAssetId         6ad88c893e97a4a8c5617767
gumletStatus          ready
drmRequested          true
drmVerifiedAt         2026-10-21T10:02:16.315Z
drmBlockedReason      null
processedAt           2026-10-21T10:02:20.669Z
durationSeconds       975
```

The source key is unchanged since attempt 5 and the recorded size is the real
one, so the file that was committed by R2 at 09:20:13Z is the file that was
processed. **No second upload of the lecture happened.**

The recovery was driven by `POST /videos/:id/retry`, which for a Gumlet row with
no asset yet enqueues the ingest; the worker then called `adopt()`, which signs
a fresh ingestion URL for the object that was already in the bucket, created
**one** provider asset (`6ad88c89…`), and the DRM verification confirmed the
manifest is CENC-encrypted before the video became `READY`.

That is the key confirmation of the root cause: **the existing architecture was
already able to recover this video from the bytes it had — there was simply no
affordance to trigger it.** The dashboard offers "Try processing again" only
for `FAILED`, and "Move to Gumlet DRM" only for `READY`/`FAILED`; a video
stranded at `UPLOADING` offered neither, so the one action that would have
worked was unreachable from the interface.

The fix supplies that affordance directly, and makes it safe:

* **"Check whether the file arrived"** in the panel — asks the API to confirm
  the object and, if it is there, queues it. No re-upload.
* `POST /videos/:id/complete` is now idempotent, so it is safe to call twice
  (once from the dashboard's recovery probe, once from the panel's button).

### The other stranded videos

`GET /api/v1/meta/health/deep` reports `videosByStatus.UPLOADING = 3`, and the
database agrees. All three are the same failure, and none of them has an
object in R2:

| Video | Lesson | source in R2 | recoverable without re-uploading |
|---|---|---|---|
| `cmvcyv0zp01w9e401s3l4got2` | حصة 3 (بداية شرح الخليط) | **no** | no — the bytes were never stored |
| `cmvec8p6n01tcfe01mf5jrvpg` | Example 1 | **no** | no — the bytes were never stored |
| `cmveck6p501umfe01ke6ljad3` | Example 1 | **no** | no — the bytes were never stored |

These three need the file to be uploaded again. The fixed dashboard will say so
plainly ("The file was not saved, so it has to be uploaded again") and will
retry the transfer up to three times before giving up, and it will no longer
claim that Gumlet is working on them.

---

## 5. A separate finding, not part of this fix

`GET /api/v1/meta/health/deep` also reports:

> *"The last DRM verification sweep had problems: 1 video(s) failed verification
> and are blocked until re-verified"*

That video is `cmv09znia000thl01wixuismf` (lesson "حصة اختبار",
`status=READY`, `gumletStatus=deleted`). Its **provider asset has been
deleted at Gumlet**, so it can no longer be verified as DRM-protected and is
blocked from playback. It is unrelated to the upload failure and was left
untouched; it needs a replacement asset (`POST /videos/:id/gumlet/replace-failed-asset`)
and an operator decision about the deleted asset.
