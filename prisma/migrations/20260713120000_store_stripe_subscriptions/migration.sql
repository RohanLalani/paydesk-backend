-- CreateEnum
CREATE TYPE "StoreSubscriptionStatus" AS ENUM ('pending', 'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused');

-- CreateTable
CREATE TABLE "StoreSubscription" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "StoreSubscriptionStatus" NOT NULL DEFAULT 'pending',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeCheckoutSessionId" TEXT,
    "stripePriceId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreSubscription_storeId_key" ON "StoreSubscription"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreSubscription_stripeSubscriptionId_key" ON "StoreSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreSubscription_stripeCheckoutSessionId_key" ON "StoreSubscription"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "StoreSubscription_status_idx" ON "StoreSubscription"("status");

-- CreateIndex
CREATE INDEX "StoreSubscription_stripeCustomerId_idx" ON "StoreSubscription"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "StoreSubscription" ADD CONSTRAINT "StoreSubscription_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
