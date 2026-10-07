-- AlterTable
ALTER TABLE "PilotImpact" ADD COLUMN     "changeId" TEXT,
ALTER COLUMN "actionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PlatformChange" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "alertClientId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "externalId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "actorName" TEXT NOT NULL DEFAULT '',
    "actorEmail" TEXT,
    "via" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'external',
    "pilotActionId" TEXT,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL DEFAULT '',
    "objectName" TEXT NOT NULL DEFAULT '',
    "eventType" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL DEFAULT 'null',
    "afterJson" TEXT NOT NULL DEFAULT 'null',
    "line" TEXT NOT NULL DEFAULT '',
    "significant" BOOLEAN NOT NULL DEFAULT false,
    "rawJson" TEXT NOT NULL DEFAULT '{}',
    "note" TEXT NOT NULL DEFAULT '',
    "noteById" TEXT,
    "noteByName" TEXT,
    "noteAt" TIMESTAMP(3),
    "hqProject" TEXT,
    "hqWrittenAt" TIMESTAMP(3),
    "hqError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformChangeSync" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "syncedTo" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformChangeSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformChange_externalId_key" ON "PlatformChange"("externalId");

-- CreateIndex
CREATE INDEX "PlatformChange_accountId_at_idx" ON "PlatformChange"("accountId", "at");

-- CreateIndex
CREATE INDEX "PlatformChange_alertClientId_at_idx" ON "PlatformChange"("alertClientId", "at");

-- CreateIndex
CREATE INDEX "PlatformChange_pilotActionId_idx" ON "PlatformChange"("pilotActionId");

-- CreateIndex
CREATE INDEX "PlatformChange_significant_source_at_idx" ON "PlatformChange"("significant", "source", "at");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformChangeSync_platform_accountId_key" ON "PlatformChangeSync"("platform", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PilotImpact_changeId_horizon_key" ON "PilotImpact"("changeId", "horizon");

-- AddForeignKey
ALTER TABLE "PilotImpact" ADD CONSTRAINT "PilotImpact_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "PlatformChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

