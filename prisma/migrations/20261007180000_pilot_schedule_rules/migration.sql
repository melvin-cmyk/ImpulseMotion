-- AlterTable
ALTER TABLE "PilotAction" ADD COLUMN     "revertAt" TIMESTAMP(3),
ADD COLUMN     "revertedAt" TIMESTAMP(3),
ADD COLUMN     "ruleId" TEXT,
ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PilotRule" (
    "id" TEXT NOT NULL,
    "alertClientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT,
    "objectName" TEXT,
    "metric" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 7,
    "minConversions" INTEGER NOT NULL DEFAULT 5,
    "action" TEXT NOT NULL,
    "actionValue" DOUBLE PRECISION,
    "cooldownDays" INTEGER NOT NULL DEFAULT 3,
    "notifyChannel" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PilotRule_enabled_platform_accountId_idx" ON "PilotRule"("enabled", "platform", "accountId");

-- CreateIndex
CREATE INDEX "PilotRule_alertClientId_idx" ON "PilotRule"("alertClientId");

