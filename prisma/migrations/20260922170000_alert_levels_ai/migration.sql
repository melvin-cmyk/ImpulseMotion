-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "level" TEXT NOT NULL DEFAULT 'account',
ADD COLUMN     "filterJson" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'rule',
ADD COLUMN     "prompt" TEXT,
ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "AlertEvent" ADD COLUMN     "entityLevel" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "entityName" TEXT;
