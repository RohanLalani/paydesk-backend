-- CreateEnum
CREATE TYPE "DepartmentType" AS ENUM ('merchandise', 'lottery', 'fuel', 'misc_services');

-- CreateEnum
CREATE TYPE "DepartmentMinimumAge" AS ENUM ('none', 'age_18', 'age_18_time_sensitive', 'age_21', 'age_21_time_sensitive');

-- AlterTable
ALTER TABLE "Department"
  ADD COLUMN "posDepartmentNumber" INTEGER,
  ADD COLUMN "type" "DepartmentType" NOT NULL DEFAULT 'merchandise',
  ADD COLUMN "minimumAge" "DepartmentMinimumAge" NOT NULL DEFAULT 'none',
  ADD COLUMN "defaultRetailMargin" DECIMAL(8,4),
  ADD COLUMN "minimumRingUpAmount" DECIMAL(12,2),
  ADD COLUMN "maximumRingUpAmount" DECIMAL(12,2),
  ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "allowNegativeInventorySales" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowEbt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowManualRingUp" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "onPos" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "defaultTaxId" TEXT;

-- Preserve current EBT defaults.
UPDATE "Department"
SET "allowEbt" = "defaultAllowEbt";

-- Backfill a stable unique POS department number per store.
WITH numbered_departments AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "storeId"
      ORDER BY "createdAt" ASC, "name" ASC, "id" ASC
    ) AS number
  FROM "Department"
)
UPDATE "Department" AS department
SET "posDepartmentNumber" = numbered_departments.number
FROM numbered_departments
WHERE department."id" = numbered_departments."id";

-- Best-effort tax backfill from active store tax. Stores without an active tax remain nullable and must be configured in the UI/API.
WITH store_default_tax AS (
  SELECT DISTINCT ON ("storeId")
    "storeId",
    "id" AS "taxId"
  FROM "Tax"
  WHERE "isActive" = true
  ORDER BY "storeId", "name" ASC, "id" ASC
)
UPDATE "Department" AS department
SET "defaultTaxId" = store_default_tax."taxId"
FROM store_default_tax
WHERE department."storeId" = store_default_tax."storeId";

-- Enforce required POS department number after backfill.
ALTER TABLE "Department"
  ALTER COLUMN "posDepartmentNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Department_storeId_posDepartmentNumber_key" ON "Department"("storeId", "posDepartmentNumber");

-- CreateIndex
CREATE INDEX "Department_storeId_onPos_posDepartmentNumber_idx" ON "Department"("storeId", "onPos", "posDepartmentNumber");

-- CreateIndex
CREATE INDEX "Department_defaultTaxId_idx" ON "Department"("defaultTaxId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_defaultTaxId_fkey" FOREIGN KEY ("defaultTaxId") REFERENCES "Tax"("id") ON DELETE SET NULL ON UPDATE CASCADE;
