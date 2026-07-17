CREATE INDEX "Product_storeId_trackInventory_idx" ON "Product"("storeId", "trackInventory");
CREATE INDEX "Product_storeId_currentQuantity_idx" ON "Product"("storeId", "currentQuantity");
CREATE INDEX "InventoryLog_storeId_productId_createdAt_idx" ON "InventoryLog"("storeId", "productId", "createdAt");
CREATE INDEX "Transaction_storeId_transactionStatus_createdAt_idx" ON "Transaction"("storeId", "transactionStatus", "createdAt");
CREATE INDEX "TransactionItem_productId_transactionId_idx" ON "TransactionItem"("productId", "transactionId");
