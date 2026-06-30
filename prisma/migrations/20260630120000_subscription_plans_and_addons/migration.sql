-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('plus', 'advanced');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "plan" "SubscriptionPlan" NOT NULL DEFAULT 'plus';

-- CreateTable
CREATE TABLE "SubscriptionAddon" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyAmount" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionAddon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionAddon_subscriptionId_code_key" ON "SubscriptionAddon"("subscriptionId", "code");

-- CreateIndex
CREATE INDEX "SubscriptionAddon_subscriptionId_isActive_idx" ON "SubscriptionAddon"("subscriptionId", "isActive");

-- AddForeignKey
ALTER TABLE "SubscriptionAddon" ADD CONSTRAINT "SubscriptionAddon_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
