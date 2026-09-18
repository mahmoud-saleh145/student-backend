# Wallet & credit system

Phase 1 of the platform upgrade. This document covers what was built, the money
rules it enforces, and what has *not* been built yet.

## What changed, in one paragraph

A recharge code carries money: the student redeems it, credits land in their
wallet, and they spend those credits in the **Library**.

> **Scope, corrected 2026-09-18.** The wallet is for the Library only.
> **Courses and course parts never debit it.** Course access — whole course,
> section or part — comes from access cards, which is what it always was.
> Everything that existed before still works: codes created before the wallet
> keep their `ACCESS` behaviour and keep unlocking courses exactly as they did.

## Entities

### `wallets`

One row per user, created lazily on first touch (no back-fill needed for
students who registered before the wallet existed).

| Column | Meaning |
|---|---|
| `balance` | Cached balance. **Not** the source of truth. |
| `totalRecharged` / `totalSpent` | Lifetime totals for the admin table. |
| `version` | Bumped on every mutation; makes a lost update visible after the fact. |

### `wallet_transactions` — the ledger

Append-only. **This is the source of truth.** There is no update or delete path
anywhere in the service or the API. A mistake is corrected with a compensating
`REVERSAL` or `ADMIN_ADJUSTMENT` entry, which leaves the original visible.

Each row records: wallet, user, type, direction, source, amount (always
positive), currency, the balance before and after, an optional reference, the
acting administrator where relevant, a note, and an optional idempotency key.

Types: `CREDIT_RECHARGE`, `PURCHASE`, `REFUND`, `ADMIN_ADJUSTMENT`, `REVERSAL`.
Sources: `PAYMENT_CODE`, `COURSE_PART`, `LIBRARY_PART`, `LIBRARY_PACKAGE`,
`ADMIN`, `SYSTEM`.

`referenceType` / `referenceId` is deliberately loose coupling: a library
purchase writes `{ LIBRARY_PART, lib_… }` without the wallet module needing to
know what a library part is, and without a new nullable FK column per feature.

`WalletTxSource.COURSE_PART` exists in the enum but is **never written**. It is
left in place because removing an enum value needs a migration and buys nothing;
treat any row carrying it as history from the withdrawn build in which course
parts were briefly bought with credits.

### `recharge_revenue` — the cash-in record

One immutable row per redeemed recharge code. **Platform cash collected =
`SUM(actualPaidAmount)` on this table.**

It is separate from `revenue_ledger` on purpose: that table recognises *course*
revenue and carries a teacher share, neither of which a wallet top-up has.

> **Accounting rule, stated once.** Cash enters the wallet system exactly once,
> at recharge. Spending credits on a library item is an *allocation* of cash
> already recognised, not new revenue. Counting both would double-count every
> pound.
>
> Course money is a **separate system entirely** and never mixes with this one:
> course and part access is sold as cards, offline, and those cards' face values
> are reported on their own. Never sum a wallet figure with a course figure.

### `access_codes` / `code_batches` — extended, not replaced

New column `kind` (`ACCESS` | `RECHARGE`), defaulting to `ACCESS`. Every row
that existed before this migration keeps granting course access.

`RECHARGE` rows additionally carry the four frozen numbers below.

`access_code_redemptions.courseId` is now nullable — a recharge redemption buys
credits, not a course. Existing rows are unchanged.

## The discount calculation

The rule the entire financial report rests on:

```
actualPaid = faceValue − discount     ← THE REVENUE
credits    = actualPaid               ← what the wallet receives
```

A 1 000 EGP card sold at 20% off is **800 EGP of revenue and 800 credits**, not
1 000 of either. The face value is a marketing number; it never appears in a
revenue total. `listRechargeCodes` and `rechargeRevenue` report
`discountGiven` separately so the gap between the two is explicit rather than
inferred.

| Face value | Discount | Paid (revenue) | Credits |
|---|---|---|---|
| 1000 | 20% | 800 | 800 |
| 500 | 20% | 400 | 400 |
| 1000 | 100% | 0 | 0 |
| 500 | 125.50 fixed | 374.50 | 374.50 |

A 100% discount is explicitly supported: a giveaway card that redeems, credits
nothing, and still writes a zero-revenue row so the giveaway appears in the
report rather than being invisible. A discount **larger** than the face value is
refused — it would mean negative revenue.

All four numbers are computed **once, at generation**, and frozen onto every
card in the batch. Changing the minimum-recharge setting or the discount policy
next month cannot retroactively change what a card already in a student's hand
is worth, because nothing recomputes them at redemption time.

### Arithmetic

All money arithmetic runs on **integer piastres** (`src/modules/wallet/money.ts`).
JavaScript numbers cannot represent 2-decimal currency exactly — `0.1 + 0.2 !==
0.3` — and a wallet wrong by a piastre per transaction is a wallet nobody can
audit. Percentages are parsed into basis points and rounded half-up, the way a
human doing the sum on paper would. A third decimal place is rejected rather
than rounded away, because that is a bug at the call site and hiding it moves
the loss into the ledger.

## How a balance is protected

A balance can never go negative. Three independent mechanisms, because this is
the failure that turns into real money:

1. **The debit is one conditional statement.**
   `UPDATE wallets SET balance = balance - x WHERE id = ? AND balance >= x`.
   The check and the deduction are the same atomic operation, so two concurrent
   purchases cannot both pass the check — whichever commits second finds the
   balance already reduced and updates zero rows, which the service turns into
   `INSUFFICIENT_CREDIT`. Read-modify-write in application code would defeat
   this, which is why `prisma.wallet.update` is not used on the balance.
2. **A Serializable transaction** (`MONEY_TX_OPTIONS`) wraps the whole purchase,
   so a failure at any step rolls the lot back.
3. **A CHECK constraint** on the column refuses a negative balance outright,
   whatever the application does.

`GET /admin/wallets/:userId/integrity` re-derives the balance from the ledger
and compares it with the cache. A cache nobody checks is a cache nobody should
trust. It is read-only: a mismatch is fixed with a compensating entry, never by
writing to `wallets.balance`.

## Redemption

One Serializable transaction does all of it, so a failure at any step leaves no
trace — no half-consumed code, no orphan credit, no revenue row without a
redemption:

1. re-read and re-validate the code **inside** the transaction;
2. credit the wallet with the code's frozen `creditAmount`;
3. write the redemption row (the unique `(codeId, userId)` index is the real
   double-redeem guarantee);
4. mark the code exhausted;
5. write the immutable revenue row at `actualPaidAmount`.

The amounts come from the code, never from the request — `POST /wallet/redeem`
has no amount parameter to post one into.

Unknown, revoked and expired cards all return the identical error, so the
endpoint cannot be used to guess valid codes. It is rate-limited on the same
bucket as code validation.

### The recharge/access separation

A recharge card has `courseId = NULL`, and the legacy course path reads a null
`courseId` as "a global code that unlocks anything". Both `validate()` and
`redeemInTransaction()` therefore reject `kind = RECHARGE` **before** any scope
resolution. This is what stops a 50 EGP top-up card opening every course on the
platform. The guard is repeated in both methods rather than shared, because the
redemption path must not depend on an earlier validation call having been made.

## Minimum recharge

Three new platform settings, editable at `PUT /admin/settings`:

| Key | Default | Meaning |
|---|---|---|
| `wallet.minimumRecharge` | `50` | Smallest face value a recharge card may carry, EGP. |
| `wallet.maximumRecharge` | `100000` | Largest face value, EGP. |
| `wallet.allowAdminOverrideMinimum` | `false` | Whether an admin may deliberately issue below the minimum. |

The minimum is checked against the **face value**, not the credited amount —
otherwise a legal 100% discount card would be impossible to issue. The override
is off by default, so the floor is a real floor rather than a suggestion the
dashboard can talk its way past.

## API

### Student

| Method | Path | Notes |
|---|---|---|
| `GET` | `/wallet` | Balance, totals, transaction count. Creates the wallet on first read. |
| `GET` | `/wallet/transactions` | Paginated, filterable by type/direction/source/date, searchable. |
| `POST` | `/wallet/redeem` | `{ code }`. No amount parameter. Rate-limited. |

Every route is scoped to the authenticated principal. There is no `userId`
parameter on the student controller — not optional, not ignored, **absent**.
The student projection never carries the acting administrator, the originating
card, or any other student's identity.

### Admin (`@AdminOnly()` — teachers excluded)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/wallets` | Student balances; search by name/phone; sort restricted to a fixed column set. |
| `GET` | `/admin/wallets/:userId` | Balance plus recent history. |
| `POST` | `/admin/wallets/:userId/adjust` | `{ amount, direction, reason }`. Reason required. |
| `GET` | `/admin/wallets/:userId/integrity` | Ledger vs cache. |
| `GET` | `/admin/wallet-transactions` | The full ledger, filterable. |
| `POST` | `/admin/recharge-codes/preview` | Computes the money without creating anything. |
| `POST` | `/admin/recharge-codes/generate` | Creates a batch; returns plaintext codes once. |
| `GET` | `/admin/recharge-codes` | Cards with their frozen financials. |
| `GET` | `/admin/recharge-revenue` | Cash collected, with totals. |

Wallets, balances and revenue are deliberately admin-only: a teacher who could
adjust a balance could pay themselves. Enforced server-side, not by hiding a
menu item.

## New error codes

`INSUFFICIENT_CREDIT` (402), `WALLET_LOCKED` (403), `AMOUNT_BELOW_MINIMUM`
(422), `CODE_NOT_RECHARGEABLE` (400).

> **Mobile follow-up required.** `ErrorCode` is mirrored in the student app's
> `ApiErrorCode` union and rendered from its locale bundles. Until the mobile
> phase adds these four to both the `en` and `ar` bundles, they degrade to a
> generic message in the app.

## Environment variables

**None added.** The minimum recharge is a platform setting, not an env var, so
it can be changed without a redeploy.

## Not built yet

Phase 1 is the wallet and recharge codes only. Still to come, in order:

- course parts (configurable structure, percentage/fixed pricing, part
  purchases, entitlements, historical price preservation);
- the library system (materials, parts, packages, purchases);
- protected PDF/document viewing and watermarking;
- video watermarking and the wider content-protection work;
- the notification audience builder, scheduling and recurrence;
- teacher/assistant permission scoping;
- dashboard and mobile UI for all of the above.

Course-part and library purchases will debit through `WalletService.debit()`
rather than touching the balance themselves. That is the point of keeping the
ledger behind one service: there is exactly one place where credit moves, so
there is exactly one place to audit.
