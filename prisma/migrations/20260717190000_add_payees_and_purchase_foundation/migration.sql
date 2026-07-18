ALTER TYPE "StorePermissionKey" ADD VALUE IF NOT EXISTS 'view_purchases';
ALTER TYPE "StorePermissionKey" ADD VALUE IF NOT EXISTS 'manage_purchases';
ALTER TYPE "StorePermissionKey" ADD VALUE IF NOT EXISTS 'manage_payees';

ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'payee';
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'purchase';

CREATE TYPE "PurchaseType" AS ENUM ('CASH_DAILY', 'CHECK', 'CREDIT');
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'OPEN', 'VERIFIED', 'VOIDED');

ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "nextPurchaseNumber" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "Payee" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "accountNumber" TEXT,
  "contactName" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "notes" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "storeId" TEXT NOT NULL,

  CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Purchase" (
  "id" TEXT NOT NULL,
  "purchaseNumber" INTEGER NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "purchaseDate" TIMESTAMP(3) NOT NULL,
  "type" "PurchaseType" NOT NULL,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
  "costSubtotal" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "retailTotal" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "freightAmount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "rebateAmount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "marginPercent" DECIMAL(8,4),
  "referenceNumber" TEXT,
  "notes" TEXT,
  "storeId" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "createdByActorId" TEXT,
  "updatedByActorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseItem" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitCost" DECIMAL(14,4) NOT NULL,
  "extendedCost" DECIMAL(14,2) NOT NULL,
  "unitRetailSnapshot" DECIMAL(14,2) NOT NULL,
  "extendedRetail" DECIMAL(14,2) NOT NULL,
  "productNumberSnapshot" INTEGER,
  "barcodeSnapshot" TEXT,
  "productNameSnapshot" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payee_storeId_name_key" ON "Payee"("storeId", "name");
CREATE INDEX "Payee_storeId_isActive_name_idx" ON "Payee"("storeId", "isActive", "name");

CREATE UNIQUE INDEX "Purchase_storeId_purchaseNumber_key" ON "Purchase"("storeId", "purchaseNumber");
CREATE UNIQUE INDEX "Purchase_storeId_payeeId_invoiceNumber_key" ON "Purchase"("storeId", "payeeId", "invoiceNumber");
CREATE INDEX "Purchase_storeId_purchaseDate_idx" ON "Purchase"("storeId", "purchaseDate");
CREATE INDEX "Purchase_storeId_status_purchaseDate_idx" ON "Purchase"("storeId", "status", "purchaseDate");
CREATE INDEX "Purchase_storeId_payeeId_purchaseDate_idx" ON "Purchase"("storeId", "payeeId", "purchaseDate");
CREATE INDEX "Purchase_storeId_type_purchaseDate_idx" ON "Purchase"("storeId", "type", "purchaseDate");
CREATE INDEX "Purchase_storeId_purchaseNumber_idx" ON "Purchase"("storeId", "purchaseNumber");

CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");
CREATE INDEX "PurchaseItem_productId_purchaseId_idx" ON "PurchaseItem"("productId", "purchaseId");

ALTER TABLE "Payee" ADD CONSTRAINT "Payee_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_createdByActorId_fkey" FOREIGN KEY ("createdByActorId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_updatedByActorId_fkey" FOREIGN KEY ("updatedByActorId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
