-- =============================================================================
-- course_part_purchases: one card, many students
--
-- ## What was broken
--
-- `accessCodeId` carried a UNIQUE index, which made a purchase one-to-one with
-- the card that paid for it. But a part card is routinely multi-use: one code,
-- `maxRedemptions` copies sold, one redemption per student. The first
-- redemption wrote `accessCodeId = <code>` and every later student's insert hit
-- the unique index. Because redemption runs in a Serializable transaction
-- alongside the code consumption and the access grant, the abort took the whole
-- redemption with it and surfaced as a 500 — not as a message an admin or a
-- student could act on.
--
-- The practical effect: a batch of fifty printed cards, or any card generated
-- with `maxRedemptions > 1`, was redeemable by exactly one student. The second
-- attempt failed with a raw Prisma unique-constraint error.
--
-- The idempotency key was already correct throughout: `partcode:<codeId>:<userId>`
-- permits exactly one purchase per student per card, which is the invariant that
-- was actually wanted. This migration moves uniqueness onto nothing new — it
-- simply stops the FK from being one that contradicts multi-use.
--
-- ## What changes
--
-- Drops `course_part_purchases_accessCodeId_key` and adds a non-unique index
-- with the same name minus `_key`. The foreign key is left in place; only the
-- uniqueness is dropped.
--
-- `course_part_purchases_walletTransactionId_key` is deliberately KEPT unique:
-- a wallet transaction is one purchase, so 1:1 is the correct shape there, and
-- nothing writes that column any more.
--
-- ## Safety
--
-- The CHECK constraint on provenance is untouched, and it is what enforces
-- "exactly one of walletTransactionId / accessCodeId" — so the exclusivity of
-- provenance per row is still guaranteed.
--
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and Prisma runs
-- each migration in one. `DROP INDEX` here takes a brief ACCESS EXCLUSIVE lock
-- on this one table, and `course_part_purchases` is a reporting table written by
-- card redemption — not a hot read path — so the lock window is acceptable. Apply
-- during a quiet moment rather than at a redemption peak.
-- =============================================================================

DROP INDEX IF EXISTS "course_part_purchases_accessCodeId_key";

CREATE INDEX IF NOT EXISTS "course_part_purchases_accessCodeId_idx"
  ON "course_part_purchases" ("accessCodeId");