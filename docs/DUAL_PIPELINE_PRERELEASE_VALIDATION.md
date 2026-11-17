# Dual pipeline: pre-release validation and release checklist

Written 2026-11-17, after `docs/DUAL_PIPELINE_INDEPENDENCE.md`, and revised
three times the same day: when the two functional gaps of the first version
were closed (section 2.10), when the owner's notification policy was applied,
and when publication became the trigger and the app-only audience stopped
depending on past playback (both in section 2.11). The release checklist
(section 3) reflects the final state.

Release artefacts: backend branch `fix/dual-pipeline-independence` at code
commit **a292083**; dashboard branch `feat/dual-pipeline-status` at
**8d8e06e** (unchanged); worker image **`edu-worker:dual-pipeline-a292083`**
(id `sha256:b992dc1a6ece…`, built locally). Every earlier `dual-pipeline-*`
image is superseded and has been removed from the laptop.

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
   course with no real students**.
4. **A decision on the "new video" notification.** It has never been sent in
   production (zero rows of that kind against 241 finished Gumlet lectures;
   section 2.10), so students see it for the first time with this release.
   The policy of section 2.11 makes it conservative, but it is still new, so
   it needs a deliberate yes. `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` (API and
   worker) holds it back.

One setting is optional and safe to leave unset: the first app build that
plays mobile HLS, per platform (`MOBILE_HLS_MIN_BUILD_ANDROID`,
`MOBILE_HLS_MIN_BUILD_IOS`). It only affects who is told when a lecture is
playable in the app alone; unset means fewer students are told then, never
the wrong ones (section 2.11).

**Not validated, and not claimed:** iOS (no iOS runtime exists on this
machine); a production release build on a physical Android phone (the
emulator can only run the development build against a local API); real Gumlet
asset *creation* (billable write; only read-only calls were made); delivery of
the push itself to a phone (the notification row, the inbox API and the push
job were verified; no push provider was called, and the push is best effort by
design); which Play / App Store build numbers first play mobile HLS (they are
assigned by the build service and are not in the repository - the owner's
consoles have them). The Android emulator run of section 2.2 was made on
commit 9e19d4a and not repeated: the later commits do not change playback or
tickets (one constant in `playback.service.ts` moved to a shared file).

| # | Requirement | Result |
|---|---|---|
| 1 | Worker image builds and starts with the existing configuration | **GO** (rebuilt at a292083) |
| 2 | Android emulator: playback, authorisation, encryption | **GO** (dev build, local stack, at 9e19d4a) |
| 3 | Real Gumlet integration | **GO** (read-only) |
| 4 | `mobile-priority-real-queue` failure | **GO** - defect in the test, fixed |
| 5 | Reconciler: Redis, database, duplicates, several instances | **GO** - two defects found and fixed |
| 6 | New uploads never blocked by a backlog pause | **GO in code; conditional in production** (condition 1) |
| 7 | Gumlet off the laptop | **Prepared and trialled locally; not part of this release** |
| 8 | Flag on does not queue the 200 old videos | **GO** |
| 9 | Release checklist | Section 3 (final) |
| 10 | Duration when only the mobile pipeline succeeds | **GO** (section 2.10) |
| 11 | Notification policy: published only, playable, no re-announcement on replacement, once, historical silence | **GO** (section 2.11; condition 4) |
| 12 | Publishing a lesson, section or course sends at once; bounded for bulk | **GO** (section 2.11) |
| 13 | App-only eligibility without past playback | **GO**, with the limits stated in section 2.11 |

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

- **Rebuilt for the final code:** `edu-worker:dual-pipeline-a292083`
  (`sha256:b992dc1a6ece9924579b83a9e27e7b35e205c220103fa1045411a40a100f0e43`,
  1.46 GB, `BUILD_COMMIT=a2920834…` baked in, all three new migrations
  inside). The real `.env.worker` validates inside it with networking disabled
  (135 keys; `MOBILE_PIPELINE_ENABLED=false`,
  `NEW_VIDEO_NOTIFICATIONS_ENABLED=true`, minimum HLS builds unset, as
  resolved values). Started again through the real compose file and the real
  `.env.worker` with the local override: `Up (healthy)`, and it processed the
  uploads of section 2.11 (4 mobile encodes, 4 Gumlet ingests and the one
  expected Gumlet rejection, 4 push jobs, no other error). A first build of
  this tag was discarded: it was made while a migration rehearsal had the
  three new migration folders moved aside, so it lacked them. The image above
  was built from an untouched checkout and checked for all five.

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
| Backend, full unit run incl. both real-BullMQ suites, at a292083 | **184 suites passed; 3,661 tests passed, 0 failed**, 5 skipped (opt-in); two consecutive runs |
| `first-playable-pipeline` (duration, notification policy, publication, app-only eligibility, build recording) | 103 / 103 |
| Mutation check of that suite | 41 rules removed one at a time; every removal makes at least one test fail |
| `dual-pipeline-real-queue`, `mobile-priority-real-queue` (real BullMQ) | 8 / 8 each |
| `tsc`, `eslint` on changed files | clean |
| Dashboard | unchanged (25 / 25 Playwright at 8d8e06e) |

Things found while running them, all in tests, all fixed:

- A full run with jest's default worker count ran the laptop out of memory
  (54 MB free) and produced six false timeouts. The suite is now run with
  `--maxWorkers=4` (about 50 s).
- `storage-resumable-download` failed once in a full run. Its stream double
  broke the connection after a fixed 15 ms, sometimes before the delivered
  bytes had been written; the download then correctly resumed from the smaller
  size the file really had, and the test's exact offsets no longer matched.
  The double now breaks the connection once the bytes are on disk. The
  product code was right and is unchanged.
- The mutation check found one assertion of mine that could not fail (two
  timestamps taken within the same millisecond). The test now uses a
  timestamp an hour old.

### 2.10 Duration, and what the notification actually did before

**Duration.** `Lesson.durationSeconds` was written only by the Gumlet sync and
by the legacy local transcode. The mobile pipeline filled the *video* row's
duration when it was empty and stopped there. The student's lecture list falls
back to the video's figure, so it was right; everything that reads the lesson
row was not: the course total on the course card, the dashboard lecture row,
a lecture that reuses the video, lesson analytics.

Fix (798f639): when the mobile ladder is recorded and the video had **no**
duration, the duration ffprobe measured (against which the transcoder already
verifies every rendition's segment total) is written to the video, copied to
every lecture the video is attached to, and those courses are recounted -
through the same helper the Gumlet sync uses. Zero or unparseable is "unknown"
and writes nothing. A duration Gumlet already supplied is not touched; a
Gumlet sync that finishes later still writes the provider's figure over the
mobile one; one that reports no duration erases nothing. Replacing a file
clears the video's stored duration, so the new recording is measured rather
than shown with the old file's length.

**Notification - a correction to the first version of this document.** It
said the notification "is still sent when Gumlet finishes". It is not. The
only sender was `VideosService.markReady()`, which only the legacy local
transcode reaches; the Gumlet path returns before it. Read-only production
check, 2026-11-17: **0** notifications of kind `NEW_VIDEO` have ever been
written, against 241 Gumlet lectures that became READY (136 in October, 105
in November).

### 2.11 Notification policy (a292083)

What is owed is a small state on the video row, and sending it is a separate
step that anything may trigger and that is safe to repeat:

```
NULL --first playable--> PENDING --claim--> SENDING --written--> DONE
                            ^                  |   \--written--> MOBILE --Gumlet READY--> DONE
                            \-----failed-------/
```

| Policy | How it is implemented |
|---|---|
| **Published lessons only** | It goes out only when the lesson and its section are PUBLISHED, the section's release date (`unlocksAt`) has passed, and the course is one enrolled students are served (PUBLISHED or HIDDEN - the two states `CourseAccessService.decide()` serves). Otherwise the row stays PENDING. An archived or deleted lecture stops being owed. |
| **Publication is the trigger** | A lesson, a section or a course going from not-published to published settles its waiting lectures **inside that request**: `LessonsService.update`, `SectionsService.update`, and `CoursesAdminService.publish` / `unpublish` (DRAFT or SUSPENDED to HIDDEN also starts serving students). An edit that does not change the status, and a course that was already being served, trigger nothing. Every lecture is still checked on its own, so publishing a section does not release a lecture whose lesson is a draft. |
| **Bounded for bulk** | One publish settles at most 25 lectures and for at most 3 seconds, newest first, and asks the access gate once per student for the whole pass rather than once per lecture. What is left stays PENDING and is flagged, and the reconciler takes it on its next wake (30 s). |
| **The reconciler is recovery** | It retries a failed attempt, takes over the claim of a process that died, finishes what a bounded publish left, and handles the one event nothing announces: a section's release date passing. With nothing owed it costs two indexed queries per pass. |
| **Recipients** | The original rule (ACTIVE enrolment of an ACTIVE, undeleted account on the course), narrowed by the gates the lesson endpoint applies to a student: `assertContentAccess` (course state, access window, academic targeting) and `assertSectionAccessible` (section- and part-scoped enrolments; a free preview is exempt there and here). A database error during the check is a failure to retry, never "nobody is eligible". |
| **Playback availability** | *Every platform* = Gumlet READY and the app can play it (its own ladder, or the Gumlet fallback): everyone is told, standard wording. *Mobile ladder READY, Gumlet still working*: nothing is sent; it waits for Gumlet to end one way or the other. *Gumlet FAILED, ladder READY and mobile HLS delivery on*: the app-only audience below. *Playable nowhere*: nothing. |
| **Replacement** | `initUpload` does not reset anything about the announcement. An announced lecture (or one the migration marked) is never announced again; a draft that was never announced stays owed and is announced once on publish. |
| **Exactly once** | The dispatch is claimed with a compare-and-set on the row. Each notification row carries `dedupeKey = new-video:<video>:<student>`, unique in the database. A failed attempt goes back to PENDING and is retried; a claim held by a dead process is taken over after 5 minutes. |
| **Durable vs. push** | The in-app notification row is the durable part and is what "once" is guaranteed for. The push is queued for the rows a pass newly wrote and is **best effort**: if the process dies, or Redis does not answer, between writing the rows and queueing the push, the retry finds the rows and queues nothing - that push is lost, never doubled. No exactly-once claim is made for the push. |
| **Historical videos** | The migration marks every already-processed video DONE, and a debt can only be created by a first-playable transition (Gumlet becoming READY; the mobile ladder finishing while Gumlet is not READY). Encoding an old Gumlet-READY lecture for mobile creates none. |
| **Failure isolation** | Nothing after a pipeline has recorded its result can fail the job; the announcer never throws. |
| **Switch** | `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` sends nothing and records the lecture as DONE. |

#### The app-only audience: which signals exist, and the rule

When Gumlet has failed and only the mobile ladder is ready, the question is
which students have a phone that will actually play it. What the server can
know, checked against the code and against production (read-only,
2026-11-17):

| Signal | What it shows | Verdict |
|---|---|---|
| An account, or an active enrolment | nothing about a device | not used |
| An ACTIVE bound Android/iOS device (`devices`) | the student uses the app on an approved phone | necessary, not sufficient |
| The app **version** the device reports (`devices.appVersion`) | **nothing**: every Android build reports `1.0.0`, the ones from before mobile HLS included (all 7 active Android devices in production) | not usable |
| The native **build number** (`X-App-Build`: Android versionCode, iOS build number) | which install it is. The app sends it on every request; the server read it and **did not store it** | **now stored** (`devices.appBuild`), at sign-in and on every token refresh |
| The app declaring `hls-aes128` itself | authoritative - but it is declared only on a ticket request, i.e. when a video is played | kept as a second, positive signal |
| The forced-upgrade setting (`minimumAppVersion`) | not set in production, and version-based | not usable |
| A push token | notifications are enabled on a phone | says nothing about the build |

Production today: 1,186 active web devices against 8 students with an active
phone (7 Android, 1 iOS), and one HLS ticket ever issued. The app is at the
very start of its rollout, which is exactly when "has played HLS before"
excludes almost everyone.

**The rule.** A student is in the app-only audience when they pass the access
gates and have an ACTIVE Android/iOS device for which either holds:

- **by build** - the build that phone last reported is at or above the first
  build of its platform that plays mobile HLS (`MOBILE_HLS_MIN_BUILD_ANDROID`,
  `MOBILE_HLS_MIN_BUILD_IOS`). No playback is needed: signing in, or simply
  having the app open long enough to refresh its tokens (the access-token
  lifetime, 15 minutes by default), records the build; or
- **by declaration** - the app on that phone has declared HLS support to this
  server (it was issued an HLS ticket).

A browser, a revoked phone and a phone on an older build are not a compatible
phone. A build that is missing or is not a plain number is *unknown*, never
assumed.

**When it cannot be determined** (the phone has not reported a build yet, or
no minimum is configured for its platform) the student is **held back, not
dropped**: not notified by the app-only announcement; counted, with the
reason, in that announcement's log line; looked at again on every reconciler
pass for 72 hours, so a student who opens an updated app is told then; and
told with everyone else the moment Gumlet recovers. Nobody on an unsupported
or unknown build is notified, and nobody is excluded silently or for good.

The wording says where the lecture can be watched, in the title and in the
body, and claims nothing about anywhere else: "New video available in the
mobile app" / "<lecture> is now available to watch in the mobile app."
(Arabic: "فيديو جديد متاح في تطبيق الهاتف").

**Limits, stated plainly.**

- The minimum build numbers are the owner's to supply. They are assigned by
  the build service and are not in the repository. Until they are set, only
  the declaration signal qualifies anyone. (My release notes say the first
  Android build with working mobile HLS is versionCode 12; that needs
  confirming in the Play Console. I have no figure for iOS.)
- A build number is what the app reports. It is trusted for one purpose -
  sending or withholding a notification - and nothing else reads it.
- The capability is declared by the app's JavaScript; an over-the-air update
  could in principle change what a given native build can play. The minimum
  is therefore a statement about the builds actually shipped, to be kept true.
- Existing devices have no build recorded until they next sign in or refresh
  their tokens after this release.
- The clean long-term signal is the app declaring its capabilities when it
  starts, not only when it plays. That is a mobile-app change and is not part
  of this release.

Footprint: the `NewVideoAnnouncer` service and module; one hook each in
`LessonsService.update`, `SectionsService.update` and
`CoursesAdminService.publish` / `unpublish`; one pass in the existing pipeline
reconciler; `devices.appBuild` written where the device descriptor already
was, plus one fire-and-forget conditional write after a successful token
refresh (outside the rotation, not awaited, unable to delay or fail it). The
existing notification service is used as it is. `gumlet-ingest.service.ts`
differs from `origin/main` by one constructor parameter and one block of two
calls.

Migrations: `20261117090000_video_new_video_announcement` (two columns, an
index, and the `UPDATE` that marks already-processed videos DONE - the only
statement in the release that writes to existing rows) and
`20261117100000_device_app_build` (one nullable column).

#### Evidence

**Unit tests** (real services over a stateful fake database).

| Asked for | Pinned by |
|---|---|
| Draft video becomes READY, no notification | "a DRAFT lecture becomes playable: nobody is told, and the announcement stays owed" |
| Draft is later published, one notification | "the draft is published later: the notification goes out then, once" |
| Published video becomes playable, one notification | "a published lecture becomes playable: every eligible student is told, once" |
| Both pipelines become READY, no duplicate | Gumlet-first, mobile-first, and the same instant in two processes |
| Replacing an announced video's file, no new notification | three cases: announced, migration-marked, never-announced draft |
| Processing fails, no notification | both sides failing; Gumlet failing alone |
| Dispatch fails and retries safely | rows not written; written but not recorded; dead process's claim; Redis not answering; database outage |
| Historical backfill, zero notifications | 200 old lectures: 0 notifications, 0 push jobs |
| Authorised / enrolled recipients only | 5 told, 9 not; targeting; reused lecture; preview |
| **Immediate on publication** | section published; course published; DRAFT/SUSPENDED to HIDDEN; lesson published while its section is a draft; a draft lesson inside a newly published section stays held; a rename or an already-served course triggers nothing |
| **Bulk is bounded** | 40 waiting lectures: exactly 25 in the request, the access gate asked once per student, the rest by the reconciler, 200 distinct notification keys; the time budget; a publish, the reconciler and a second process at once |
| **Release date** | a section not yet released waits; sent after the date; a free preview is not held |
| **App-only without past playback** | a student with no ticket of any kind is told by build; older build and unknown build are not; browser and revoked phone are not; declaration counts with no minimum configured; no minimum means no phone is vouched for; non-numeric builds; nobody compatible means nothing sent and everyone still owed |
| **Held back, not dropped** | told when a compatible build is reported, once, without restarting the 72 h; a re-look with nobody new writes nothing; closed after 72 h; everyone told when Gumlet recovers |
| **Wording** | title and body, English and Arabic |
| **Build recording** | recorded on token refresh; unchanged build writes nothing; malformed header neither stored nor queried; only the caller's own device; never throws; cannot delay or fail the refresh |

**Mutation check.** 41 rules were removed one at a time; each removal fails at
least one test.

**Migrations on a scratch database** shaped like production: the three apply
in order; 9 already-processed videos marked DONE, 3 not-yet-playable left
NULL, `updatedAt` unchanged, second run of the `UPDATE` changes 0 rows,
`migrate status` clean. Read-only production count: the `UPDATE` will mark
**264 of 272** videos.

**End to end, with the new image as the worker** (local API from the same
commit, real BullMQ, real ffmpeg, Gumlet answered by the local stub, minimum
Android build 12; the course has one eligible student and one REVOKED
enrolment; **no playback ticket was issued at any point**):

| Lecture | What happened | Notifications |
|---|---|---|
| B, published | The student's phone had signed in on build 10. Gumlet rejected the source; mobile READY. | **0** - log: `0 notified (of 1 enrolled, 1 with an active phone: 0 compatible by app build, 0 by declared HLS support); 1 held back (… 1 below the minimum build)`; state `MOBILE` |
| B, later | The app refreshed its tokens on build 12 (no sign-in, no playback); the server recorded build 12. | 1 on the next reconciler pass, 43 s after the first attempt: "New video available in the mobile app" / "…is now available to watch in the mobile app."; state still `MOBILE`, its timestamp unchanged |
| B, later still | "Retry Gumlet", accepted, READY | still 1; state `DONE` |
| C, lesson DRAFT | both pipelines READY; then the section set to DRAFT and the lesson published | 0; state `PENDING` |
| C | the **section** published (`PATCH /admin/sections/:id`, answered in 394 ms) | 1, written inside that request |
| D, lesson DRAFT | both pipelines READY; then the course set to DRAFT and the lesson published | 0; state `PENDING` |
| D | the **course** published (`POST /admin/courses/:id/publish`, answered in 101 ms) | 1, written inside that request |
| A, published | both pipelines succeed | 1, standard wording |

Totals: 4 lectures, 4 notification rows, 4 push jobs completed and 0 failed;
the REVOKED enrolment received nothing.

#### What the owner should know (behaviour, not defects)

- **It is still new to students** (condition 4). Read-only production
  figures: 31 courses, largest 48 active enrolments, 12 on average; 4 active
  push tokens in total, so today it is mostly the in-app inbox entry.
- **While Gumlet is still working, nobody is told**, even if the app could
  already play the lecture. The wait ends when Gumlet finishes or fails.
- **A section's release date** is the one thing that is not instant: nothing
  happens at that moment, so the reconciler sends it within 10 minutes of the
  date (`VIDEO_PIPELINE_RECONCILE_SECONDS`).
- **Publishing a very large course** sends the first 25 waiting lectures in
  the request and the rest within about half a minute.
- **With the Gumlet fallback switched off**, a Gumlet-READY lecture waits for
  its mobile ladder. Production runs with the fallback on.
- **A draft can wait indefinitely**, and is announced whenever it is published.
- A lecture that the OLD worker finishes between the API deploy and the
  worker swap (a matter of minutes) is not announced, then or later.
- A student who enrols after a lecture was announced does not receive it.

---

## 3. Release checklist

Final version, 2026-11-17. Changes from the previous version: the image tag
and commit; a third, one-column migration; the two optional minimum-build
settings; a section-publish check in smoke test #2; the rollback table.

Release artefacts: backend `fix/dual-pipeline-independence` at **a292083**
(later commits are documentation only), dashboard `feat/dual-pipeline-status`
8d8e06e, image `edu-worker:dual-pipeline-a292083`
(`sha256:b992dc1a6ece9924579b83a9e27e7b35e205c220103fa1045411a40a100f0e43`).
`origin/main` had not moved in either repository when this was written
(backend 164ae72, dashboard 12dcda7). **Each numbered step is an approval
gate.**

### Step 0 - before anything

- [ ] Review and merge both pull requests. Then
      `git diff a292083 <merge commit> -- . ":!docs"` must be empty. If it is
      not (main moved, a conflict was resolved), rebuild the image from the
      merge commit - with nothing else touching the checkout - and repeat the
      image checks of section 2.1 before going on.
- [ ] On the laptop: `docker image inspect edu-worker:dual-pipeline-a292083
      --format "{{.Id}}"` → the id above. Keep `edu-worker:30a21fa-priority-vfr`
      (rollback) and `edu-worker:30a21fa-priority-r2` (the watchdog runs on
      it); no `docker image prune`.
- [ ] Laptop on home Wi-Fi and AC power, lid open; Docker healthy.
- [ ] Note the current Render deploy id (for rollback) and Vercel deployment.
- [ ] **Choose the smoke-test course: one with no real students.** Several
      courses have no active enrolment. Check:
      `select count(*) from enrollments where "courseId" = '<id>' and state = 'ACTIVE'`
      → 0, or only the test account. Both smoke tests upload there.
- [ ] **Decide the notification** (condition 4): live with this release
      (nothing to set), or held back (`NEW_VIDEO_NOTIFICATIONS_ENABLED=false`
      on Render in step 2 **and** in `.env.worker` in step 5).
- [ ] **Optional - the first app builds that play mobile HLS.** Look them up
      in the Play Console (versionCode) and App Store Connect (build number)
      and set `MOBILE_HLS_MIN_BUILD_ANDROID` / `MOBILE_HLS_MIN_BUILD_IOS` to
      the same values on Render (step 2) **and** in `.env.worker` (step 5).
      Leaving them unset is safe: in the Gumlet-failed case fewer students are
      told at once, and the rest when Gumlet recovers. A platform whose build
      numbers are not plain whole numbers should be left unset.

### Step 1 - database

- [ ] Neon: create backup branch `pre-dual-pipeline-<date>` from production.
- [ ] From the release commit, with the production `DIRECT_URL`:
      `npx prisma migrate deploy` → applies **exactly three** migrations:
      `20261116120000_video_pipeline_intents` (four columns on `videos`),
      `20261117090000_video_new_video_announcement` (two columns and one index
      on `videos`, and the `UPDATE` that marks already-processed videos DONE:
      264 of 272 at the 17 November reading), and
      `20261117100000_device_app_build` (one column on `devices`).
- [ ] Verify:
      `select count(*) from videos where "mobileGeneration" <> 0` → 0;
      `select "newVideoAnnounceState", count(*) from videos group by 1` → only
      `DONE` and NULL (no `PENDING`, `SENDING` or `MOBILE`);
      `select status, count(*) from videos where "newVideoAnnounceState" is null group by 1`
      → only rows not yet playable (`UPLOADING`, and anything in flight at
      that moment);
      `select count(*) from devices where "appBuild" is not null` → 0.
- Effect on running code: none. The columns are additive and the old API and
  worker never read them. The `UPDATE` touches two new columns on ~264 rows;
  no existing device row is touched.

### Step 2 - API (Render), flag still OFF

- [ ] Environment: `MOBILE_PIPELINE_ENABLED` stays `false`. Nothing else is
      required. Optional, as decided in step 0: `MOBILE_HLS_MIN_BUILD_ANDROID`,
      `MOBILE_HLS_MIN_BUILD_IOS`, `NEW_VIDEO_NOTIFICATIONS_ENABLED=false`;
      `VIDEO_PIPELINE_RECONCILE_SECONDS` (default 600).
- [ ] Manual deploy of the merged commit.
- [ ] Verify: log lines `NewVideoAnnouncerModule dependencies initialized` and
      `video pipeline reconciler: scan at boot…`; no `pending intents:` line;
      `GET /videos/<any id>/status` returns `source`, `gumlet`, `mobile`
      blocks; `/meta/health/deep` unchanged; a student can sign in and stay
      signed in (the token refresh now also records the app build).

### Step 3 - dashboard (Vercel)

- [ ] Deploy the merged commit. Open a lecture: three chips are shown.

### Step 4 - smoke test #1 (one video, flag OFF, old worker)

- [ ] Upload one short test lecture to a published lesson of the
      **smoke-test course**.
- [ ] Expect: upload accepted; chips `Uploaded · Gumlet Pending→Ready ·
      Mobile HLS Not started`; exactly one row; nothing in the mobile queue.
- This proves the new acceptance path on production without any mobile work.
  The notification is not asserted here: the old worker is still the one that
  finishes Gumlet, and it does not create the announcement.

### Step 5 - worker and watchdog (laptop)

- [ ] In `deploy/laptop-worker/.env.worker`: back it up, then set
      `WORKER_IMAGE=edu-worker:dual-pipeline-a292083` and
      `BUILD_COMMIT=a29208349eeb6e498e22486a1f8ad962a03588f4`. Nothing else is
      required (plus, only as decided in step 0, the same
      `MOBILE_HLS_MIN_BUILD_*` values as on Render and/or
      `NEW_VIDEO_NOTIFICATIONS_ENABLED=false`).
- [ ] Confirm nothing is running (`GET /videos/mobile/overview` →
      `worker.detail.activeJobs: []`, and no lecture mid-upload), then
      `docker compose --env-file .env.worker up -d`.
- [ ] Verify: `docker inspect edu-worker --format "{{.Image}}"` → the image id
      of step 0; container healthy; heartbeat build `a29208349eeb`; the
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

### Step 8 - smoke test #2 (flag ON, new worker)

**8a - a published lesson**

- [ ] Upload one short test lecture to a published lesson of the smoke-test
      course.
- [ ] Expect within a minute: `Uploaded · Gumlet Pending · Mobile HLS Queued`;
      one new job `mobile-hls:<videoId>:p1g1` in the mobile queue, **without**
      a priority; the 8 backlog jobs untouched.
- [ ] Expect within a few minutes: `Mobile HLS Processing nn%` then `Ready`;
      Gumlet `Ready` independently.
- [ ] `select "mobileStatus", "mobileGeneration", "mobileEnqueuedAt" is not null, "durationSeconds" > 0, "newVideoAnnounceState" from videos where id = '<videoId>'`
      → `READY, 1, true, true, DONE`. The lecture row in the dashboard shows
      the duration.
- [ ] `select count(*) from notifications where kind = 'NEW_VIDEO' and route = '/lesson/<lessonId>'`
      → the course's eligible enrolments (0 for an empty course, 1 if only the
      test account is enrolled), and **the same number again** after both
      chips read Ready. Worker log: `became playable via gumlet|mobile:
      announcement owed`, then one line `announced (every platform): n
      eligible, n notified, 0 already had it`. With the switch off: 0 rows and
      the line `new-video notifications are switched off`.

**8b - a draft lesson, released by publishing**

- [ ] Set a second lesson of the smoke-test course to Draft and upload a
      short lecture to it. When both chips read Ready:
      `select "newVideoAnnounceState" from videos where id = '<videoId>'` →
      `PENDING`; no notification row for that lesson.
- [ ] Publish the lesson in the dashboard. **Immediately**, without waiting:
      state `DONE`; the notification count for that lesson equals the
      course's eligible enrolments.
- [ ] Optional, same idea one level up: repeat with the lesson published and
      its *section* set to Draft, then publish the section - the state turns
      `DONE` in that request.

**Then**

- [ ] `select route, count(*) from notifications where kind = 'NEW_VIDEO' group by 1`
      → only the lectures uploaded in this step; no old lecture.
- [ ] `select platform, "appBuild", count(*) from devices where "appBuild" is not null group by 1, 2`
      → builds start to appear as students sign in or the app refreshes.
- [ ] On a phone with the HLS-capable app (once it is live): the lecture plays;
      the ticket row has `delivery = hls`.
- [ ] Remove the test videos from the dashboard. (Their Gumlet assets remain
      at Gumlet; delete them there by hand if wanted.)

The app-only announcement (Gumlet failed, mobile ready) cannot be produced on
demand in production without breaking a Gumlet upload on purpose, so it is not
part of the smoke test. It is covered by the local end-to-end run of section
2.11.

### Step 9 - backfill (separate approval)

- [ ] List A (32 ids, `backfill-A.txt`) in batches of about 8, with the usual
      watcher. `POST /videos/mobile/resume` only when a batch should run.
- [ ] After the first batch:
      `select count(*) from notifications where kind = 'NEW_VIDEO'` is what it
      was before the batch, and
      `select count(*) from videos where "newVideoAnnounceState" = 'PENDING'`
      did not grow because of it. A backfill announces nothing.

### Step 10 - optional, later: Gumlet off the laptop (section 2.7)

### Afterwards - two things worth looking at

`select "newVideoAnnounceState", count(*), min("newVideoAnnounceStateAt") from videos where "newVideoAnnounceState" in ('PENDING','SENDING','MOBILE') group by 1`
- `PENDING`: lectures waiting for their lesson, section or course to be
  published, for a release date, or for Gumlet to finish. `SENDING` older than
  a few minutes: an interrupted attempt; the reconciler takes it over by
  itself after 5 minutes. `MOBILE`: lectures announced app-only because Gumlet
  failed - "Retry Gumlet" on them tells everyone else.

The worker's log line for an app-only announcement states who was told and
who was held back and why (`… compatible by app build, … by declared HLS
support; … held back (… app build unknown or no minimum configured, … below
the minimum build)`).

### Rollback

| What | How | Leaves behind |
|---|---|---|
| Stop new mobile jobs | `MOBILE_PIPELINE_ENABLED=false` on Render | queued jobs stay and run |
| Stop encoding | `POST /videos/mobile/pause` (no scope = everything) | nothing lost |
| Stop notifications | `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` on Render (redeploy) and in `.env.worker` (`up -d`) | notifications already sent cannot be recalled; lectures that become playable while it is off are not announced later |
| App-only notifications reach too many or too few | change or remove `MOBILE_HLS_MIN_BUILD_ANDROID` / `_IOS` (Render and `.env.worker`) | unset = only apps that declared HLS support are told app-only |
| Worker | restore the `.env.worker` backup (image `30a21fa-priority-vfr`), `docker compose --env-file .env.worker up -d` | jobs keep their ids; the old image runs them; it does not announce or copy durations |
| Watchdog | restore the `watchdog.js` backup and `docker restart edu-hls-watchdog`, or set `WATCHDOG_PAUSE_SCOPE=all` | its pauses hold new uploads again |
| API | Render → roll back to the noted deploy | new columns ignored; a row left "accepted, not delivered" is re-queued by the old 30-minute sweep; `PENDING` announcements stay as they are and are sent if the new build returns |
| Dashboard | Vercel → promote the previous deployment | - |
| Mobile playback | `POST /videos/mobile/delivery` `mode=gumlet` | unchanged emergency switch |
| Migrations | not needed for any rollback; if wanted, drop the index and the seven columns (six on `videos`, one on `devices`) after the API and worker rollback | - |

No rollback step deletes a video, a Gumlet asset, an R2 object or a queue.
