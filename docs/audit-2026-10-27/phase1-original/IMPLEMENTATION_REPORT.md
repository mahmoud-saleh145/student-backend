# Student Center — audit and repair: implementation report

Dates: 2026-10-26 → 2026-10-27. Scope: `edu-backend`, `edu-dashboard`, `edu-web/student-web` and `edu-mobile-final/mobile-app-student`, on your Desktop.

**Nothing was pushed, merged, deployed, migrated, committed or submitted.** All changes are uncommitted working-tree edits, made on top of your existing uncommitted work. An audit-only patch per project is in `patches/`.

Evidence labels used below:
- **[test]** verified by a passing test or check
- **[prod]** verified against live production (read-only GET)
- **[code]** source inspection only
- **[n/v]** not verified

## 1. Overall verdict

**Ready with documented limitations for a controlled backend + web + dashboard release; not ready for store publication.**

- **Backend, web and dashboard:** the fixes are small, tested and backward-compatible. Before deploying, (a) confirm the live commits (§2), (b) merge the work in the order given in `LOCAL_CHANGES_AND_DEPLOYMENT_RISK.md`, and (c) run the full backend test suite on Windows (only 66/140 files could be re-run here).
- **Mobile:** a new build is required. The only AAB predates everything here. Android can go to closed testing after decision D1. iOS needs decisions D4/D5 and a real-device FairPlay test.

## 2. Production baseline

| Component | Deployed version | Evidence |
|---|---|---|
| Video worker | **`b7ad4c8`**, on the **unmerged** branch `fix/gumlet-failed-asset-recovery` | [prod] `/api/v1/meta/health/deep` → `videoPipeline.worker.build = b7ad4c844aea` |
| API (Render) | **unknown**: `apiBuild` is null | [prod] same endpoint. Best reference: `origin/main` `bcf1719` [n/v] |
| Dashboard / web (Vercel) | unknown | [n/v]. References: dashboard `origin/main` `30509ca`, web `origin/main` `58c6129` |
| Database | 17 migrations applied as of 2026-10-10; the repo has 20 | `baseline-post-release.txt` [code] |
| Mobile | not in any store; Play app is a Draft; AAB vc7 from `61d08d1` (2026-10-01) | `release/PLAY_AUDIT_2026-10-23.md`; AAB inspected [code] |

**Production state worth knowing** [prod]:
- 10 videos stuck at UPLOADING, 1 FAILED, and 1 video failing the DRM verification sweep.
- `maxConcurrentStreams = 1` and a device limit of 1.
- Support contacts are empty.

## 3. Project status

| Project | Before | After the audit |
|---|---|---|
| Backend | One critical entitlement bug, several high-severity playback and throttling bypasses, contract gaps | Fixed (§4). `tsc` clean [test]; 66 of 140 unit files executed, 0 failures [test] |
| Dashboard | Four broken admin flows (sort, tabs, deleted-course cache, sign-out), teacher switches always off, shared-video delete 409 | Fixed (§4). `tsc` clean; ESLint clean on changed files [test]. Playwright e2e not run (needs a Linux Next build) [n/v] |
| Student web | **Build broken** (undeclared dependency); session logouts (4 defects); wrong year filter; hidden pending enrolments | Fixed (§4). **369/369** `node --test` [test]; `tsc` clean; ESLint clean on changed files |
| Mobile | iOS playback broken; terminate ignored; avatar 422; missing error code; OTA could ship a localhost API | Fixed in code (§4). `tsc` clean [test]; Jest partly run (§5) |

## 4. Defects fixed (root cause → fix)

### Backend

| ID | Severity | Root cause | Fix | Files | Evidence |
|---|---|---|---|---|---|
| B1 | **Critical** | `grantAccess` kept `coversAllSections` from any existing row. Pending and expired rows default to `true`, so requesting approval and then redeeming the cheapest section card unlocked the whole course. | Inherit full coverage only from an ACTIVE, unexpired row. The parts view shows "owned" only for ACTIVE rows. | `enrollments.service.ts`, `course-parts.service.ts` | [test] `enrollment-scope-widening.spec.ts` (8), `join-options` |
| B2 | High | The heartbeat rotated **expired** tickets into fresh ones (negative remaining time counts as "about to expire") with no device, section, concurrency or play-limit checks. A ticket id therefore worked forever. | End expired tickets (60 s grace) with a 200 `terminate`; re-check section scope on every beat; at rotation, re-check the device and require the same device. | `playback.service.ts` | [test] 7 new cases in `drm-verify-then-play.spec.ts` |
| B3 | High (iOS) | Rotation called `mintTicket` without `platform`/`delivery`, so FairPlay became Widevine/DASH about 4 minutes in. | Record platform and delivery per ticket in Redis (best-effort) and reuse them at rotation. | `playback.service.ts` | [test] FairPlay → FairPlay rotation case |
| B4 | High | The throttler ran before auth, so the per-user bucket never applied: every student behind a NAT, and **every web student** (requests come from Vercel), shared one IP bucket, including 60 tickets/hour. Credential limits were keyed `ip\|phone` with a client-controlled IP. | Auth guard first. Credential attempts keyed by normalised phone. | `app.module.ts`, `throttler-proxy.guard.ts` | [test] `throttler-tracker.spec.ts` (4) |
| B5 | Medium | Caption `objectKey` was not namespaced but was signed for every viewer, so staff could expose any stored object. | Require `captions/<videoId>/`. | `videos.service.ts` | [test] `storage-namespace-hardening.spec.ts` |
| B6 | Low | Three streamed or presigned upload routes skipped the course-ownership check. | `assertCourseExistsAndManageable` added. | `storage.controller.ts` (+2 test files updated) | [test] |
| B7 | Low | Attachment delete removed bytes only from `uploads`; current attachments live in `media`. | Also delete from `media`, limited to the `attachments/` namespace. | `attachments.service.ts` | [test] |
| B8 | Medium | Payment capture did not restore whole-course coverage, so a re-buyer after a part code or a revoke paid and stayed limited. | `coversAllSections: true` on capture. | `payments.service.ts` | [code] (payments are off in production) |
| B9 | Medium | `meta/app-config` never returned the teacher capability flags the dashboard reads [prod]. | Additive `teacher{…}` block. | `meta.controller.ts` | [test] `app-config-teacher-capabilities.spec.ts` |
| B10 | Medium | A teacher could not retry a failed first upload: any non-deleted row was "live", requiring `editVideoUrls`. | Gate only on READY videos. | `videos.service.ts` | [test] `video-reupload-capability.spec.ts` (6) |
| B11 | Low | Two DRM-sweep indexes existed only in a migration, so the next `migrate dev` would DROP them. | Declared in `schema.prisma` (no new migration). | `schema.prisma` | [code]: `prisma validate` needs a Linux engine; run it on Windows |
| B12 | Hygiene | Non-placeholder Cloudinary credentials in the tracked `.env.example` (a different cloud than production [prod]). | Blanked. **Rotate them anyway**: they remain in Git history. | `.env.example` | [code] |

### Student web

| ID | Root cause → fix | Files | Evidence |
|---|---|---|---|
| W1 | `@vercel/analytics` imported (your WIP) but not declared, so a clean Vercel build fails → declared at 2.0.1 with the lockfile entry copied from the installed package | `package.json`, `package-lock.json` | [code] (`npm ci` impossible offline) |
| W2 | Proxy answered 401 when only the 12 h access cookie had lapsed, logging out students who held a valid 30-day refresh token → refresh in that case | `api/proxy/[...path]/route.ts` | [test] suite |
| W3 | Session generation and refresh cooldown were process-global, so one student's sign-in or failure logged out or blocked others → scoped per browser (device cookie) | `lib/refresh-lock.ts`, auth routes | [test] 4 new cases |
| W4 | Any upstream 401 triggered a refresh / sign-out → only `UNAUTHORIZED`/`SESSION_EXPIRED`; `endsSession` ignores `PLAYBACK_TICKET_EXPIRED` and `INVALID_CREDENTIALS` | proxy, `lib/error-messages.ts` | [test] |
| W5 | Sign-out with an expired token left the server session alive → refresh once and revoke | `api/auth/logout/route.ts` | [test] tsc/lint |
| W6 | Year filter sent a faculty id as `departmentId` → `facultyId` | `features/api.ts`, `courses/page.tsx` | [test] tsc |
| W7 | The attachment ticket refetched on focus, reloading the PDF → disabled focus/reconnect refetch | `features/api.ts` | [code] |
| W8 | "All" tab in My Courses excluded pending enrolments → shows all | `my-courses/page.tsx` | [code] |

### Dashboard

| ID | Root cause → fix | Files |
|---|---|---|
| D-1 | `sort=createdAt` is not in the API vocabulary → mapped to `newest`/`oldest` (works against the current production API) | `features/courses/hooks.ts` |
| D-2 | Deleting a course invalidated `['courses','list',undefined]`, which matches nothing → prefix `['courses','list']` | `features/courses/hooks.ts` |
| D-3 | Tab switches carried `sort`/`order` into other tabs → 422 → cleared on tab change | `components/ui/tabs.tsx` |
| D-4 | Shared-video delete without `lessonId` → 409 → applied your commit `56ed65c` verbatim | `features/videos/hooks.ts`, `lesson-video-panel.tsx` |
| D-5 | Sign-out with an expired token did not revoke the session → refresh once and revoke | `lib/session.ts` |
| D-6 | Teacher switches always off → backend B9 | — |

Evidence: [test] `tsc --noEmit` clean and ESLint clean on the 5 files.

### Mobile

| ID | Root cause → fix | Files | Evidence |
|---|---|---|---|
| M1 | FairPlay HLS typed `dash` → `hls` | `ProtectedVideoPlayer.tsx`, its test | [test] `player-source-drm.test.ts` |
| M2 | Rotation timer's `finally(setPhase('ready'))` overwrote a termination → only `refreshing` → `ready` | `usePlaybackTicket.ts` | [test] tsc |
| M3 | Terminate reasons all became `PLAYBACK_DENIED` → reissuable reasons go to `expired` (re-issue UI) | `usePlaybackTicket.ts` | [test] tsc |
| M4 | The native player was not paused when the grant ended → paused | `ProtectedVideoPlayer.tsx` | [test] tsc |
| M5 | Avatar `sizeBytes: 0` → 422 → use the blob size | `features/profile/avatar.ts` | [test] tsc |
| M6 | `COURSE_NOT_TARGETED` unknown → added code and en/ar text | `api/errors.ts`, `types/api.ts`, locales | [test] `errors.test.ts` 106/106 |
| M7 | An OTA update without the production env would point apps at `http://10.0.2.2:3000` → release bundles refuse non-https or local API URLs at startup | `config/env.ts`, `__tests__/release-api-url.test.ts` | logic 9/9 [test]; the Jest file did not finish here |

## 5. Test and build evidence

All commands ran on the linked computer against the installed `node_modules` (Linux VM over the mounted folders), unless noted.

| Project | Command | Result |
|---|---|---|
| Backend | `tsc --noEmit -p tsconfig.json --incremental false` | **exit 0** (after all edits) |
| Backend | Jest unit (transpile-only config, outside the repo): 66 of 140 spec files executed after the final edits | **66 passed, 0 failed**; ≥ 958 assertions in the 55 files recorded by the runner. Files run: `results` list below |
| Backend | Not executed (environment too slow after mid-session I/O degradation) | 74 files, including 14 that import a changed module (`playback-legacy-drm-scheme`, `presigned-upload-size-verification`, `refund-api-validation`, `staff-list-scoping`, `storage-library-upload`, `thumbnails-and-section-attachments`, `video-association-integrity`, `video-attachment-integrity`, `video-pipeline-and-playback`, `video-removal-scoping`, `video-source-replacement-gumlet`, `video-upload-recovery`, `videos-automatic-gumlet-ingest`, `videos-stranded-recovery`) and `gumlet-keysystem-selection` (timed out) |
| Backend | `prisma validate` | **not run**: the CLI needs a Linux engine download (blocked) |
| Web | `node --test --experimental-strip-types "src/**/*.test.ts"` | **369/369 pass** |
| Web | `tsc --noEmit` | **exit 0** |
| Web | ESLint on the 10 changed files | **exit 0** |
| Web | `next build` | **not runnable**: only Windows SWC/lightningcss binaries installed |
| Dashboard | `tsc --noEmit` | **exit 0** |
| Dashboard | ESLint on the 5 changed files | **exit 0** |
| Dashboard | Playwright e2e / `next build` | not runnable (as for web) |
| Mobile | `tsc --noEmit` | **exit 0** (it had not run at all before your local tsconfig fix) |
| Mobile | Jest: `errors.test.ts` 106/106, `player-source-drm.test.ts` PASS | other suites not run (jest-expo start-up exceeded the call limit) |
| Mobile | APK / AAB | **not built**: no Android SDK or EAS access; use `eas build` |

**Baseline failures:** none observed in anything executed. Earlier claims of web failures came from an incomplete cloud install, not your tree.

**Please run on Windows (fast, native):**

```
cd edu-backend   && npm run typecheck && npm test && npx prisma validate
cd edu-web\student-web && npm run verify        # typecheck + lint + test + build
cd edu-dashboard && npm run verify && npm test  # Playwright
cd edu-mobile-final\mobile-app-student && npm run typecheck && npm test
```

## 6. Files changed by the audit (all uncommitted)

**Backend** (20 files, +741/−27):

| Kind | Files |
|---|---|
| Config and schema | `.env.example`, `prisma/schema.prisma` |
| Source | `src/app.module.ts`, `src/common/guards/throttler-proxy.guard.ts`, `src/modules/{attachments/attachments.service, course-parts/course-parts.service, enrollments/enrollments.service, meta/meta.controller, payments/payments.service, playback/playback.service, storage/storage.controller, videos/videos.service}.ts` |
| Tests, new | `test/unit/{app-config-teacher-capabilities, enrollment-scope-widening, storage-namespace-hardening, throttler-tracker, video-reupload-capability}.spec.ts` |
| Tests, updated | `test/unit/{attachment-storage-bucket, drm-verify-then-play, pdf-upload-size-limits}.spec.ts` |

`videos.service.ts` also carries **your** uncommitted upload-recovery work: the audit touched only `addCaption` and the `liveVideo` gate.

**Dashboard** (5 files, +80/−21): `src/components/ui/tabs.tsx`, `src/features/courses/hooks.ts`, `src/features/videos/hooks.ts`, `src/features/videos/lesson-video-panel.tsx` (the last two also carry your WIP plus `56ed65c`), `src/lib/session.ts`.

**Web** (13 files, +263/−47): `package.json`, `package-lock.json`, `src/app/api/auth/{login,logout,register}/route.ts`, `src/app/api/proxy/[...path]/route.ts`, `src/app/courses/page.tsx` (one line; your WIP preserved), `src/app/my-courses/page.tsx`, `src/features/api.ts` (your WIP preserved), `src/lib/{error-messages,refresh-lock}.ts`, and their tests.

**Mobile** (10 files, +149/−11): `src/config/env.ts`, `src/api/errors.ts`, `src/types/api.ts`, `src/features/profile/avatar.ts`, `src/features/video/{ProtectedVideoPlayer.tsx,usePlaybackTicket.ts}`, `src/i18n/locales/{ar,en}.json`, `__tests__/player-source-drm.test.ts` (your file; one assertion added), and `__tests__/release-api-url.test.ts` (new).

**Migrations prepared:** none needed.

**Preservation check** [test]: all 48 touched files on your computer are byte-identical to the audited copies, which started from your working trees. Every repo is still on its original branch and HEAD. No Git lock files were left behind.

**Scratch files left on your Desktop** (deletion is disabled for this session, so delete them yourself): `edu-mobile-final/_claude-transfer/` (tarballs, partial `node_modules` tars and a patch used for transfer). It is outside every repository.

## 7. Unresolved: issue, reason, next action

| Issue | Why not fixed | Next action |
|---|---|---|
| Production worker runs unmerged `b7ad4c8`; API commit unknown | Needs repo merges and deploy access | Merge `fix/gumlet-failed-asset-recovery` → `main`, set `BUILD_COMMIT` on the API, redeploy both, check `/meta/health/deep` |
| 10 videos stuck at UPLOADING [prod] | Your WIP fixes this; it needs review and a deploy | Address the two review notes in `LOCAL_CHANGES…` §1, deploy, then call `complete` per video or clean them up |
| Mobile registration conflict | Product decision | D1 |
| Teacher notifications 403 | Product decision | D2 |
| Teachers can grant free access | Product decision | D3 |
| iOS payments and account deletion | Product and store policy | D4, D5 |
| Rate-limit IP trust | Needs an ops decision | D6 |
| Web player progress (F9–F12), PDF eager rendering (F14), wallet totals (F16), join sheet for PAYMENT-only courses (F18) | Inside your uncommitted player work, or low severity | `findings/web_findings.md` |
| Mobile: captions and quality no-op on DRM, device-identity regeneration, iOS PDF navigation filter (suspected), forced-update gate, in-app password change | Feature work or needs a device | `findings/mobile_findings.md` |
| Backend: refresh rotation not compare-and-set, webhook marks processed on capture failure, public section listing of unpublished courses, password change also logs out the caller, push tokens not cleared on revocation | Lower severity; behaviour changes need review | `findings/backend_findings.md` F-07, F-12, F-14, F-18 |
| Unsigned R2 part/library thumbnails may 403 at the Worker | Course thumbnails are Cloudinary [prod]; part and library covers unchecked | Open a part or library cover URL in production |
| Payment provider is a placeholder | Payments are off | Before enabling online payment |

## 8. Manual actions that need you

1. **Commit** each project's work on a branch (review `patches/*.patch` first). Then merge in this order: backend branch + WIP → deploy backend → dashboard (pull `origin/main` first) → web (rebase onto `origin/main`).
2. **Confirm the live commits** in Render and Vercel, and set `BUILD_COMMIT` on the API.
3. Run `npm run prisma:status` read-only against production before deploying (migrations dated after 2026-10-10 may be pending).
4. **Rotate** the Cloudinary key that was committed in `.env.example`.
5. Fill in support contacts (Dashboard → Settings); production returns them empty.
6. Decide D1–D7.
7. Mobile:
   - `eas build -p android --profile production` → internal track → closed test (12 testers × 14 days).
   - Add reviewer credentials with a pre-approved device.
   - iOS after D4/D5 and Apple enrollment.
8. Delete `Desktop/edu-mobile-final/_claude-transfer/`.
