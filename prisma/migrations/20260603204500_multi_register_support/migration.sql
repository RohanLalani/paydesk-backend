-- AlterEnum
ALTER TYPE "StorePermissionKey" ADD VALUE IF NOT EXISTS 'manage_registers';

-- CreateEnum
CREATE TYPE "RegisterStatus" AS ENUM ('inactive', 'active', 'revoked');

-- CreateTable
CREATE TABLE "Register" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registerNumber" TEXT NOT NULL,
    "description" TEXT,
    "deviceName" TEXT,
    "status" "RegisterStatus" NOT NULL DEFAULT 'inactive',
    "activatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisterActivationCode" (
    "id" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegisterActivationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisterDevice" (
    "id" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "deviceFingerprint" TEXT,
    "deviceName" TEXT,
    "deviceTokenHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RegisterDevice_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "registerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Register_storeId_registerNumber_key" ON "Register"("storeId", "registerNumber");

-- CreateIndex
CREATE INDEX "Register_storeId_status_idx" ON "Register"("storeId", "status");

-- CreateIndex
CREATE INDEX "RegisterActivationCode_registerId_usedAt_expiresAt_idx" ON "RegisterActivationCode"("registerId", "usedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "RegisterActivationCode_storeId_idx" ON "RegisterActivationCode"("storeId");

-- CreateIndex
CREATE INDEX "RegisterActivationCode_createdByStaffId_idx" ON "RegisterActivationCode"("createdByStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "RegisterDevice_deviceTokenHash_key" ON "RegisterDevice"("deviceTokenHash");

-- CreateIndex
CREATE INDEX "RegisterDevice_registerId_isActive_idx" ON "RegisterDevice"("registerId", "isActive");

-- CreateIndex
CREATE INDEX "RegisterDevice_storeId_isActive_idx" ON "RegisterDevice"("storeId", "isActive");

-- CreateIndex
CREATE INDEX "Transaction_registerId_idx" ON "Transaction"("registerId");

-- CreateIndex
CREATE INDEX "Transaction_storeId_registerId_createdAt_idx" ON "Transaction"("storeId", "registerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterActivationCode" ADD CONSTRAINT "RegisterActivationCode_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterActivationCode" ADD CONSTRAINT "RegisterActivationCode_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterActivationCode" ADD CONSTRAINT "RegisterActivationCode_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterDevice" ADD CONSTRAINT "RegisterDevice_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterDevice" ADD CONSTRAINT "RegisterDevice_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE SET NULL ON UPDATE CASCADE;
