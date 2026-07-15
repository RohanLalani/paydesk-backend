-- CreateEnum
CREATE TYPE "StoreFeatureKey" AS ENUM ('lottery', 'recipe_suite', 'loyalty');

-- CreateEnum
CREATE TYPE "StoreFeatureSource" AS ENUM ('setup', 'manual', 'subscription', 'system');

-- CreateEnum
CREATE TYPE "StoreServiceKey" AS ENUM ('loyalty');

-- CreateEnum
CREATE TYPE "StoreServiceStatus" AS ENUM ('not_added', 'pending', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired');

-- CreateTable
CREATE TABLE "StoreFeature" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "feature" "StoreFeatureKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "source" "StoreFeatureSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreServiceSubscription" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "service" "StoreServiceKey" NOT NULL,
    "status" "StoreServiceStatus" NOT NULL DEFAULT 'pending',
    "stripeSubscriptionId" TEXT,
    "stripeSubscriptionItemId" TEXT,
    "stripePriceId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreServiceSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreFeature_storeId_feature_key" ON "StoreFeature"("storeId", "feature");

-- CreateIndex
CREATE INDEX "StoreFeature_storeId_enabled_idx" ON "StoreFeature"("storeId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "StoreServiceSubscription_stripeSubscriptionItemId_key" ON "StoreServiceSubscription"("stripeSubscriptionItemId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreServiceSubscription_storeId_service_key" ON "StoreServiceSubscription"("storeId", "service");

-- CreateIndex
CREATE INDEX "StoreServiceSubscription_storeId_status_idx" ON "StoreServiceSubscription"("storeId", "status");

-- AddForeignKey
ALTER TABLE "StoreFeature" ADD CONSTRAINT "StoreFeature_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreServiceSubscription" ADD CONSTRAINT "StoreServiceSubscription_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
