ALTER TABLE "Purchase"
ADD COLUMN "manualCost" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "manualRetail" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "manualMargin" DECIMAL(8,4),
ADD COLUMN "inventoryPostedAt" TIMESTAMP(3);

ALTER TABLE "PurchaseItem"
ADD COLUMN "departmentId" TEXT,
ADD COLUMN "priceGroupId" TEXT,
ADD COLUMN "categoryId" TEXT,
ADD COLUMN "unitsPerCase" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "caseCost" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "caseDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "rebate" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "entryType" TEXT NOT NULL DEFAULT 'purchase',
ADD COLUMN "source" TEXT;

CREATE TABLE "PurchaseExpense" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "departmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PurchaseExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseItem_departmentId_idx" ON "PurchaseItem"("departmentId");
CREATE INDEX "PurchaseExpense_purchaseId_idx" ON "PurchaseExpense"("purchaseId");
CREATE INDEX "PurchaseExpense_departmentId_idx" ON "PurchaseExpense"("departmentId");

ALTER TABLE "PurchaseExpense" ADD CONSTRAINT "PurchaseExpense_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
