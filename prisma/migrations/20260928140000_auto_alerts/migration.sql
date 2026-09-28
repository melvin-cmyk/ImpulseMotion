-- AlterTable
ALTER TABLE "Dashboard" ADD COLUMN     "slackChannel" TEXT,
ADD COLUMN     "slackChannelId" TEXT,
ADD COLUMN     "autoAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoAlertConfig" TEXT NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "AutoIncident" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "entityLevel" TEXT,
    "entityId" TEXT,
    "entityName" TEXT,
    "missCount" INTEGER NOT NULL DEFAULT 0,
    "remindCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "notifyError" TEXT,

    CONSTRAINT "AutoIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoIncident_dashboardId_status_idx" ON "AutoIncident"("dashboardId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AutoIncident_dashboardId_key_key" ON "AutoIncident"("dashboardId", "key");

-- AddForeignKey
ALTER TABLE "AutoIncident" ADD CONSTRAINT "AutoIncident_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
