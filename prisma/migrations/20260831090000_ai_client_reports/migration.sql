-- DropForeignKey
ALTER TABLE "ReportSchedule" DROP CONSTRAINT "ReportSchedule_userId_fkey";

-- DropForeignKey
ALTER TABLE "SharedReport" DROP CONSTRAINT "SharedReport_userId_fkey";

-- AlterTable
ALTER TABLE "Dashboard" ADD COLUMN     "reportFrequency" TEXT;

-- DropTable
DROP TABLE "DeckDraft";

-- DropTable
DROP TABLE "DeckHistory";

-- DropTable
DROP TABLE "ReportSchedule";

-- DropTable
DROP TABLE "SharedReport";

-- CreateTable
CREATE TABLE "ClientReport" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "periodSince" TEXT NOT NULL,
    "periodUntil" TEXT NOT NULL,
    "compareSince" TEXT,
    "compareUntil" TEXT,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "contentMd" TEXT NOT NULL DEFAULT '',
    "summary" TEXT,
    "nextStepsJson" TEXT NOT NULL DEFAULT '[]',
    "chatJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientReport_dashboardId_createdAt_idx" ON "ClientReport"("dashboardId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientReport_status_createdAt_idx" ON "ClientReport"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientReport" ADD CONSTRAINT "ClientReport_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientReport" ADD CONSTRAINT "ClientReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

