-- CreateEnum
CREATE TYPE "StorePermissionKey" AS ENUM (
    'view_store',
    'add_store',
    'edit_store',
    'delete_store',
    'manage_products',
    'manage_inventory',
    'manage_customers',
    'manage_employees',
    'view_reports',
    'process_sales',
    'override_prices'
);

-- CreateTable
CREATE TABLE "StoreStaffPermission" (
    "id" TEXT NOT NULL,
    "storeStaffId" TEXT NOT NULL,
    "permission" "StorePermissionKey" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreStaffPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreStaffPermission_storeStaffId_idx" ON "StoreStaffPermission"("storeStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreStaffPermission_storeStaffId_permission_key" ON "StoreStaffPermission"("storeStaffId", "permission");

-- AddForeignKey
ALTER TABLE "StoreStaffPermission" ADD CONSTRAINT "StoreStaffPermission_storeStaffId_fkey" FOREIGN KEY ("storeStaffId") REFERENCES "StoreStaff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
