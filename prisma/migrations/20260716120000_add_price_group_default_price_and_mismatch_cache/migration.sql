ALTER TABLE "PriceGroup"
ADD COLUMN "defaultUnitRetail" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "mismatchedItemCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "mismatchCountUpdatedAt" TIMESTAMP(3);

CREATE INDEX "PriceGroup_storeId_mismatchedItemCount_idx" ON "PriceGroup"("storeId", "mismatchedItemCount");
