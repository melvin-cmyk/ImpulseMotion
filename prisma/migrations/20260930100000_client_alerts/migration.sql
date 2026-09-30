-- AlterTable
ALTER TABLE "User" ADD COLUMN     "slackUserId" TEXT,
ADD COLUMN     "slackEmail" TEXT,
ADD COLUMN     "slackCheckedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClientAlert" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByEmail" TEXT,
    "alertClientId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '—',
    "label" TEXT NOT NULL DEFAULT '',
    "accountsJson" TEXT NOT NULL DEFAULT '[]',
    "definitionJson" TEXT NOT NULL DEFAULT '{}',
    "definitionHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "backtestJson" TEXT NOT NULL DEFAULT '{}',
    "backtestHash" TEXT,
    "backtestAt" TIMESTAMP(3),
    "chatJson" TEXT NOT NULL DEFAULT '{}',
    "armed" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastTriggeredAt" TIMESTAMP(3),
    "lastValue" DOUBLE PRECISION,
    "lastNote" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAlertEvent" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'trigger',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "detailJson" TEXT NOT NULL DEFAULT '{}',
    "message" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "notifiedAt" TIMESTAMP(3),
    "notifyError" TEXT,
    "batchId" TEXT,

    CONSTRAINT "ClientAlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientAlert_status_idx" ON "ClientAlert"("status");

-- CreateIndex
CREATE INDEX "ClientAlert_createdById_updatedAt_idx" ON "ClientAlert"("createdById", "updatedAt");

-- CreateIndex
CREATE INDEX "ClientAlertEvent_alertId_triggeredAt_idx" ON "ClientAlertEvent"("alertId", "triggeredAt");

-- CreateIndex
CREATE INDEX "ClientAlertEvent_notifiedAt_idx" ON "ClientAlertEvent"("notifiedAt");

-- AddForeignKey
ALTER TABLE "ClientAlertEvent" ADD CONSTRAINT "ClientAlertEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "ClientAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
