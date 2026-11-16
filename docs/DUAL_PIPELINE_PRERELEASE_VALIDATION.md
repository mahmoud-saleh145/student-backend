# Dual pipeline: pre-release validation and release checklist

Written 2026-11-17, after `docs/DUAL_PIPELINE_INDEPENDENCE.md`. Backend branch
`fix/dual-pipeline-independence` at code commit **9e19d4a**; dashboard branch
`feat/dual-pipeline-status` at **8d8e06e**; worker image
**`edu-worker:dual-pipeline-9e19d4a`** (id `ef76a5e80914`, built locally).

During this pass nothing was pushed, deployed or migrated in production, no
production environment variable or row was changed, and no production job was
started. Production was touched only by read-only checks (one `READ ONLY`
database transaction, `GET` requests to Gumlet). Every write-capable test ran
against a scratch database, a local Redis and local S3-compatible storage, all
removed afterwards.

---

## 1. Verdict

**GO for a staged release, with three conditions** (all are steps in the
checklist below, none is a code change):

1. The mobile pause must be re-issued with `scope=historical` and the running
   watchdog script replaced **before** `MOBILE_PIPELINE_ENABLED` is turned on.
   The flag set in production today has no scope, which means "hold
   everything", new uploads included.
2. `.env.worker` must get the new `WORKER_IMAGE` **and** `BUILD_COMMIT`; it
   pins an old commit that overrides the one baked into the image.
3. A one-video production smoke test at the two points marked below.

**Not validated, and not claimed:** iOS (no iOS runtime exists on this
machine); a production release build on a physical Android phone (the
emulator can only run the development build against a local API); real Gumlet
asset *creation* (billable write; only read-only calls were made).

| # | Requirement | Result |
|---|---|---|
| 1 | Worker image builds and starts with the existing configuration | **GO** |
| 2 | Android emulator: playback, authorisation, encryption | **GO** (dev build, local stack) |
| 3 | Real Gumlet integration | **GO** (read-only) |
| 4 | `mobile-priority-real-queue` failure | **GO** - defect in the test, fixed |
| 5 | Reconciler: Redis, database, duplicates, several instances | **GO** - two defects found and fixed |
| 6 | New uploads never blocked by a backlog pause | **GO in code; conditional in production** (condition 1) |
| 7 | Gumlet off the laptop | **Prepared and trialled locally; not part of this release** |
| 8 | Flag on does not queue the 200 old videos | **GO** |
| 9 | Release checklist | Section 3 |

---

## 2. Evidence

### 2.1 Worker image

- `docker build --target production --build-arg BUILD_COMMIT=9e19d4a…` →
  `edu-worker:dual-pipeline-9e19d4a`, 1.46 GB, user `app`, node 20.20.2,
  ffmpeg/ffprobe 5.1.9, migration `20261116120000_video_pipeline_intents`
  and the regenerated Prisma client inside.
- **The real `.env.worker`, unmodified, validated inside the new image with
  networking disabled** (`--network none`): env validation passed (132 keys);
  ladder 480/720/1080, encryption on, 30 GB reserve, Gumlet DRM fully
  configured, all queues, heartbeat key `worker:heartbeat` (the one today's API
  reads), bounded-database timeouts present.
- **Started through the real `docker-compose.yml` and the real `.env.worker`**
  with an override that re-points every endpoint to this machine (resolved
  config checked before start: local database, Redis, storage, a fake Gumlet
  key, a separate scratch folder, a different container name). Result:
  `Up (healthy)`, database and Redis connected, consumers registered, and it
  immediately encoded a job that had been waiting with no encoder running:
  probe → 480p + 720p → `mobile-READY (2 renditions)`. A second upload with
  Gumlet rejecting ended `Gumlet FAILED / Mobile READY`.
- Not done, by design: starting the new image against production endpoints.
  That is the deployment itself (and the new Prisma client must not meet the
  unmigrated database).
- Finding: `.env.worker` contains `BUILD_COMMIT=7c23265…`, which overrides the
  image's own value, so the heartbeat reported the old build. → checklist.

### 2.2 Android emulator

Setup: AVD `Pixel_10`, Android 17. The installed development-variant debug
build (`com.studentcenter.app.dev`) with the JavaScript of the **current app
commit c4a2fdd** served by Metro. API from this branch on the host
(`10.0.2.2:3000`), storage and database local. Two lectures uploaded through
the real endpoints: **A** (Gumlet READY, mobile READY) and **B** (Gumlet
**FAILED**, mobile READY).

| Check | Observation |
|---|---|
| Lesson screen for B | **"Watch now"** is offered (the app is told `READY` for its own ladder) |
| Player for B | opens, timeline `0:00 / 0:24`, plays to `0:24 / 0:24` |
| Player for A | same, `0:21 → 0:24` |
| Grant | `playback_tickets.delivery = hls` for both, bound device, watermark tag set |
| Device binding | one `android` device, `ACTIVE`, registered at first use |
| Heartbeats / accounting | last position 24 s, watched 24 s and 22 s, one play recorded for B, 0 capture attempts |
| Protection | "Protected content - recording is disabled"; tiled watermark with the student's name and id; **screenshots of the lesson and player are black** (capture protection active) |

Authorisation, against the same grant (protocol level):

```
ticket without a session                                   401 UNAUTHORIZED
ticket as a student who is NOT enrolled                    403 NOT_ENROLLED
lesson detail as a student who is NOT enrolled             403 NOT_ENROLLED
ticket as the enrolled student from a second phone         403 DEVICE_CHANGE_PENDING
master playlist of the grant, no signature                 422 VALIDATION_ERROR
master playlist, forged signature                          403 PLAYBACK_DENIED
AES key endpoint, no signature                             422 VALIDATION_ERROR
```

Encryption, in storage: 8 segments + 3 playlists, **no key file**; playlist
carries `#EXT-X-KEY:METHOD=AES-128`; a stored segment has MPEG-TS sync bytes at
36 of 9,963 packet offsets (chance level - it is not readable as plain TS).
ffmpeg decrypting and decoding the same kind of stream through a ticket was
shown in the first report.

Limits: 24-second clips, so ticket rotation was not exercised here (it was in
the 45-minute session of 2026-11-12, not repeated). Development build, local
API. No physical device. **No iOS.**

### 2.3 Gumlet (read-only, from the new image, production credentials)

- The Gumlet code is untouched: `gumlet-drm.service.ts`,
  `gumlet-ingest.service.ts`, the webhook service and controller,
  `gumlet-failure.ts`, the DRM verification services and `video.processor.ts`
  are byte-identical to `origin/main`.
- Live calls (`GET` only): account quota readable; four production assets (the
  three newest and the oldest) report `ready`, agree with the database, and
  their DASH manifests are fetched (HTTP 200) and carry CENC protection;
  licence URL signing works; the one asset deleted at Gumlet
  (`cmv09znia000thl01wixuismf`) is reported `deleted`, as recorded.
- Not exercised: creating an asset (a billable write in the production
  workspace). The most recent production upload (2026-11-16 20:41Z) went
  through that unchanged path and is READY.

### 2.4 `mobile-priority-real-queue`

- Cause: the test helper recorded "the upload was taken" only when the upload
  job **finished** (200 ms later). A historical encode that correctly started
  once the upload was taken and finished sooner (150 ms) found the record
  empty → `TypeError … reading 'startedAt'`.
- Measured: untouched `origin/main` **5 pass / 3 fail of 8 runs**; with the
  helper recording at the moment the job is taken, **8 of 8**.
- It cannot affect production: the defect is in test bookkeeping. The rule
  itself (a historical job never starts while an upload is waiting) is asserted
  separately in the same tests and held in all 16 runs, as did "two workers
  never encode at the same time".

### 2.5 Reconciler

Two defects found in my own first version and fixed in 9e19d4a:

1. A grace window keyed on `updatedAt` (which every write to the row moves)
   let a struggling mobile delivery postpone the Gumlet one, and cleared the
   in-memory "something is pending" too early. → No grace window; adds are
   idempotent.
2. The reconciler could write `QUEUED` over a row a worker had since moved to
   PROCESSING / READY. → Its write is now conditional on the row still being
   "accepted, not delivered".

Measured on real Redis and Postgres:

| Question | Answer |
|---|---|
| Redis commands for 10 idle scans | **0** |
| Redis commands for a scan with 1 pending intent | 12 (3 sent by the client; the rest run inside BullMQ's add script) |
| Redis commands for one accepted upload | 21, same accounting (3 sent by the client: 1 lookup, 2 adds) |
| Database | one query per scan: bitmap-OR of the two existing indexes, **0.12 ms** on 5,023 rows, 8 buffer hits; returns 0 rows for jobs queued by the old build |
| How often | once at boot; every 30 s **only while this process knows a delivery failed**; otherwise every 600 s (`VIDEO_PIPELINE_RECONCILE_SECONDS`) → 144 small queries a day per process |
| Duplicates | 5 instances reconciling the same 6 stranded intents at once → exactly 6 jobs per queue, generation unchanged |
| Several Render instances | safe without a lock: job ids are a function of the intent, and the web write is conditional |

### 2.6 Pause

On real Redis with the real pause flag: with `scope=historical` a new upload
is encoded while a backlog job stays queued; with `scope=all` a new upload is
held (and says QUEUED, not failed); on resume the upload runs first. A flag
written without a scope still means `all`.

Production today: the flag is set (since 2026-11-16 20:03Z) **without a
scope**, and the running watchdog (`C:\edu-watchdog\watchdog.js`, old script)
writes scope-less pauses. Both must change before the automatic flag is turned
on - otherwise new uploads queue and wait. The watchdog in this branch writes
`scope: historical` (`WATCHDOG_PAUSE_SCOPE=all` restores the old behaviour).

### 2.7 Gumlet on an always-on service (prepared, not deployed)

Safest implementation: **no new service and no new code path** - the existing
queue selection, on the Render API process:

```
Render (API):  RUN_WORKERS=true   WORKER_QUEUES=video-processing
Laptop:        WORKER_QUEUES=mobile-video-processing,push-delivery,maintenance,analytics
```

Trialled locally in exactly that shape: with **no encoder running**, the API
process took an upload through create → poll → ready → DRM manifest check to
`READY`, while the mobile job stayed QUEUED; the dashboard contract reported
`workerOnline: true, workerCanTranscode: null` for Gumlet and `workerOnline:
false` for mobile; when the encoder container started it reported under its
own heartbeat key and finished the mobile job.

Resources, measured: API alone 119 MB RSS; + the Gumlet consumer 120 MB; + four
consumers 122 MB (Render free tier: 512 MB). An idle consumer costs the same
Redis traffic wherever it runs (46 commands per 2 minutes per queue as Redis
counts them, about 10 as the client sends them), so moving one adds no polling; the
second heartbeat adds about 1,440 `SET`s a day.

Risks to accept or remove before doing it:

- A Render **free** instance sleeps after ~15 idle minutes. An upload wakes it
  and the job starts, but a long Gumlet poll can be cut short; it is resumed by
  BullMQ's stalled check and the recovery sweep. A paid always-on instance
  removes this.
- Exactly one worker per role may report: two processes consuming
  `video-processing` would overwrite each other's heartbeat. The laptop must
  drop that queue in the same change.
- The API needs the Gumlet variables (it has them: it already signs and
  syncs). Push delivery and maintenance stay on the laptop in this first step,
  so nothing else on Render changes.
- A legacy (non-Gumlet) video cannot be transcoded on a host without ffmpeg.
  Production has none.

Recommendation: release first; do this as its own change afterwards.

### 2.8 The 200 old videos

`MOBILE_PIPELINE_ENABLED=true` changes one thing: `completeUpload` records a
mobile intent **when it accepts an upload** (row not yet in the pipeline, mobile
state `NONE`). Tested with a 200-lecture library and the flag on: the boot
scan, the reconciler, both sweeps (immediately, a day later, a week later) and
a stray finalisation call on every one of the 200 queue **nothing** and write
nothing. The only bulk path is `POST /videos/mobile/migrate`, admin-only,
`dryRun=true` unless `dryRun=false` is sent, bounded by `limit`. Backlog jobs
carry BullMQ priority 10 and a new upload none, so the upload is taken first
(in-memory and real-queue tests); on production data the reconcile query
returns zero rows for the jobs already queued by the old build.

### 2.9 Test totals for this pass

| Suite | Result |
|---|---|
| Backend, full unit run incl. both real-BullMQ suites | 184 suites passed, 1 skipped (opt-in); **3,565 tests passed, 0 failed** |
| `dual-pipeline-real-queue` (real BullMQ) | 8 / 8, three consecutive runs |
| `mobile-priority-real-queue` (real BullMQ) | 8 of 8 runs |
| `tsc`, `eslint` on changed files | clean |
| Dashboard | unchanged in this pass (25 / 25 Playwright at 8d8e06e) |

Known gaps, none blocking:

- When only the mobile pipeline succeeds, the lecture's duration is not copied
  to the lesson row, so the course list shows `0m` for it (lesson detail and
  the player are correct).
- The "new video available" notification is still sent when Gumlet finishes; a
  Gumlet-failed, mobile-ready lecture does not notify.

---

## 3. Release checklist

Release artefacts: backend `fix/dual-pipeline-independence` (code 9e19d4a;
later commits are documentation only - rebuild the image if any code changes),
dashboard `feat/dual-pipeline-status` 8d8e06e, image
`edu-worker:dual-pipeline-9e19d4a`. Each numbered step is an approval gate.

### Step 0 - before anything

- [ ] Review and merge both pull requests.
- [ ] Laptop on home Wi-Fi and AC power, lid open; Docker healthy.
- [ ] Note the current Render deploy id (for rollback) and Vercel deployment.

### Step 1 - database

- [ ] Neon: create backup branch `pre-dual-pipeline-<date>` from production.
- [ ] From the release commit, with the production `DIRECT_URL`:
      `npx prisma migrate deploy` → applies **only**
      `20261116120000_video_pipeline_intents`.
- [ ] Verify: `select count(*) from videos where "mobileGeneration" <> 0` → 0;
      the four columns exist (`mobileRequestedAt`, `mobileEnqueuedAt`,
      `mobileGeneration`, `mobileTrigger`).
- Effect on running code: none (additive columns).

### Step 2 - API (Render), flag still OFF

- [ ] Environment: **no change**. `MOBILE_PIPELINE_ENABLED` stays `false`.
      Optional: `VIDEO_PIPELINE_RECONCILE_SECONDS` (default 600).
- [ ] Manual deploy of the merged commit.
- [ ] Verify: log line `video pipeline reconciler: scan at boot…`; no
      `pending intents:` line; `GET /videos/<any id>/status` returns `source`,
      `gumlet`, `mobile` blocks; `/meta/health/deep` unchanged.

### Step 3 - dashboard (Vercel)

- [ ] Deploy the merged commit. Open a lecture: three chips are shown.

### Step 4 - smoke test #1 (one video, flag OFF)

- [ ] Upload one short test lecture to an **unpublished** test lesson.
- [ ] Expect: upload accepted; chips `Uploaded · Gumlet Pending→Ready ·
      Mobile HLS Not started`; exactly one row; nothing in the mobile queue.
- This proves the new acceptance path on production without any mobile work.

### Step 5 - worker and watchdog (laptop)

- [ ] In `deploy/laptop-worker/.env.worker`: back it up, then set
      `WORKER_IMAGE=edu-worker:dual-pipeline-9e19d4a` and
      `BUILD_COMMIT=9e19d4a78ee6a7fda1f1ea203bc11ba2e9b5f757`. Nothing else.
- [ ] Confirm no encode is running (`GET /videos/mobile/overview` →
      `worker.detail.activeJobs: []`), then `docker compose --env-file .env.worker up -d`.
- [ ] Verify: container healthy; heartbeat build `9e19d4a78ee6`; the delayed
      backlog jobs are still delayed (the pause is still on).
- [ ] Watchdog: copy `deploy/laptop-worker/watchdog/watchdog.js` to
      `C:\edu-watchdog\`, restart the `edu-hls-watchdog` container, confirm its
      start log shows `pauseScope: historical`.

### Step 6 - pause scope

- [ ] `POST /videos/mobile/pause` with
      `{ "reason": "backlog paused between batches", "scope": "historical" }`.
- [ ] Verify `GET /videos/mobile/overview` → `pause.scope = historical`.
- From here a backlog pause no longer holds new uploads.

### Step 7 - turn automatic mobile processing ON

- [ ] Render: `MOBILE_PIPELINE_ENABLED=true`, save, redeploy.
- [ ] Verify immediately: mobile queue counts unchanged (no new jobs); no
      `pending intents:` log line.

### Step 8 - smoke test #2 (one video, flag ON)

- [ ] Upload one short test lecture to the unpublished test lesson.
- [ ] Expect within a minute: `Uploaded · Gumlet Pending · Mobile HLS Queued`;
      one new job `mobile-hls:<videoId>:p1g1` in the mobile queue, **without**
      a priority; the 8 backlog jobs untouched.
- [ ] Expect within a few minutes: `Mobile HLS Processing nn%` then `Ready`;
      Gumlet `Ready` independently.
- [ ] `select "mobileStatus", "mobileGeneration", "mobileEnqueuedAt" is not null
      from videos where id = '<videoId>'` → `READY, 1, true`.
- [ ] On a phone with the HLS-capable app (once it is live): the lecture plays;
      the ticket row has `delivery = hls`.
- [ ] Remove the two test videos from the dashboard. (Their Gumlet assets
      remain at Gumlet; delete them there by hand if wanted.)

### Step 9 - backfill (separate approval)

- [ ] List A (32 ids, `backfill-A.txt`) in batches of about 8, with the usual
      watcher. `POST /videos/mobile/resume` only when a batch should run.

### Step 10 - optional, later: Gumlet off the laptop (section 2.7)

### Rollback

| What | How | Leaves behind |
|---|---|---|
| Stop new mobile jobs | `MOBILE_PIPELINE_ENABLED=false` on Render | queued jobs stay and run |
| Stop encoding | `POST /videos/mobile/pause` (no scope = everything) | nothing lost |
| Worker | restore the `.env.worker` backup, `docker compose --env-file .env.worker up -d` | jobs keep their ids; the old image runs them |
| API | Render → roll back to the noted deploy | new columns ignored; a row left "accepted, not delivered" is re-queued by the old 30-minute sweep |
| Dashboard | Vercel → promote the previous deployment | - |
| Mobile playback | `POST /videos/mobile/delivery` `mode=gumlet` | unchanged emergency switch |
| Migration | not needed for any rollback; if wanted, drop the four columns after the API rollback | - |

No rollback step deletes a video, a Gumlet asset, an R2 object or a queue.
