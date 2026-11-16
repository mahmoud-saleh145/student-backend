# Video upload: two independent processing pipelines

Engineering report for branch `fix/dual-pipeline-independence` (backend, based on
`origin/main` 164ae72) and `feat/dual-pipeline-status` (dashboard, based on
`origin/main` 12dcda7). Written 2026-11-17.

**Nothing in this work has been deployed, pushed, migrated in production or
queued for processing.** Production was read (one read-only database
transaction, R2 `HEAD` requests, Redis read commands) and not written.

---

## A. Root causes

### A1. Why newly uploaded videos never enter the Mobile HLS queue

**The automatic enqueue exists and is switched off in production by an
environment variable.**

- `VideosService.completeUpload` queued the mobile job only inside
  `if (this.cfg.mobile?.autoProcess !== false)` (`src/modules/videos/videos.service.ts`,
  the block after `enqueueTranscode`).
- `autoProcess` is `bool(process.env.MOBILE_PIPELINE_ENABLED, true)`
  (`src/config/configuration.ts`).
- The Render API was deployed on 2026-11-10 with `MOBILE_PIPELINE_ENABLED=false`,
  deliberately, "until the worker swap". The worker was swapped the same day; the
  flag was never lifted. (The laptop worker's own environment also still reads
  `false`, verified with `docker exec edu-worker`.)

Evidence from production (read 2026-11-16 22:08Z): **32 videos have been uploaded
since that deploy. All 32 are Gumlet `READY` with a verified source, and all 32
have `mobileStatus = NONE`, `mobileJobId = NULL`** — no job was ever created for
any of them. Had the enqueue been attempted and failed, the row would read
`FAILED` with "Could not queue mobile processing"; none does. Every one of the
44 mobile-READY videos was queued by hand in operator batches.

So the immediate cause is configuration, not code. Flipping the flag alone
would, however, have exposed the design problems below — which is why this
branch does not stop at "set the variable".

### A2. Dependencies on Gumlet (and on the laptop) found in the code

| # | Coupling | Where | Effect |
|---|---|---|---|
| 1 | Mobile enqueue ran **after** the Gumlet enqueue and only if that succeeded | `completeUpload`: `enqueueTranscode` throws `QUEUE_UNAVAILABLE` before the mobile block | A queue problem on the Gumlet job meant no mobile job, and the dashboard was told the upload failed for a file that was verified in R2 |
| 2 | The mobile instruction was **not durable** | `enqueueMobileTranscode`: Redis first, database second; on failure `mobileStatus = FAILED` | An API restart between the two lost the job silently (row stays `NONE`, and no sweep looks at `NONE`); a Redis blip reported a healthy video as FAILED |
| 3 | **Playback** gated on the Gumlet state before choosing a pipeline | `PlaybackService.issueTicket`: `video.status` checks ahead of `planDelivery` | A lecture Gumlet rejected (or was still packaging) could not be played on a phone even with a READY mobile ladder |
| 4 | The **lesson DTO** reports the Gumlet state as "the" status | `LessonsService.detail`: `status: video.status` | The shipped apps hide the Watch button unless that field is `READY` |
| 5 | The backlog tool required Gumlet success | `migrateLibraryToMobile`: `status in (READY, ARCHIVED)` | A Gumlet-failed lecture could never be selected for mobile processing |
| 6 | Replacing a lecture's file reset Gumlet but **not** mobile | `initUpload` (replace branch) | The row stayed mobile-READY for the *previous* recording: apps would have been served the old video over HLS while the web played the new one |
| 7 | **Gumlet ingestion runs on the laptop** | `WORKER_QUEUES` is empty on the only worker, so it consumes `video-processing` too | When the laptop sleeps, Gumlet submission, the recovery sweep, scheduled announcements and push delivery all stop — the reverse dependency |
| 8 | The operator pause holds **every** mobile job | `MobileVideoProcessor`: `if (pause.paused) defer` | Pausing between backlog batches would also park every new upload |

### A3. Does the dashboard fail when Gumlet rejects a video?

Not at upload time: Gumlet is called asynchronously by the worker, so a
rejection arrives later as `status = FAILED`. But the panel had **one** badge
(the Gumlet state), labelled the result "Processing failed", never rendered the
`mobile` block the API already returned, and stopped polling once Gumlet
settled. A reader could not tell a Gumlet rejection from a lost upload. And a
`complete` call that failed after a successful PUT *was* shown as an upload
error.

### A4. Other defects found on the way

- `queue.add()` **never returns** while Redis is unreachable (BullMQ's
  connection retries for ever), so a Redis outage hung the upload request.
- `StorageService.objectSize` answers `null` for "not there" *and* for "could
  not ask", so a network blip told the administrator to upload the file again.
- `StorageService.downloadToFile` was a single streamed GET with no resume: the
  cause of the `aborted` / `socket hang up` failures in batch 5.
- HLS segment uploads were not retried (a stream body cannot be replayed by the
  SDK): one dropped PUT discarded an hour-long encode.
- `maxStalledCount` was the library default of 1: a lecture interrupted by two
  laptop sleeps was failed permanently ("job stalled more than allowable limit").
- A first failed attempt marked the row `FAILED` while BullMQ's own retry was
  still pending — a staff retry in that window queued a second job.
- A mobile row stuck in `PROCESSING` with no job was only noticed after 4 hours.

---

## B. Changes implemented

### Backend (`edu-backend`, branch `fix/dual-pipeline-independence`)

| File | Change |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/20261116120000_video_pipeline_intents/` | Four **additive** columns on `videos`: `mobileRequestedAt`, `mobileEnqueuedAt`, `mobileGeneration`, `mobileTrigger` |
| `src/modules/videos/pipeline-state.ts` (new) | Pure helpers: the three states (source / gumlet / mobile), deterministic job ids, `mobileLadderCanCarry`, `studentFacingVideoStatus` |
| `src/modules/videos/videos.service.ts` | `completeUpload` rewritten around durable acceptance; `enqueueMobileTranscode` records the intent first and is idempotent; `queueUploadTranscode`; `reconcilePendingIntents` (outbox drain); bounded queue operations; `retryMobileProcessing` refuses duplicates / READY; `markMobileRetrying`; READY guard in `markMobileProcessing`; faster orphan detection; `initUpload` resets the mobile state on replacement; richer `status()` |
| `src/modules/videos/video-pipeline-reconciler.service.ts` (new), `videos.module.ts` | In-process timer that delivers undelivered intents (API and worker) |
| `src/modules/videos/videos.controller.ts` | `pause` accepts `scope`; `mobile/retry` accepts `force` (admins) |
| `src/modules/playback/playback.service.ts` | The Gumlet-state gate defers exactly one case to after device authorisation (`refuseForVideoStatus`, `mobileHlsApplies`) |
| `src/modules/lessons/lessons.service.ts`, `lessons.controller.ts` | Native HLS clients are shown `READY` when their own ladder can play the lecture |
| `src/modules/storage/storage.service.ts` | `objectSizeStrict`; resumable ranged `downloadToFile` |
| `src/jobs/processors/hls-transcoder.ts` | Output uploads retried; read-after-write check looks again before failing |
| `src/jobs/processors/mobile-video.processor.ts` | Pause scope; `maxStalledCount: 5`; a retryable attempt no longer marks FAILED |
| `src/jobs/processors/scratch-guard.ts` | `PauseScope` (`all` / `historical`), `pauseHolds` |
| `src/jobs/worker-heartbeat.ts` | One heartbeat key per worker role, so a split deployment reports truthfully |
| `src/jobs/queue.constants.ts`, `src/config/env.validation.ts`, `.env.example` | `MOBILE_JOB_ATTEMPTS`; `VIDEO_PIPELINE_RECONCILE_SECONDS` |
| `test/unit/…` | 4 new spec files + a stateful test-double module; 6 existing specs updated to the new contract |

### Dashboard (`edu-dashboard`, branch `feat/dual-pipeline-status`)

| File | Change |
|---|---|
| `src/features/videos/hooks.ts` | Types for the three blocks; polling continues (slower) while only mobile is in flight; `useRetryMobileProcessing` |
| `src/features/videos/pipeline-status.tsx` (new) | `PipelineSummary` (Upload / Gumlet / Mobile HLS chips) and `MobilePipelinePanel` |
| `src/features/videos/lesson-video-panel.tsx` | Renders both; the failure block and its retry are named for Gumlet; "uploaded, not confirmed" state |
| `src/features/videos/upload.ts` | Finalisation is retried; an unreachable API after a stored file is `unconfirmed`, not `error` |
| `e2e/stub-api/server.mjs`, `e2e/video-dual-pipeline.spec.ts` (new), `e2e/video-upload.spec.ts` | The stub models the two pipelines separately; 7 new scenarios |

### Mobile app

No change required. The shipped apps decide the player from the ticket
(`drm.scheme`) and gate the Watch button on `lesson.video.status`; both are now
answered correctly by the server for the Gumlet-failed / mobile-ready case.

---

## C. Final architecture

```
Dashboard ──PUT──▶ R2 (original)
    │
    └─ POST /videos/:id/complete
         1. HEAD the object (strict: "missing" ≠ "could not ask")      ── SOURCE = VERIFIED
         2. DB: mobile intent   (mobileStatus=QUEUED, generation+1,    ── durable, before Redis
                                 mobileJobId = mobile-hls:<id>:p1g<n>)
         3. Redis: add that job (bounded 5 s; failure ≠ error)         ── mobileEnqueuedAt
         4. DB: web intent      (status=QUEUED, processingJobId=NULL)  ── durable, before Redis
         5. Redis: add transcode:<id>:src<hash(sourceKey)>             ── processingJobId
         └─ 201 { upload: VERIFIED, gumlet: {queued}, mobile: {status, queued} }

video-processing queue ──▶ VideoProcessor ──▶ Gumlet      writes: status, gumlet*, drm*
mobile-video-processing ──▶ MobileVideoProcessor ─ ffmpeg ─▶ R2   writes: mobile*, hlsPrefix, renditions

VideoPipelineReconciler (in-process, every 120 s, API + worker):
    rows with an intent and no job  ──▶ add the same deterministic job
```

- **Three states, three sets of columns.** Source: `sourceKey`, `sourceSizeBytes`.
  Gumlet: `status`, `gumlet*`, `drm*`, `processing*`. Mobile: `mobile*`,
  `hlsPrefix`, renditions. No Gumlet code path writes a mobile column and no
  mobile code path writes a Gumlet one (asserted by test).
- **Durable intent (outbox).** The instruction to process is committed to
  Postgres before Redis is touched. `mobileEnqueuedAt IS NULL` / `processingJobId
  IS NULL` on a QUEUED row is the undelivered state; the reconciler drains it.
- **Idempotent by identity.** Job ids are a function of the work
  (`mobile-hls:<video>:p<profile>g<generation>`, `transcode:<video>:src<hash>`),
  so a retried request, two API processes and the reconciler all add *the same*
  job, which BullMQ collapses. A new intent is a compare-and-set on
  `mobileGeneration`.
- **Upload success ≠ processing success.** `complete` answers 201 as soon as the
  source is verified and the row is committed. A queue outage is reported in the
  body (`queued: false`), never as a failed upload.
- **Truthful QUEUED.** A job waits in Redis however long the encoder is away;
  the status endpoint says QUEUED, whether an encoder is online, and whether an
  operator pause is holding it.
- **Recovery without a worker.** The reconciler is a timer inside every
  process, not a queued job: it needs neither Redis nor a worker to start. It
  costs one indexed query per tick and no Redis traffic when nothing is pending.
- **Playback.** `issueTicket` still refuses on the Gumlet state — except when
  Gumlet's verdict is its own (`FAILED` / `QUEUED` / `PROCESSING`), the mobile
  ladder is complete **and** the request comes from a bound, HLS-capable mobile
  device. That one case is decided after device authorisation and before the
  stream slot and the play allowance. Lesson access, entitlement, device
  binding, concurrency, play limits, watermark, ticket rotation, AES key
  delivery and the DRM gate for Gumlet are unchanged.

---

## D. Tests

All commands were run on this laptop on 2026-11-16/17.

| Command | Result |
|---|---|
| `npx tsc --noEmit` (backend) | clean |
| `npx eslint` on every changed backend file | clean |
| `npx jest --runInBand` (backend, full unit suite, `PIPELINE_TEST_REDIS_URL` set) | **183 suites passed, 2 skipped; 3,548 tests passed, 0 failed** |
| `npx jest test/unit/mobile-priority-real-queue.spec.ts` (pre-existing opt-in suite, real BullMQ) | 5 / 5 in three of four runs; one run failed one test on a timing race inside the test itself (a 150 ms encode finishing before a 200 ms one is recorded) |
| `npx jest test/unit/dual-pipeline-real-queue.spec.ts` (real BullMQ on local Redis) | **5 / 5** |
| `npx prisma migrate deploy` + `prisma migrate diff` on a scratch local database | 27 migrations applied; diff against `schema.prisma` is empty |
| `npx tsc --noEmit`, `npx eslint src/features/videos` (dashboard) | clean |
| `npx playwright test e2e/video-dual-pipeline.spec.ts e2e/video-upload.spec.ts` (production build, Chromium) | **25 / 25** (7 new, 18 existing) |
| Local end-to-end: real Postgres, Redis, S3 (rustfs), ffmpeg 9.0; Gumlet replaced by a local stand-in that rejects | see below |

Scenario coverage (`test/unit/dual-pipeline-independence.spec.ts` unless noted):

| Scenario | Where it is proven |
|---|---|
| A normal upload | unit; e2e (dashboard) |
| B Gumlet rejection | unit; dashboard e2e; **local end-to-end with real ffmpeg** |
| C Docker offline | unit; real BullMQ; **local end-to-end** (upload accepted with no worker, encoded when one started) |
| D Redis unavailable | unit (reject *and* hang); real BullMQ against a dead port |
| E API crash between commit and enqueue | unit (second process + reconciler) |
| F duplicate finalisation | unit; real BullMQ (5 concurrent) ; local end-to-end |
| G independent retries | unit; dashboard e2e (endpoint call counts); local end-to-end |
| H ffmpeg failure | unit (generic error, output-verification error, failed re-encode) |
| I worker restart | unit; **real BullMQ** (worker killed mid-encode, stalled check recovers the same job) |
| J existing videos | unit (legacy rows byte-identical after every sweep) |
| K dashboard visibility | unit (`status()` contract); dashboard e2e |
| L real mobile playback | **partially** — see "Not verified" |

Local end-to-end run (2026-11-16 22:14Z), real endpoints throughout:

```
complete -> HTTP 201 in 95 ms   (no worker running)
  upload VERIFIED · gumlet.queued true · mobile QUEUED, jobId mobile-hls:<id>:p1g1
complete (repeat) -> alreadyQueued=true, same two job ids
worker started:
  22:14:28 gumlet=PENDING mobile=QUEUED
  22:14:31 gumlet=FAILED  mobile=PROCESSING      (Gumlet stand-in: 422 unsupported codec)
  22:14:37 gumlet=FAILED  mobile=READY           (ffmpeg, 480p + 720p, AES-128)
app  lesson.video.status = READY
app  ticket -> 200, drm.scheme=none; master playlist 2 variants
app  ffmpeg decrypt+decode of 12 s -> exit 0; watermark present
old app (no hls-aes128) -> 409 VIDEO_PROCESSING_FAILED
web  lesson.video.status = FAILED; ticket -> 409 VIDEO_PROCESSING_FAILED
Retry Gumlet -> mobile block byte-identical before/after
Retry Mobile HLS on a READY ladder -> 409 INVALID_STATE
```

### Not verified

- **Scenario L on a device.** Playback was verified at protocol level (a real
  ticket, the real manifest and key endpoints, ffmpeg decrypting the stream),
  not in the app. The Android emulator run and any iOS run were **not**
  performed in this pass. No iOS runtime exists on this Windows machine.
- **Gumlet happy path end-to-end.** The local run used a rejecting stand-in.
  Gumlet success is covered by the existing unit suites and by production
  itself; it was not re-exercised against the real provider.
- **Production behaviour.** Nothing was deployed, so every statement about
  production after deployment is a prediction from tests.
- **The worker Docker image** for this branch was not built.

---

## E. Production assessment (as read on 2026-11-16 22:08Z)

Working today: uploads, Gumlet ingestion (every `READY` video's Gumlet asset
is `ready`, with the one exception listed under class 9), web and app playback
through Gumlet, the 44 migrated ladders.

Not working / blocked until deployment and a configuration decision:

- No new upload is queued for mobile (A1). 32 lectures since 10 Nov.
- Mobile encoding is **paused** by an operator flag (auto-set at 20:03Z:
  "laptop off home Wi-Fi"). 8 historical jobs are parked in the delayed set.
- While the laptop is asleep or off: no Gumlet ingestion, no recovery sweep,
  no scheduled announcements, no push delivery (A2 #7).
- A Gumlet-failed lecture cannot be played on mobile even with a ladder (A2 #3).
  One live video is already in that position: `cmv09znia000thl01wixuismf`
  (Gumlet asset `deleted`, mobile READY).

---

## F. Existing videos

271 live videos, classified from the database, R2 `HEAD`s and the queue:

| # | Class | Count | Content |
|---|---|---|---|
| 1 | Mobile READY (master playlist present in R2) | 44 | 32.9 h |
| 2 | Mobile QUEUED with a live job (delayed behind the pause) | 4 | 4.0 h |
| 3 | Mobile PROCESSING with an active worker | 0 | |
| 4 | Mobile PROCESSING but orphaned | 0 | |
| 5 | Mobile NONE, source available | 200 | 156.7 h |
| 6 | Mobile FAILED, source available (all four: network, BullMQ retry pending) | 4 | 2.3 h |
| 7 | Source missing | 19 | 8 abandoned `UPLOADING`, 11 `ARCHIVED` |
| 8 | Gumlet READY, mobile missing | 203 | 159.0 h |
| 9 | Gumlet failed/deleted, mobile READY | 1 | |
| 10 | Both failed | 0 | |

Proposed recovery, in controlled batches (nothing started):

- **List A — 32 uploads since 2026-11-10 14:41Z that were never queued**
  (19.7 h of content, 6.6 GB of sources; encoding time on the laptop was not
  re-measured here - earlier batches suggest somewhere between 10 and 20 hours
  of worker time). These are the lectures students are being sent to
  now; recommended first, newest first, in batches of ~8. Ids:
  `dual-pipeline-report/backfill-A.txt`.
- **List B — 168 historical videos** (137.0 h): continue the existing batch
  method after List A.
- **List C — 4 FAILED on network errors**: their BullMQ retries are still
  pending and run on resume; no action beyond resuming. The resumable download
  in this branch addresses their cause.
- **Class 7** needs re-uploads, not processing. Left untouched.
- The 4 QUEUED jobs keep their place; nothing is re-queued.

---

## G. Deployment plan (each step is an approval gate)

1. **Neon backup branch**, then apply migration `20261116120000_video_pipeline_intents`
   (`prisma migrate deploy` from the release commit). Additive; the running API
   and worker are unaffected by it.
2. **Deploy the API** (Render, manual deploy of the release commit). Keep
   `MOBILE_PIPELINE_ENABLED=false` for this step. Effect: durable acceptance,
   the reconciler, the status contract, the playback fix. No new mobile jobs yet.
3. **Deploy the dashboard** (Vercel). It degrades cleanly against an older API,
   so order relative to step 2 is not critical; after is tidier.
4. **Build and swap the worker image** on the laptop (resumable download,
   upload retries, stalled budget, pause scope). Keep the previous image tag
   for rollback, as before.
5. **Change the pause to `scope=historical`** (`POST /videos/mobile/pause`), so
   the backlog stays parked and new uploads flow.
6. **Set `MOBILE_PIPELINE_ENABLED=true`** on Render. From here every new upload
   is queued for mobile automatically.
7. Upload one test lecture; confirm the three chips and both pipelines.
8. **Backfill List A** in batches.
9. *(Recommended, separate decision)* **Split the workers**: on Render set
   `RUN_WORKERS=true` and `WORKER_QUEUES=video-processing,push-delivery,maintenance,analytics`;
   on the laptop set `WORKER_QUEUES=mobile-video-processing`. Gumlet ingestion,
   recovery, announcements and pushes then no longer depend on the laptop.

Monitoring after step 6: `GET /videos/mobile/overview`; API log lines
`pending intents:` (should stay silent) and `accepted, but its transcode job is
not in the queue yet`; rows with `mobileStatus='QUEUED' AND "mobileEnqueuedAt"
IS NULL` older than five minutes (should be zero).

## H. Rollback

- **API**: Render → roll back to the previous deploy. The new columns stay and
  are ignored by the old build. Jobs already in Redis keep their ids and are
  consumed normally by either build. Rows the new API left QUEUED-but-undelivered
  are picked up by the old 30-minute sweep (QUEUED, job missing → re-queued).
- **Stop new mobile jobs without a rollback**: `MOBILE_PIPELINE_ENABLED=false`.
- **Stop encoding**: `POST /videos/mobile/pause` (default scope `all`).
- **Mobile playback back to Gumlet for everyone**: `POST /videos/mobile/delivery`
  `mode=gumlet` (existing emergency switch; unchanged).
- **Worker**: restore the previous `.env.worker` and `docker compose up -d`, as
  in earlier swaps.
- **Dashboard**: Vercel → promote the previous deployment.
- **Migration**: no down-migration is needed for a rollback. If the columns must
  go: `ALTER TABLE "videos" DROP COLUMN …` for the four columns, after rolling
  the API back.

No rollback step deletes a video, a Gumlet asset, an R2 object or a queue.

## I. Operations that need approval

1. Push either branch / open pull requests.
2. Create the Neon backup branch and apply the migration to production.
3. Deploy the API to Render.
4. Deploy the dashboard to Vercel.
5. Build and swap the laptop worker image.
6. Change the pause flag to `scope=historical` (a Redis write).
7. Set `MOBILE_PIPELINE_ENABLED=true` on Render.
8. Queue backfill List A (and later List B).
9. The worker split (Render `RUN_WORKERS` / `WORKER_QUEUES`, laptop `WORKER_QUEUES`).
10. Any on-device playback test against production.
