# Student Center — implementation report

> **[2026-10-29] Phase 3 is current: see `PHASE3_2026-10-29.md`.** It supersedes these statements below:
> - §P2b.4 "`npx prisma generate` … not run": the Windows-generated client was regenerated on Windows on 2026-10-28 at 19:57 UTC. It includes `failedAt` and matches the schema (checked 2026-10-29).
> - "whole-repo type-check not completed": now exit 0.
> - "23 of 150 files": the full suite now passes (153 suites, 1 skipped).
> - "migration revision not re-applied": all 21 migrations were replayed on a throwaway PostgreSQL 16. That is local evidence only, **not** Neon.
> - The patch baselines: none of the patches applies to `HEAD` or `origin/main`; see Phase 3 §5.
> - The earlier text is kept unchanged in `superseded-2026-10-29/`.

This report has three parts:
- **Phase 2b** (2026-10-28): remediation of defects found by the read-only verification.
- **Phase 2** (2026-10-27): implements the owner decisions D1–D7 and re-verifies everything.
- **Phase 1** (2026-10-26/27): the original audit and repair. It is kept below unchanged. Where they disagree, the later phase is current. Phase 2's 147/147 backend result was obtained on 2026-10-27, before the remediation; after the remediation only 23 of 150 files were re-run (§P2b.4).

**Nothing was pushed, merged, deployed, migrated, committed or submitted, and no branch was switched.** Every change is an uncommitted working-tree edit, made on top of your own uncommitted work and the 2026-10-27 release state. The Phase 2 patches are in `patches/phase2-*-owner-decisions.patch`.

Evidence labels:
- **[test]** a passing test or check run in this work
- **[code]** source inspection
- **[prod]** live production, read-only GET
- **[n/v]** not verified or blocked, with the reason given

---

# Phase 2b — remediation (2026-10-28)

The read-only verification on 2026-10-28 found defects in the Phase 2 work. This section records the fixes. It is authorised by the remediation brief of the same day. Nothing was committed, pushed, merged, deployed or migrated, no branch was switched, no stash was touched, and no file was deleted.

## P2b.1 Preservation

- Before any edit, the branch, HEAD, working tree and stash list of all four repositories were re-read.
- Every target file was compared byte-for-byte with its last known copy; all matched.
- New user work had appeared in the backend (student password administration; see `LOCAL_CHANGES_AND_DEPLOYMENT_RISK.md` §9.1). None of those files were edited. In particular, `auth.service.ts` was deliberately left alone, and the fixes were designed around it.
- After writing, every file was read back from your computer and its hash checked: 22/22 matched.

## P2b.2 Fixes

| # | Defect | Fix | Regression tests |
|---|---|---|---|
| 1 | Course archive → restore turned PENDING_APPROVAL requests into ACTIVE access (pre-existing, admin-only) | Archive records the pending ids in its archive record. Restore puts them, and any never-approved ADMIN_APPROVAL row, back to PENDING_APPROVAL before re-activating the rest. One residual case remains for legacy archives; a read-only SQL check is in `OWNER_DECISIONS.md` D3. | `course-archive-restore-states.spec.ts` |
| 2 | D5: after 10 failed erasures a request was stuck forever, with no signal and no recovery | `failedAt` column (same unapplied migration). Retries stop at 10, and the account stays blocked (never silently reactivated). Errors are sanitised to class and code. The `ACCOUNT_DELETION_NEEDS_ATTENTION` log marker is repeated each sweep. Admin-only, reasoned, audited list, retry and cancel are limited to failed requests. Erasure re-checks in its own transaction that the request is PROCESSING for exactly that user and that the user is a student. | `account-deletion.spec.ts` (new blocks) |
| 3 | D5: the wallet "forfeiture" was stated as policy | Mobile shows the balance (and repeats it in the confirmation), with the delete button disabled until it loads. All wording is neutral and makes no refund claim (app, `PRIVACY.md`, dashboard deletion page). The policy questions are listed in `OWNER_DECISIONS.md` D5. | mobile `account-deletion.test.ts`; dashboard `public-pages.spec.ts` |
| 4 | D6: Render hop count unverified; the default may share one bucket across anonymous mobile traffic | Attribution code unchanged (conservative: no client header can move a bucket). Added the MASTER-only read-only `GET /admin/diagnostics/client-ip` and a written verification procedure. | `client-ip-attribution.spec.ts` (real Express stack) |
| 5 | D5: the app said "can no longer be restored" for a late cancel | Server and app now say "can no longer be cancelled in the app, please contact support" | `account-deletion.spec.ts`, mobile login flow |

**D6 live behaviour: NOT verified.** No live request evidence from Render exists yet. The diagnostic endpoint has to be deployed first.

**Wallet policy: still requires owner approval.**

## P2b.3 Files changed (remediation only)

- **Backend (14):**
  - `prisma/schema.prisma`;
  - `prisma/migrations/20261027120000_account_deletion_requests/migration.sql` (revised in place; never applied);
  - `src/app.module.ts`;
  - `src/common/net/client-ip.ts`;
  - `src/modules/account-deletion/account-deletion.{controller,dto,module,service}.ts`;
  - `src/modules/courses/courses.admin.service.ts`;
  - new `src/modules/diagnostics/{client-ip-diagnostics.controller,diagnostics.module}.ts`;
  - `test/unit/account-deletion.spec.ts`;
  - new `test/unit/client-ip-attribution.spec.ts`;
  - new `test/unit/course-archive-restore-states.spec.ts`.
- **Dashboard (2):** `src/app/(public)/account-deletion/page.tsx`, `e2e/public-pages.spec.ts`.
- **Mobile (6):** `src/app/settings/delete-account.tsx`, `src/app/(auth)/login.tsx`, `src/i18n/locales/{en,ar}.json`, `PRIVACY.md`, `__tests__/account-deletion.test.ts`.
- **Web:** none.

## P2b.4 Verification

All commands ran in the Linux VM on your computer over the mounted folders, with exit codes as recorded. The VM restarted and disconnected several times during this phase, and the machine was slow (one `tsc` pass took 143 s). Nothing is counted as passing unless its run finished with a summary line.

| Check | Command (abridged) | Exit | Result |
|---|---|---|---|
| Prisma client for tests (outside the repo) | `prisma generate --no-engine --schema ~/pgen/schema.prisma` | 0 | client includes the new `failedAt` |
| `npx prisma generate` in `edu-backend` | — | **not run (deliberate)** | Your Windows-generated client (written 18:46 UTC, with the Windows engine) predates the `failedAt` column. Running generate from the Linux VM would need a Linux engine download (blocked) and could leave a client your Windows install cannot run. **Run `npx prisma generate` on Windows.** |
| Prisma schema | `prisma validate` | 0 (one earlier attempt: 124, timeout) | valid |
| Backend type-check | `tsc -p` over `src/**` plus 7 specs (including your new `student-password-administration.spec.ts`), generated client outside the repo | 0 | after two typing fixes in the new D6 test |
| Backend type-check, whole repo (adds `prisma/`, `scripts/` and all tests) | `tsc -p tsconfig-full-check.json` | 124, 124 | **not completed** (timeouts) |
| `course-archive-restore-states.spec.ts` | jest | 0 | 11/11 |
| `account-deletion.spec.ts` | jest | 1, then 0 | first run 47/48 (a stale message expectation, updated); rerun 48/48 |
| `client-ip-attribution.spec.ts` | jest | 0 | 19/19 |
| `web-proxy-client-ip`, `throttler-tracker`, `course-publish` | jest | 0 | 44/44 |
| `course-thumbnail`, `login-lockout`, your `student-password-administration` | jest | 0 | 77/77 |
| `env-validation`, `teacher-course-announcements`, `enrollment-admin-only-grants` | jest | 0 | 167/167 |
| Backend full unit suite (150 files) | batched jest | 0, 0, then device disconnect | **23 of 150 files completed today, 0 failures** (the 12 above plus 11 in two batches: 103/103 and 106/106). The remaining 127 were **not re-run** after the remediation. |
| Mobile type-check | `tsc --noEmit --incremental false` | 0 | clean |
| Mobile `__tests__/account-deletion.test.ts` | jest | 124, 124, then 0 | two start-up timeouts after the VM restart; the completed run passed 6/6 |
| Mobile `__tests__/i18n.test.ts`, `__tests__/errors.test.ts` | jest | 0 | 113/113 (en/ar key parity includes the new keys) |
| Dashboard type-check | `tsc --noEmit --incremental false` | 0 | clean |
| Web | — | — | no web files changed in the remediation; not re-run |
| Lint on changed files | eslint on the 12 changed backend files, the 2 dashboard files and the 3 changed mobile TS/TSX files (mobile with the import-resolver rules off, as in Phase 1) | 0, 0, 0 | clean. JSON and Markdown files are not linted. |
| Playwright, `next build`, backend integration suite, Android build | — | — | not runnable here (Windows-only binaries, no database or Android SDK) |
| `prisma migrate status` against production | — | — | **not run**: only the Windows schema engine is installed, and the VM cannot reach Neon |
| Migration revised (`failedAt`) on a database | — | — | **not re-run**. The original was applied to a throwaway PostgreSQL 16 on 2026-10-27; the one-column revision was not re-applied anywhere. |

**Run on Windows before merging:**

```
cd edu-backend   && npx prisma generate && npm run typecheck && npm test && npx prisma validate && npx prisma migrate status
cd edu-dashboard && npm run typecheck && npm run lint
cd edu-mobile-final\mobile-app-student && npm run typecheck && npm test
```

---

# Phase 2 — owner decisions D1–D7

> Written 2026-10-27. Where §P2b above corrects it (restore, stuck deletions, wallet wording, D6 hop count, verification status), §P2b is current. This Phase 2 text was **not** on your Desktop until 2026-10-28: it existed only in the Project and the zip.

## P2.1 Verdict

**Code-complete and verified for D1–D7, with documented limitations. Not deployed; not ready for store publication.**

- **Backend:**
  - all 147 unit spec files pass [test];
  - `tsc` is clean over `src/` and the new tests [test];
  - `prisma validate` passes [test];
  - the new migration applies cleanly after all earlier migrations on a local PostgreSQL 16 [test].
- **Web:** 377/377 tests [test]; `tsc` clean [test]; ESLint clean on changed files [test].
- **Dashboard:** `tsc` clean [test]; ESLint clean on changed files [test]. Playwright not runnable here [n/v].
- **Mobile:**
  - all 21 Jest files pass [test];
  - `tsc` clean [test];
  - ESLint clean on changed files, with the resolver-based `import/*` rules off (their native binding is Windows-only) [test].
- **Android:** a new AAB is required. It was not built: there is no Android SDK or EAS session here [n/v].
- **iOS:** postponed by D4. Blockers are listed in `OWNER_DECISIONS.md` D4.

## P2.2 What each decision changed

| # | Backend | Dashboard | Web | Mobile |
|---|---|---|---|---|
| D1 | Contract test only (`registration-contract-no-study-type.spec.ts`) | — | — | Contract test (`registration-no-study-type.test.ts`) |
| D2 | `POST /notifications/courses/:courseId/announcements` (StaffOnly, course-scoped, body = message only) | Course tab and notification centre use it; e2e spec and stub | — | — |
| D3 | `grant`/`extend` → `@AdminOnly` plus service-level `assertAdministrator` | none needed (no UI) | — | — |
| D4 | — | — | — | `EnrollSheet.tsx` removed after a reference check; no-checkout test; docs |
| D5 | `AccountDeletionModule` (request, cancel, hourly locked sweep, erase); login block; migration; error code | Public `/account-deletion` and `/privacy` rewritten (en and ar) | Error code typed and translated | Delete-account screen, login cancel flow, error code, locales, PRIVACY and DATA-SAFETY |
| D6 | `client-ip.ts` in the request middleware; throttler uses `req.ip` only; `TRUST_PROXY_HOPS`; `WEB_PROXY_SHARED_SECRET` | — | `client-ip-forwarding.ts` in `backendRequest`; `.env.example` | — |
| D7 | — | — | — | Build guard in `app.config.ts`; acknowledgement in `eas.json`; `StagingBanner`; `staging-guard.ts` |

Full detail per decision, including what is erased and kept on deletion and the manual hosting steps for D6, is in `OWNER_DECISIONS.md`.

## P2.3 New API surface

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/v1/notifications/courses/:courseId/announcements` | Staff; teacher must be assigned (`students` capability) | D2 course announcement to the course's ACTIVE students |
| `POST /api/v1/auth/account-deletion` | Student, password in body | D5 schedule deletion (30 days); signs out everywhere |
| `POST /api/v1/auth/account-deletion/cancel` | Public, phone and password | D5 cancel a pending deletion |
| `POST /api/v1/admin/enrollments/grant`, `POST /api/v1/admin/enrollments/:id/extend` | now **Admin** (was Staff) | D3 |
| New error `ACCOUNT_DELETION_PENDING` (403) | — | D5 sign-in refused while pending |

New request headers, server to server only: `X-Edu-Client-Ip` and `X-Edu-Proxy-Secret` (D6). The API strips both on arrival.

New environment variables:

| Variable | Where | Default | Notes |
|---|---|---|---|
| `WEB_PROXY_SHARED_SECRET` | API (Render) **and** student web (Vercel, server-side) | unset = off | At least 32 characters; never `NEXT_PUBLIC_*` |
| `TRUST_PROXY_HOPS` | API | 1 | Read only with `TRUST_PROXY=true` |
| `ACCOUNT_DELETION_SWEEP_INTERVAL_SECONDS` | API | 3600 | 0 disables the sweep on that process |
| `STAGING_USES_PRODUCTION_API` | EAS staging profile (build-time only) | `acknowledged` in `eas.json` | Not secret |

## P2.4 Migration (prepared, not applied)

- **Name:** `prisma/migrations/20261027120000_account_deletion_requests/migration.sql`, with LF line endings as `.gitattributes` requires.
- **Content:** additive only: an enum, a table, two indexes, the partial unique index `account_deletion_requests_one_pending_per_user`, and an FK `ON DELETE RESTRICT`. There is no backfill and no change to existing tables.
- **Order:** apply **before** deploying the API that contains D5. The login path tolerates the missing table (`P2021`) so a wrong order does not break sign-in, but deletion requests need the table.
- **Verified:** on a throwaway PostgreSQL 16.15 in the cloud workspace, all 22 migrations applied in order, and the constraints behaved as designed [test]. The output is in `OWNER_DECISIONS.md` D5.
- **Not verified:** `prisma migrate status` against production [n/v]. The schema engine binary is Windows-only on your machine and direct database TCP is blocked from the VM. Run it read-only on Windows: `npx prisma migrate status`.
- **Keep the partial index.** Prisma cannot express it. Generate future migrations with `--create-only` and delete any `DROP INDEX "account_deletion_requests_one_pending_per_user"` it proposes. This is the same rule as for the existing partial indexes.

## P2.5 Verification evidence

All commands ran on your computer's mounted folders through the Linux VM, against the installed `node_modules`, unless marked as run in the cloud workspace.

| Project | Check | Result |
|---|---|---|
| Backend | `tsc` over `src/**` plus the 6 new or changed specs, with a no-engine Prisma client generated from the **current** schema (outside the repo) | **exit 0** [test] |
| Backend | Jest, **all 147 `test/unit` spec files**, run in batches with a transpile-only config outside the repo | **147/147 files pass** [test]. One regression found and fixed: `login-lockout.spec.ts` lacked the new delegate in its Prisma double. |
| Backend | `prisma validate` | **valid** [test] |
| Backend | `prisma format --check` | reports unformatted, **as it does on `HEAD`** (pre-existing) |
| Backend | Migrations on a local PostgreSQL 16.15 (cloud workspace) | **22/22 applied**; constraint checks pass [test] |
| Backend | `tools/offline-verify/verify.sh logic` (official harness), run on a copy outside the repo | access matrix 110/110, media origin 29/29, device headers 16/16, shape contract OK [test]. The harness stub gained `Optional`, which the middleware now uses. |
| Backend | `test/integration/*.e2e-spec.ts` | **not run** [n/v]: they need the project's Postgres and Redis (`scripts/dev-infra.sh`) |
| Backend | ESLint on 19 changed files | 1 error, **pre-existing on `HEAD`** (`CourseStatus` unused import in `enrollments.service.ts`) |
| Web | `node --test` (all) | **377/377** [test] |
| Web | `tsc --noEmit` | **exit 0** [test] |
| Web | ESLint on changed files | **exit 0** [test]. A full `eslint .` timed out in the VM. |
| Web | `next build` | **not runnable** (Windows-only SWC binaries) [n/v] |
| Dashboard | `tsc --noEmit` | **exit 0** [test] |
| Dashboard | ESLint on changed files | **exit 0** (after one fix) [test] |
| Dashboard | Playwright (`teacher-notifications`, `public-pages`) | **not runnable** (needs a native Next server) [n/v] |
| Mobile | `tsc --noEmit` | **exit 0** [test] |
| Mobile | Jest, **all 21 files** (including 5 new) | **all pass** [test] |
| Mobile | ESLint on 15 changed files | **exit 0**, with resolver-based `import/*` rules off (their native binding is Windows-only) [test] |
| Mobile | Android build | **not built** [n/v]: no Android SDK, no Gradle network, no EAS login |

Run on Windows before merging (fast and native):

```
cd edu-backend   && npx prisma generate && npm run typecheck && npm test && npx prisma validate && npx prisma migrate status
cd edu-web\student-web && npm run verify
cd edu-dashboard && npm run verify && npm test
cd edu-mobile-final\mobile-app-student && npm run typecheck && npm run lint && npm test
```

`npx prisma generate` comes first because the Desktop `node_modules` holds only Prisma's stub client after your last `npm ci`. Without it, tests that touch Prisma enums fail with "Cannot read properties of undefined".

## P2.6 Files changed in Phase 2 (all uncommitted)

- **Backend** (29 files, +1969/−29):
  - new module `src/modules/account-deletion/` (5 files);
  - `src/common/net/client-ip.ts`;
  - migration `20261027120000_account_deletion_requests`;
  - edits to `auth.service.ts`, `notifications.controller.ts`, `enrollments.{controller,service}.ts`, `request-context.middleware.ts`, `throttler-proxy.guard.ts`, `request-context.ts`, `configuration.ts`, `env.validation.ts`, `main.ts`, `app.module.ts`, `error-codes.ts`, `schema.prisma`, `.env.example` and the offline-harness stub;
  - tests: 5 new, 2 updated.
- **Dashboard** (7 files, +226/−60): `features/courses/hooks.ts`, `features/notifications/notification-centre.tsx`, `app/(public)/{account-deletion,privacy}/page.tsx`, `e2e/stub-api/server.mjs`, `e2e/teacher-notifications.spec.ts` (new), `e2e/public-pages.spec.ts`.
- **Web** (6 files, +189/−1): `src/lib/client-ip-forwarding.ts` and its test (new), `src/lib/session.ts`, `src/i18n/dictionaries.ts`, `src/types/api.ts`, `.env.example`.
- **Mobile** (25 files, +685/−306, of which −233 is the removed `EnrollSheet.tsx`):
  - new: `config/staging-guard.ts`, `components/feedback/StagingBanner.tsx` and 4 tests;
  - edits: `app.config.ts`, `eas.json`, `config/env.ts`, `app/_layout.tsx`, `app/(auth)/login.tsx`, `app/settings/delete-account.tsx`, `features/auth/api.ts`, `api/{endpoints,errors}.ts`, `types/api.ts`, both locales, 2 tests, and the `PRIVACY`, `DATA-SAFETY`, `GOOGLE_PLAY` and `MANUAL_STEPS` docs.

**Preservation.**
- Every write was preceded by a hash check of the target on your computer against the copy it was derived from, and followed by a hash check of the result. All matched [test].
- One write was delivered stale by the transfer tool, caught by that check and re-sent.
- `EnrollSheet.tsx` was the only deletion. It was identical to `HEAD` apart from line endings.
- A stale `edu-backend/.git/index.lock` left by an earlier read-only `git diff` was moved aside to `.git/stale-index-lock-from-claude-1793097807` rather than deleted. You can delete it.

## P2.7 Deployment order (when you choose to deploy)

1. Commit each project on a branch and review `patches/phase2-*.patch`.
2. Backend:
   1. `npx prisma migrate status` (read-only);
   2. `npx prisma migrate deploy` from the release job;
   3. deploy the API;
   4. confirm the hourly sweep log line, "Account deletion sweep scheduled in-process every 3600s".
3. D6:
   1. set `WEB_PROXY_SHARED_SECRET` on Render, then on Vercel (student web, server-side, Sensitive);
   2. redeploy the API, then the web.
4. Dashboard: deploy (D2 UI and the new public deletion and privacy text). **Not before step 2**, or the public page describes a flow production does not have.
5. Mobile: `eas build -p android --profile production` → internal track → closed test. The staging profile builds only with its acknowledgement and shows the production-data badge.
6. Google Play Data safety: deletion is in-app; the web URL is `/account-deletion` on the dashboard.

## P2.8 Open items after Phase 2

| Item | Next action |
|---|---|
| `TRUST_PROXY_HOPS` for Render unknown | Confirm with Render support or a controlled check; keep 1 until then |
| Dashboard does not forward browser IPs (D6 covered the student web) | Optional: reuse `client-ip-forwarding.ts` in the dashboard's server calls |
| No admin indicator for a pending deletion | Optional dashboard follow-up |
| Wallet credit forfeited on deletion | Confirm the policy legally |
| iOS (D4) | Blockers listed in `OWNER_DECISIONS.md` |
| Playwright, `next build`, the Android build and the backend integration suite | Run on Windows (§P2.5) |

---

# Phase 1 — audit and repair (kept as written)

Dates: 2026-10-26 → 2026-10-27. Scope: `edu-backend`, `edu-dashboard`, `edu-web/student-web` and `edu-mobile-final/mobile-app-student`, on your Desktop.

**Nothing was pushed, merged, deployed, migrated, committed or submitted.** All changes are uncommitted working-tree edits, made on top of your existing uncommitted work. An audit-only patch per project is in `patches/`.

Evidence labels used below:
- **[test]** verified by a passing test or check
- **[prod]** verified against live production (read-only GET)
- **[code]** source inspection only
- **[n/v]** not verified

### 1. Overall verdict

**Ready with documented limitations for a controlled backend + web + dashboard release; not ready for store publication.**

- **Backend, web and dashboard:** the fixes are small, tested and backward-compatible. Before deploying, (a) confirm the live commits (§2), (b) merge the work in the order given in `LOCAL_CHANGES_AND_DEPLOYMENT_RISK.md`, and (c) run the full backend test suite on Windows (only 66/140 files could be re-run here).
- **Mobile:** a new build is required. The only AAB predates everything here. Android can go to closed testing after decision D1. iOS needs decisions D4/D5 and a real-device FairPlay test.

### 2. Production baseline

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

### 3. Project status

| Project | Before | After the audit |
|---|---|---|
| Backend | One critical entitlement bug, several high-severity playback and throttling bypasses, contract gaps | Fixed (§4). `tsc` clean [test]; 66 of 140 unit files executed, 0 failures [test] |
| Dashboard | Four broken admin flows (sort, tabs, deleted-course cache, sign-out), teacher switches always off, shared-video delete 409 | Fixed (§4). `tsc` clean; ESLint clean on changed files [test]. Playwright e2e not run (needs a Linux Next build) [n/v] |
| Student web | **Build broken** (undeclared dependency); session logouts (4 defects); wrong year filter; hidden pending enrolments | Fixed (§4). **369/369** `node --test` [test]; `tsc` clean; ESLint clean on changed files |
| Mobile | iOS playback broken; terminate ignored; avatar 422; missing error code; OTA could ship a localhost API | Fixed in code (§4). `tsc` clean [test]; Jest partly run (§5) |

### 4. Defects fixed (root cause → fix)

#### Backend

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

#### Student web

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

#### Dashboard

| ID | Root cause → fix | Files |
|---|---|---|
| D-1 | `sort=createdAt` is not in the API vocabulary → mapped to `newest`/`oldest` (works against the current production API) | `features/courses/hooks.ts` |
| D-2 | Deleting a course invalidated `['courses','list',undefined]`, which matches nothing → prefix `['courses','list']` | `features/courses/hooks.ts` |
| D-3 | Tab switches carried `sort`/`order` into other tabs → 422 → cleared on tab change | `components/ui/tabs.tsx` |
| D-4 | Shared-video delete without `lessonId` → 409 → applied your commit `56ed65c` verbatim | `features/videos/hooks.ts`, `lesson-video-panel.tsx` |
| D-5 | Sign-out with an expired token did not revoke the session → refresh once and revoke | `lib/session.ts` |
| D-6 | Teacher switches always off → backend B9 | — |

Evidence: [test] `tsc --noEmit` clean and ESLint clean on the 5 files.

#### Mobile

| ID | Root cause → fix | Files | Evidence |
|---|---|---|---|
| M1 | FairPlay HLS typed `dash` → `hls` | `ProtectedVideoPlayer.tsx`, its test | [test] `player-source-drm.test.ts` |
| M2 | Rotation timer's `finally(setPhase('ready'))` overwrote a termination → only `refreshing` → `ready` | `usePlaybackTicket.ts` | [test] tsc |
| M3 | Terminate reasons all became `PLAYBACK_DENIED` → reissuable reasons go to `expired` (re-issue UI) | `usePlaybackTicket.ts` | [test] tsc |
| M4 | The native player was not paused when the grant ended → paused | `ProtectedVideoPlayer.tsx` | [test] tsc |
| M5 | Avatar `sizeBytes: 0` → 422 → use the blob size | `features/profile/avatar.ts` | [test] tsc |
| M6 | `COURSE_NOT_TARGETED` unknown → added code and en/ar text | `api/errors.ts`, `types/api.ts`, locales | [test] `errors.test.ts` 106/106 |
| M7 | An OTA update without the production env would point apps at `http://10.0.2.2:3000` → release bundles refuse non-https or local API URLs at startup | `config/env.ts`, `__tests__/release-api-url.test.ts` | logic 9/9 [test]; the Jest file did not finish here |

### 5. Test and build evidence

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

### 6. Files changed by the audit (all uncommitted)

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

### 7. Unresolved: issue, reason, next action

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

### 8. Manual actions that need you

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
