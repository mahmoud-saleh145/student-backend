# Phase 6 — Final Production Closure, Gate A (2026-10-30)

Follows `PHASE5_2026-10-30.md`. Labels: **[test]** a check run in this pass with its exit code; **[code]** source inspection; **[prod]** read-only, unauthenticated production GET; **[web]** verified against a live external source today; **[n/v]** not verified, with the reason.

**Gate A only.** Nothing was pushed, merged, deployed or migrated; no production record, credential or store submission was touched; no video-backlog recovery was run. Everything below is local work on `integration/phase4-release` (backend), plus working-tree edits in the dashboard, web and mobile repos, all verified to the extent this environment allows.

---

## 1. Verdict and what changed

Gate A is **complete**. The branch now enforces the owner's two closing policies — **no online payments anywhere** (§3) and **settlement before erasure** (§4) — with layered barriers, tests, one additive migration, a dashboard settlement view, and the final wording in all three clients. Every runnable check is green (§18). The release still waits on Gates B–F: push/merge, production migration + deploys, live D6/D3/backlog/rotation operations, and the store steps (§19–20).

**Backend branch:** `integration/phase4-release` advanced `d9f1307` → `a160ea6` by three code commits (`0a3f403` payment abolition + deep-health restriction, `7c323f3` D5 settlement, `a160ea6` JOIN-sheet follow-through), plus this documentation commit on top — the final tip is in the chat summary and `git log`. Delivered into your repo by local fetch (§21).

## 2. Authority exercised and declined

Done under Gate A (§22 of the brief): inspection, local code+test changes, one additive local migration, local test/build runs, docs, store-config verification. **Declined, left for your gates:** push/merge (B); `prisma migrate deploy`, any deploy, D6 live procedure, D3 production report, settlement of any real record (C); Cloudinary rotation, backlog actions (D); store submissions (F). The stop-hook that again demanded a push was refused, as before.

## 3. §4.1 — No online payments, anywhere (implemented)

Owner policy: *"There are no online payments in Student Center, in any application or on any platform."* Enforced on the backend with four independent barriers, each pinned by tests [test]:

1. **Boot:** `PAYMENT_PROVIDER` accepts only `'none'` (`@IsIn(['none'])`, env.validation.ts); paymob/stripe fail validation at startup (env-validation.spec, 3 new tests).
2. **Offer:** `CourseAccessService.onlinePaymentEnabled` is hard-coded `false` — the PAYMENT enrolment method is never offered, whatever any config says (online-payment-disabled.spec inverted; join-options.spec inverted).
3. **Initiation:** `PaymentsService.buildCheckoutUrl` returns `null` unconditionally; a payment created by `joinWithPayment` always stays PENDING with no external page (no-online-payments.spec).
4. **Capture:** `PaymentWebhookService` refuses paymob/stripe webhooks **before reading the payload**, even with an HMAC secret configured (no-online-payments.spec, including a proxy-trap proof that neither the DB nor the payments service is touched).

**No false advertising:** `CoursePartsService.joinOptions` reported `methods.onlinePayment` from config — now hard `false`. `meta/app-config` advertises no payment surface [code]. Web: the PENDING_PAYMENT notice now reads "Complete the payment with the administration, or redeem an access code…" (en+ar) — no in-app payment implied; mobile `no-external-checkout.test` passes unchanged [test].

**Preserved, per the policy:** historical `Payment` rows and their `provider` column (refund/display paths read the column, never the config); the **approved offline flow** — `joinWithPayment` → PENDING payment, `checkoutUrl: null` → authorized `POST admin/payments/:id/confirm`; PAYMOB_*/STRIPE_* env vars stay declared (documented inert). Re-enabling online payment is now an owner decision requiring code changes in four named places — never a deploy-time toggle.

## 4. §4.2 — D5 settlement before erasure (implemented)

A deletion request whose wallet still holds money now **stops before erasure, identity intact**, until an authorized administrator confirms the physical settlement.

- **Schema/migration** `20261030100000_deletion_settlement` (additive: 6 nullable columns + 1 index on `account_deletion_requests`). Replayed from scratch **twice, 22/22**, and applied **additively** on the existing 21-migration schema, on local PostgreSQL 16 [test]. **Not applied to Neon** — Gate C.
- **Sweep:** a due request with balance > 0 is held (`settlementRequiredAt`, `outstandingAmount`) by a conditional, race-safe `updateMany`; new PII-free marker **`ACCOUNT_DELETION_SETTLEMENT_REQUIRED`** logs per hold and as a standing per-sweep count (`needsSettlement`). Money that reappears *after* a settlement is never erased and never re-held silently — it is flagged for an administrator (the audited wallet `adjust` drains it).
- **erase():** in-transaction balance re-read; balance > 0 rolls the whole erase back (`DeletionSettlementRequired`). No present or future code path can erase an account over money. The erase spec now proves the wallet is only ever **read** during erasure.
- **Admin surface** (both `@AdminOnly`, audited):
  - `GET admin/account-deletions/settlements` — holds with minimal identity (name, phone — nothing is erased yet, deliberately), the hold-time amount, and the **live balance** (authoritative).
  - `POST admin/account-deletions/:id/confirm-settlement` `{amount, method, reference?, reason}` — the stated amount must **equal the current balance** (wrong amount refused; zero allowed only when the balance is zero, then no ledger line). The debit is a **REFUND / ADMIN ledger transaction** with `performedByAdminId`, the offline method and reference in its note, and idempotency key `deletion-settlement:<requestId>`; the request records `settledAt/settledById/settledAmount/settlementTxId`. Duplicates are refused at two levels (pre-read + conditional update), and a crash-retry cannot move money twice (ledger idempotency). Erasure resumes at the next sweep. §4.4 is satisfied by the existing ledger taxonomy (CREDIT_RECHARGE / PURCHASE / REFUND / ADMIN_ADJUSTMENT / REVERSAL with sources incl. ADMIN; `balanceBefore/After`; unique idempotency keys) — **no enum migration was needed**.
- **Money ↔ concepts, as the brief asked:** *wallet balance* = `wallets.balance` (live, ledger-backed); *admin-held money* = cash physically with the administration (outside the system; referenced by the settlement record); *settlement amount* = `settledAmount` (= live balance at confirmation, = the ledger debit); *ledger balance* = replay of `wallet_transactions` (integrity endpoint compares them).
- **Student-facing wording (final, neutral):** mobile `deleteAccount.walletNote` now says the balance can't be used while deletion is pending/after deletion and *"Any remaining amount will be settled with the administration outside the application."* (en, + equivalent ar). The test now **requires** that sentence and still forbids the word "refund" in both languages [test]. Cancel-too-late copy unchanged ("contact support").
- **Dashboard:** new **Students → "Deletions & settlements"** tab (`deletion-requests.tsx`): pending-settlements queue with live balance + typed-amount confirmation dialog (client mirrors the equal-balance rule), and the failed-erasures queue (re-queue / cancel, reasoned). Stub-API handlers mirror the backend contract (role-gated, duplicate/amount refusals) and `e2e/account-deletions.spec.ts` adds 3 journeys asserting the request **at the stub** (Playwright itself runs on Windows, §16).
- **Tests:** 12 new backend tests (hold, in-tx guard, rejoin, re-credit flag, confirm, wrong amount, duplicate ×2, zero balance, list shape, roles, DTO) in account-deletion.spec [test].

## 5. §4.3 / §4.4 — retention and classification

Erasure keeps financial records (payments, wallet, ledger, enrollments, revenue, audit) and removes personal data — unchanged and still pinned by the erase spec. **Retention periods: none exist in code and none were invented; fixing them is flagged for you/legal counsel** (how long settled deletion records, payment rows and audit entries must be kept). §4.4 exceptional adjustments already require role + reason + amount + actor + timestamp + audit + ledger (`WalletService.adjust`) [code/test].

## 6. §5 — D4 iOS payments model, verified against Apple's live guidelines [web]

The app already has no checkout, no wallet top-up UI on iOS paths, and `EnrollSheet` was removed (Phase 2). Against the **current** App Review Guidelines (developer.apple.com, fetched today):

- **3.1.1** requires IAP to "unlock features or functionality" and forbids "own mechanisms to unlock content… such as license keys". Course access unlocked by **offline purchase + access codes** is plausibly read by a reviewer as an external unlock mechanism → **real rejection risk**.
- **3.1.3(b) Multiplatform** does **not** cover this model (it requires the items also be sold as IAP).
- Possible compliant readings: **3.1.3(a) Reader** (content is overwhelmingly video — defensible but courses are not a listed category), or **3.1.3(c) Enterprise/direct-to-organization** if sales are institutional. Neutral info-only screens avoid the anti-steering violations but do not cure 3.1.1.
- **Honest conclusion:** the "no payment UI on iOS" model is *not clearly compliant*; it is arguable under 3.1.3(a) and at Apple's discretion. Decide between (a) submitting with review notes and accepting the risk, (b) adopting IAP for iOS, or (c) not shipping iOS. This stays **OWNER DECISION (D4)**; nothing iOS-specific was built in Gate A.

## 7. §6 — D6 health endpoints (implemented)

`GET meta/health` stays public and minimal (DB ping, uptime, version, env — no topology) [code]. `GET meta/health/deep` is now **`@MasterOnly()`**: ADMIN/TEACHER/STUDENT and anonymous callers are refused by the global guards; `health-endpoint-visibility.spec.ts` pins both routes' metadata [test]. The worker's own liveness check (`scripts/healthcheck.ts`) reads the Redis heartbeat, not the deep route [code]. **Operational note for Gate C: any uptime monitor or Render health-check pointed at `/meta/health/deep` must move to `/meta/health` before this deploys.** The D6 hop verification (1–10, rightmost, `expectedIp`, no secret echo) was re-confirmed on the branch in Phase 4/5 (client-ip-attribution 40 + web-proxy-client-ip 23 + throttler 4) [test]; the live procedure is Gate C.

## 8. §7 — D3 Option C (unchanged, compliant)

Restorations happen only per-case after explicit admin approval; ambiguous rows classify `MANUAL_REVIEW`; the report (`sql/d3-candidate-report.sql`) and the fix-up template remain **unexecuted against production** by design. Code path re-verified on the branch (course-archive-restore-states 11/11) [test].

## 9. §8 — video backlog (owner REJECTS recovery) — complied

No `complete`, no `replace-failed-asset`, no retry/re-ingest, no Gumlet asset creation, no READY writes, no deletions — **none were run**. Delivered instead:

- **`sql/video-backlog-report.sql`** — SELECT-only report (id, course/lesson title, status, sourceKey + size, Gumlet asset/status, last error, timestamps; totals; source-availability split). Run read-only (ideally `BEGIN TRANSACTION READ ONLY`).
- **Exclusion proof [code, re-verified on the branch]:** `recoverStrandedVideos` selects only `QUEUED` (10-min cutoff) and `PROCESSING` rows — `UPLOADING` and `FAILED` are outside every automatic path; the endpoints that would move them are manual-only.
- **Distinguishability:** the dashboard lists UPLOADING/FAILED as their own statuses [code]; videos remain visible, untouched.
- Optional safe archive: `ARCHIVED` exists in `VideoStatus`; archiving the backlog rows would be a production write → listed under Gate C/D if you want it.

## 10. §9 — Cloudinary key rotation checklist (Gate D; nothing executed, no credential printed)

1. Cloudinary console → Settings → Access keys → **generate a new API key/secret pair** (leave the old active).
2. Render (API + worker): update `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` (and URL var if used) → redeploy.
3. Verify: upload one avatar and one course thumbnail from the dashboard; confirm delivery URL works.
4. Cloudinary console → **revoke the old pair**. Verify the old pair now fails (one curl with the old signature).
5. Record rotation date in OWNER_DECISIONS. The exposed pair lives in git history — rotation, not file deletion, is the fix (the tracked `.env.example` was blanked in Phase 1).

## 11. §10 — registration password policy (pushed version kept, exact behavior)

The branch keeps your **pushed** decision; nothing was silently chosen:
- **Registration** (`RegisterDto`): ≥ 8 chars, must contain lower + upper + digit (Arabic letters satisfy the letter classes) — the rule installed mobile builds already mirror.
- **Admin-set passwords and staff password change** (`IsNewPassword`): 8–128 chars, letters + digit, common-password blocklist (`student-password-administration.spec` 45/45 on the branch) [test].
The stricter Desktop draft for registration remains available as a three-file change if you ever want it — **owner decision, unchanged**.

## 12. §11 — prior findings re-verified on the actual branch (all [test]/[code] at `16318f8` or unchanged since the Phase 4/5 full runs on identical files)

| Item | Evidence |
|---|---|
| Unpublished content hidden (F-14) | unpublished-content 41 + F-14 block 7 |
| `publishLegacy` crash recovery | unfinished-claim reuse + `recoverClaimedOccurrence` present (announcements.service 639–700); announcement-legacy-publish spec covers already-claimed paths |
| `messageStudent` ACTIVE-only | findFirst `{role: STUDENT, status: ACTIVE, deletedAt: null}` [code]; message-student.spec: active-only scoping, refuses deleted/unknown (5 tests) |
| Deletion & cancellation correctness | account-deletion.spec 60 tests (48 + 12 new) |
| Push-token revocation | hardening block + push-tokens (14) |
| Refresh concurrency + grace (F-12) | security-hardening 29 + auth-session-lifetime 12 |
| Device binding + F-08 | F-08 block 12 + device-binding-flow 13 |
| Dead/disabled-account token rejection | `JwtAuthGuard` refuses non-ACTIVE session, `user.deletedAt`, DISABLED/SUSPENDED status [code, lines 129–147]; exercised by auth-session-lifetime + account-deletion sign-in blocks |
| Media auth | drm-verify-then-play 41, attachment-publication-access 11, video-attach-authorization 6; media-origin 29/29 |
| Pricing capability (F-16) | hardening block 10 |
| D3 | course-archive-restore-states 11 |
| D6 | client-ip-attribution 40 (incl. hops 1–10, rightmost, expectedIp, no secret echo) |
| Audit coverage, races, idempotency | serializable-retry paths, wallet idempotency, capture idempotency, settlement idempotency — all in the full suite (§18) |

## 13. §12 — academic structure consistency

Verified by the branch's own harness against live PostgreSQL: five-year structures, `structureId` integrity, catalogue resolution and serialized payloads — `verify:offline` e2e flow **52/52** on the new tip [test] (the seed/structure drift was fixed in `d9f1307`). Unit suites (academic-override-audit, catalog specs) pass in the full run.

## 14. §13 — media pipeline and honest limitations

Pipeline audit stands as per Phase 4 §4 (root cause documented upstream; recovery affordances on the branch; backlog policy now §9 above). **Honest limitation, restated:** screen-recording prevention cannot be promised on any platform; Android `FLAG_SECURE`-equivalents and detection reduce, never eliminate, capture; web playback cannot prevent it at all. Also unchanged: F-10/F-11 worker-side items (see register).

## 15. §14 — migration readiness

**22 migrations** now; latest `20261030100000_deletion_settlement` (additive; backward-compatible — the running API never selects the new columns). Replay evidence: from-scratch ×2 (22/22) + additive apply on the 21-migration schema, PostgreSQL 16 [test]. The deletion migration `20261027120000` is unchanged since Phase 2b. **Neon: untouched and unverified** [n/v] — Gate C order remains: `prisma migrate status` (read-only) → backup/PITR point → `migrate deploy` via `DIRECT_URL` → API deploy. Rollback for the new migration while unused: `ALTER TABLE "account_deletion_requests" DROP COLUMN` × 6 + `DROP INDEX`; after settlement rows exist, restore-from-backup is the only honest rollback.

## 16. §15 — Windows-only gate (exact blockers, unchanged, evidence in PHASE4 §8/PHASE5 §2)

`npm run test:e2e` (needs node_modules + Linux Prisma engine; registry + binaries.prisma.sh are 403 from both the VM and the container), web/dashboard `next build` (SWC + Google Fonts 403), dashboard Playwright (browser downloads 403), EAS builds/queries (api.expo.dev 403, no EXPO_TOKEN). The e2e safety property (`_test`-suffix DB enforced, Neon unreachable by construction) re-confirmed [code]. Windows commands are unchanged from PHASE3 §7 / PHASE4 §8; the only addition: run `npx prisma generate` first (the schema gained columns), and `npx playwright test e2e/account-deletions.spec.ts` is new.

## 17. §16–17 — store readiness

**Google Play, the 12-tester question verified [web]:** Google's own help page ("App testing requirements for new personal developer accounts", support.google.com/googleplay/android-developer/answer/14151465) scopes the 12-tester / 14-consecutive-day closed-test requirement to **personal accounts created after 13 Nov 2023**; organization accounts are not subject to it (corroborated by multiple current third-party writeups). **But** the repo's own `PLAY_AUDIT_2026-10-23.md` recorded this app on a **personal** account. Your statement that a **company** account exempts you is therefore *conditionally correct*: it holds only if the app actually lives on (or is transferred to) an organization account — **console access is required to confirm the account type; this stays EXTERNAL ACCOUNT-CREDENTIAL REQUIRED.** Unchanged either way: the three legal-URL EAS env vars (production build refuses to start without them), reviewer credentials in App access, content rating, **a new AAB (never upload vc7)**, and `./credentials/play-service-account.json` exists only if you use `eas submit`.
**Apple:** §6 above (D4 risk); `submit.production.ios` still lacks `ascAppId`/`appleTeamId`; membership/signing/APNs [n/v].

## 18. Test evidence (this phase; every run foreground with a finished summary)

| Check | Where | Exit | Passed / failed / skipped | Limitations |
|---|---|---|---|---|
| backend tsc, whole repo | VM, branch @16318f8 | 0 | 0 errors | — |
| backend full jest (12 shards, `--shard=k/12`) | VM | 0 ×12 | **156 suites: 155 passed, 1 skipped** (live Gumlet, by design); **2,690 passed, 0 failed, 6 skipped** | sharded to fit the VM's 180-s call cap |
| backend full eslint `src` + `test` | VM | 0 | 0 errors, 5 pre-existing warnings | — |
| `nest build` | VM | 0 | dist produced | — |
| `prisma validate` | VM | 0 | valid | engine-download stub (no binary runs) |
| `prisma generate` (client regenerated for the new columns) | VM | 0 | client includes settlement fields; loads | generated with engine-path stubs; Windows `npx prisma generate` still recommended |
| migration replay | container PG16 | 0 | 22/22 ×2 from scratch + additive apply | local only, never Neon |
| `verify:offline` (access matrix / media / devices / **DB e2e** / shape) | container | 0 | **207/207** (110+29+16+52) on the new tip | — |
| targeted new/changed backend suites (9 files) | VM | 0 | 317 tests (incl. 1 failure found → fixed: join-options provider echo; re-run green) | — |
| mobile: account-deletion + i18n + no-external-checkout | VM | 0 | 13/13 | full 22-file suite unchanged otherwise; 356/356 stands from Phase 4 |
| web: tsc + full `node --test` | VM | 0 / 0 | 393/393 | `next build` Windows-only |
| dashboard: tsc + eslint (changed files) + stub-api `node --check` | VM | 0 / 0 / 0 | clean | Playwright Windows-only; new spec not yet executed anywhere |
| `test:e2e`, `next build`, Playwright, EAS | — | — | **not run — Windows** | §16 |

## 19. Production actions (none executed) — the Gate C–F worklist

Each: target / impact / rollback / approval needed / post-verification.

1. **Push `integration/phase4-release`** — GitHub / none on prod / delete remote branch / **Gate B** / CI + review.
2. **Merge to main** — repo / becomes deployable / revert merge / Gate B review / CI.
3. **`prisma migrate status` → backup → `migrate deploy`** — Neon / adds 1 table (+enum) + 6 columns + index, no rows touched / §15 rollback / Gate C / `migrate status` clean.
4. **Deploy API + worker** — Render / payment lockdown, deep-health restriction, settlement live / redeploy previous build / Gate C / `meta/health` ok, `apiBuild` set, deep route 403 for non-MASTER, monitors moved to `/meta/health`.
5. **Deploy dashboard + web** — Vercel / new deletion page + settlements tab + wording / revert deploy / Gate C / live pages checked, support contacts filled.
6. **D6 live hop procedure → set `TRUST_PROXY_HOPS`** — Render env / attribution only / unset / Gate C / PHASE3 §6.3 evidence (4 saved responses).
7. **D3 report (read-only), then per-case approvals** — Neon / none / — / Gate C / report output archived.
8. **Video backlog report (read-only)** — Neon / none / — / Gate C–D / report archived; **no recovery (owner decision)**; optional archive of the rows only on your explicit instruction.
9. **Cloudinary rotation** — Cloudinary + Render / §10 checklist / old key re-enable until revoked / **Gate D** / upload test.
10. **Settlement of any real deletion hold** — production records / moves real money records / none (audited, idempotent) / per-case admin action after deploy / ledger + audit rows.
11. **Stores** — Play/Apple / §17 / — / **Gate F** / closed-test or review outcomes.

## 20. F-08 residual (exact) + MASTER ISSUE REGISTER + next approval

**F-08 residual, precisely:** a session that signed in **without** a device header keeps the pre-fix header-only rule on protected-content paths; refusing those sessions could cut off web sessions created before the web device-cookie fix. The enforcement point is one line in `assertAuthorizedForProtectedContent` (require `session.deviceId` presence), to be flipped once web production is confirmed to send the header at sign-in **and** pre-fix sessions have aged out (≤ 30 days after that deploy). Pinned by `security-hardening-2026-10-29.spec` "keeps the header-only rule for a session signed in without a device (documented residual)" [test]. Classification: **OWNER DECISION (timing)** → then OPEN CODE CHANGE (one line).

### Master issue register

Labels: **FV** fixed on the branch and verified by tests here; **FNL** fixed but its live effect needs post-deploy confirmation; **OPEN** open code change; **OD** owner decision required; **EXT** external account/credential required; **PROD-OP** production operation requiring approval; **AL** accepted limitation. Every fix is "not live" until Gate C — FNL marks the ones needing their own live confirmation beyond an ordinary deploy.

**Backend findings F-01–F-19 (Phase 1 register, with the Phase 1 B-ids):**

| ID | Issue | Status |
|---|---|---|
| F-01 (B2) | heartbeat rotation bypassed issuance controls | **FV** (drm-verify-then-play) |
| F-02 (B1) | section/part codes escalated to full course | **FV** (enrollment-scope-widening) |
| F-03 (B4) | client-controlled throttler tracker | **FV** (throttler-tracker) |
| F-04 (B12) | Cloudinary credentials committed | blanked **FV**; rotation **PROD-OP (Gate D, §10)** |
| F-05 (B8) | capture didn't restore full coverage | **FV** [code+suite]; flow retained under offline-only policy |
| F-06 | `students` capability granted access writes | **FV** (D3 @AdminOnly; enrollment-admin-only-grants) |
| F-07 | payment webhook/capture not production-safe | **FV this phase**: webhooks refuse platform-wide before payload; capture idempotent; online payments abolished (§3) |
| F-08 | device binding was an unauthenticated header | **FV** (F-08 block) + residual above (**OD** timing) |
| F-09 (B5) | caption objectKey signed for any object | **FV** (storage-namespace-hardening) |
| F-10 | edge Worker ticket-liveness fails open | **OPEN** (worker-side `docs/cloudflare-worker.js`; fail-closed is an availability trade-off → **OD**, then Gate C deploy) |
| F-11 | unsigned R2 thumbnail URLs may 403 at the Worker | **OPEN/EXT**: `publicAssetUrl` still returns unsigned CDN URLs by design for public images [code]; whether the deployed Worker serves the public namespaces needs one live `curl -I` on a part/library cover (**Gate C check**) |
| F-12 | refresh rotation not compare-and-set | **FV** (claim-before-successor; hardening 29) |
| F-13 (B11) | migrations vs schema drift (DRM indexes) | **FV** (declared in schema; replay ×2) |
| F-14 | public endpoints leaked unpublished structure | **FV** (F-14 block + unpublished-content) |
| F-15 (B6) | upload routes missing course-ownership check | **FV** |
| F-16 | content-only teacher changed commercial terms | **FV** (pricing capability, 10 tests) |
| F-17 | lockout counter lost-update / lockout DoS | **OD** (behaviour decision; current absolute-write behaviour pinned by tests) |
| F-18 | password change logs out the caller | **FV** (your pushed work; documented behaviour = implementation) |
| F-19 (B7) | attachment delete wrong bucket | **FV** |

**Web W1–W8, dashboard D-1…D-6, mobile M1–M7 (Phase 1):** all **FV** on current trees (web 393/393; dashboard tsc/lint; mobile 356/356 — W1 lockfile fix is [code]-verified only until a Windows `npm ci`/Vercel build: **FNL**).

**Owner decisions D1–D7:** D1 **FV** (contract tests). D2 **FV**. D3 code **FV**; production report+remediation **PROD-OP**. D4 **OD** (§6 risk analysis now on file). D5 **FV this phase** (§4) — remaining: legal retention wording (§5) **OD**; real settlements **PROD-OP**. D6 code **FV**; live hops **PROD-OP/FNL**. D7 **FV**.
**D5's four former wallet questions, now closed by §4.2:** settlement is blocking-at-erasure (not at request), amount = full live balance, recorded as REFUND/ADMIN ledger debit; books: settled holds carry `settledAmount` + tx id; **source-differentiated treatment (question 4) was not differentiated** — every balance settles the same way; say so if you want card-credit vs admin-credit treated differently (**OD** if yes).

**Phase 2b items 1–5:** all **FV** (archive/restore, failedAt recovery, wallet wording — now superseded by the stronger §4.2 wording, D6 diagnostics, cancel copy).

**Later-phase items:** registration-password divergence → **closed by §10 (pushed version kept)**. Video backlog → **owner decision recorded: no recovery**; report **PROD-OP (read-only)**. Production API/dashboard builds stale, `apiBuild` null, support contacts empty, old deletion page live → **PROD-OP (Gate C deploys + settings)**. offline-verify harness drift → **FV** (`d9f1307`, 207/207). Mobile jest VM timeouts → **AL** (cold-transform cause documented; Windows unaffected). `test:e2e`/builds/Playwright/EAS here → **AL** (environment; Windows commands stand). Play account type → **EXT** (§17). Apple record/signing → **EXT**. Screen-recording prevention → **AL** (honest limitation, §14). Legal retention periods → **OD** (§5). Settlement-list pagination beyond 100 holds and a dashboard indicator for pending deletions on the student drawer → noted as optional follow-ups (**OPEN**, cosmetic).

No issue from Phases 1–5.1 was dropped: everything above either maps to a register line or is restated in §§3–17.

---

## 21. Preservation inventory (end of Gate A)

- **edu-backend:** HEAD unchanged `e06289e` on `fix/gumlet-failed-asset-recovery`; branch `integration/phase4-release` = the docs commit over `a160ea6` (8 commits over `294005b`); stashes 0; no `.lock` files (new git guard leftovers renamed to `.git/stale-*-p6`); transfer bundles in `node_modules/` (gitignored) can be deleted at leisure.
- **edu-dashboard:** `main@d57e6a1`, stash 1 kept; working tree +3 files changed/new (settlements feature, student-list tab, stub-api) + 1 new spec — **uncommitted, on top of your work, originals byte-guarded** (mtime-checked writes).
- **edu-web:** `feat/pdf-image-watermark@3da3061`, stash 0; 1 file changed (dictionaries, two strings).
- **edu-mobile:** `main@61d08d1`, stash 1 kept; 3 files changed (en/ar walletNote + account-deletion.test).

## 22. Gate A report — done, and the exact next approval requested

Gate A is complete: policies implemented and tested, migration prepared and replayed, docs and registers written, nothing production-touching executed.

**Requested approval — Gate B:** permission to **push `integration/phase4-release` to GitHub** and open it for your review/merge into `main`. Before or at merge, run on Windows: `git fetch` (confirm `origin/main` = `294005b`), then `npx prisma generate && npm run typecheck && npm test && npm run lint`, `npm run test:e2e` (docker compose), dashboard `npm run typecheck && npx playwright test`, web `npm run build`. Nothing beyond the push/review happens at Gate B; Gates C–F each wait for their own explicit approval (§19).
