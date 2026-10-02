-- AlterTable
ALTER TABLE "AlertClient" ADD COLUMN     "hqSlug" TEXT;

-- CreateTable
CREATE TABLE "PilotAction" (
    "id" TEXT NOT NULL,
    "alertClientId" TEXT,
    "clientName" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdByEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "why" TEXT NOT NULL DEFAULT '',
    "goalJson" TEXT NOT NULL DEFAULT '{}',
    "needsDouble" BOOLEAN NOT NULL DEFAULT false,
    "hqProject" TEXT,
    "hqWrittenAt" TIMESTAMP(3),
    "hqError" TEXT,
    "undoOfId" TEXT,
    "undoneById" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotOperation" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "objectName" TEXT NOT NULL DEFAULT '',
    "parentName" TEXT NOT NULL DEFAULT '',
    "field" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "readBackJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "PilotOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PilotAction_alertClientId_createdAt_idx" ON "PilotAction"("alertClientId", "createdAt");

-- CreateIndex
CREATE INDEX "PilotAction_accountId_createdAt_idx" ON "PilotAction"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "PilotAction_createdById_createdAt_idx" ON "PilotAction"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "PilotOperation_actionId_position_idx" ON "PilotOperation"("actionId", "position");

-- AddForeignKey
ALTER TABLE "PilotOperation" ADD CONSTRAINT "PilotOperation_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "PilotAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

