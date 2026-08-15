-- CreateTable
CREATE TABLE "RefundReason" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT,
    "returnToInventory" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundReason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundReason_storeId_normalizedName_key" ON "RefundReason"("storeId", "normalizedName");

-- CreateIndex
CREATE INDEX "RefundReason_storeId_isActive_idx" ON "RefundReason"("storeId", "isActive");

-- CreateIndex
CREATE INDEX "RefundReason_storeId_createdAt_idx" ON "RefundReason"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "RefundReason" ADD CONSTRAINT "RefundReason_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
