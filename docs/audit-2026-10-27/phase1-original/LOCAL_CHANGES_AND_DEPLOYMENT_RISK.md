# Local changes and deployment risk

Audit date: 2026-10-26/27. All Git inspection was read-only (`git --no-optional-locks`). Nothing was fetched, committed, stashed, switched, merged or pushed. The connected computer cannot reach GitHub (proxy 403), so the remote-tracking refs below are as of the last fetch on that machine: **2026-10-18** for the backend, dashboard and web, and **2026-10-10** for mobile. Pushes made since then from another machine would not be visible.

**Audit edits are uncommitted.** Every change made during this audit is an uncommitted working-tree edit on top of whatever was already checked out. They are listed per file in `IMPLEMENTATION_REPORT.md` §6. None of them has been committed, so each project's `git diff` now shows your earlier uncommitted work and the audit's work together.

## 0. Production baseline — what could and could not be established

| Project | Host (from config evidence) | Deployed commit | Evidence | Confidence |
|---|---|---|---|---|
| Backend API | Render, `https://student-backend-814y.onrender.com` | **Not verifiable.** Production `GET /api/v1/meta/health/deep` (read via the built-in browser, 2026-10-26 21:48 UTC) reports `apiBuild: null`, because neither `BUILD_COMMIT` nor `RENDER_GIT_COMMIT` is visible to the API. | live health endpoint; `baseline-production.txt` (17 applied migrations as of 2026-10-10) | Low. Reference: `origin/main` = `bcf1719` |
| Backend **worker** | Docker container, host `bcd7e0fe996d` | **Verified: `b7ad4c844aea`** = `b7ad4c8`, the 3rd of the 4 unmerged commits on `fix/gumlet-failed-asset-recovery`. **Production runs unmerged branch code.** | live `/meta/health/deep` → `videoPipeline.worker.build` | High |
| Media edge Worker | Cloudflare `edu-media-gate.startuppp3.workers.dev` | Not verifiable | `wrangler.toml` comments ("verified 2026-09-25") | Low |
| Database | Neon Postgres 18.6 | 17 migrations applied as of 2026-10-10 post-release fingerprint; the repo now has 20 migration folders | `baseline-post-release.txt`, `prisma/migrations` | Partial; **later migrations may or may not be applied** |
| Dashboard | Vercel, `student-dashoard.vercel.app` (privacy URL in the Play audit) | Not verifiable | none in the repo | Low. Reference: `origin/main` = `30509ca` (2026-10-16) |
| Student web | Vercel, `student-web-gray.vercel.app` (`WEB_ORIGINS`) | Not verifiable | none in the repo | Low. Reference: `origin/main` = `58c6129` (2026-10-23) |
| Mobile | Not live in any store. Play Console app is a **Draft** with no bundle uploaded (`release/PLAY_AUDIT_2026-10-23.md`) | Latest production AAB: versionCode 7, built 2026-10-01 from `61d08d1` | `release/PLAY_AUDIT_2026-10-23.md`; AAB inspected (package `com.eduplatform.app`, signed, `expo-updates` included) | High (for the artifact) |

**Treat `origin/main` as the likely production code, not as verified production code.** Before any deploy, confirm the live commit in the Render and Vercel dashboards ("Events" / "Deployments" show the commit SHA).

## 1. Backend — `edu-backend`

- **Branch:** `fix/gumlet-failed-asset-recovery` at `e06289e`, pushed to `origin/fix/gumlet-failed-asset-recovery`. It is **4 commits ahead of `origin/main`** (`fcd8cdb`, `c36f365`, `b7ad4c8`, `e06289e`): Gumlet reprocess/recovery, stranded-video requeue, jittered transcode backoff, and a lecture-slot fix.
- **Your uncommitted work** (8 tracked files, +422/−33, plus 3 untracked files): video **upload interruption recovery**.
  - `completeUpload` is idempotent and recovers a row stranded at UPLOADING whose bytes already landed. It verifies an optional client `sizeBytes` and prunes superseded source objects (`storage.pruneSupersededSources`).
  - `delete` removes the whole `source/videos/<id>/` prefix.
  - The status DTO gains `uploadConfirmed`.
  - `backfill-gumlet-durations.js` stops writing geometry.
  - `wrangler.toml` adds a Vercel preview origin to `WEB_ORIGINS`.
  - New: `docs/VIDEO_UPLOAD_INTERRUPTION_ROOT_CAUSE.md`, `test/unit/playback-tracking-contract.spec.ts`, `test/unit/video-upload-recovery.spec.ts`.
  - Most of `git diff` on these files is CRLF noise. `git diff --ignore-cr-at-eol` shows the real change.
- **Worktrees (branches checked out elsewhere):**

  | Worktree | Branch | State vs `origin/main` |
  |---|---|---|
  | `edu-backend-admin` | `feat/revenue-reporting` | merged |
  | `edu-backend-codeprice` | `feat/optional-access-code-price` | merged |
  | `edu-backend-drm` | `chore/gumlet-video-migration` | merged; no upstream |
  | `edu-backend-recovery` | `recovery/always-on-verification` | 2 ahead of `origin/preview/shared-video-drm-fixes` |
  | (opencode temp) | detached `d8e2f67` | prunable |

  Uncommitted work inside those worktrees is **not visible from here**: only the main folder was granted. Check each with `git -C <worktree> status`.
- **Other local branches:** `recovery/drm-shared-video` (no upstream), `hotfix/gumlet-embed` (pushed, merged).
- **Overlap with `origin/main`:** `src/modules/videos/videos.service.ts` is changed by both the 4 branch commits and the uncommitted work. No conflict exists yet because the branch is based on `origin/main`.

**Risk analysis of the uncommitted backend work (Category B)**

- **Safe direction:** the new `complete` body is optional (`CompleteUploadDto` fields are all optional). An old dashboard that sends no body still works.
- **Observation (not fixed, because it's your WIP):** `completeUpload` writes `processingError: null, processingStartedAt: null` **before** it checks whether the video is already QUEUED/PROCESSING/READY. A repeated `complete` on a video that is actively processing resets its `processingStartedAt`, which other code may use for stall detection. **Recommendation:** move that `update` below the "already in the pipeline" and READY/ARCHIVED early returns, or only clear those fields when re-queueing.
- **Gumlet path:** `localJobIsLive` checks only the local BullMQ job. A Gumlet-processed video with no local job is treated as "job gone" and re-queued, which can create a second Gumlet asset if the first is still packaging. Verify against `gumlet-ingest.service` before shipping.
- `pruneSupersededSources` deletes objects under the video's own prefix only, keeping the current key. Safe as written.
- `wrangler.toml`: adding a Vercel **preview** deployment URL to `WEB_ORIGINS` lets that preview read signed media. It is harmless if the preview is yours, but it should not ship to production unintentionally.
- **Deployment order:** this backend work must be **deployed before** the dashboard's uncommitted upload work, which depends on `uploadConfirmed` and the recovering `complete`.

## 2. Dashboard — `edu-dashboard`

- **Branch:** `main` at `d57e6a1`, **behind `origin/main` by 7 commits**: revenue reporting, the optional card price, and departments in the code course picker. Nothing on local `main` is unpushed.
- **Your uncommitted work** (5 files, +834/−77): **resilient video upload** in `src/features/videos/upload.ts`, `hooks.ts` and `lesson-video-panel.tsx`, plus the e2e stub and spec. The upload now survives a failed PUT by asking `complete` whether the bytes landed, and shows "file did not arrive" honestly.
- **Overlap with `origin/main`:** `e2e/stub-api/server.mjs` is changed by both → **a merge conflict is likely** when you pull.
- **Worktrees:** `edu-dashboard-admin` (`feat/revenue-reporting`, merged), `edu-dashboard-codeprice` (merged), `edu-dashboard-recovery` (`recovery/shared-video-dashboard`, **1 commit not in `origin/main`**: `56ed65c` "send lessonId on delete").
- **Copies under `Desktop/Claude outputs` (backend folder):** `hooks.ts`, `lesson-video-panel.tsx`, `upload.ts`, `video-upload.spec.ts` and `r2-cors.md` look like an earlier copy of this same WIP. Not compared in detail.

**Risk:** the uncommitted upload work depends on backend fields that are only in the backend's uncommitted work (`uploadConfirmed`, idempotent `complete`). Shipped against the current production backend, the "upload confirmed" state would read as `undefined`. Ship the backend first.

## 3. Student web — `edu-web/student-web`

- **Branch:** `feat/pdf-image-watermark` at `3da3061` (pushed, merged into `origin/main`). The checkout is **behind `origin/main` by 7 commits**: cross-year course visibility, the mobile toolbar overflow fix, and the Huawei/Widevine diagnostics merge.
- **Local `main` has 1 unpushed commit:** `16f045c` "send the destination lesson on playback tickets". The same change exists on the unpushed worktree branch `recovery/shared-video-web` (`73be245`).
- **Other unpushed or unmerged branches:**

  | Branch | Commits not in `origin/main` |
  |---|---|
  | `fix/huawei-drm-trace-retrieval` (worktree `student-web-huawei-fix`) | 3 (on-screen DRM trace, Gumlet embed experiment for Huawei) |
  | `feat/course-card-meta-lines` | 1 ("add analytics") |
  | `diag/fairplay-eruda` | 2 (diagnostic) |
  | `backup/diag-vercel-metadata` | 1 |
  | `diag/pdfjs-fontface` (worktree) | marked **NOT FOR MERGE** |

- **Your uncommitted work** (6 tracked files, +222/−105, plus 6 untracked): **playback tracking**.
  - New `src/lib/playback-tracking.ts` and `src/lib/watch-clock.ts`, with tests.
  - Changes to `player/[id]/page.tsx`, `DrmVideo.tsx`, `features/api.ts`, `features/curriculum.ts` (+test) and `courses/page.tsx`.
  - **`@vercel/analytics` added in `layout.tsx` but not in `package.json`.** This was fixed during the audit (see the implementation report).
- **Overlap with `origin/main`:** `src/app/courses/page.tsx`, `src/components/protection/DrmVideo.tsx` and `src/features/api.ts` are changed both locally and upstream. **Expect merge conflicts.** `courses/page.tsx` is the riskiest, because upstream rewrote cross-year browsing.

**Risk:** the `@vercel/analytics` import would have **failed a clean Vercel build** (`npm ci` installs only what the lockfile declares). It is now declared in both `package.json` and `package-lock.json`, using the exact version and integrity already installed locally (2.0.1).

## 4. Mobile — `edu-mobile-final/mobile-app-student`

- **Branch:** `main` at `61d08d1`, **behind `origin/main` by 3 commits** by youssef-hamed04 (2026-10-08/09: "old commit", "تحديث 2.0", "تحديث 2.1"). Nothing on local `main` is unpushed. `backup-before-release-merge` is local only.
- **Nested repository:** `mobile-app/` is a separate Git repository (`youssef-hamed04/mobile-app`, a single "Initial commit") inside the working tree. It looks unrelated, so confirm and remove it from this folder if so. A nested repo inside an EAS project is uploaded with the build archive unless it is ignored.
- **Your uncommitted work** (13 files, +434/−67; dated 2026-10-09/10):
  - Registration rebuilt on `/catalog/academic-selection`, with **no study type**.
  - Protected player DRM source construction.
  - `tsconfig` `ignoreDeprecations` fixed so `tsc` runs at all.
  - New `__tests__/player-source-drm.test.ts`; `release/` notes plus the downloaded AAB.
- **Genuine conflict with `origin/main`:** youssef's 3 commits add a **required** `studyType: GENERAL | PROGRAMS` to the registration wizard. Your uncommitted work **removes** study type. Both touch `register.tsx`, `features/auth/{api,hooks,schemas}.ts`, the locales and `tsconfig.json`. → **Owner decision D1.**
- **Build state:** the only production AAB (versionCode 7) predates all of the above.

## 5. Classification summary

| Item | Category | Recommended action |
|---|---|---|
| Backend branch `fix/gumlet-failed-asset-recovery` (4 commits) | B | Review → PR to `main`. It touches the same service as the WIP: merge it first, then rebase the WIP. |
| Backend uncommitted upload recovery | B | Revise the `processingStartedAt` ordering and check the Gumlet "job gone" case → test → commit → deploy **before** the dashboard WIP |
| Backend `wrangler.toml` preview origin | B | Keep it local, or remove it before `wrangler deploy` |
| Dashboard local `main` behind 7 | A | `git pull --ff-only` once the WIP is committed or stashed (expect a conflict in `e2e/stub-api/server.mjs`) |
| Dashboard uncommitted upload WIP | B | Retain; ship after the backend WIP |
| Dashboard `56ed65c` (lessonId on delete) | A | **Applied to the working tree during the audit** (identical change). Merge the branch, or drop it as a duplicate once committed. |
| Web checkout behind 7; local `main` +1 unpushed | B | Commit the WIP on a branch → rebase onto `origin/main` → resolve `courses/page.tsx`, `DrmVideo.tsx` and `api.ts` |
| Web diagnostic branches (`diag/*`, `backup/*`) | C (if merged) | Do **not** merge into `main`: they add debug consoles and experiments |
| Mobile 3 upstream commits vs local registration WIP | B → **decision D1** | Decide the study-type rule, then merge by hand |
| Mobile nested `mobile-app/` repository | B | Confirm it is unrelated, then move it out |
| Audit fixes (all repos) | A | Review the diff per file (implementation report §6), then commit on a branch per project |

## 6. Migrations and the database

- The repo has 20 migration folders. The 2026-10-10 post-release fingerprint showed 17 applied. Migrations dated after it (for example `20261012090000_strict_drm_playback`) **may be pending in production**. Run `npm run prisma:status` against production, read-only, before deploying.
- **No new migration was created by the audit.** The `schema.prisma` change only declares two indexes that `20261012090000_strict_drm_playback` already creates, so `prisma migrate diff` stops proposing to DROP them.
- `.gitattributes` pins `prisma/migrations/**/*.sql` to LF because Prisma checksums the bytes. Keep it that way.

## 7. Things that could break production if deployed without care

1. **Backend audit change: guard order** (JWT before throttler). Rate limits become per user for authenticated traffic and per phone for sign-in. Unauthenticated floods against protected routes are now rejected by the JWT guard (401) **before** throttling. That is cheap, because signature verification happens before any DB read, but it is a behaviour change to watch in logs.
2. **Backend audit change: heartbeat hardening.**
   - An expired ticket (more than 60 s past expiry) now ends playback instead of rotating, and the client re-issues through the full checks.
   - A rotation from a different or unapproved device is refused.
   - Old mobile builds show their generic "denied" screen in those cases. That is correct behaviour, but it is user-visible.
3. **Web proxy changes** affect every signed-in request. They are covered by 369 passing unit tests, but have not been exercised against a live backend.
4. **The dashboard delete-with-lessonId change assumes the deployed backend accepts `?lessonId=`.** `origin/main` does; confirm the live commit.
