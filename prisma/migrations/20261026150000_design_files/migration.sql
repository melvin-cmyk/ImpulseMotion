-- CreateTable
CREATE TABLE "DesignFile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientDashboardId" TEXT,
    "fileId" TEXT NOT NULL,
    "editLink" TEXT NOT NULL,
    "viewLink" TEXT NOT NULL,
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesignFile_fileId_key" ON "DesignFile"("fileId");

-- CreateIndex
CREATE INDEX "DesignFile_ownerId_updatedAt_idx" ON "DesignFile"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "DesignFile_updatedAt_idx" ON "DesignFile"("updatedAt");

-- AddForeignKey
ALTER TABLE "DesignFile" ADD CONSTRAINT "DesignFile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignFile" ADD CONSTRAINT "DesignFile_clientDashboardId_fkey" FOREIGN KEY ("clientDashboardId") REFERENCES "Dashboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

