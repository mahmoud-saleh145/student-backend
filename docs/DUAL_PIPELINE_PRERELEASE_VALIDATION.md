# Dual pipeline: pre-release validation and release checklist

Written 2026-11-17, after `docs/DUAL_PIPELINE_INDEPENDENCE.md`. **Revised the
same day**: the two functional gaps the first version listed are closed
(section 2.10) and the release checklist was reviewed again end to end
(section 3).

Release artefacts: backend branch `fix/dual-pipeline-independence` at code
commit **798f639**; dashboard branch `feat/dual-pipeline-status` at
**8d8e06e** (unchanged); worker image **`edu-worker:dual-pipeline-798f639`**
(id `sha256:8b25526bc67f…`, built locally). The image from the first version,
`dual-pipeline-9e19d4a`, is superseded and must not be deployed: it does not
contain the two fixes.

Nothing was pushed, deployed or migrated in production, no production
environment variable or row was changed, and no production job was started.
Production was touched only by read-only checks (`READ ONLY` database
transactions, `GET` requests to Gumlet). Every write-capable test ran against
a scratch database, a local Redis and local S3-compatible storage, all removed
afterwards.

---

## 1. Verdict

**GO for a staged release, with four conditions** (all are steps in the
checklist below, none is a code change):

1. The mobile pause must be re-issued with `scope=historical` and the running
   watchdog script replaced **before** `MOBILE_PIPELINE_ENABLED` is turned on.
   The flag set in production today has no scope, which means "hold
   everything", new uploads included.
2. `.env.worker` must get the new `WORKER_IMAGE` **and** `BUILD_COMMIT`; it
   pins an old commit that overrides the one baked into the image.
3. A one-video production smoke test at the two points marked below, **in a
   course with no real students** (see condition 4).
4. **The "new video" notification goes live with this release, for the first
   time.** Production holds zero notifications of that kind against 241
   finished Gumlet lectures: it was wired only to the legacy local transcode
   (section 2.10). From the worker swap on, every lecture that becomes
   playable notifies the course's enrolled students once. That is the
   requested behaviour, but it is new to students, so it needs a deliberate
   yes; `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` (API and worker) holds it back.

**Not validated, and not claimed:** iOS (no iOS runtime exists on this
machine); a production release build on a physical Android phone (the
emulator can only run the development build against a local API); real Gumlet
asset *creation* (billable write; only read-only calls were made); delivery of
the push itself to a phone (the notification row, the inbox API and the push
job were verified; no push provider was called). The Android emulator run of
section 2.2 was made on commit 9e19d4a and not repeated: 798f639 does not
touch playback, tickets or the app.

| # | Requirement | Result |
|---|---|---|
| 1 | Worker image builds and starts with the existing configuration | **GO** (rebuilt at 798f639) |
| 2 | Android emulator: playback, authorisation, encryption | **GO** (dev build, local stack, at 9e19d4a) |
| 3 | Real Gumlet integration | **GO** (read-only) |
| 4 | `mobile-priority-real-queue` failure | **GO** - defect in the test, fixed |
| 5 | Reconciler: Redis, database, duplicates, several instances | **GO** - two defects found and fixed |
| 6 | New uploads never blocked by a backlog pause | **GO in code; conditional in production** (condition 1) |
| 7 | Gumlet off the laptop | **Prepared and trialled locally; not part of this release** |
| 8 | Flag on does not queue the 200 old videos | **GO** |
| 9 | Release checklist | Section 3 (reviewed again) |
| 10 | Duration when only the mobile pipeline succeeds | **GO** (section 2.10) |
| 11 | "New video" notification: first playable pipeline, exactly once | **GO** (section 2.10; condition 4) |

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

- **Rebuilt for the two closing fixes:** `edu-worker:dual-pipeline-798f639`
  (`sha256:8b25526bc67f…`, 1.46 GB, `BUILD_COMMIT=798f639d…` baked in). The
  real `.env.worker` validates inside it with networking disabled (133 keys;
  `MOBILE_PIPELINE_ENABLED=false` and `NEW_VIDEO_NOTIFICATIONS_ENABLED=true`
  as resolved values). Started again through the real compose file and the
  real `.env.worker` with the local override: `Up (healthy)`, and it processed
  the uploads of section 2.10 (3 mobile encodes, 2 Gumlet ingests and the one
  expected Gumlet rejection, 2 push jobs, no other error).

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

### 2.9 Test totals

| Suite | Result |
|---|---|
| Backend, full unit run incl. both real-BullMQ suites, at 798f639 | **184 suites passed; 3,588 tests passed, 0 failed**, 5 skipped (opt-in) |
| `first-playable-pipeline` (new: duration and notification) | 32 / 32; 9 of them fail when the duration rule or either "who announces" rule is removed, 8 when the claim is removed |
| `dual-pipeline-real-queue` (real BullMQ) | 8 / 8 |
| `mobile-priority-real-queue` (real BullMQ) | 8 / 8 |
| `tsc`, `eslint` on changed files | clean |
| Dashboard | unchanged (25 / 25 Playwright at 8d8e06e) |

A first full run of this pass reported 6 timeouts in 5 suites. The machine
was out of memory at that moment (jest's default worker count next to a
database migration and a Docker call: 54 MB free). Re-run with
`--maxWorkers=4`: the result above, in 59 s.

### 2.10 The two remaining gaps (closed in 798f639)

#### What was actually wrong

**Duration.** `Lesson.durationSeconds` was written only by the Gumlet sync and
by the legacy local transcode. The mobile pipeline filled the *video* row's
duration when it was empty and stopped there. The student's lecture list falls
back to the video's figure, so it was right; everything that reads the lesson
row was not: the course total on the course card
(`Course.totalDurationSeconds` = sum of lesson durations), the dashboard
lecture row, a lecture that reuses the video, lesson analytics. Those showed
zero for a lecture that played.

**Notification - a correction to the first version of this document.** It
said the notification "is still sent when Gumlet finishes". It is not. The
only sender was `VideosService.markReady()`, which only the legacy local
transcode reaches; the Gumlet path returns before it. Read-only production
check, 2026-11-17: **0** notifications of kind `NEW_VIDEO` have ever been
written, against 241 Gumlet lectures that became READY (136 in October, 105
in November). So this was not "Gumlet-only"; it was not sent at all.

#### What changed

| | |
|---|---|
| Duration | When the mobile ladder is recorded and the video had **no** duration, the duration ffprobe measured (and against which the transcoder already verifies every rendition's segment total) is written to the video, copied to every lecture the video is attached to, and those courses are recounted - through the same helper the Gumlet sync uses. Zero or unparseable is "unknown" and writes nothing. |
| Gumlet's duration behaviour | Unchanged. A duration Gumlet already supplied is not touched (video, lecture or total). A Gumlet sync that finishes later still writes the provider's figure over the mobile one; one that reports no duration erases nothing. |
| Replaced file | `initUpload` now clears the video's stored duration when the file is replaced, so the new recording is measured rather than shown with the old file's length. The lecture keeps the old figure until a pipeline measures the new file. |
| Notification | Moved to `NewVideoAnnouncer`, called by both pipelines. "Once" is a compare-and-set on a new column, `videos.newVideoAnnouncedAt`, so two processes finishing together send one. |
| Who announces | Gumlet side: only on the **transition** to READY (a re-sync of a READY video is not news). Mobile side: only while the Gumlet side is **not** READY (if it is, Gumlet was first). |
| Old lectures | Silent by those two rules alone: an old lecture is Gumlet-READY, so encoding it for mobile announces nothing, whatever the column holds. The migration additionally marks every lecture that was already processed, which covers an old lecture whose Gumlet asset is repaired later. |
| Eligibility | Unchanged: the video must still have its origin lecture; recipients are the course's ACTIVE enrolments of ACTIVE, undeleted accounts; push preferences are applied in the push processor as before. Same title, body and route. |
| Failure | Nothing after the ladder is recorded can fail the job (a failure there would make the queue encode the lecture again). The announcement is at-most-once: the claim is released only if the notification rows could not be written; a Redis hang on the push queue releases the caller after 10 s and keeps the claim. |
| Switch | `NEW_VIDEO_NOTIFICATIONS_ENABLED` (default `true`; API and worker). Off still records the lecture as announced, so switching it back on does not announce what became playable meanwhile. |
| Gumlet code | `gumlet-ingest.service.ts` differs from `origin/main` by one constructor parameter and one call (12 lines). Asset creation, status sync, DRM verification and duration handling are byte-identical. |

Migration `20261117090000_video_new_video_announcement`: one nullable column,
and one `UPDATE` that sets it on videos already processed - the only statement
in the release that writes to existing rows.

#### Evidence

**Unit (real services over a stateful fake database, 32 tests):** Gumlet
FAILED + mobile READY shows the duration on video, lecture and course; reused
lectures and their courses included; Gumlet's figure untouched when it came
first and written over the mobile one when it comes later; unmeasured
durations ignored; Gumlet-first, mobile-first and same-instant in two
processes each produce one notification per student; expired enrolments,
suspended and deleted accounts and other courses are not told; a re-sync, a
forced re-encode, a retry and a legacy re-transcode add nothing; 200 old
lectures backfilled produce zero notifications and zero push jobs; a replaced
file is announced once more; a notification, database or Redis failure never
fails the job; the switch.

**Migration on a seeded scratch database** (one row per state production
holds): the 9 already-processed rows were stamped (from `processedAt`, else
`mobileProcessedAt`, else `updatedAt`), the 3 not-yet-playable ones
(abandoned upload, in flight, failed-never-ready) left NULL, `updatedAt`
unchanged on every row, second run `UPDATE 0`, `migrate status` clean.
Read-only production count: it will stamp **264 of 272** videos; the 8 left
are the abandoned `UPLOADING` rows.

**End to end, with the new image as the worker** (local API from the same
commit, real BullMQ, real ffmpeg, Gumlet answered by the local stub; the
course has one eligible student and one REVOKED enrolment):

| Lecture | What happened | Duration (video / lesson / student API) | Notifications |
|---|---|---|---|
| B | Gumlet rejected the source; mobile READY | 24 s / 24 s / 24 s; course total recounted | 1 row, to the eligible student; announced by `mobile` 78 ms after the ladder was recorded; in the student's inbox |
| B, later | "Retry Gumlet" with Gumlet accepting: READY 50 s after the announcement | unchanged | still 1 |
| A | Gumlet READY first, mobile READY 6 s later | 24 s / 24 s / 24 s | 1 row; announced by `gumlet` 68 ms after READY |
| A, later | three more Gumlet syncs from the API, then a forced mobile re-encode | unchanged | still 1 |

Totals: 2 lectures, 2 `NEW_VIDEO` rows, 2 push jobs completed, 0 failed; the
REVOKED enrolment received nothing.

#### What the owner should know (behaviour, not defects)

- **It is new to students** (condition 4). Read-only production figures: 31
  courses, largest 48 active enrolments, 12 on average; 4 active push tokens
  in total, so today the notification is mostly the in-app inbox entry.
- **Draft lectures are announced too.** The eligibility rule was kept exactly
  as asked, and it has never looked at whether the lesson is published. Of
  211 lectures uploaded in the last 30 days, 8 sit in a DRAFT lesson today.
  A student told about one of those opens a lecture they cannot see. A
  published-only rule is a small change; it was not made because it
  changes eligibility.
- **Mobile-first announcements.** If the mobile ladder finishes before Gumlet,
  the student is told while the web player still says "processing". The app
  plays it.
- **A replaced file is announced again**, as a re-transcode always was.
- **At-most-once.** A crash between the claim and the write loses that one
  announcement; it is never sent twice.
- A lecture that the OLD worker finishes between the API deploy and the
  worker swap (a matter of minutes) is not announced, then or later.

---

## 3. Release checklist

Reviewed again on 2026-11-17 after the two fixes. What changed from the first
version: two migrations instead of one; a new image tag and commit; both smoke
tests moved to a course with no real students and extended; the notification
decision; notification and watchdog rows in the rollback table.

Release artefacts: backend `fix/dual-pipeline-independence` at **798f639**
(later commits are documentation only), dashboard `feat/dual-pipeline-status`
8d8e06e, image `edu-worker:dual-pipeline-798f639`
(`sha256:8b25526bc67f417128aecd601dd131e611d097e477c1df962c54875f8b3704c7`).
`origin/main` had not moved in either repository when this was written
(backend 164ae72, dashboard 12dcda7). **Each numbered step is an approval
gate.**

### Step 0 - before anything

- [ ] Review and merge both pull requests. Then
      `git diff 798f639 <merge commit> -- . ":!docs"` must be empty. If it is
      not (main moved, a conflict was resolved), rebuild the image from the
      merge commit and repeat the image checks of section 2.1 before going on.
- [ ] On the laptop: `docker image inspect edu-worker:dual-pipeline-798f639
      --format "{{.Id}}"` → the id above. Keep `edu-worker:30a21fa-priority-vfr`
      (rollback) and `edu-worker:30a21fa-priority-r2` (the watchdog runs on
      it); no `docker image prune`.
- [ ] Laptop on home Wi-Fi and AC power, lid open; Docker healthy.
- [ ] Note the current Render deploy id (for rollback) and Vercel deployment.
- [ ] **Choose the smoke-test course: one with no real students.** Several
      courses have no active enrolment. Check:
      `select count(*) from enrollments where "courseId" = '<id>' and state = 'ACTIVE'`
      → 0, or only the test account. Both smoke tests upload there, because
      from step 5 on a lecture that becomes playable notifies its course.
- [ ] **Decide the notification** (condition 4): live with this release
      (nothing to set), or held back (`NEW_VIDEO_NOTIFICATIONS_ENABLED=false`
      on Render in step 2 **and** in `.env.worker` in step 5).

### Step 1 - database

- [ ] Neon: create backup branch `pre-dual-pipeline-<date>` from production.
- [ ] From the release commit, with the production `DIRECT_URL`:
      `npx prisma migrate deploy` → applies **exactly two** migrations:
      `20261116120000_video_pipeline_intents` (four columns) and
      `20261117090000_video_new_video_announcement` (one column, and the
      `UPDATE` that marks already-processed videos: 264 of 272 at the
      17 November reading).
- [ ] Verify:
      `select count(*) from videos where "mobileGeneration" <> 0` → 0;
      `select count(*) from videos where "newVideoAnnouncedAt" is null and (status in ('READY','ARCHIVED') or "mobileStatus" = 'READY')` → 0;
      `select status, count(*) from videos where "newVideoAnnouncedAt" is null group by 1` → only rows not yet playable (`UPLOADING`, and anything in flight at that moment).
- Effect on running code: none. The columns are additive and the old API and
  worker never read them. The `UPDATE` touches one new column on ~264 rows and
  holds no lock a running job waits on for more than an instant.

### Step 2 - API (Render), flag still OFF

- [ ] Environment: **no change**. `MOBILE_PIPELINE_ENABLED` stays `false`.
      Optional: `VIDEO_PIPELINE_RECONCILE_SECONDS` (default 600);
      `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` only if step 0 decided so.
- [ ] Manual deploy of the merged commit.
- [ ] Verify: log line `video pipeline reconciler: scan at boot…`; no
      `pending intents:` line; `GET /videos/<any id>/status` returns `source`,
      `gumlet`, `mobile` blocks; `/meta/health/deep` unchanged.

### Step 3 - dashboard (Vercel)

- [ ] Deploy the merged commit. Open a lecture: three chips are shown.

### Step 4 - smoke test #1 (one video, flag OFF, old worker)

- [ ] Upload one short test lecture to a lesson of the **smoke-test course**.
- [ ] Expect: upload accepted; chips `Uploaded · Gumlet Pending→Ready ·
      Mobile HLS Not started`; exactly one row; nothing in the mobile queue.
- This proves the new acceptance path on production without any mobile work.
  The notification is not asserted here: the old worker is still the one that
  finishes Gumlet, and it does not announce.

### Step 5 - worker and watchdog (laptop)

- [ ] In `deploy/laptop-worker/.env.worker`: back it up, then set
      `WORKER_IMAGE=edu-worker:dual-pipeline-798f639` and
      `BUILD_COMMIT=798f639d5abe14128263f6dabe268fb5a4a29a97`. Nothing else
      (plus `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` only if step 0 decided so).
- [ ] Confirm nothing is running (`GET /videos/mobile/overview` →
      `worker.detail.activeJobs: []`, and no lecture mid-upload), then
      `docker compose --env-file .env.worker up -d`.
- [ ] Verify: `docker inspect edu-worker --format "{{.Image}}"` → the image id
      of step 0; container healthy; heartbeat build `798f639d5abe`; the
      delayed backlog jobs are still delayed (the pause is still on).
- [ ] Watchdog: back up `C:\edu-watchdog\watchdog.js`, copy
      `deploy/laptop-worker/watchdog/watchdog.js` over it,
      `docker restart edu-hls-watchdog`, confirm its start log shows
      `pauseScope: historical`.

### Step 6 - pause scope

- [ ] `POST /videos/mobile/pause` with
      `{ "reason": "backlog paused between batches", "scope": "historical" }`.
- [ ] Verify `GET /videos/mobile/overview` → `pause.scope = historical`, and
      the mobile queue counts are what they were (8 delayed at the last
      reading).
- From here a backlog pause no longer holds new uploads. Do not go to step 7
  before this reads `historical`.

### Step 7 - turn automatic mobile processing ON

- [ ] Render: `MOBILE_PIPELINE_ENABLED=true`, save, redeploy.
- [ ] Verify immediately: mobile queue counts unchanged (no new jobs); no
      `pending intents:` log line.

### Step 8 - smoke test #2 (one video, flag ON, new worker)

- [ ] Upload one short test lecture to a lesson of the smoke-test course.
- [ ] Expect within a minute: `Uploaded · Gumlet Pending · Mobile HLS Queued`;
      one new job `mobile-hls:<videoId>:p1g1` in the mobile queue, **without**
      a priority; the 8 backlog jobs untouched.
- [ ] Expect within a few minutes: `Mobile HLS Processing nn%` then `Ready`;
      Gumlet `Ready` independently.
- [ ] `select "mobileStatus", "mobileGeneration", "mobileEnqueuedAt" is not null, "durationSeconds" > 0, "newVideoAnnouncedAt" is not null from videos where id = '<videoId>'`
      → `READY, 1, true, true, true`. The lecture row in the dashboard shows
      the duration.
- [ ] `select count(*) from notifications where kind = 'NEW_VIDEO' and route = '/lesson/<lessonId>'`
      → the course's active enrolments (0 for an empty course, 1 if only the
      test account is enrolled), and **the same number again** after both
      chips read Ready. Worker log: one line `announced to the course (first
      playable pipeline: gumlet|mobile)`. With the switch off: 0, and the log
      line `new-video notifications are switched off`.
- [ ] `select route, count(*) from notifications where kind = 'NEW_VIDEO' group by 1`
      → only lectures uploaded since step 5; no old lecture.
- [ ] On a phone with the HLS-capable app (once it is live): the lecture plays;
      the ticket row has `delivery = hls`.
- [ ] Remove the two test videos from the dashboard. (Their Gumlet assets
      remain at Gumlet; delete them there by hand if wanted.)

### Step 9 - backfill (separate approval)

- [ ] List A (32 ids, `backfill-A.txt`) in batches of about 8, with the usual
      watcher. `POST /videos/mobile/resume` only when a batch should run.
- [ ] After the first batch:
      `select count(*) from notifications where kind = 'NEW_VIDEO'` is what it
      was before the batch. A backfill announces nothing.

### Step 10 - optional, later: Gumlet off the laptop (section 2.7)

### Rollback

| What | How | Leaves behind |
|---|---|---|
| Stop new mobile jobs | `MOBILE_PIPELINE_ENABLED=false` on Render | queued jobs stay and run |
| Stop encoding | `POST /videos/mobile/pause` (no scope = everything) | nothing lost |
| Stop notifications | `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` on Render (redeploy) and in `.env.worker` (`up -d`) | notifications already sent cannot be recalled; lectures that become playable while it is off are not announced later |
| Worker | restore the `.env.worker` backup (image `30a21fa-priority-vfr`), `docker compose --env-file .env.worker up -d` | jobs keep their ids; the old image runs them; it does not announce or copy durations |
| Watchdog | restore the `watchdog.js` backup and `docker restart edu-hls-watchdog`, or set `WATCHDOG_PAUSE_SCOPE=all` | its pauses hold new uploads again |
| API | Render → roll back to the noted deploy | new columns ignored; a row left "accepted, not delivered" is re-queued by the old 30-minute sweep; lectures finished under the old build are never announced |
| Dashboard | Vercel → promote the previous deployment | - |
| Mobile playback | `POST /videos/mobile/delivery` `mode=gumlet` | unchanged emergency switch |
| Migration | not needed for any rollback; if wanted, drop the five columns after the API and worker rollback | - |

No rollback step deletes a video, a Gumlet asset, an R2 object or a queue.
