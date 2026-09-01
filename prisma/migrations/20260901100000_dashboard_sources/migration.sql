-- Data sources attached to a client dashboard (HubSpot first). Secrets are
-- AES-256-GCM encrypted by lib/secrets.ts; Meta / Google stay on Dashboard columns.

-- CreateTable
CREATE TABLE "DashboardSource" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "secretEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DashboardSource_dashboardId_idx" ON "DashboardSource"("dashboardId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardSource_dashboardId_kind_externalId_key" ON "DashboardSource"("dashboardId", "kind", "externalId");

-- AddForeignKey
ALTER TABLE "DashboardSource" ADD CONSTRAINT "DashboardSource_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
