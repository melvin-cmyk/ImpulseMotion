-- CreateTable
CREATE TABLE "CreativeAsset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "alertClientId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT,
    "file" TEXT,
    "providerId" TEXT,
    "sourceId" TEXT,
    "error" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeAsset_createdAt_idx" ON "CreativeAsset"("createdAt");

-- CreateIndex
CREATE INDEX "CreativeAsset_alertClientId_createdAt_idx" ON "CreativeAsset"("alertClientId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeAsset_status_idx" ON "CreativeAsset"("status");

