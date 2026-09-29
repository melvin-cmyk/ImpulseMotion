-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT NOT NULL,
    "createdByEmail" TEXT,
    "dashboardId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '—',
    "metaAccountId" TEXT,
    "googleCustomerId" TEXT,
    "definitionJson" TEXT NOT NULL DEFAULT '{}',
    "definitionHash" TEXT NOT NULL DEFAULT '',
    "writesPlatform" BOOLEAN NOT NULL DEFAULT false,
    "scheduleJson" TEXT NOT NULL DEFAULT '{}',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "nextRunAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "maxItemsPerRun" INTEGER NOT NULL DEFAULT 20,
    "dryRunHash" TEXT,
    "dryRunAt" TIMESTAMP(3),
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "chatJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineRun" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "definitionHash" TEXT NOT NULL,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "itemsPlanned" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsSkipped" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,

    CONSTRAINT "RoutineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineItem" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "runId" TEXT,
    "stepId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalId" TEXT,
    "label" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineEvent" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "userRole" TEXT,
    "definitionHash" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Routine_status_nextRunAt_idx" ON "Routine"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Routine_createdById_updatedAt_idx" ON "Routine"("createdById", "updatedAt");

-- CreateIndex
CREATE INDEX "Routine_dashboardId_idx" ON "Routine"("dashboardId");

-- CreateIndex
CREATE INDEX "RoutineRun_routineId_startedAt_idx" ON "RoutineRun"("routineId", "startedAt");

-- CreateIndex
CREATE INDEX "RoutineRun_status_startedAt_idx" ON "RoutineRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "RoutineItem_routineId_status_idx" ON "RoutineItem"("routineId", "status");

-- CreateIndex
CREATE INDEX "RoutineItem_runId_idx" ON "RoutineItem"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RoutineItem_routineId_itemKey_key" ON "RoutineItem"("routineId", "itemKey");

-- CreateIndex
CREATE INDEX "RoutineEvent_routineId_createdAt_idx" ON "RoutineEvent"("routineId", "createdAt");

-- AddForeignKey
ALTER TABLE "RoutineRun" ADD CONSTRAINT "RoutineRun_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineItem" ADD CONSTRAINT "RoutineItem_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineEvent" ADD CONSTRAINT "RoutineEvent_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

