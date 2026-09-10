-- CreateEnum
CREATE TYPE "LoyaltyRedemptionMode" AS ENUM ('PRODUCTS', 'CASHBACK', 'BOTH');

-- CreateTable
CREATE TABLE "LoyaltyPointsProgram" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pointsEarned" INTEGER NOT NULL,
    "spendThresholdCents" INTEGER NOT NULL,
    "pointValueCents" INTEGER NOT NULL,
    "redemptionMode" "LoyaltyRedemptionMode" NOT NULL,
    "cashbackStoreWide" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyPointsProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyPointsProgramProduct" (
    "programId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyPointsProgramProduct_pkey" PRIMARY KEY ("programId","productId")
);

-- CreateIndex
CREATE INDEX "LoyaltyPointsProgram_storeId_isActive_idx" ON "LoyaltyPointsProgram"("storeId", "isActive");

-- CreateIndex
CREATE INDEX "LoyaltyPointsProgram_storeId_updatedAt_idx" ON "LoyaltyPointsProgram"("storeId", "updatedAt");

-- CreateIndex
CREATE INDEX "LoyaltyPointsProgramProduct_productId_idx" ON "LoyaltyPointsProgramProduct"("productId");

-- AddForeignKey
ALTER TABLE "LoyaltyPointsProgram" ADD CONSTRAINT "LoyaltyPointsProgram_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointsProgramProduct" ADD CONSTRAINT "LoyaltyPointsProgramProduct_programId_fkey" FOREIGN KEY ("programId") REFERENCES "LoyaltyPointsProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointsProgramProduct" ADD CONSTRAINT "LoyaltyPointsProgramProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
