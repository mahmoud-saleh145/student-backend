# Phase 6.1 — pre-push critical review (2026-10-30)

Review of the Gate A implementation (`f3ae0fa`), before Gate B. Labels as before. Nothing was pushed, merged, deployed, migrated, rotated or touched in production; no user-facing behavior changed. One corrective commit was made from the review's own finding: **`c27f3b5`** (settlement list distinguishes wallet balance from money owed) — the branch tip the verdict applies to.

**Verdict: Gate B is safe.** One financial-clarity defect was found and corrected (§1); everything else passed, with the residual risks listed honestly in §8.

---

## 1. Financial settlement correctness — PASS after correction `c27f3b5`

**The review's central question — wallet balance vs real refund liability — was the one real defect found.** The balance is prepaid credit; its ledger records how each pound got in. Recharge-card credit (`CREDIT_RECHARGE`, source `PAYMENT_CODE`) is cash the student actually paid; an administrative credit (`ADMIN_ADJUSTMENT`) may be goodwill/compensation and not owed back. Gate A's implementation cleared the full live balance and surfaced nothing to distinguish the two at the decision point. Corrected, without changing the flow:

- `GET admin/account-deletions/settlements` now returns `ledger` per row — lifetime credit and debit totals by `WalletTxType` (read-only `walletTransaction.groupBy`; account-deletion.service.ts `listPendingSettlements`) — so eligibility is judged from the ledger, not assumed from the balance. Pinned by a test that also proves the breakdown path exposes nothing but `groupBy` (no write surface).
- The **decompose-not-partial-settle** flow is documented at every point of use (service doc, both Swagger descriptions, the dashboard amount-field hint): a non-refundable portion is first removed via the audited `adjust()` (`ADMIN_ADJUSTMENT` debit with a reason — available during the hold: the user is not yet `deletedAt`, wallet.service.ts guard), then the remainder is settled (its `REFUND` line with method + reference). Every pound of the cleared balance ends in exactly one explicit, typed, reasoned ledger entry.

**The specific questions, with references (all account-deletion.service.ts unless noted):**

| Question | Answer |
|---|---|
| Financially correct ledger entry? | Yes. `debit(tx, {type: REFUND, source: ADMIN, …})` (L671–678): direction DEBIT is explicit and stored (`WalletTxDirection`, schema ~229), amount positive, `balanceBefore/After` recorded by `move()`. `WalletTxType.REFUND` had **no other use in src** (verified by grep — the `TX_REFUND` in refunds.service.ts is the separate `payment_transactions` table), so no report assumes a direction for it; ledger SUMs use `direction`, never type (schema comment ~228). With `reference {type:'account_deletion', id}` this is precisely the brief's "refund-settlement" class (§4.4), queryable as such. |
| Pretends an online refund? | No. No provider is touched; the note reads "Wallet settled physically outside the app (<method>, ref <reference>): <reason>"; the Swagger description now states "no online refund is performed or implied". |
| Double credit/debit possible? | No. `wallet_transactions.idempotencyKey @unique` (schema:2681); `move()` answers a replayed key from the existing row **before** any balance change (wallet.service.ts:201–227); the debit itself is one conditional `UPDATE … WHERE balance >= amount` (wallet.service.ts:243–258), so it can also never overdraw. |
| Amount from an auditable liability, not a blind copy? | The amount to **clear** is the live balance (itself ledger-derived; the integrity endpoint re-sums it). The amount **owed** is an administrative judgment made from the new per-type ledger breakdown; the admin must *type* the figure (never pre-filled, dashboard) and the server refuses any figure ≠ the live balance (L658–664), so record and movement can never disagree. |
| Partial settlements? | **Intentionally rejected**, now with the rationale documented: a partial would leave money with no record of why the remainder wasn't owed, and the erase guard would keep blocking. The decomposition flow covers the partial case with a complete audit trail. |
| Idempotency key scope? | `deletion-settlement:<requestId>` (L676) — one per deletion request. A later, separate deletion request (after cancel + re-request) has a new id → new key. Correct. |
| Concurrent confirmations? | Serializable tx with bounded retry (`withSerializableRetry`), pre-read refusal of `settledAt`, conditional `updateMany where settledAt: null` (L683) decides a race, and the ledger key makes even a theoretical double-debit a replay. Pinned by the duplicate + race tests. |
| Ledger write ok, finalization fails? | Same transaction — both roll back; the retry replays the debit idempotently. |
| Finalization ok, HTTP response lost? | The retry gets `INVALID_STATE "This settlement was already confirmed."` — money moved exactly once; the list shows the row settled. (A replay-as-success response was considered and deliberately not added: a loud refusal is safer for a money action than a silent 200.) |
| Wrong student / wrong request? | The admin supplies only the request id; `userId` is re-read from the request row **inside** the transaction (L640–646), the hold is required (`settlementRequiredAt`), and the typed amount must equal that user's live balance — three independent mismatch catches. |
| Permissions? | Both endpoints `@AdminOnly()` (= ADMIN + MASTER), pinned by the roles metadata test; DTO validated (whitelist, amount 0–1 M EGP 2dp, method 2–80, reason 10–500). |

**Noted, accepted:** the settlement debit increments `wallets.totalSpent` (documented as "lifetime totals" — wallet.service debit SQL). An admin "total spent" display will include settlements; the ledger is authoritative and typed. Cosmetic; a split would be a schema change not worth taking at this gate.

## 2. Account deletion lifecycle — PASS (one regression test added)

| Claim | Evidence |
|---|---|
| Accepted request blocks access | `request()` revokes in the same tx (`revokeAccessInTx`, L203): sessions → REVOKED, refresh tokens revoked, playback tickets revoked, push tokens deactivated; sign-in refused with `ACCOUNT_DELETION_PENDING` (auth.service.ts:259, 403). |
| Old tokens cannot restore access | `JwtAuthGuard` requires an ACTIVE session row (jwt-auth.guard.ts:129) — revoked sessions fail regardless of JWT validity; refresh tokens are revoked rows; deleted users fail at L141, DISABLED/SUSPENDED at L145. |
| Protected content unreachable | Same guard fronts course/media routes; playback tickets revoked; heartbeat re-checks (drm-verify-then-play 41). |
| Minimal identity reachable by admins during hold | `listPendingSettlements` (name, phone, amounts, ledger) — AdminOnly; nothing erased until settled (sweep hold precedes claim; erase guard L748–757). |
| No misleading indefinite state | Held rows stay PENDING with `settlementRequiredAt` set, surfaced on the dashboard tab and nagged by the standing `ACCOUNT_DELETION_SETTLEMENT_REQUIRED` count every sweep; failed rows have the same pattern (`needsAttention`). |
| Settlement → safe finalization | Settled rows rejoin the due query (`settledAt not null`); erase re-checks balance (==0 after settlement) and all Phase 2b guards (request claimed for exactly this user, target is a student). |
| Duplicate/concurrent requests idempotent | Partial unique index (one PENDING per user) + `findOpen` return + unique-violation winner path (request() L199–207); sweep claims via conditional updateMany; erase re-reads in-tx. |
| Financial history intact | Erase spec enumerates the untouched tables; the wallet is proven **read-only** during erasure (`Object.keys(tx.wallet) == ['findUnique']`). |
| **Admin cannot bypass the settlement requirement** | New regression test (`c27f3b5`): `retryFailed`'s update touches exactly `{failedAt, attempts, lastError}` — it cannot clear a hold; and the due query excludes held rows regardless of failure state (where-shape test). `cancelFailed` only cancels (money stays, account restored) — no erasure. No other writer of COMPLETED exists besides `erase()` (grep). |

## 3. Online-payment lockdown — PASS (repo-wide sweep)

Searched all four repos for `paymob|stripe|PAYMENT|checkout|iap|billing|storekit|payment url`:

- **Backend:** the only `buildCheckoutUrl` caller stores/returns null (payments.service.ts:149–166, builder returns null unconditionally at L198); `enrollments.service.ts:240–249` renders its payment block only when `checkoutUrl` is truthy → permanently the manual-flow message (the URL-bearing branch is now unreachable dead code — kept as history, harmless). Webhooks refuse pre-payload (payment-webhook.service.ts:49, 136). Remaining `payment.provider` references are the **column** on historical rows (refunds/display) — exactly what must stay readable. `POST admin/payments/:id/confirm` (offline confirmation) untouched and green in the suite. No wallet→course debit exists (course-part-purchase.spec pins "touches no wallet table"). No capability flag anywhere re-enables: env refuses, getter is constant, `meta/app-config` has no payment surface.
- **Mobile:** no IAP/billing/StoreKit/Paymob/Stripe SDK or reference anywhere (package.json + src); `checkoutUrl` survives only in a type and a mock fixture; `no-external-checkout.test` pins "no screen opens a payment checkout URL" — passed today.
- **Web:** no checkout/provider code; PENDING_PAYMENT copy now names the administration/access codes (both languages); 393/393.
- **Dashboard:** payment surface is the offline confirm/refund admin UI only.

## 4. Video backlog freeze — PASS, with one honestly-stated residual

- **Automatic paths:** the only scheduled caller is `maintenance.scheduler` → `recoverStrandedVideos` (jobs/schedulers/maintenance.scheduler.ts:95 → maintenance.processor.ts:75), whose query selects **only** QUEUED (>10 min) and PROCESSING rows (videos.service.ts:657–678) — UPLOADING and FAILED are structurally unreachable. Gumlet webhooks cannot resurrect a failure: FAILED/ERRORED are terminal and a late "ready" after failure still cannot grant playback (gumlet-webhook-terminal-transitions.spec, incl. the out-of-order case) [test].
- **READY videos:** no file in `videos/`, `playback/` or media paths is touched by any Gate A commit (`git diff --name-only d9f1307..c27f3b5`) — playback behavior is unchanged and its 41-test suite is green.
- **Report:** `sql/video-backlog-report.sql` contains zero write verbs outside comments (mechanically checked; same for the D3 report).
- **Residual, stated plainly:** the **manual, authenticated staff endpoints** (`POST videos/:id/complete`, `POST videos/:id/gumlet/replace-failed-asset`) still exist and a staff user clicking them *would* re-ingest — they are not reachable by anything automatic, but the freeze is enforced by authorization + your instruction, not by a hard switch. If you want it mechanical, say so at Gate B and a guarded kill-switch (e.g. refuse re-ingest while a `VIDEO_INGEST_FREEZE` env is set) is a small reviewed change; it was **not** added now because this pass must not change behavior.

## 5. D3 and D6 — PASS

D3: candidate report SELECT-only (checked); remediation template unexecuted; clear restorations flow through the explicit, reasoned, audited admin endpoints; ambiguity stays `MANUAL_REVIEW` (course-archive-restore-states 11/11). D6: `health/deep` MASTER-only (health.controller.ts:82; metadata test); `health` public/minimal; the diagnostic reports **only an allowlist** of five address headers (`DIAGNOSTIC_ADDRESS_HEADERS`, client-ip.ts:98–104, each truncated to 64 chars at L198–201) — `authorization`, cookies and `x-edu-proxy-secret` are structurally unable to appear; forwarded-address claims require the shared secret (client-ip-attribution 40, web-proxy-client-ip 23).

## 6. Migration `20261030100000_deletion_settlement` — PASS

Additive only: 6 nullable columns + 1 index on `account_deletion_requests`; no row writes, drops or renames; no destructive statement. Replayed from scratch ×2 (22/22) and applied additively onto the 21-migration schema (local PG16) [test]. Backward compatible: the deployed API never selects the new columns, so **migration-before-deploy** order is safe (and required for the new API). `settledById`/`settlementTxId` are deliberately plain strings (no FK): both are written exclusively from server-side values (the authenticated actor; the ledger row id returned by the same transaction), the audit row carries the actor too, and omitting FKs keeps the migration trivially additive. Pre-existing note, not introduced here: `Wallet.user` is `onDelete: Cascade`, moot because users are never hard-deleted (Restrict anchors + soft-delete design). Rollback while unused: drop the 6 columns + index; once settlement rows exist, backup-restore is the only honest rollback. **Not run against Neon.**

## 7. Cross-platform consistency — PASS

One message everywhere: backend refuses/never offers online payment; mobile JOIN sheet is "a comparison, not a checkout" with the no-checkout test; web names the administration/access codes; dashboard advertises nothing and its settlement UI mirrors the exact backend rules (typed amount == live balance; drain-then-settle hint; ledger breakdown). The dashboard calls the **real** routes (`admin/account-deletions/settlements`, `:id/confirm-settlement`, `:id/retry`, `:id/cancel` — exact match to the controller) through the same authenticated proxy as every other admin call; the stub is e2e-only (its server never runs in production builds) and now enforces the same role gate, amount-equality, duplicate and reason refusals, so the Playwright journeys cannot "pass" on a false confirmation.

## 8. Remaining risks (none block Gate B)

1. The settlement's eligibility judgment is human — by design; the ledger breakdown is the tool, not a verdict (owner may still want card-vs-admin credit treated differently as policy: say so and it becomes a rule).
2. `wallets.totalSpent` includes settlement debits (cosmetic, §1).
3. Manual video re-ingest endpoints remain callable by staff (§4 residual; optional kill-switch on request).
4. F-10/F-11 (edge Worker fail-open; unsigned thumbnail URLs) — unchanged, worker-side, in the register; one live `curl -I` on a cover URL at Gate C settles F-11.
5. F-08 residual timing, D4 iOS model, legal retention periods — owner decisions, unchanged.

## Verification at `c27f3b5` [test]

Backend (VM): tsc 0 · full jest sharded ×12, all exit 0 — **156 suites (155 passed, 1 skipped live-only), 2,691 passed / 0 failed / 6 skipped** · eslint on changed files 0. Dashboard: tsc 0, eslint 0, stub `node --check` ok. Mobile/web unchanged since their green runs earlier today. Windows-only items unchanged (e2e, builds, Playwright execution, EAS).

**Gate B request (unchanged): push `integration/phase4-release` (tip `c27f3b5`) for your review and merge.**
