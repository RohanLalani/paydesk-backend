-- AlterTable
ALTER TABLE "InventoryLog"
ADD COLUMN "productName" TEXT,
ADD COLUMN "productBarcode" TEXT,
ADD COLUMN "productNumber" INTEGER,
ADD COLUMN "inventoryAdjustmentReasonId" TEXT;

-- CreateIndex
CREATE INDEX "InventoryLog_inventoryAdjustmentReasonId_idx" ON "InventoryLog"("inventoryAdjustmentReasonId");

-- AddForeignKey
ALTER TABLE "InventoryLog" ADD CONSTRAINT "InventoryLog_inventoryAdjustmentReasonId_fkey" FOREIGN KEY ("inventoryAdjustmentReasonId") REFERENCES "InventoryAdjustmentReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
