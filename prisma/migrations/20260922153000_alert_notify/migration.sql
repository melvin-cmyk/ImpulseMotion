-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "notifyJson" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "AlertEvent" ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "notifyError" TEXT;
