-- DropIndex
DROP INDEX IF EXISTS "Order_idempotencyKey_key";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "idempotencyScope" TEXT;

-- CreateIndex
CREATE INDEX "Order_idempotencyKey_idx" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyScope_idempotencyKey_key" ON "Order"("idempotencyScope", "idempotencyKey");
