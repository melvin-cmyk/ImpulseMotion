-- DropForeignKey
ALTER TABLE "AutoIncident" DROP CONSTRAINT "AutoIncident_dashboardId_fkey";

-- DropIndex
DROP INDEX "AutoIncident_dashboardId_key_key";

-- DropIndex
DROP INDEX "AutoIncident_dashboardId_status_idx";

-- AlterTable
ALTER TABLE "AutoIncident" ADD COLUMN     "clientId" TEXT,
ALTER COLUMN "dashboardId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AlertClient" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountsJson" TEXT NOT NULL DEFAULT '[]',
    "dashboardId" TEXT,
    "slackChannel" TEXT,
    "slackChannelId" TEXT,
    "autoAlerts" BOOLEAN NOT NULL DEFAULT true,
    "autoAlertConfig" TEXT NOT NULL DEFAULT '{}',
    "dormant" BOOLEAN NOT NULL DEFAULT false,
    "gone" BOOLEAN NOT NULL DEFAULT false,
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlertClient_key_key" ON "AlertClient"("key");

-- CreateIndex
CREATE INDEX "AutoIncident_clientId_status_idx" ON "AutoIncident"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AutoIncident_clientId_key_key" ON "AutoIncident"("clientId", "key");

-- AddForeignKey
ALTER TABLE "AutoIncident" ADD CONSTRAINT "AutoIncident_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AlertClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

