ALTER TABLE "Product" ALTER COLUMN "priceGroupId" DROP NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "productCategoryId" DROP NOT NULL;

DROP INDEX IF EXISTS "Product_barcode_key";
CREATE UNIQUE INDEX "Product_storeId_barcode_key" ON "Product"("storeId", "barcode");
