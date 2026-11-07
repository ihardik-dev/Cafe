-- AlterTable: Enforce non-negative inventory constraint at the PostgreSQL database level
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_stockQuantity_non_negative" CHECK ("stockQuantity" >= 0);
