-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_priceGroupId_fkey";

-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_productCategoryId_fkey";

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_priceGroupId_fkey" FOREIGN KEY ("priceGroupId") REFERENCES "PriceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_productCategoryId_fkey" FOREIGN KEY ("productCategoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
