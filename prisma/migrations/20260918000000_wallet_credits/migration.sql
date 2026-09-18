-- =============================================================================
-- Wallet / credit system
--
-- Additive only. Nothing is dropped, nothing is back-filled destructively, and
-- every new column on an existing table is either nullable or carries a default
-- that reproduces the pre-migration behaviour:
--
--   * access_codes.kind and code_batches.kind default to 'ACCESS', so every
--     code that exists today keeps granting course access exactly as before.
--   * access_code_redemptions."courseId" only loses its NOT NULL constraint;
--     existing rows keep their value. Relaxing a constraint is safe to roll
--     forward and the data is unchanged.
--
-- The CHECK constraints at the end are the last line of defence for the money
-- rules the service also enforces: a balance can never be negative, a ledger
-- amount is always positive, and a discount percentage is always 0-100.
-- =============================================================================

-- --- enums -------------------------------------------------------------------

CREATE TYPE "CodeKind" AS ENUM ('ACCESS', 'RECHARGE');

CREATE TYPE "DiscountType" AS ENUM ('NONE', 'PERCENTAGE', 'FIXED');

CREATE TYPE "WalletTxType" AS ENUM (
  'CREDIT_RECHARGE',
  'PURCHASE',
  'REFUND',
  'ADMIN_ADJUSTMENT',
  'REVERSAL'
);

CREATE TYPE "WalletTxDirection" AS ENUM ('CREDIT', 'DEBIT');

CREATE TYPE "WalletTxSource" AS ENUM (
  'PAYMENT_CODE',
  'COURSE_PART',
  'LIBRARY_PART',
  'LIBRARY_PACKAGE',
  'ADMIN',
  'SYSTEM'
);

-- New audit actions. PostgreSQL 12+ permits ADD VALUE inside a transaction as
-- long as the value is not used in the same transaction, which it is not here.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WALLET_CREDIT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WALLET_DEBIT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WALLET_ADJUST';

-- --- wallets -----------------------------------------------------------------

CREATE TABLE "wallets" (
  "id"             TEXT           NOT NULL,
  "userId"         TEXT           NOT NULL,
  "balance"        DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "currency"       TEXT           NOT NULL DEFAULT 'EGP',
  "totalRecharged" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "totalSpent"     DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "version"        INTEGER        NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)   NOT NULL,

  CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets" ("userId");
CREATE INDEX "wallets_balance_idx" ON "wallets" ("balance");

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- wallet_transactions (append-only ledger) --------------------------------

CREATE TABLE "wallet_transactions" (
  "id"                 TEXT                NOT NULL,
  "walletId"           TEXT                NOT NULL,
  "userId"             TEXT                NOT NULL,
  "type"               "WalletTxType"      NOT NULL,
  "direction"          "WalletTxDirection" NOT NULL,
  "source"             "WalletTxSource"    NOT NULL DEFAULT 'SYSTEM',
  "amount"             DECIMAL(12, 2)      NOT NULL,
  "currency"           TEXT                NOT NULL DEFAULT 'EGP',
  "balanceBefore"      DECIMAL(12, 2)      NOT NULL,
  "balanceAfter"       DECIMAL(12, 2)      NOT NULL,
  "accessCodeId"       TEXT,
  "referenceType"      TEXT,
  "referenceId"        TEXT,
  "performedByAdminId" TEXT,
  "note"               TEXT,
  "metadata"           JSONB,
  "idempotencyKey"     TEXT,
  "createdAt"          TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_transactions_idempotencyKey_key"
  ON "wallet_transactions" ("idempotencyKey");
CREATE INDEX "wallet_transactions_walletId_createdAt_idx"
  ON "wallet_transactions" ("walletId", "createdAt");
CREATE INDEX "wallet_transactions_userId_createdAt_idx"
  ON "wallet_transactions" ("userId", "createdAt");
CREATE INDEX "wallet_transactions_type_createdAt_idx"
  ON "wallet_transactions" ("type", "createdAt");
CREATE INDEX "wallet_transactions_source_createdAt_idx"
  ON "wallet_transactions" ("source", "createdAt");
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx"
  ON "wallet_transactions" ("referenceType", "referenceId");
CREATE INDEX "wallet_transactions_accessCodeId_idx"
  ON "wallet_transactions" ("accessCodeId");

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "wallets" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_performedByAdminId_fkey"
  FOREIGN KEY ("performedByAdminId") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- recharge_revenue (immutable cash-in record) -----------------------------

CREATE TABLE "recharge_revenue" (
  "id"                TEXT           NOT NULL,
  "accessCodeId"      TEXT           NOT NULL,
  "batchId"           TEXT,
  "userId"            TEXT           NOT NULL,
  "faceValue"         DECIMAL(12, 2) NOT NULL,
  "discountType"      "DiscountType" NOT NULL DEFAULT 'NONE',
  "discountPercent"   DECIMAL(5, 2),
  "discountAmount"    DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "actualPaidAmount"  DECIMAL(12, 2) NOT NULL,
  "creditAmount"      DECIMAL(12, 2) NOT NULL,
  "currency"          TEXT           NOT NULL DEFAULT 'EGP',
  "batchNameSnapshot" TEXT,
  "codeSnapshot"      TEXT           NOT NULL,
  "recognizedAt"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"         TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recharge_revenue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recharge_revenue_accessCodeId_key"
  ON "recharge_revenue" ("accessCodeId");
CREATE INDEX "recharge_revenue_recognizedAt_idx"
  ON "recharge_revenue" ("recognizedAt");
CREATE INDEX "recharge_revenue_userId_recognizedAt_idx"
  ON "recharge_revenue" ("userId", "recognizedAt");
CREATE INDEX "recharge_revenue_batchId_recognizedAt_idx"
  ON "recharge_revenue" ("batchId", "recognizedAt");

ALTER TABLE "recharge_revenue"
  ADD CONSTRAINT "recharge_revenue_accessCodeId_fkey"
  FOREIGN KEY ("accessCodeId") REFERENCES "access_codes" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recharge_revenue"
  ADD CONSTRAINT "recharge_revenue_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "code_batches" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recharge_revenue"
  ADD CONSTRAINT "recharge_revenue_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- access_codes: recharge columns ------------------------------------------

ALTER TABLE "access_codes"
  ADD COLUMN "kind"             "CodeKind"     NOT NULL DEFAULT 'ACCESS',
  ADD COLUMN "faceValue"        DECIMAL(12, 2),
  ADD COLUMN "discountType"     "DiscountType" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "discountPercent"  DECIMAL(5, 2),
  ADD COLUMN "discountAmount"   DECIMAL(12, 2),
  ADD COLUMN "actualPaidAmount" DECIMAL(12, 2),
  ADD COLUMN "creditAmount"     DECIMAL(12, 2),
  ADD COLUMN "redeemedAt"       TIMESTAMP(3),
  ADD COLUMN "redeemedByUserId" TEXT;

CREATE INDEX "access_codes_kind_status_idx" ON "access_codes" ("kind", "status");
CREATE INDEX "access_codes_kind_createdAt_idx" ON "access_codes" ("kind", "createdAt");
CREATE INDEX "access_codes_redeemedAt_idx" ON "access_codes" ("redeemedAt");

-- --- code_batches: recharge columns ------------------------------------------

ALTER TABLE "code_batches"
  ADD COLUMN "kind"             "CodeKind"     NOT NULL DEFAULT 'ACCESS',
  ADD COLUMN "faceValue"        DECIMAL(12, 2),
  ADD COLUMN "discountType"     "DiscountType" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "discountPercent"  DECIMAL(5, 2),
  ADD COLUMN "discountAmount"   DECIMAL(12, 2),
  ADD COLUMN "actualPaidAmount" DECIMAL(12, 2),
  ADD COLUMN "creditAmount"     DECIMAL(12, 2);

CREATE INDEX "code_batches_kind_createdAt_idx" ON "code_batches" ("kind", "createdAt");

-- --- access_code_redemptions: allow a course-less (recharge) redemption -------

ALTER TABLE "access_code_redemptions"
  ALTER COLUMN "courseId" DROP NOT NULL;

ALTER TABLE "access_code_redemptions"
  ADD COLUMN "walletTransactionId" TEXT,
  ADD COLUMN "creditedAmount"      DECIMAL(12, 2);

CREATE UNIQUE INDEX "access_code_redemptions_walletTransactionId_key"
  ON "access_code_redemptions" ("walletTransactionId");

ALTER TABLE "access_code_redemptions"
  ADD CONSTRAINT "access_code_redemptions_walletTransactionId_fkey"
  FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- money invariants, enforced by the database -------------------------------

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance" >= 0);

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_totals_non_negative"
  CHECK ("totalRecharged" >= 0 AND "totalSpent" >= 0);

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_balances_non_negative"
  CHECK ("balanceBefore" >= 0 AND "balanceAfter" >= 0);

ALTER TABLE "recharge_revenue"
  ADD CONSTRAINT "recharge_revenue_amounts_non_negative"
  CHECK (
    "faceValue" >= 0
    AND "discountAmount" >= 0
    AND "actualPaidAmount" >= 0
    AND "creditAmount" >= 0
  );

ALTER TABLE "recharge_revenue"
  ADD CONSTRAINT "recharge_revenue_discount_within_face"
  CHECK ("discountAmount" <= "faceValue");

ALTER TABLE "recharge_revenue"
  ADD CONSTRAINT "recharge_revenue_percent_range"
  CHECK ("discountPercent" IS NULL OR ("discountPercent" >= 0 AND "discountPercent" <= 100));

ALTER TABLE "access_codes"
  ADD CONSTRAINT "access_codes_discount_percent_range"
  CHECK ("discountPercent" IS NULL OR ("discountPercent" >= 0 AND "discountPercent" <= 100));

ALTER TABLE "code_batches"
  ADD CONSTRAINT "code_batches_discount_percent_range"
  CHECK ("discountPercent" IS NULL OR ("discountPercent" >= 0 AND "discountPercent" <= 100));
