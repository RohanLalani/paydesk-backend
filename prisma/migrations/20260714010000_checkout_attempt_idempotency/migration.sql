-- AlterTable
ALTER TABLE "StoreSubscription"
ADD COLUMN "checkoutAttemptId" TEXT,
ADD COLUMN "checkoutIdempotencyKey" TEXT,
ADD COLUMN "checkoutSessionExpiresAt" TIMESTAMP(3);
