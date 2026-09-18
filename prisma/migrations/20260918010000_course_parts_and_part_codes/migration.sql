-- =============================================================================
-- Course parts, and the part-scoped access cards that unlock them
--
-- This replaces six migrations that were applied in an order their folder names
-- did not reflect:
--
--   20260918010000_course_parts              (hand-written)
--   20260918010748                           (auto: dropped an undeclared FK)
--   20260918012922                           (auto: dropped an undeclared column)
--   20260918020000_part_purchase_wallet_fk   (hand-written: restored the FK)
--   20260918030000_course_parts_by_code      (hand-written)
--   20260918040000_part_acquisition_provenance (hand-written: restored again)
--
-- The hand-written ones carried round, future timestamps; Prisma names its own
-- with the real UTC clock, so an auto-generated migration sorted into the
-- middle of the sequence and the shadow-database replay tried to drop a
-- constraint before the migration that creates it had run (P3006).
--
-- Squashed here into the single coherent end state. Nothing is added and then
-- taken away again.
--
-- Financial rule this encodes: **the wallet is for the Library only.** A course
-- part is unlocked by redeeming a part-scoped access card, and the money
-- changes hands offline when the card is sold — exactly as course-scoped and
-- section-scoped cards already work. `course_part_purchases.accessCodeId` is
-- the live provenance. `walletTransactionId` remains, nullable and unused, so
-- that any row from the withdrawn wallet-purchase build stays readable.
-- =============================================================================

-- --- enums -------------------------------------------------------------------

CREATE TYPE "PartPricingModel" AS ENUM ('PERCENTAGE', 'FIXED');

CREATE TYPE "PartEntitlementSource" AS ENUM ('PURCHASE', 'CODE', 'ADMIN', 'MIGRATION');

-- Values added to pre-existing types. PostgreSQL 12+ permits ADD VALUE inside a
-- transaction provided the value is not used in the same transaction, which it
-- is not here.
ALTER TYPE "SectionGrantSource" ADD VALUE IF NOT EXISTS 'PART_PURCHASE';
ALTER TYPE "CodeTargetType" ADD VALUE IF NOT EXISTS 'PART';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PART_PURCHASE';

-- --- course_parts ------------------------------------------------------------

CREATE TABLE "course_parts" (
  "id"           TEXT               NOT NULL,
  "courseId"     TEXT               NOT NULL,
  "title"        TEXT               NOT NULL,
  "titleAr"      TEXT,
  "description"  TEXT,
  "sortOrder"    INTEGER            NOT NULL,
  "status"       "ContentStatus"    NOT NULL DEFAULT 'PUBLISHED',
  "isActive"     BOOLEAN            NOT NULL DEFAULT true,
  "pricingModel" "PartPricingModel" NOT NULL DEFAULT 'PERCENTAGE',
  "pricePercent" DECIMAL(5, 2),
  "priceAmount"  DECIMAL(12, 2),
  "currency"     TEXT               NOT NULL DEFAULT 'EGP',
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)       NOT NULL,
  "deletedAt"    TIMESTAMP(3),

  CONSTRAINT "course_parts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_parts_courseId_sortOrder_key"
  ON "course_parts" ("courseId", "sortOrder");
CREATE INDEX "course_parts_courseId_isActive_sortOrder_idx"
  ON "course_parts" ("courseId", "isActive", "sortOrder");
CREATE INDEX "course_parts_deletedAt_idx" ON "course_parts" ("deletedAt");

ALTER TABLE "course_parts"
  ADD CONSTRAINT "course_parts_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_parts"
  ADD CONSTRAINT "course_parts_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- access cards can target a part ------------------------------------------

ALTER TABLE "access_codes" ADD COLUMN "coursePartId" TEXT;

CREATE INDEX "access_codes_coursePartId_idx" ON "access_codes" ("coursePartId");

ALTER TABLE "access_codes"
  ADD CONSTRAINT "access_codes_coursePartId_fkey"
  FOREIGN KEY ("coursePartId") REFERENCES "course_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "code_batches" ADD COLUMN "coursePartId" TEXT;

ALTER TABLE "code_batches"
  ADD CONSTRAINT "code_batches_coursePartId_fkey"
  FOREIGN KEY ("coursePartId") REFERENCES "course_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- course_part_purchases (immutable acquisition record) --------------------

CREATE TABLE "course_part_purchases" (
  "id"                     TEXT               NOT NULL,
  "userId"                 TEXT               NOT NULL,
  "courseId"               TEXT               NOT NULL,
  "coursePartId"           TEXT               NOT NULL,
  "priceAtPurchase"        DECIMAL(12, 2)     NOT NULL,
  "currency"               TEXT               NOT NULL DEFAULT 'EGP',
  "pricingModelAtPurchase" "PartPricingModel" NOT NULL,
  "pricePercentAtPurchase" DECIMAL(5, 2),
  "coursePriceAtPurchase"  DECIMAL(12, 2),
  "partTitleSnapshot"      TEXT               NOT NULL,
  "courseTitleSnapshot"    TEXT               NOT NULL,
  "teacherId"              TEXT,
  "sharePercent"           DECIMAL(5, 2),
  "teacherAmount"          DECIMAL(12, 2)     NOT NULL DEFAULT 0,
  "platformAmount"         DECIMAL(12, 2)     NOT NULL DEFAULT 0,
  "sectionIdsSnapshot"     TEXT[]             NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Provenance. Exactly one is set; see the CHECK at the end.
  "walletTransactionId"    TEXT,
  "accessCodeId"           TEXT,
  "idempotencyKey"         TEXT               NOT NULL,
  "purchasedAt"            TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"              TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "course_part_purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_part_purchases_walletTransactionId_key"
  ON "course_part_purchases" ("walletTransactionId");
CREATE UNIQUE INDEX "course_part_purchases_accessCodeId_key"
  ON "course_part_purchases" ("accessCodeId");
CREATE UNIQUE INDEX "course_part_purchases_idempotencyKey_key"
  ON "course_part_purchases" ("idempotencyKey");
CREATE INDEX "course_part_purchases_userId_purchasedAt_idx"
  ON "course_part_purchases" ("userId", "purchasedAt");
CREATE INDEX "course_part_purchases_courseId_purchasedAt_idx"
  ON "course_part_purchases" ("courseId", "purchasedAt");
CREATE INDEX "course_part_purchases_coursePartId_purchasedAt_idx"
  ON "course_part_purchases" ("coursePartId", "purchasedAt");
CREATE INDEX "course_part_purchases_teacherId_purchasedAt_idx"
  ON "course_part_purchases" ("teacherId", "purchasedAt");
CREATE INDEX "course_part_purchases_purchasedAt_idx"
  ON "course_part_purchases" ("purchasedAt");

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_coursePartId_fkey"
  FOREIGN KEY ("coursePartId") REFERENCES "course_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_walletTransactionId_fkey"
  FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_accessCodeId_fkey"
  FOREIGN KEY ("accessCodeId") REFERENCES "access_codes" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- course_part_entitlements ------------------------------------------------

CREATE TABLE "course_part_entitlements" (
  "id"            TEXT                    NOT NULL,
  "userId"        TEXT                    NOT NULL,
  "coursePartId"  TEXT                    NOT NULL,
  "courseId"      TEXT                    NOT NULL,
  "source"        "PartEntitlementSource" NOT NULL DEFAULT 'PURCHASE',
  "purchaseId"    TEXT,
  "grantedAt"     TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"     TIMESTAMP(3),
  "revokedById"   TEXT,
  "revokedReason" TEXT,
  "createdAt"     TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)            NOT NULL,

  CONSTRAINT "course_part_entitlements_pkey" PRIMARY KEY ("id")
);

-- The double-grant guarantee. Two concurrent redemptions cannot both create the
-- row, whatever the application does.
CREATE UNIQUE INDEX "course_part_entitlements_userId_coursePartId_key"
  ON "course_part_entitlements" ("userId", "coursePartId");
CREATE UNIQUE INDEX "course_part_entitlements_purchaseId_key"
  ON "course_part_entitlements" ("purchaseId");
CREATE INDEX "course_part_entitlements_userId_courseId_idx"
  ON "course_part_entitlements" ("userId", "courseId");
CREATE INDEX "course_part_entitlements_courseId_grantedAt_idx"
  ON "course_part_entitlements" ("courseId", "grantedAt");
CREATE INDEX "course_part_entitlements_coursePartId_revokedAt_idx"
  ON "course_part_entitlements" ("coursePartId", "revokedAt");

ALTER TABLE "course_part_entitlements"
  ADD CONSTRAINT "course_part_entitlements_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_entitlements"
  ADD CONSTRAINT "course_part_entitlements_coursePartId_fkey"
  FOREIGN KEY ("coursePartId") REFERENCES "course_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_entitlements"
  ADD CONSTRAINT "course_part_entitlements_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "course_part_entitlements"
  ADD CONSTRAINT "course_part_entitlements_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "course_part_purchases" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- existing content tables gain an optional part link -----------------------

ALTER TABLE "course_sections" ADD COLUMN "partId" TEXT;

CREATE INDEX "course_sections_partId_idx" ON "course_sections" ("partId");

-- SetNull, not Cascade: deleting a part must never delete the teaching material
-- inside it. The sections simply become unassigned.
ALTER TABLE "course_sections"
  ADD CONSTRAINT "course_sections_partId_fkey"
  FOREIGN KEY ("partId") REFERENCES "course_parts" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "enrollment_section_grants" ADD COLUMN "partId" TEXT;

CREATE INDEX "enrollment_section_grants_partId_idx"
  ON "enrollment_section_grants" ("partId");

ALTER TABLE "enrollment_section_grants"
  ADD CONSTRAINT "enrollment_section_grants_partId_fkey"
  FOREIGN KEY ("partId") REFERENCES "course_parts" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- pricing and money invariants, enforced by the database -------------------

-- A part carries the price its model calls for, and only that one. The service
-- validates the whole course's allocation; this stops a hand-edited row from
-- being internally nonsense.
ALTER TABLE "course_parts"
  ADD CONSTRAINT "course_parts_price_matches_model"
  CHECK (
    ("pricingModel" = 'PERCENTAGE' AND "pricePercent" IS NOT NULL AND "priceAmount" IS NULL)
    OR
    ("pricingModel" = 'FIXED' AND "priceAmount" IS NOT NULL AND "pricePercent" IS NULL)
  );

ALTER TABLE "course_parts"
  ADD CONSTRAINT "course_parts_percent_range"
  CHECK ("pricePercent" IS NULL OR ("pricePercent" >= 0 AND "pricePercent" <= 100));

ALTER TABLE "course_parts"
  ADD CONSTRAINT "course_parts_amount_non_negative"
  CHECK ("priceAmount" IS NULL OR "priceAmount" >= 0);

ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_amounts_non_negative"
  CHECK (
    "priceAtPurchase" >= 0
    AND "teacherAmount" >= 0
    AND "platformAmount" >= 0
  );

-- The teacher's cut plus the platform's cut is the whole value. If this ever
-- fails, money has gone missing between the two columns.
ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_split_sums_to_price"
  CHECK ("teacherAmount" + "platformAmount" = "priceAtPurchase");

-- Exactly one provenance. A row claiming both a wallet debit and a card, or
-- neither, is meaningless — and the second case is how an acquisition record
-- with nothing behind it would sneak in.
ALTER TABLE "course_part_purchases"
  ADD CONSTRAINT "course_part_purchases_one_acquisition_source"
  CHECK (
    ("walletTransactionId" IS NOT NULL AND "accessCodeId" IS NULL)
    OR
    ("walletTransactionId" IS NULL AND "accessCodeId" IS NOT NULL)
  );
