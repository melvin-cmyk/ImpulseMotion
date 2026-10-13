-- « Mes dashboards » : versions (état avant chaque modification) pour revenir en arrière
CREATE TABLE "StaffDashboardVersion" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "userId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "label" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "datasetsJson" TEXT NOT NULL DEFAULT '{}',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "html" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffDashboardVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffDashboardVersion_dashboardId_createdAt_idx" ON "StaffDashboardVersion"("dashboardId", "createdAt");
ALTER TABLE "StaffDashboardVersion" ADD CONSTRAINT "StaffDashboardVersion_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "StaffDashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
