ALTER TABLE "Store" ADD COLUMN "nextProductNumber" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Product" ADD COLUMN "productNumber" INTEGER;

WITH numbered_products AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "storeId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "Product"
)
UPDATE "Product" p
SET "productNumber" = numbered_products.rn
FROM numbered_products
WHERE p."id" = numbered_products."id";

UPDATE "Store" s
SET "nextProductNumber" = COALESCE(store_counts.max_number, 0) + 1
FROM (
  SELECT "storeId", MAX("productNumber") AS max_number
  FROM "Product"
  GROUP BY "storeId"
) store_counts
WHERE s."id" = store_counts."storeId";

ALTER TABLE "Product" ALTER COLUMN "productNumber" SET NOT NULL;

ALTER TABLE "ProductCategory" ADD COLUMN "departmentId" TEXT;

WITH category_departments AS (
  SELECT
    pc."id" AS "categoryId",
    MIN(p."departmentId") AS "departmentId",
    COUNT(DISTINCT p."departmentId") AS "departmentCount"
  FROM "ProductCategory" pc
  JOIN "Product" p ON p."productCategoryId" = pc."id"
  GROUP BY pc."id"
)
UPDATE "ProductCategory" pc
SET "departmentId" = category_departments."departmentId"
FROM category_departments
WHERE pc."id" = category_departments."categoryId"
  AND category_departments."departmentCount" = 1;

CREATE UNIQUE INDEX "Product_storeId_productNumber_key" ON "Product"("storeId", "productNumber");
CREATE INDEX "Product_storeId_productNumber_idx" ON "Product"("storeId", "productNumber");
CREATE INDEX "ProductCategory_departmentId_idx" ON "ProductCategory"("departmentId");

DROP INDEX "ProductCategory_storeId_name_key";
CREATE UNIQUE INDEX "ProductCategory_storeId_departmentId_name_key" ON "ProductCategory"("storeId", "departmentId", "name");

ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
