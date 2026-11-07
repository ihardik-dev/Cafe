-- AlterTable
ALTER TABLE "RefundAudit" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RefundAudit_idempotencyKey_key" ON "RefundAudit"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RefundAudit_idempotencyKey_idx" ON "RefundAudit"("idempotencyKey");
