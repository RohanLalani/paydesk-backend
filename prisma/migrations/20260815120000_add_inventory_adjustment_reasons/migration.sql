-- CreateTable
CREATE TABLE "InventoryAdjustmentReason" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryAdjustmentReason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAdjustmentReason_storeId_normalizedName_key" ON "InventoryAdjustmentReason"("storeId", "normalizedName");

-- CreateIndex
CREATE INDEX "InventoryAdjustmentReason_storeId_isActive_idx" ON "InventoryAdjustmentReason"("storeId", "isActive");

-- CreateIndex
CREATE INDEX "InventoryAdjustmentReason_storeId_createdAt_idx" ON "InventoryAdjustmentReason"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "InventoryAdjustmentReason" ADD CONSTRAINT "InventoryAdjustmentReason_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
