-- CreateEnum
CREATE TYPE "PunchCardRewardType" AS ENUM ('PERCENTAGE_DISCOUNT', 'FREE_PRODUCT');

-- CreateTable
CREATE TABLE "PunchCardProgram" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rewardType" "PunchCardRewardType" NOT NULL,
    "discountPercentage" DECIMAL(5,2),
    "freeProductId" TEXT,
    "requiredTransactions" INTEGER NOT NULL,
    "minimumTransactionCents" INTEGER NOT NULL,
    "storeWide" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PunchCardProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PunchCardProgramDepartment" (
    "programId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PunchCardProgramDepartment_pkey" PRIMARY KEY ("programId","departmentId")
);

-- CreateIndex
CREATE INDEX "PunchCardProgram_storeId_isActive_idx" ON "PunchCardProgram"("storeId", "isActive");

-- CreateIndex
CREATE INDEX "PunchCardProgram_storeId_updatedAt_idx" ON "PunchCardProgram"("storeId", "updatedAt");

-- CreateIndex
CREATE INDEX "PunchCardProgram_freeProductId_idx" ON "PunchCardProgram"("freeProductId");

-- CreateIndex
CREATE INDEX "PunchCardProgramDepartment_departmentId_idx" ON "PunchCardProgramDepartment"("departmentId");

-- AddForeignKey
ALTER TABLE "PunchCardProgram" ADD CONSTRAINT "PunchCardProgram_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchCardProgram" ADD CONSTRAINT "PunchCardProgram_freeProductId_fkey" FOREIGN KEY ("freeProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchCardProgramDepartment" ADD CONSTRAINT "PunchCardProgramDepartment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "PunchCardProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchCardProgramDepartment" ADD CONSTRAINT "PunchCardProgramDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
