ALTER TYPE "StoreFeatureKey" ADD VALUE IF NOT EXISTS 'vendor_orders';

CREATE TYPE "VendorOrderStatus" AS ENUM (
  'DRAFT',
  'READY',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED'
);

CREATE TABLE "ProductVendor" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "vendorSku" TEXT,
  "unitsPerCase" INTEGER NOT NULL DEFAULT 1,
  "caseCost" DECIMAL(14,2) NOT NULL,
  "caseDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "minOrderQuantity" INTEGER,
  "leadTimeDays" INTEGER,
  "isPreferred" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductVendor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VendorOrder" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "status" "VendorOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "estimatedCost" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "purchaseId" TEXT,
  "notes" TEXT,
  "sentAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdByActorId" TEXT,
  "updatedByActorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VendorOrderItem" (
  "id" TEXT NOT NULL,
  "vendorOrderId" TEXT NOT NULL,
  "productVendorId" TEXT,
  "productId" TEXT NOT NULL,
  "quantityOrdered" INTEGER NOT NULL,
  "quantityReceived" INTEGER NOT NULL DEFAULT 0,
  "unitsPerCase" INTEGER NOT NULL DEFAULT 1,
  "caseCost" DECIMAL(14,2) NOT NULL,
  "caseDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  "unitCost" DECIMAL(14,4) NOT NULL,
  "extendedCost" DECIMAL(14,2) NOT NULL,
  "productNumberSnapshot" INTEGER,
  "barcodeSnapshot" TEXT,
  "productNameSnapshot" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVendor_storeId_productId_payeeId_key" ON "ProductVendor"("storeId", "productId", "payeeId");
CREATE INDEX "ProductVendor_storeId_productId_isActive_idx" ON "ProductVendor"("storeId", "productId", "isActive");
CREATE INDEX "ProductVendor_storeId_payeeId_isActive_idx" ON "ProductVendor"("storeId", "payeeId", "isActive");
CREATE INDEX "VendorOrder_storeId_status_createdAt_idx" ON "VendorOrder"("storeId", "status", "createdAt");
CREATE INDEX "VendorOrder_storeId_payeeId_createdAt_idx" ON "VendorOrder"("storeId", "payeeId", "createdAt");
CREATE INDEX "VendorOrderItem_vendorOrderId_idx" ON "VendorOrderItem"("vendorOrderId");
CREATE INDEX "VendorOrderItem_productId_vendorOrderId_idx" ON "VendorOrderItem"("productId", "vendorOrderId");

ALTER TABLE "ProductVendor" ADD CONSTRAINT "ProductVendor_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVendor" ADD CONSTRAINT "ProductVendor_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVendor" ADD CONSTRAINT "ProductVendor_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorOrder" ADD CONSTRAINT "VendorOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorOrder" ADD CONSTRAINT "VendorOrder_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorOrderItem" ADD CONSTRAINT "VendorOrderItem_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "VendorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorOrderItem" ADD CONSTRAINT "VendorOrderItem_productVendorId_fkey" FOREIGN KEY ("productVendorId") REFERENCES "ProductVendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VendorOrderItem" ADD CONSTRAINT "VendorOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
