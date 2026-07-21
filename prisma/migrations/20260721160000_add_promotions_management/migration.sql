ALTER TYPE "AuditAction" ADD VALUE 'pause';
ALTER TYPE "AuditAction" ADD VALUE 'archive';
ALTER TYPE "AuditEntityType" ADD VALUE 'promotion';
ALTER TYPE "StorePermissionKey" ADD VALUE 'view_promotions';
ALTER TYPE "StorePermissionKey" ADD VALUE 'manage_promotions';
ALTER TYPE "StorePermissionKey" ADD VALUE 'activate_promotions';
ALTER TYPE "StorePermissionKey" ADD VALUE 'override_promotions';

CREATE TYPE "PromotionType" AS ENUM ('BUY_X_GET_Y_FREE', 'BUY_X_GET_Y_PERCENT_OFF', 'BUY_X_GET_Y_FIXED_PRICE', 'QUANTITY_BUNDLE_PRICE', 'QUANTITY_PERCENT_OFF', 'FIXED_AMOUNT_OFF_ITEM', 'PERCENT_OFF_ITEM', 'FIXED_AMOUNT_OFF_GROUP', 'MIX_AND_MATCH_BUNDLE', 'SPEND_THRESHOLD_FIXED_OFF', 'SPEND_THRESHOLD_PERCENT_OFF', 'CUSTOM_PRICE');
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'EXPIRED', 'INACTIVE', 'ARCHIVED');
CREATE TYPE "PromotionConflictStrategy" AS ENUM ('PRIORITY', 'BEST_CUSTOMER_DISCOUNT', 'BEST_STORE_MARGIN');
CREATE TYPE "PromotionProductRole" AS ENUM ('QUALIFYING', 'REWARD');

CREATE TABLE "Promotion" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" "PromotionType" NOT NULL,
  "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
  "startAt" TIMESTAMP(3),
  "endAt" TIMESTAMP(3),
  "priority" INTEGER NOT NULL DEFAULT 0,
  "stackable" BOOLEAN NOT NULL DEFAULT false,
  "conflictStrategy" "PromotionConflictStrategy" NOT NULL DEFAULT 'PRIORITY',
  "allowCashierOverride" BOOLEAN NOT NULL DEFAULT false,
  "requireManagerApproval" BOOLEAN NOT NULL DEFAULT false,
  "applyAutomatically" BOOLEAN NOT NULL DEFAULT true,
  "printOnReceipt" BOOLEAN NOT NULL DEFAULT true,
  "displayAtPos" BOOLEAN NOT NULL DEFAULT true,
  "stopLowerPriority" BOOLEAN NOT NULL DEFAULT false,
  "excludePriceOverrides" BOOLEAN NOT NULL DEFAULT true,
  "allowRepeatedApplications" BOOLEAN NOT NULL DEFAULT true,
  "maxApplicationsPerTransaction" INTEGER,
  "maxDiscountedQuantityPerTransaction" INTEGER,
  "limitOneUsePerCustomer" BOOLEAN NOT NULL DEFAULT false,
  "loyaltyRequired" BOOLEAN NOT NULL DEFAULT false,
  "allowEbtProducts" BOOLEAN NOT NULL DEFAULT true,
  "applyBeforeTax" BOOLEAN NOT NULL DEFAULT true,
  "useSeparateRewardProducts" BOOLEAN NOT NULL DEFAULT false,
  "configuration" JSONB NOT NULL,
  "internalNotes" TEXT,
  "createdByActorId" TEXT NOT NULL,
  "updatedByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PromotionProduct" (
  "id" TEXT NOT NULL,
  "promotionId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "role" "PromotionProductRole" NOT NULL DEFAULT 'QUALIFYING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromotionProduct_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Promotion_storeId_status_idx" ON "Promotion"("storeId", "status");
CREATE INDEX "Promotion_storeId_startAt_endAt_idx" ON "Promotion"("storeId", "startAt", "endAt");
CREATE INDEX "Promotion_storeId_type_idx" ON "Promotion"("storeId", "type");
CREATE INDEX "Promotion_storeId_updatedAt_idx" ON "Promotion"("storeId", "updatedAt");
CREATE UNIQUE INDEX "PromotionProduct_promotionId_productId_role_key" ON "PromotionProduct"("promotionId", "productId", "role");
CREATE INDEX "PromotionProduct_promotionId_role_idx" ON "PromotionProduct"("promotionId", "role");
CREATE INDEX "PromotionProduct_productId_idx" ON "PromotionProduct"("productId");
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdByActorId_fkey" FOREIGN KEY ("createdByActorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_updatedByActorId_fkey" FOREIGN KEY ("updatedByActorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
