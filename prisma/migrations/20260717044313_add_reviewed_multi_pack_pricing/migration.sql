-- CreateEnum
CREATE TYPE "MultiPackType" AS ENUM ('MULTIPACK_DEAL', 'CASE_SALE');

-- CreateEnum
CREATE TYPE "MultiPackStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MultiPackProposalAction" AS ENUM ('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE');

-- CreateEnum
CREATE TYPE "MultiPackProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'proposal_submitted';
ALTER TYPE "AuditAction" ADD VALUE 'proposal_approved';
ALTER TYPE "AuditAction" ADD VALUE 'proposal_rejected';
ALTER TYPE "AuditAction" ADD VALUE 'proposal_cancelled';
ALTER TYPE "AuditAction" ADD VALUE 'multi_pack_created';
ALTER TYPE "AuditAction" ADD VALUE 'multi_pack_updated';
ALTER TYPE "AuditAction" ADD VALUE 'multi_pack_deactivated';
ALTER TYPE "AuditAction" ADD VALUE 'multi_pack_reactivated';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'multi_pack';
ALTER TYPE "AuditEntityType" ADD VALUE 'multi_pack_proposal';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StorePermissionKey" ADD VALUE 'manage_multi_pack_pricing';
ALTER TYPE "StorePermissionKey" ADD VALUE 'review_multi_pack_pricing';

-- CreateTable
CREATE TABLE "ProductMultiPack" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "MultiPackType" NOT NULL,
    "unitsPerPack" INTEGER NOT NULL,
    "caseBarcode" TEXT,
    "multiPackRetail" DECIMAL(12,2) NOT NULL,
    "aggregateCostSnapshot" DECIMAL(12,4),
    "marginSnapshot" DECIMAL(8,4),
    "status" "MultiPackStatus" NOT NULL DEFAULT 'ACTIVE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedFromProposalId" TEXT,
    "approvedByActorId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMultiPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MultiPackProposal" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "targetMultiPackId" TEXT,
    "action" "MultiPackProposalAction" NOT NULL,
    "status" "MultiPackProposalStatus" NOT NULL DEFAULT 'PENDING',
    "proposedType" "MultiPackType" NOT NULL,
    "proposedUnitsPerPack" INTEGER NOT NULL,
    "proposedCaseBarcode" TEXT,
    "proposedMultiPackRetail" DECIMAL(12,2) NOT NULL,
    "unitCostSnapshot" DECIMAL(12,4),
    "aggregateCostSnapshot" DECIMAL(12,4),
    "marginSnapshot" DECIMAL(8,4),
    "productVersionSnapshot" INTEGER,
    "multiPackVersionSnapshot" INTEGER,
    "submittedByActorId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByActorId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MultiPackProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMultiPack_approvedFromProposalId_key" ON "ProductMultiPack"("approvedFromProposalId");

-- CreateIndex
CREATE INDEX "ProductMultiPack_storeId_productId_isActive_idx" ON "ProductMultiPack"("storeId", "productId", "isActive");

-- CreateIndex
CREATE INDEX "ProductMultiPack_storeId_caseBarcode_idx" ON "ProductMultiPack"("storeId", "caseBarcode");

-- CreateIndex
CREATE INDEX "ProductMultiPack_storeId_type_isActive_idx" ON "ProductMultiPack"("storeId", "type", "isActive");

-- CreateIndex
CREATE INDEX "MultiPackProposal_storeId_status_submittedAt_idx" ON "MultiPackProposal"("storeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "MultiPackProposal_storeId_productId_status_idx" ON "MultiPackProposal"("storeId", "productId", "status");

-- CreateIndex
CREATE INDEX "MultiPackProposal_targetMultiPackId_status_idx" ON "MultiPackProposal"("targetMultiPackId", "status");

-- CreateIndex
CREATE INDEX "MultiPackProposal_submittedByActorId_submittedAt_idx" ON "MultiPackProposal"("submittedByActorId", "submittedAt");

-- AddForeignKey
ALTER TABLE "ProductMultiPack" ADD CONSTRAINT "ProductMultiPack_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMultiPack" ADD CONSTRAINT "ProductMultiPack_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiPackProposal" ADD CONSTRAINT "MultiPackProposal_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiPackProposal" ADD CONSTRAINT "MultiPackProposal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
