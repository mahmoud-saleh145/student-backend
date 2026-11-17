# Dual pipeline: staged production release plan

Prepared 2026-11-17. This is the document to release from. It supersedes the
checklist in `DUAL_PIPELINE_PRERELEASE_VALIDATION.md` (which keeps the test
evidence) and records what was verified for this release: the app builds, the
source revisions, and the plan itself.

Nothing in this document has been done. Nothing was pushed, merged, deployed
or migrated; no production environment variable, row or job was changed.
Production and the stores were only read.

---

## 1. Verdict

**GO for the staged backend release, with `NEW_VIDEO` notifications off.**

**NO-GO for relying on mobile HLS on phones yet:** the Android build that
plays it properly (versionCode 12) is still in Google Play review, and no iOS
production build could be found or verified. The release is built so that this
does not block it: builds that cannot play mobile HLS properly keep the Gumlet
stream they play today.

Conditions, all of them steps in section 7:

1. `MOBILE_HLS_MIN_BUILD_ANDROID=12` is set on the API **when it is deployed**.
   Without it, turning the pipeline on puts every new lecture on a path the
   live Android build (11) cannot hold past five minutes.
2. `NEW_VIDEO_NOTIFICATIONS_ENABLED=false` on the API and on the worker. It is
   also the default now, so a missing variable sends nothing.
3. The mobile pause is re-issued with `scope=historical` and the watchdog
   script replaced **before** `MOBILE_PIPELINE_ENABLED=true`.
4. `.env.worker` gets the new `WORKER_IMAGE` and `BUILD_COMMIT`.
5. Both smoke tests run in the hidden course that nobody is enrolled in.

---

## 2. Verified build numbers

### Android

| versionCode | Source commit | Declares `hls-aes128` | Has the ticket-rotation fix | Google Play |
|---|---|---|---|---|
| 2 - 8 (27 Sep - 5 Nov) | 30c6b56, a4b2df9, 61d08d1 | no | no | 6 was live 8 - 10 Nov |
| 3 - 6 (6 - 7 Nov, second series) | not recorded by the build service | no (built two days before the capability was first committed, 9 Nov 19:15) | no | - |
| 9 (10 Nov) | a9bac7b | **yes** | no | never released |
| 10 | no build exists | - | - | - |
| **11** (10 Nov) | 7706a53 | **yes** | **no** | **live in production** since 10 Nov 21:47 |
| **12** (16 Nov) | c4a2fdd | **yes** | **yes** | **in review** (submitted 16 Nov), not live |

- **First build that declares mobile HLS:** 9 (never shipped). **First one on
  Google Play that declares it:** 11.
- **First genuinely HLS-capable build: 12.** This is the value for
  `MOBILE_HLS_MIN_BUILD_ANDROID`.

How each column was established - none of it from memory:

- *Build history:* the build service's own list (21 Android builds), with the
  commit of each; each commit checked in the mobile repository for the
  capability declaration (`src/features/video/api.ts`) and for the fixed
  player (`src/features/video/playerLifecycle.ts`, added by mobile PR 6).
- *The artefacts themselves:* the three AAB files on this machine were opened
  and their manifest and JavaScript bundle read.

  | File | versionCode in the manifest | `hls-aes128` in the bundle | Strings that exist only in the fixed player |
  |---|---|---|---|
  | `…-vc9-935e3e14.aab` (sha256 `263f2154…`) | 9 | present | 0 of 2 |
  | `…-vc11-9b43ca38.aab` (sha256 `012962b3…`) | 11 | present | 0 of 2 |
  | `…-vc12-09dfdb8b.aab` (sha256 `a1b2ce70…`) | 12 | present | 2 of 2 |

- *Google Play Console, Production track, read 2026-11-17:* release
  "12 (1.0.0)" - **In review**; release "11 (1.0.0)" - **Available on Google
  Play**, released 10 Nov 21:47; release history: "6 (1.0.0)", released 8 Nov
  00:28, replaced 10 Nov 21:47. 8 installs, 4 monthly active devices.

What "has the fix" means. The server issues playback tickets that last 300
seconds (measured on production tickets), and the app swaps to a new one while
playing. In the source of builds 9 and 11 that swap released the old player on
a timer; in my earlier emulator test of that source it broke 3 of 4 rotations
(frozen picture, the stream dying about five minutes later). Mobile PR 6
replaced it, and build 12 is the first that contains it. **Not verified:**
build 12 on a physical phone - that test is still pending and can only happen
once 12 is installable (internal track, or after approval).

### iOS

**The first HLS-capable iOS build number is not verified, and I found no iOS
production build at all.**

- The build service holds 6 iOS builds: all **simulator** builds (internal
  distribution), all build number 1. None is a store build.
- iOS is built and submitted by a separate developer under their own Apple
  account. I have no access to that App Store Connect, and no IPA exists on
  this machine.
- The public App Store lookup for the production bundle id returns no app
  (checked for Egypt and for the default storefront).
- Production has seen exactly one iOS device: first seen 16 Nov, reporting
  app version 1.0.2 with the user agent `EduPlatformDev/3` - a
  **development** build (build 3), not a store build. It has never requested a
  playback ticket.

So there is nothing to put in `MOBILE_HLS_MIN_BUILD_IOS` yet. Section 3 says
what that means and what to do meanwhile.

---

## 3. Do the production builds support mobile HLS?

| Platform | Production build | Supports the mobile HLS path? |
|---|---|---|
| Android | versionCode **11** | **No, not properly.** It asks for HLS and plays it, but does not survive a ticket rotation. |
| Android (pending) | versionCode 12, in review | Yes by source and by bundle; not yet tested on a physical phone. |
| iOS | none found | Unknown. |

### What this means, and how the existing path is preserved

Before this release the server decided "HLS or Gumlet" by one thing: whether
the app declared `hls-aes128`. Build 11 declares it. Today that matters for 44
lectures (the ones with a mobile ladder). With `MOBILE_PIPELINE_ENABLED=true`
it would matter for **every new lecture**.

The release therefore adds one rule (commit 4de70a4): where a minimum build is
configured for a platform, an install below it - or one that does not report
its build - is treated exactly like an app from before the capability existed.
It keeps the Gumlet grant it has always played, and the lesson screen shows it
the Gumlet status.

| With `MOBILE_HLS_MIN_BUILD_ANDROID=12` | Lecture ready on both | Gumlet failed, mobile ready |
|---|---|---|
| Android 11 (declares HLS) | Gumlet stream (Widevine), as before the mobile pipeline | "not available", exactly like an old app |
| Android 12 | mobile HLS | mobile HLS |
| Web | Gumlet | not available |

Verified end to end on the final image (local stack, real ticket endpoint):
build 11 received a `gumlet` ticket and build 12 an `hls` ticket for the same
lecture and the same device; with Gumlet failed, build 11 was refused with
`VIDEO_PROCESSING_FAILED` and build 12 received an `hls` ticket whose
playlists, key and segments opened. Nothing else about a ticket changes:
authorisation, device binding, the concurrency slot, the play allowance and
the watermark are untouched.

The build number is whatever the app sends in `X-App-Build`. Reporting a
higher one only gets an install the stream it asked for anyway.

**iOS.** With no minimum set, an iOS app that declares HLS is served HLS, as
today. Since no iOS build has been verified, the conservative setting is
`MOBILE_HLS_MIN_BUILD_IOS=999999999`: every iOS install keeps Gumlet
(FairPlay) until a real build number is known, then the variable is set to
it. This is a decision for the owner; the only iOS install production has ever
seen is a development build that has played nothing, so either choice affects
nobody today.

---

## 4. Source revisions, image, migrations, dashboard

| Item | Value | Checked |
|---|---|---|
| Backend branch | `fix/dual-pipeline-independence`, on `origin/main` 164ae72 (13 commits up to the code commit) | working tree clean, no stash, `origin/main` has not moved, branch not on the remote |
| Backend code commit | **1aecb4a** (`1aecb4ab407f63dea62952ad5b4d733b7db8dca2`) = 4de70a4 plus three fixes from the pre-merge review (below) | verified from a clean checkout of exactly that commit: typecheck clean, 184 suites, 3,683 tests, 0 failed |
| Worker image | **not needed in Stage 1.** `edu-worker:dual-pipeline-4de70a4` (`sha256:97e5db73b1b8…`) predates the review fixes and is superseded: **rebuild from a clean checkout of the merge commit before Stage 2**, and repeat the checks in this row. For 4de70a4 they were: | `BUILD_COMMIT` baked in = the commit above; **all 214 compiled files in the image are identical** to a fresh build of that commit; `schema.prisma` identical; the three migrations are inside; the real `.env.worker` validates in it with networking off (135 keys; notifications resolve to `false`) |
| Migrations | `20261116120000_video_pipeline_intents`, `20261117090000_video_new_video_announcement`, `20261117100000_device_app_build` | additive; applied in order on a scratch database shaped like production; one `UPDATE` (marks 264 of 272 videos as already announced) |
| Dashboard branch | `feat/dual-pipeline-status`, 1 commit **8d8e06e** on `origin/main` 12dcda7 | working tree clean, `origin/main` has not moved, typechecks; the status response it reads has not changed in the backend since it was built |

Earlier images (`dual-pipeline-9e19d4a`, `-798f639`, `-f363a8f`, `-a292083`)
were test artefacts and have been removed from the laptop. Kept:
`30a21fa-priority-vfr` (rollback) and `30a21fa-priority-r2` (watchdog).

Tests at 4de70a4: 184 suites, 3,679 tests passed, 0 failed (two runs); the
build-gate and default-off rules each fail a test when removed.

### Pre-merge review (pull requests #21 and #10)

Both pull requests are open and mergeable; neither has been merged. An
independent review of the whole backend diff found **no defect that affects
Stage 1** (nothing that queues an old video, fails a healthy one, submits to
Gumlet twice, loses an upload, refuses a ticket that works today, or breaks
with the old worker as the consumer). Three of its findings were fixed in
1aecb4a, each with tests:

- A process with notifications **off** marked any waiting announcement DONE on
  its next pass - so with the API and the worker switched on at different
  moments, a draft's announcement could be lost. A process that is off now
  closes only a debt it recorded itself. (Affects only the later stage that
  enables notifications.)
- A mobile encode's result is now recorded only for the file it read.
  Replacing a lecture's file while its encode was running used to end with
  the previous recording's ladder marked READY. (The old worker has the same
  gap; it is closed when the worker is swapped in Stage 2.)
- `VIDEO_PIPELINE_RECONCILE_SECONDS` present but empty means "not set", not
  "reconciler disabled".

Noted, not changed:

- **Do not leave `MOBILE_HLS_MIN_BUILD_ANDROID` / `_IOS` present but empty.**
  The API (and later the worker) refuses to start with an empty value. On
  Render that fails the deploy and the previous one stays live. The Stage 1
  values were checked against the release build: accepted.
- Lectures the **old** worker finishes during Stage 1 are not marked as
  already announced. Before notifications are ever enabled, the marking
  `UPDATE` from the migration is run once more (it is idempotent). This is
  part of that later stage, not of Stage 1.
- The four rows left queued by the paused batch show `queued: false` in the
  new status response although their jobs exist. Cosmetic.
- `scope: historical` is not understood by the old worker, which treats any
  pause as "hold everything". It is used only after the worker swap (step 6).

The worktree `edu-backend-dual-pipeline` is also being edited by another
session (uncommitted changes to `deploy/laptop-worker/watchdog/watchdog.js`
and two new watchdog test files). They are not part of this release and are
not in commit 1aecb4a. Release builds are made from the clean checkout
`edu-backend-dual-pipeline-release`, never from that folder.

---

## 5. Notifications stay off

- `NEW_VIDEO_NOTIFICATIONS_ENABLED` now defaults to **false**. It must be
  `true` on the API **and** on the worker for anything to be sent.
- Set it to `false` explicitly in both places anyway (steps 2 and 5).
- While it is off, a lecture that becomes playable is recorded as dealt with.
  **It will not be announced when notifications are switched on later** - by
  design, so that enabling them cannot produce a burst about old lectures.
- Verified on the final image with the variable set nowhere: two lectures
  processed, zero notification rows, zero push jobs, and the log line
  `new-video notifications are switched off`.
- Enabling them is a separate, later approval: set `true` on Render and in
  `.env.worker`, restart both.

---

## 6. The historical videos are not queued by enabling the pipeline

Production today (read-only): 211 lectures with a source and no mobile
version (195 live + 16 archived, 156.7 hours), 44 with one, 4 queued and 4
failed from the paused batch.

Each automatic mechanism of the new build, against those rows:

| Mechanism | What it looks for | Rows it finds in production |
|---|---|---|
| Finalising an upload | a new upload | none of the old lectures |
| Reconciler, mobile side | `QUEUED`, not delivered, **with a recorded request** (a column the migration adds as NULL) | **0** |
| Reconciler, Gumlet side | `QUEUED` with no job id and a confirmed upload | **0** |
| Stranded-job recovery | `QUEUED`/`PROCESSING` whose job is gone | 0 - the 4 queued rows' jobs are all present (`delayed`) |
| Turning the flag on | nothing: it is read when an upload is finalised | - |

The only bulk path is the administrator's migrate endpoint, which is a dry run
unless told otherwise. A test pins this (200 old lectures, flag on, every
timer and restart: nothing queued). The 8 delayed jobs already in the queue
stay delayed while the pause holds.

---

## 7. Release checklist

Each numbered step is an approval gate. Nothing before step 7 turns anything
on.

### Step 0 - prepare

- [ ] Merge the backend pull request (#21). `git diff 1aecb4a <merge commit> -- . ":!docs"`
      must be empty. The dashboard pull request (#10) is merged in step 3:
      merging it deploys to production on Vercel.
- [ ] No worker image is needed until step 5; it is rebuilt then from a clean
      checkout of the merge commit. No `docker image prune`.
- [ ] Laptop on home Wi-Fi and AC power, lid open; Docker healthy.
- [ ] Note the current Render deploy id and Vercel deployment (rollback).
- [ ] Prepare the smoke-test course (section 8).
- [ ] Decide the iOS setting (section 3): `999999999` or unset.

### Step 1 - database

- [ ] Neon: backup branch `pre-dual-pipeline-<date>` from production.
- [ ] From the release commit, with the production `DIRECT_URL`:
      `npx prisma migrate deploy` → applies **exactly three** migrations.
- [ ] Verify:
      `select count(*) from videos where "mobileGeneration" <> 0` → 0;
      `select "newVideoAnnounceState", count(*) from videos group by 1` → only `DONE` and NULL;
      `select count(*) from videos where "newVideoAnnounceState" is null and (status in ('READY','ARCHIVED') or "mobileStatus" = 'READY')` → 0;
      `select count(*) from devices where "appBuild" is not null` → 0.
- Effect on running code: none.

### Step 2 - API (Render)

- [ ] Environment - **set before deploying**:
      `MOBILE_PIPELINE_ENABLED=false` (unchanged),
      `NEW_VIDEO_NOTIFICATIONS_ENABLED=false`,
      `MOBILE_HLS_MIN_BUILD_ANDROID=12`,
      `MOBILE_HLS_MIN_BUILD_IOS` as decided in step 0.
- [ ] Manual deploy of the merged commit.
- [ ] Verify: log lines `NewVideoAnnouncerModule dependencies initialized` and
      `video pipeline reconciler: scan at boot…`; no `pending intents:` line;
      `GET /videos/<any id>/status` returns `source`, `gumlet`, `mobile`;
      `/meta/health/deep` unchanged; a student can sign in and stay signed in.
- From this moment build 11 is served Gumlet for the 44 lectures that have a
  mobile version too (log line `build 11 on android declares hls-aes128 but is
  older than the first build…`).

### Step 3 - dashboard (Vercel)

- [ ] Merge the dashboard pull request (#10): Vercel deploys `main` to
      production by itself. Open a lecture: three chips are shown. (The new
      dashboard also works against the old API; the new blocks are optional.)

### Step 4 - smoke test #1 (section 8)

### Step 5 - worker and watchdog (laptop)

- [ ] Build the image from a clean checkout of the merge commit, tag it
      `edu-worker:dual-pipeline-<short sha>`, and repeat the image checks of
      section 4.
- [ ] `deploy/laptop-worker/.env.worker`: back it up, then set
      `WORKER_IMAGE` to that tag, `BUILD_COMMIT` to the full merge commit,
      `NEW_VIDEO_NOTIFICATIONS_ENABLED=false`,
      `MOBILE_HLS_MIN_BUILD_ANDROID=12`, and the same
      `MOBILE_HLS_MIN_BUILD_IOS` as on Render.
- [ ] Confirm nothing is running (`GET /videos/mobile/overview` →
      `worker.detail.activeJobs: []`, no lecture mid-upload), then
      `docker compose --env-file .env.worker up -d`.
- [ ] Verify: `docker inspect edu-worker --format "{{.Image}}"` → the image id;
      healthy; heartbeat build = the first 12 characters of the merge commit;
      the 8 backlog jobs still delayed.
- [ ] Watchdog: back up `C:\edu-watchdog\watchdog.js`, copy
      `deploy/laptop-worker/watchdog/watchdog.js` over it,
      `docker restart edu-hls-watchdog`; its start log shows
      `pauseScope: historical`.

### Step 6 - pause scope

- [ ] `POST /videos/mobile/pause` with
      `{ "reason": "backlog paused between batches", "scope": "historical" }`.
- [ ] `GET /videos/mobile/overview` → `pause.scope = historical`; queue counts
      unchanged (8 delayed). Do not go on until this reads `historical`.

### Step 7 - turn automatic mobile processing on

- [ ] Render: `MOBILE_PIPELINE_ENABLED=true`, save, redeploy.
- [ ] Verify at once: mobile queue counts unchanged (8 delayed, nothing
      waiting); no `pending intents:` line;
      `select "mobileStatus", count(*) from videos group by 1` is what it was.

### Step 8 - smoke test #2 (section 8)

### Step 9 - backfill (separate approval)

- [ ] List A (32 ids, `backfill-A.txt`) in batches of about 8 with the usual
      watcher; `POST /videos/mobile/resume` only when a batch should run.

### Later, each a separate approval

- Enabling notifications (section 5).
- Setting `MOBILE_HLS_MIN_BUILD_IOS` once an iOS build is verified.
- Moving Gumlet off the laptop.

---

## 8. The two smoke tests

**Where.** The course "Physics 1" with status `HIDDEN`
(`cmuynjcbc006ffe01fkobmcge`): unlisted, one teacher, no section, no lesson,
and **no enrolment in any state**. The other empty courses are `PUBLISHED`
and visible in the catalogue, so they are not used.

**Preparation (dashboard):** add one section and two published lessons to it.
Check immediately before each test:
`select count(*) from enrollments where "courseId" = 'cmuynjcbc006ffe01fkobmcge'` → 0.

**No notification can reach a student:** the switch is off in both processes
(nothing is sent to anyone), and nobody is enrolled in this course. Each test
ends by confirming `select count(*) from notifications where kind = 'NEW_VIDEO'` → 0.

**Test files:** #1 any short clip; #2 a clip of **7 minutes or more**, so that
playback crosses a ticket rotation (tickets last 5 minutes).

### Smoke test #1 - after steps 1 - 3 (pipeline off, old worker)

| Check | Expect |
|---|---|
| Upload | accepted; the dashboard reads "The file is uploaded…" |
| Status chips | `Uploaded · Gumlet Pending → Ready · Mobile HLS Not started` |
| `GET /videos/<id>/status` | `source.state = VERIFIED`; `gumlet.state = READY`; `mobile.status = NONE`, `mobile.jobId = null`; `durationSeconds > 0` |
| Database | exactly one video row for the lesson; `"mobileStatus" = 'NONE'`, `"mobileJobId"` null |
| Mobile queue | unchanged: 8 delayed, nothing new |
| Duration | the lecture row shows the real length; `"durationSeconds" > 0` on the video and the lesson |
| Playback (web) | the administrator's preview plays it |
| Notifications | `NEW_VIDEO` count 0 |

### Smoke test #2 - after steps 5 - 7 (pipeline on, new worker)

| Check | Expect |
|---|---|
| Upload | accepted; within a minute `Uploaded · Gumlet Pending · Mobile HLS Queued` |
| Mobile queue | one new job `mobile-hls:<videoId>:p1g1`, **without** a priority; the 8 backlog jobs still delayed |
| Processing | `Mobile HLS Processing nn%` then `Ready`; Gumlet `Ready` on its own |
| `GET /videos/<id>/status` | `gumlet.state = READY`; `mobile.status = READY`; `renditions` lists the ladder; `durationSeconds > 0` |
| Database | `select "mobileStatus", "mobileGeneration", "mobileEnqueuedAt" is not null, "durationSeconds" > 0, "newVideoAnnounceState" from videos where id = '<videoId>'` → `READY, 1, true, true, DONE` |
| Duration | shown on the lecture row; equal on video and lesson |
| Worker log | `became playable via …: announcement owed` then `new-video notifications are switched off` |
| Playback (web) | the administrator's preview plays it |
| Notifications | `NEW_VIDEO` count still 0; no new job in the push queue for it |
| Old lectures | `select "mobileStatus", count(*) from videos group by 1` changed by this one video only |

**Playback on a phone** needs an account that can open the lesson. Use the
review account, not a student: grant it this course from the dashboard for the
test and remove the grant afterwards (the enrolment count is then 1, and it is
the test account).

| Phone | Expect |
|---|---|
| Android **11** (what Google Play serves today) | plays over **Gumlet**; `select delivery from playback_tickets where "videoId" = '<videoId>' order by "issuedAt" desc limit 1` → `gumlet`; API log line `build 11 on android declares hls-aes128 but is older…` |
| Android **12** (when it can be installed) | plays over **HLS** (`delivery = hls`) and **keeps playing past six minutes** |
| iOS | not part of this test |

Afterwards: remove the two test videos in the dashboard (their Gumlet assets
stay at Gumlet; delete them there by hand if wanted) and remove the review
account's grant.

---

## 9. Rollback

| What | How | Leaves behind |
|---|---|---|
| Stop new mobile jobs | `MOBILE_PIPELINE_ENABLED=false` on Render | queued jobs stay and run |
| Stop encoding | `POST /videos/mobile/pause` (no scope = everything) | nothing lost |
| Put every phone back on Gumlet | `POST /videos/mobile/delivery` `mode=gumlet` | the emergency switch, unchanged |
| A build is wrongly kept on Gumlet, or wrongly given HLS | change `MOBILE_HLS_MIN_BUILD_ANDROID` / `_IOS` on Render and redeploy | unset = the app's declaration decides, as before this release |
| Worker | restore the `.env.worker` backup (image `30a21fa-priority-vfr`), `docker compose --env-file .env.worker up -d` | jobs keep their ids; the old image runs them |
| Watchdog | restore the `watchdog.js` backup, `docker restart edu-hls-watchdog` | its pauses hold new uploads again |
| API | Render → roll back to the noted deploy | new columns ignored; build 11 is served HLS again for lectures that have a mobile version |
| Dashboard | Vercel → promote the previous deployment | - |
| Migrations | not needed for any rollback; if wanted, drop the index and the seven columns after the API and worker rollback | - |

No rollback step deletes a video, a Gumlet asset, an R2 object or a queue.

---

## 10. Remaining blockers and open items

**Blocking the backend release:** none.

**Open, and handled by the plan rather than blocking it:**

1. **Android 12 is not live.** Until Google approves it, no phone in
   production runs a build that plays mobile HLS properly, so mobile HLS on a
   real device cannot be smoke-tested in production. With the minimum build
   set, build 11 keeps Gumlet and nothing regresses.
2. **Build 12 has not been tested on a physical phone.**
3. **iOS: no production build found, no build number verified.** Needs the iOS
   developer's App Store Connect build number and the commit it was built
   from. Until then: `MOBILE_HLS_MIN_BUILD_IOS=999999999`, or unset by the
   owner's decision.
4. **Notifications are off.** Lectures processed meanwhile will not be
   announced later.
5. **Carried over, unchanged:** the 211 historical lectures are a separate,
   manual backfill; the laptop is still the worker.
