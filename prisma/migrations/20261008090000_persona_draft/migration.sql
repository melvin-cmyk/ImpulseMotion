-- CreateTable
CREATE TABLE "PersonaDraft" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "inputsJson" TEXT NOT NULL DEFAULT '{}',
    "kind" TEXT NOT NULL DEFAULT 'persona',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonaDraft_dashboardId_key" ON "PersonaDraft"("dashboardId");

-- AddForeignKey
ALTER TABLE "PersonaDraft" ADD CONSTRAINT "PersonaDraft_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
