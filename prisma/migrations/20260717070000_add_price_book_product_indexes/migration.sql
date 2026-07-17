CREATE INDEX "Product_storeId_isActive_productNumber_idx" ON "Product"("storeId", "isActive", "productNumber");
CREATE INDEX "Product_storeId_departmentId_productNumber_idx" ON "Product"("storeId", "departmentId", "productNumber");
CREATE INDEX "Product_storeId_productCategoryId_productNumber_idx" ON "Product"("storeId", "productCategoryId", "productNumber");
CREATE INDEX "Product_storeId_priceGroupId_productNumber_idx" ON "Product"("storeId", "priceGroupId", "productNumber");
