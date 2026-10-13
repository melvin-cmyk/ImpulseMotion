-- « Mes dashboards » : conversation du copilote IA par (dashboard, consultant)
CREATE TABLE "StaffDashboardThread" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffDashboardThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffDashboardThread_dashboardId_userId_key" ON "StaffDashboardThread"("dashboardId", "userId");
CREATE INDEX "StaffDashboardThread_dashboardId_updatedAt_idx" ON "StaffDashboardThread"("dashboardId", "updatedAt");
ALTER TABLE "StaffDashboardThread" ADD CONSTRAINT "StaffDashboardThread_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "StaffDashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
