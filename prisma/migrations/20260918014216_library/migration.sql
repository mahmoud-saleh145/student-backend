-- =============================================================================
-- Library
--
-- A separate top-level system: documents sold for wallet credits, independent
-- of courses in both directions. Owning a course grants nothing here, and a
-- student may buy library material while enrolled in nothing at all.
--
-- Purely additive. No existing table is altered and no existing row is touched;
-- every object below is new.
--
-- Folder named with the real UTC clock, so a Prisma-generated migration can
-- never sort into the middle of this sequence — the mistake that broke the
-- course-parts history.
-- =============================================================================

-- --- enums -------------------------------------------------------------------

CREATE TYPE "LibraryPurchaseKind" AS ENUM ('PART', 'PACKAGE');

CREATE TYPE "LibraryEntitlementSource" AS ENUM ('PURCHASE', 'PACKAGE', 'ADMIN');

-- --- library_materials -------------------------------------------------------

CREATE TABLE "library_materials" (
  "id"             TEXT            NOT NULL,
  "title"          TEXT            NOT NULL,
  "titleAr"        TEXT,
  "description"    TEXT,
  "coverKey"       TEXT,
  "status"         "ContentStatus" NOT NULL DEFAULT 'DRAFT',
  "isActive"       BOOLEAN         NOT NULL DEFAULT true,
  "sortOrder"      INTEGER         NOT NULL DEFAULT 0,
  "universityId"   TEXT,
  "facultyId"      TEXT,
  "academicYearId" TEXT,
  "subjectId"      TEXT,
  "createdById"    TEXT,
  "publishedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)    NOT NULL,
  "deletedAt"      TIMESTAMP(3),

  CONSTRAINT "library_materials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "library_materials_status_sortOrder_idx"
  ON "library_materials" ("status", "sortOrder");
CREATE INDEX "library_materials_universityId_facultyId_academicYearId_idx"
  ON "library_materials" ("universityId", "facultyId", "academicYearId");
CREATE INDEX "library_materials_subjectId_idx" ON "library_materials" ("subjectId");
CREATE INDEX "library_materials_deletedAt_idx" ON "library_materials" ("deletedAt");
CREATE INDEX "library_materials_title_idx" ON "library_materials" ("title");

ALTER TABLE "library_materials"
  ADD CONSTRAINT "library_materials_universityId_fkey"
  FOREIGN KEY ("universityId") REFERENCES "universities" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "library_materials"
  ADD CONSTRAINT "library_materials_facultyId_fkey"
  FOREIGN KEY ("facultyId") REFERENCES "faculties" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "library_materials"
  ADD CONSTRAINT "library_materials_academicYearId_fkey"
  FOREIGN KEY ("academicYearId") REFERENCES "academic_years" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "library_materials"
  ADD CONSTRAINT "library_materials_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "subjects" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "library_materials"
  ADD CONSTRAINT "library_materials_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- library_parts -----------------------------------------------------------

CREATE TABLE "library_parts" (
  "id"           TEXT            NOT NULL,
  "materialId"   TEXT            NOT NULL,
  "title"        TEXT            NOT NULL,
  "titleAr"      TEXT,
  "description"  TEXT,
  "sortOrder"    INTEGER         NOT NULL,
  "status"       "ContentStatus" NOT NULL DEFAULT 'PUBLISHED',
  "isActive"     BOOLEAN         NOT NULL DEFAULT true,
  "price"        DECIMAL(12, 2)  NOT NULL,
  "currency"     TEXT            NOT NULL DEFAULT 'EGP',
  "objectKey"    TEXT            NOT NULL,
  "mimeType"     TEXT,
  "sizeBytes"    BIGINT,
  "pageCount"    INTEGER,
  "isPreview"    BOOLEAN         NOT NULL DEFAULT false,
  "uploadedById" TEXT,
  "createdAt"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)    NOT NULL,
  "deletedAt"    TIMESTAMP(3),

  CONSTRAINT "library_parts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "library_parts_materialId_sortOrder_key"
  ON "library_parts" ("materialId", "sortOrder");
CREATE INDEX "library_parts_materialId_isActive_sortOrder_idx"
  ON "library_parts" ("materialId", "isActive", "sortOrder");
CREATE INDEX "library_parts_deletedAt_idx" ON "library_parts" ("deletedAt");

ALTER TABLE "library_parts"
  ADD CONSTRAINT "library_parts_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "library_materials" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- --- library_packages --------------------------------------------------------

CREATE TABLE "library_packages" (
  "id"          TEXT            NOT NULL,
  "materialId"  TEXT,
  "title"       TEXT            NOT NULL,
  "titleAr"     TEXT,
  "description" TEXT,
  "status"      "ContentStatus" NOT NULL DEFAULT 'PUBLISHED',
  "isActive"    BOOLEAN         NOT NULL DEFAULT true,
  "sortOrder"   INTEGER         NOT NULL DEFAULT 0,
  "price"       DECIMAL(12, 2)  NOT NULL,
  "currency"    TEXT            NOT NULL DEFAULT 'EGP',
  "createdAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)    NOT NULL,
  "deletedAt"   TIMESTAMP(3),

  CONSTRAINT "library_packages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "library_packages_materialId_isActive_sortOrder_idx"
  ON "library_packages" ("materialId", "isActive", "sortOrder");
CREATE INDEX "library_packages_deletedAt_idx" ON "library_packages" ("deletedAt");

ALTER TABLE "library_packages"
  ADD CONSTRAINT "library_packages_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "library_materials" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- --- library_package_items ---------------------------------------------------

CREATE TABLE "library_package_items" (
  "id"            TEXT         NOT NULL,
  "packageId"     TEXT         NOT NULL,
  "libraryPartId" TEXT         NOT NULL,
  "sortOrder"     INTEGER      NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "library_package_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "library_package_items_packageId_libraryPartId_key"
  ON "library_package_items" ("packageId", "libraryPartId");
CREATE INDEX "library_package_items_libraryPartId_idx"
  ON "library_package_items" ("libraryPartId");

ALTER TABLE "library_package_items"
  ADD CONSTRAINT "library_package_items_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "library_packages" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, not Cascade: a part that is inside a package cannot be deleted out
-- from under it. Removing it from the package is an explicit act.
ALTER TABLE "library_package_items"
  ADD CONSTRAINT "library_package_items_libraryPartId_fkey"
  FOREIGN KEY ("libraryPartId") REFERENCES "library_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- library_purchases (immutable) -------------------------------------------

CREATE TABLE "library_purchases" (
  "id"                    TEXT                  NOT NULL,
  "userId"                TEXT                  NOT NULL,
  "kind"                  "LibraryPurchaseKind" NOT NULL,
  "libraryPartId"         TEXT,
  "libraryPackageId"      TEXT,
  "priceAtPurchase"       DECIMAL(12, 2)        NOT NULL,
  "currency"              TEXT                  NOT NULL DEFAULT 'EGP',
  "titleSnapshot"         TEXT                  NOT NULL,
  "materialTitleSnapshot" TEXT,
  "partIdsSnapshot"       TEXT[]                NOT NULL DEFAULT ARRAY[]::TEXT[],
  "walletTransactionId"   TEXT                  NOT NULL,
  "idempotencyKey"        TEXT                  NOT NULL,
  "purchasedAt"           TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"             TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "library_purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "library_purchases_walletTransactionId_key"
  ON "library_purchases" ("walletTransactionId");
CREATE UNIQUE INDEX "library_purchases_idempotencyKey_key"
  ON "library_purchases" ("idempotencyKey");
CREATE INDEX "library_purchases_userId_purchasedAt_idx"
  ON "library_purchases" ("userId", "purchasedAt");
CREATE INDEX "library_purchases_kind_purchasedAt_idx"
  ON "library_purchases" ("kind", "purchasedAt");
CREATE INDEX "library_purchases_libraryPartId_idx"
  ON "library_purchases" ("libraryPartId");
CREATE INDEX "library_purchases_libraryPackageId_idx"
  ON "library_purchases" ("libraryPackageId");
CREATE INDEX "library_purchases_purchasedAt_idx"
  ON "library_purchases" ("purchasedAt");

ALTER TABLE "library_purchases"
  ADD CONSTRAINT "library_purchases_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library_purchases"
  ADD CONSTRAINT "library_purchases_libraryPartId_fkey"
  FOREIGN KEY ("libraryPartId") REFERENCES "library_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library_purchases"
  ADD CONSTRAINT "library_purchases_libraryPackageId_fkey"
  FOREIGN KEY ("libraryPackageId") REFERENCES "library_packages" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library_purchases"
  ADD CONSTRAINT "library_purchases_walletTransactionId_fkey"
  FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- library_entitlements ----------------------------------------------------

CREATE TABLE "library_entitlements" (
  "id"            TEXT                       NOT NULL,
  "userId"        TEXT                       NOT NULL,
  "libraryPartId" TEXT                       NOT NULL,
  "source"        "LibraryEntitlementSource" NOT NULL DEFAULT 'PURCHASE',
  "purchaseId"    TEXT,
  "grantedAt"     TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"     TIMESTAMP(3),
  "revokedById"   TEXT,
  "revokedReason" TEXT,
  "createdAt"     TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)               NOT NULL,

  CONSTRAINT "library_entitlements_pkey" PRIMARY KEY ("id")
);

-- A student holds a part once. Two concurrent purchases cannot both create the
-- row, and a package overlapping a part already owned cannot duplicate it.
CREATE UNIQUE INDEX "library_entitlements_userId_libraryPartId_key"
  ON "library_entitlements" ("userId", "libraryPartId");
CREATE INDEX "library_entitlements_userId_revokedAt_idx"
  ON "library_entitlements" ("userId", "revokedAt");
CREATE INDEX "library_entitlements_libraryPartId_revokedAt_idx"
  ON "library_entitlements" ("libraryPartId", "revokedAt");
CREATE INDEX "library_entitlements_purchaseId_idx"
  ON "library_entitlements" ("purchaseId");

ALTER TABLE "library_entitlements"
  ADD CONSTRAINT "library_entitlements_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library_entitlements"
  ADD CONSTRAINT "library_entitlements_libraryPartId_fkey"
  FOREIGN KEY ("libraryPartId") REFERENCES "library_parts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library_entitlements"
  ADD CONSTRAINT "library_entitlements_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "library_purchases" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- money and shape invariants, enforced by the database ---------------------

ALTER TABLE "library_parts"
  ADD CONSTRAINT "library_parts_price_non_negative" CHECK ("price" >= 0);

ALTER TABLE "library_packages"
  ADD CONSTRAINT "library_packages_price_non_negative" CHECK ("price" >= 0);

ALTER TABLE "library_purchases"
  ADD CONSTRAINT "library_purchases_price_non_negative"
  CHECK ("priceAtPurchase" >= 0);

-- A purchase names exactly the thing its kind says it bought. Anything else is
-- a row nobody can interpret.
ALTER TABLE "library_purchases"
  ADD CONSTRAINT "library_purchases_target_matches_kind"
  CHECK (
    ("kind" = 'PART'    AND "libraryPartId" IS NOT NULL AND "libraryPackageId" IS NULL)
    OR
    ("kind" = 'PACKAGE' AND "libraryPackageId" IS NOT NULL AND "libraryPartId" IS NULL)
  );
