# Owner decisions — resolved

The owner decided D1–D7 on 2026-10-27, and every decision is final. This file records each decision, what was built for it, the evidence, and what remains. Nothing was committed, pushed, merged, deployed, migrated or submitted.

**Revised 2026-10-28 (Phase 2 remediation).** A read-only verification found four problems in the first Phase 2 write-up and code; they are corrected below and marked **[2026-10-28]**:
- D3: course restore could approve pending requests (fixed);
- D5: a deletion that failed 10 times stayed stuck with no way out (fixed);
- D5: the wallet "forfeiture" policy was stated as settled (withdrawn; now an open owner question);
- D6: the Render proxy hop count is unverified, and the default may lump direct mobile traffic together (diagnostic added; still unverified).

The original Phase 1 version of this file (with the alternatives and recommendations behind each decision) is kept unchanged at `phase1-original/OWNER_DECISIONS.md`.

Evidence labels:
- **[test]** verified by a passing test or check run during this work
- **[code]** verified by source inspection
- **[prod]** verified against live production with a read-only GET
- **[n/v]** not verified or blocked, with the reason given

| # | Decision | Status |
|---|---|---|
| D1 | Keep the local academic-selection registration; students never choose a study type | **Resolved, implemented** |
| D2 | Teachers may notify the ACTIVE students of their OWN courses only | **Resolved, implemented** |
| D3 | Granting free access and extending access are admin-only | **Resolved, implemented** |
| D4 | Android first; iOS postponed; no StoreKit; no price hiding | **Resolved, implemented** (iOS blockers documented) |
| D5 | In-app account deletion with a 30-day cancellation period | **Resolved, implemented** (migration prepared, not applied to production) |
| D6 | A web-to-API shared secret carries the browser IP | **Implemented; live proxy behaviour NOT verified** (owner must set the secret on both hosts and confirm the Render hop count first) |
| D7 | No staging backend exists; staging uses production, with guardrails | **Resolved, implemented** |

---

## D1. Registration has no student-chosen study type

**Decision.** Keep the local `/catalog/academic-selection` registration. Students never pick GENERAL or PROGRAMS. `studyType` stays an optional legacy field on the API for older builds. Do not merge the upstream required `studyType`.

**State.**
- Mobile (local, uncommitted work, kept as is):
  - `RegisterPayload` is `fullName, phone, password, universityId, facultyId, departmentId, academicYearId, gender`. [code]
  - `register.tsx` uses `useAcademicSelectionOptions`. [code]
- Backend:
  - `RegisterDto.studyType` is optional. [code]
  - `users.service.assertAcademicSelectionIsCoherent` re-checks university → faculty → department → the department's academic-structure rung, and cross-checks `studyType` only when one is sent. [code]

**Tests added.**
- `edu-backend/test/unit/registration-contract-no-study-type.spec.ts` [test, PASS]:
  - the exact mobile payload passes the API's own `ValidationPipe` options;
  - a legacy `studyType: 'PROGRAMS'` is still accepted;
  - an invalid study type is rejected;
  - each academic id is required;
  - a client-declared `academicSystem` is rejected.
- `mobile-app-student/__tests__/registration-no-study-type.test.ts` [test, PASS]:
  - neither registration schema has `studyType`;
  - a complete academic step parses without it.
  - This is the test that fails if the upstream commits (`c30964d`, `2d6a890`, `d31f51e`) are merged unchanged.

**Remaining.**
- When you pull mobile `origin/main`, resolve the conflict in favour of the local files: `register.tsx`, `features/auth/{api,hooks,schemas}.ts`, the locales and `tsconfig.json`.
- Run the two tests above after the merge.

## D2. Teacher notifications to their own course

**Decision.**
- Teachers may notify the ACTIVE students of courses they are assigned to.
- The audience is derived on the server; no arbitrary recipients.
- Admin broadcasts and direct messages stay admin-only.

**Backend.** New `POST /api/v1/notifications/courses/:courseId/announcements`:
- `@StaffOnly()`, audited as `course_announcement`.
- First calls `courseAccess.assertCourseExistsAndManageable(actor, courseId, 'students')`: an unassigned teacher gets 403 `NOT_COURSE_TEACHER`; an admin passes.
- The body is `CourseAnnouncementDto` (`title`, `titleAr?`, `body`, `bodyAr?`, `sendPush?`). Under the global `whitelist + forbidNonWhitelisted` pipe, any `userId`, `universityId`, `academicYearId`, `courseId`, `route` or `audience` field is a 422.
- The server sets `courseId`, `route: /course/<id>` and `publishNow`, then calls the existing `AnnouncementsService.createLegacy`.
  - Its audience compiles to active, non-deleted STUDENT accounts with an ACTIVE enrollment in that course. [test]
- `POST /notifications/announcements` (broadcasts and `userId` messages) is unchanged and `@AdminOnly()`. [test]

**Dashboard.**
- The course "Notifications" tab (`useCourseAnnouncement`) and the notification centre's COURSES branch now post to the course route.
- The centre's broadcast options are unchanged (admin-only server-side).

**Tests.**
- `test/unit/teacher-course-announcements.spec.ts`, 13 cases [test, PASS]:
  - assigned teacher allowed;
  - unassigned teacher refused;
  - admin allowed;
  - six audience-widening fields rejected;
  - audience compiles to ACTIVE students;
  - route roles.
- Dashboard Playwright `e2e/teacher-notifications.spec.ts` (3 cases), plus the matching stub handler. **[n/v]**: it needs a native Next.js dev server, which cannot run in the Linux VM; run `npm test` on Windows.

## D3. Free access and extensions are admin-only

**Decision.** Granting free access, including approving a pending request through the grant path, and extending an access window are administration-only, on every path.

**Backend.**
- `EnrollmentsController.grant` and `.extend` changed from `@StaffOnly()` to `@AdminOnly()`.
- `EnrollmentsService.grantByAdmin` and `.extend` also call the new `assertAdministrator(role, action)` before any database read. A future caller that bypasses the route still gets 403 `INSUFFICIENT_ROLE`.
- Unchanged:
  - list and reject stay staff (scoped by the course check);
  - revoke and code generation were already admin-only.
- **[2026-10-28] Correction: course restore could approve pending requests.** The earlier text said restore only "restores existing access". That was wrong.
  - **Defect (pre-existing, admin-only):** archiving moves both ACTIVE and PENDING_APPROVAL enrollments to ARCHIVED, and restore turned every ARCHIVED row with a live window into ACTIVE. An unapproved request therefore became full access after archive → restore.
  - **Fix (`courses.admin.service.ts`):**
    - archive now records the ids of PENDING_APPROVAL rows in the archive record's snapshot (not in the audit row or the API response);
    - restore puts those rows back to PENDING_APPROVAL before anything else.
    - For courses archived **before** the fix (no recorded ids), restore also returns to PENDING_APPROVAL every row with method ADMIN_APPROVAL and no approval stamp. Every real admin grant stamps `approvedAt`, so no approved student is affected.
    - Previously active students come back ACTIVE (live window) or EXPIRED (lapsed), as before.
  - **Known residual (legacy archives only):** a student who was approved once, lost access and re-requested keeps the old `approvedAt`. In an archive made before the fix, such a row is indistinguishable from an approved one and still comes back ACTIVE. A read-only check for production (lists archived courses holding such rows):
    ```sql
    SELECT e."courseId", COUNT(*) AS ambiguous_rows
    FROM enrollments e JOIN courses c ON c.id = e."courseId"
    WHERE c.status = 'ARCHIVED' AND e.state = 'ARCHIVED'
      AND e.method = 'ADMIN_APPROVAL' AND e."approvedAt" IS NOT NULL
    GROUP BY e."courseId";
    ```
    Before restoring any such course, review those rows by hand.
  - **[2026-10-29] This query is a superset.** It also returns every genuinely approved student, and courses archived after the fix. Use `sql/d3-candidate-report.sql` instead: it restricts to legacy archives and classifies each row from the audit log. Remediation is `sql/d3-remediation-template.sql`, which writes production data and so needs authorisation. Both were tested on a throwaway database (`PHASE3_2026-10-29.md` §6.1).
  - **Tests:** `test/unit/course-archive-restore-states.spec.ts` runs archive → restore with the real service against an in-memory table covering ACTIVE (lifetime, live window, lapsed, admin-granted), PENDING_APPROVAL (fresh and re-request), PENDING_PAYMENT, EXPIRED and REVOKED, plus repeated cycles, legacy archives, the residual case (pinned), role checks, and that the ids stay out of audit and response.

**Dashboard.** It has no grant or extend UI [code], so nothing needed hiding.

**Tests.** `test/unit/enrollment-admin-only-grants.spec.ts` [test, PASS]:
- A teacher whose assignment carries the student capability (the stub's capability check would pass) gets `INSUFFICIENT_ROLE` on both operations, with no reads or writes.
- ADMIN and MASTER still work.
- Route metadata is checked.

## D4. Android first; iOS postponed

**Decision.**
- Android ships first and iOS is postponed.
- No StoreKit and no price hiding.
- Remove the dead `EnrollSheet.tsx` only after verifying it has no references.
- Document the iOS blockers.

**Done.**
- **`EnrollSheet.tsx` was verified unreferenced, then removed.** No import in `src/`, `app.config.ts` or `__tests__/` [code]; only the wallet-scope test listed it by path, and docs mentioned it.
  - The deleted working copy was byte-identical to the committed `HEAD` blob apart from CRLF line endings, so no uncommitted work was lost.
  - Restore with `git checkout -- src/features/enrollment/EnrollSheet.tsx` if ever needed.
- With it gone, the app has **no screen that opens a payment checkout URL**.
  - `__tests__/no-external-checkout.test.ts` keeps it that way [test, PASS].
  - `wallet-scope.test.ts` now checks `JoinSheet.tsx` instead [test, PASS].
- `release/GOOGLE_PLAY.md` §7 and `docs/MANUAL_STEPS.md` §17 were updated.

**iOS blockers (all postponed with iOS).**
1. App Store guideline 3.1.1: paid digital content is unlocked by codes or cards bought outside the app, there is no IAP, and prices are shown. Under D4 neither StoreKit nor price hiding will be added, so an iOS submission is expected to be rejected until a commercial model for iOS is chosen.
2. Apple Developer Program enrollment is not verified (`release/APPLE.md`).
3. A real-device FairPlay playback test is needed after the backend deploy (ticket rotation now keeps FairPlay; phase 1, B3).
4. App Store Connect setup: app record, APNs key, privacy nutrition labels, iPad screenshots (`supportsTablet: true`), and reviewer accounts with pre-approved devices.
5. `eas.json` `submit.production.ios` is empty: `ascAppId` and `appleTeamId` are missing.
6. Account deletion (guideline 5.1.1(v)) is no longer a blocker: D5 is in-app.

## D5. In-app account deletion, 30-day cancellation

**Decision.**
- In-app deletion with a 30-day cancellation period.
- Backend request and cancel API, and a reliable scheduled deletion (no in-memory timer).
- Use is blocked while pending, but cancellation is not.
- Personal data is anonymised; financial and audit records are retained.
- Sessions, push tokens, devices, media and jobs are handled.
- Races and duplicates are prevented.

**State machine** (`account_deletion_requests`, new migration `20261027120000_account_deletion_requests`):

```
request ─► PENDING (scheduledFor = now + 30 d) ─► cancel ─► CANCELLED
                                                └► sweep claims ─► PROCESSING ─► erase ─► COMPLETED
                                                                              └► failure ─► PENDING (+attempts, lastError)
```

**API.**

| Route | Who | Behaviour |
|---|---|---|
| `POST /api/v1/auth/account-deletion` `{ password }` | signed-in **student** (`@StudentOnly`), credential throttle | Re-checks the password and creates the PENDING request. In the same transaction it revokes every session, refresh token, live playback ticket and push token, and writes an audit row. Idempotent: an open request is returned with its **original** date. A concurrent duplicate loses on the partial unique index, and the winner is returned. Staff accounts are refused (`INSUFFICIENT_ROLE`); admins delete staff through `DELETE /admin/users/:id`. |
| `POST /api/v1/auth/account-deletion/cancel` `{ phone, password }` | `@Public`, credential throttle (keyed by phone) | Uses `AuthService.verifyCredentials`, which is the sign-in check (same lockout, timing equalisation and failed-attempt accounting). Cancels only a PENDING request whose date has not passed, with a conditional update; otherwise 409 `INVALID_STATE`. Audited. |
| `POST /api/v1/auth/login` | everyone | After the password and status checks, a PENDING or PROCESSING request → 403 `ACCOUNT_DELETION_PENDING`. Production withholds `details`, so clients show the code's own message, and the mobile login screen offers "Cancel deletion and sign in". If the table does not exist yet (`P2021`, API deployed before the migration), sign-in proceeds normally. |

**Scheduler.** `AccountDeletionScheduler` runs the sweep on the API process:
- hourly (`ACCOUNT_DELETION_SWEEP_INTERVAL_SECONDS`; 0 disables it; minimum 300);
- first run about 2 minutes after boot;
- under the Redis lock `account-deletion-sweep` (30 min);
- same pattern as the DRM sweep.

Why it is reliable:
- **Nothing lives in memory.** Each run re-reads due rows from Postgres, so a restart or a missed run only delays erasure.
- The worker on your PC was not used, because it is not always running.
- Every transition is a conditional `updateMany`, so a second sweeper or a racing cancel cannot double-process a request.
- A PROCESSING row left by a crashed sweep is picked up again. Erasure is one transaction and idempotent.
- **[2026-10-28] Repeated failures (corrected).** Previously, after 10 failed attempts the sweep silently stopped: the account stayed blocked from sign-in, could not be cancelled (its 30 days were over), was not erased, and nobody was told. Now:
  - after the 10th failure the request gets `failedAt` (new nullable column in the same, still unapplied, migration) and the sweep stops retrying it;
  - the account stays blocked from sign-in. It is still a pending deletion and is **never reactivated automatically**. Nothing was erased, because every attempt is one transaction that rolled back;
  - every failure is logged with the request id, the attempt number and the error class/code only (for example `Error:P2034`). `lastError` stores the same. Error messages are never stored or logged, because they can echo data;
  - the final failure, and every later sweep while any request is waiting, logs `ACCOUNT_DELETION_NEEDS_ATTENTION`. Point a log alert at that string;
  - **admin recovery** (MASTER/ADMIN only, a written reason of at least 10 characters, audited with the reason). It works only for a request that has `failedAt`; a normal pending deletion cannot be touched:
    - `GET /api/v1/admin/account-deletions/attention`: id, userId, status, timings, attempts, error class. No name, phone or email;
    - `POST /api/v1/admin/account-deletions/:id/retry` `{reason}`: clears `failedAt`, resets attempts, and the next sweep erases;
    - `POST /api/v1/admin/account-deletions/:id/cancel` `{reason}`: at the holder's confirmed request; status CANCELLED, after which the holder signs in normally;
  - in-app cancellation keeps the documented 30-day window. After it (or while erasing), the app now says "can no longer be cancelled in the app, please contact support" instead of "can no longer be restored";
  - erasure re-reads its request **inside** the transaction. It refuses unless the request is PROCESSING for exactly that user id and the account is a STUDENT, so a stale or mismatched call can never erase another account.
  - There is no dashboard screen for recovery yet; the routes are API-only.
  - **Tests:** `account-deletion.spec.ts` covers ten consecutive failures (stop, mark, alert, nothing erased, no personal data in logs), no automatic retry afterwards, normal retries below the limit, in-app cancel refused after the window, admin retry and cancel (audited, reasoned), refusal for normal pending requests, the PII-free list, role and DTO checks, the wrong-account and non-student guards, and error sanitising.

**What the erase does** (one transaction, then best-effort storage and cache cleanup):

| Data | Action |
|---|---|
| User | `fullName` → "Deleted user", `phone` → `deleted:<userId>` (frees the number), `email`, `avatarUrl` and `gender` → null, an unusable password hash, `DISABLED`, `deletedAt` set |
| Student profile | `studentNumber` and `notes` → null (academic selection kept) |
| Sessions, refresh tokens, playback tickets, push tokens | revoked or deactivated; IP and user-agent nulled on sessions and tickets |
| Devices | per row: key → `deleted:<deviceId>`, name, model, OS and app version cleared, `REVOKED` |
| Device-change requests, push tokens, notifications, notification preferences | deleted |
| Security events | IP, user agent, device key and metadata nulled |
| Code redemptions | IP and device key nulled (amounts kept) |
| Support | the ticket subject and the bodies of messages the student wrote → "[removed at the account holder's request]" |
| Avatar files | `media/avatars/<userId>/` deleted (best effort, outside the transaction) |
| Redis | `pb:slots:<userId>` cleared |
| **Kept** | enrollments, payments, wallet and ledger, redemptions, purchases, revenue rows, part and library entitlements, watch progress and events, audit log (pseudonymous; audit rows may hold the IP of an audited action) |

**Policy notes for you.**
- **[2026-10-28] Wallet balance: the policy is NOT decided (the earlier "forfeited" wording is withdrawn).**
  - **What the code does (verified by source inspection).** The erase never touches the wallet, its balance or the ledger, so they stay as financial records. During the 30 days the balance is frozen in practice: the holder cannot sign in. After erasure:
    - admin wallet lists (`WalletService.listWallets`) filter `deletedAt: null`, so the balance disappears from them while the rows remain;
    - `WalletService.adjust` refuses a deleted user, so no admin adjustment or refund is possible through the app;
    - there is no aggregate "total wallet liability" figure anywhere in the code.
  - **What the app says now.**
    - Mobile shows the current balance before the final step, repeats it in the confirmation, and keeps the delete button disabled until the balance has loaded.
    - Mobile, `PRIVACY.md` and the dashboard deletion page say only facts: the balance stays on record, cannot be used while pending or afterwards, and the holder should contact support first. They neither promise nor rule out a refund.
  - **Recommended technically safe approach (needs your approval before any build).** Settle balances **during** the 30-day window, while `adjust` still works: refund outside the app if your policy says so, then record an audited debit with the reason. Never delete or rewrite ledger rows. Optionally, report outstanding balances of erased accounts as a separate liability line.
  - **Questions for you (legal / accounting):**
    1. Is unused prepaid credit refundable under your terms and applicable consumer law?
    2. Should a positive balance block deletion until settled, or only be disclosed?
    3. How should erased accounts' balances appear in your books (liability, breakage income, after how long)?
    4. Does the answer differ for credit bought with cash cards versus admin top-ups?
- Inbox notifications from broadcasts can still be created for a pending account (status stays ACTIVE), but push is off and the student cannot sign in to see them. They are deleted at erasure.
- Admin views show a pending account as active. There is no dashboard indicator yet (optional follow-up).

**Clients.**
- **Mobile:**
  - Settings → Delete account: consequences, "What we keep", password, confirm. The result shows the scheduled date and signs the device out.
  - Login: `ACCOUNT_DELETION_PENDING` shows a "Cancel deletion and sign in" button (cancel, then the normal sign-in).
  - New error code in `ApiErrorCode` and `KNOWN_CODES`; en and ar strings.
  - `PRIVACY.md` and `DATA-SAFETY.md` updated.
- **Web:** the error code is typed and translated ("cancel in the app").
- **Dashboard public pages:** `/account-deletion` and `/privacy` (en and ar) describe the new flow and retention exactly as the code does it.
  - **Publish them only with or after the backend release**: before that, production still has the ticket flow.

**Migration.** Additive only: a new enum and table, two indexes, a partial unique index (one PENDING per user) and an `ON DELETE RESTRICT` foreign key.
- **Not applied to production.**
- Applied in order with all 21 earlier migrations on a throwaway local **PostgreSQL 16.15** in the cloud workspace [test]. There:
  - a second PENDING request is rejected by the unique index;
  - a new request after a cancel is accepted;
  - a hard delete of the user is refused;
  - a sweep claim on a not-yet-due row updates 0 rows.
- Production is Neon Postgres 18 per the earlier baseline. PostgreSQL 16 accepted the same SQL.

**Tests.**
- `test/unit/account-deletion.spec.ts`, 30 cases [test, PASS]: request, idempotency, race, staff refusal, cancel and its race, the sweep claim, skip, crash recovery, failure revert, what is erased and kept, login blocking, route roles, DTO, scheduler lock, interval, and the migration's constraints.
- `test/unit/login-lockout.spec.ts`: its double gained the new delegate [test, PASS].
- `mobile-app-student/__tests__/account-deletion.test.ts` [test, PASS].
- `prisma validate`: valid [test].

## D6. Web-to-API shared secret for the client IP

**Decision.**
- The student web server forwards the browser IP with a shared secret.
- Server-only env vars; never `NEXT_PUBLIC_*`.
- The forwarded IP is trusted only with a valid secret; `X-Forwarded-For` is never trusted blindly.
- Keep per-phone limits for credentials and per-user limits for authenticated traffic.
- Direct API traffic stays protected.

**Backend.**
- New `src/common/net/client-ip.ts`, applied first in `RequestContextMiddleware`, so every `req.ip` reader agrees: throttler, sessions, security events, audit.
  - When `X-Edu-Proxy-Secret` matches `WEB_PROXY_SHARED_SECRET` (constant-time SHA-256 comparison; at least 32 characters), `req.ip` becomes the single, syntactically valid address in `X-Edu-Client-Ip`.
  - Otherwise both headers are ignored and `req.ip` is Express's own.
  - Both headers are **stripped** from the request in every case. The secret is never logged or echoed.
- `ThrottlerProxyGuard` no longer reads `X-Forwarded-For`. The tracker order is: user id, else submitted phone, else `req.ip`.
- New `TRUST_PROXY_HOPS` (default 1, was hard-coded) for Express `trust proxy`.
- `WEB_PROXY_SHARED_SECRET` is optional. A value under 32 characters stops the API at boot.

**Web.**
- New `src/lib/client-ip-forwarding.ts`, used by `backendRequest` (the one server-side call path: proxy, login, register, logout, refresh).
  - It reads the browser address from `x-vercel-forwarded-for`, else `x-real-ip`. Vercel overwrites both with the real client IP [Vercel docs].
  - It never uses `X-Forwarded-For`, and never forwards a browser-sent `x-edu-*` header.
  - It sends nothing unless `WEB_PROXY_SHARED_SECRET` (server env) is set.
- A test asserts that no `NEXT_PUBLIC_*SECRET` exists and that no `'use client'` module reads the secret.

**Tests.**
- `test/unit/web-proxy-client-ip.spec.ts`, 23 cases [test, PASS].
- `throttler-tracker.spec.ts`, updated [test, PASS].
- `env-validation.spec.ts` (147, including "every `process.env` name is declared") [test, PASS].
- Web `client-ip-forwarding.test.ts`, 8 cases [test, PASS].
- Offline harness `run-device-headers`, 16/16 [test].

**Manual hosting steps (you).**
1. Generate one value: `openssl rand -base64 48`.
2. Render (API) → Environment: add `WEB_PROXY_SHARED_SECRET=<value>`.
3. Vercel (student web) → Settings → Environment Variables:
   - add `WEB_PROXY_SHARED_SECRET=<value>` for Production (and Preview if previews call production);
   - type **Sensitive**;
   - never prefix it `NEXT_PUBLIC_`.
4. Deploy the API first, then the web. Until both are set, behaviour is exactly as before (no forwarding).
5. **[2026-10-28] `TRUST_PROXY_HOPS` on Render is NOT verified, and the default may be wrong.**
   - **Evidence so far is contradictory and not authoritative** (none of it is live evidence from this API):
     - a Render community post says Render appends its proxy address, with the client second-to-last;
     - Render staff on its feedback board say the first entry is the real client;
     - another thread reports `trust proxy 3` worked.
   - **Consequence if the real count is greater than 1 and the default stays 1:** every anonymous **direct** (mobile) request is attributed to a Render proxy address, so all anonymous mobile traffic shares one 120-requests-per-minute bucket. That covers the registration catalogue lists and `meta/app-config`. It is an availability risk at peak, not an evasion risk.
   - **Not affected either way:** sign-in (per phone), signed-in traffic (per user), and web traffic carrying the secret.
   - **Too many hops** would let a client choose its own address, so do not raise the count without evidence.
   - **The code was left as is**, which is the conservative choice: no client-written header can change a bucket [test].
   - **How to verify (new):** `GET /api/v1/admin/diagnostics/client-ip` (MASTER only, read-only) shows how the platform delivered the **caller's own** request:
     - `X-Forwarded-For` entries, the socket address, and what `req.ip` would be for hop counts 1–5 (checked against real Express [test]);
     - the values of `x-real-ip`, `true-client-ip`, `cf-connecting-ip`, `x-client-ip` and `fly-client-ip`.
     - It never shows the proxy secret, which is stripped before any handler runs, or the authorization header.
   - **After deploying the API, from a network whose public address you know** (for example from https://api.ipify.org):
     1. call the endpoint directly against the Render URL with a MASTER token, once plainly and once with `X-Forwarded-For: 198.51.100.77`;
     2. the right hop count is the one whose `ipByHopCount` entry equals your public address in **both** calls;
     3. if `true-client-ip` or `cf-connecting-ip` equals your address in both calls, report it: trusting a platform header is a separate change that needs its own review;
     4. set `TRUST_PROXY_HOPS` on Render only after that, then redeploy.
   - **[2026-10-29] Procedure superseded** by `PHASE3_2026-10-29.md` §6.3.
     - The diagnostic now keeps the rightmost forwarding entries and covers hop counts 1–10.
     - It takes `?expectedIp=` and returns `hopCountsMatchingExpected`.
     - A plain call alone matches every count from the right one upward, so the decision uses the intersection of the plain and the forged call, from two networks.
   - **Tests:** `test/unit/client-ip-attribution.spec.ts` runs real Express, the middleware and the throttler key. It covers:
     - direct anonymous traffic, and spoofed `X-Forwarded-For` entries never moving a bucket;
     - spoofed `x-edu-client-ip` without the secret, and the trusted web proxy with and without a secret;
     - credential and signed-in keys;
     - the effect of too few, correct and too many hops;
     - the diagnostic matching Express, being MASTER-only and never echoing the secret.
6. Rotate the secret by setting the new value on both hosts and redeploying. During the gap, attribution falls back to the old behaviour (safe).

**Not done.** The dashboard also calls the API server-side, but D6 named the student web only, so the dashboard was not changed.

## D7. Staging points at production

**Decision.**
- There is no staging backend; the staging profile uses the production API.
- Document the consequences and add guardrails without breaking production builds.
- Do not invent a staging URL.
- Recommend a path to a real staging environment.

**Consequences.** A staging build is a real client of production:
- testers create real accounts, enrollments, device bindings (the device limit is 1 in production), support tickets and audit rows;
- they consume real codes;
- account deletion requested from a staging build deletes a real account.

There is no data isolation. The app id differs (`com.eduplatform.app.stg`), so it installs beside the store app.

**Guardrails.**
- **Build time** (`app.config.ts`, on the EAS build worker only, like the production check): a staging build is refused when the API is non-HTTPS, local or a placeholder, when mocks are on, or when it targets the production API without `STAGING_USES_PRODUCTION_API=acknowledged`. That acknowledgement is now in `eas.json` → `build.staging.env`.
- **Run time:** a staging build on the production API shows a permanent red badge, "STAGING build · PRODUCTION data" (en and ar), on every screen (`StagingBanner`). It does not take touches.
- Production and development builds are unaffected [test].
- No staging hostname was added anywhere. A test fails if any profile points at a host other than production or the emulator.
- Your local, git-ignored `.env.staging` contains the placeholder `https://staging-api.example.com`. It was not edited. EAS builds use `eas.json`, not that file, but a local `APP_VARIANT=staging npx expo start` would hit the placeholder.

**Tests.**
- `__tests__/staging-guard.test.ts`, 17 cases [test, PASS]: profile environment selection, the build guard, `app.config.ts` on a simulated worker, and the badge.
- `production-config.test.ts`, updated [test, PASS].

**Recommended path to a real staging environment.**
1. Create a Neon **branch** of production (copy-on-write) or a separate small database, and run `prisma migrate deploy` against it.
2. Create a second Render web service from the same repo with its own env: database, Redis (a separate Upstash database), `R2_*` pointing at a **separate bucket**, Gumlet test collection, `PAYMENT_PROVIDER=none`, a different JWT secret set, `WEB_PROXY_SHARED_SECRET` of its own, and `NODE_ENV=production`.
3. Point `eas.json` → `staging.env.EXPO_PUBLIC_API_URL` at it and remove `STAGING_USES_PRODUCTION_API`. The badge then disappears automatically.
4. Give staging its own Firebase client (`com.eduplatform.app.stg`) in `google-services.json` (RELEASE_READINESS A4).
