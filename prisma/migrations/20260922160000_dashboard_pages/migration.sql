-- CreateTable
CREATE TABLE "DashboardPage" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "intent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardPage_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DashboardWidget" ADD COLUMN     "pageId" TEXT;

-- CreateIndex
CREATE INDEX "DashboardPage_dashboardId_position_idx" ON "DashboardPage"("dashboardId", "position");

-- CreateIndex
CREATE INDEX "DashboardWidget_pageId_position_idx" ON "DashboardWidget"("pageId", "position");

-- AddForeignKey
ALTER TABLE "DashboardPage" ADD CONSTRAINT "DashboardPage_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "DashboardPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
