-- CreateTable
CREATE TABLE "PilotImpact" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "horizon" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL DEFAULT '',
    "verdict" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "hqWrittenAt" TIMESTAMP(3),
    "hqError" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotImpact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PilotImpact_actionId_horizon_key" ON "PilotImpact"("actionId", "horizon");

-- CreateIndex
CREATE INDEX "PilotImpact_status_computedAt_idx" ON "PilotImpact"("status", "computedAt");

-- AddForeignKey
ALTER TABLE "PilotImpact" ADD CONSTRAINT "PilotImpact_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "PilotAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
