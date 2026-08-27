-- CreateTable
CREATE TABLE "DashboardMember" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DashboardMember_userId_idx" ON "DashboardMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardMember_dashboardId_userId_key" ON "DashboardMember"("dashboardId", "userId");

-- AddForeignKey
ALTER TABLE "DashboardMember" ADD CONSTRAINT "DashboardMember_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardMember" ADD CONSTRAINT "DashboardMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
