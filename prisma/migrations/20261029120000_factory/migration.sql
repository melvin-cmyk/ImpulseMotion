-- Fabrique de statics (lot 1) : runs, copys proposés, retours à niveaux, document de contexte ;
-- traçabilité run/copy sur les visuels, template écarté. Additif, rejouable.
ALTER TABLE "CreativeAsset" ADD COLUMN IF NOT EXISTS "factoryRunId" TEXT;
ALTER TABLE "CreativeAsset" ADD COLUMN IF NOT EXISTS "copyId" TEXT;
CREATE INDEX IF NOT EXISTS "CreativeAsset_factoryRunId_idx" ON "CreativeAsset"("factoryRunId");

ALTER TABLE "CreativeTemplate" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "FactoryRun" (
    "id" TEXT NOT NULL,
    "alertClientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'offer',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "templateIdsJson" TEXT NOT NULL DEFAULT '[]',
    "contextMd" TEXT NOT NULL DEFAULT '',
    "sourcesJson" TEXT NOT NULL DEFAULT '[]',
    "settingsJson" TEXT NOT NULL DEFAULT '{}',
    "parentRunId" TEXT,
    "routineId" TEXT,
    "jobId" TEXT,
    "estimatedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "generated" INTEGER NOT NULL DEFAULT 0,
    "kept" INTEGER NOT NULL DEFAULT 0,
    "cut" INTEGER NOT NULL DEFAULT 0,
    "driveFolderId" TEXT,
    "driveLink" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FactoryRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FactoryRun_alertClientId_createdAt_idx" ON "FactoryRun"("alertClientId", "createdAt");
CREATE INDEX IF NOT EXISTS "FactoryRun_status_idx" ON "FactoryRun"("status");

CREATE TABLE IF NOT EXISTS "FactoryCopy" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "templateId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "headline" TEXT NOT NULL,
    "subline" TEXT NOT NULL DEFAULT '',
    "cta" TEXT NOT NULL DEFAULT '',
    "angle" TEXT NOT NULL DEFAULT '',
    "persona" TEXT NOT NULL DEFAULT '',
    "voiceSource" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "editedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FactoryCopy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FactoryCopy_runId_order_idx" ON "FactoryCopy"("runId", "order");

CREATE TABLE IF NOT EXISTS "CreativeFeedback" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "alertClientId" TEXT,
    "assetId" TEXT,
    "templateId" TEXT,
    "runId" TEXT,
    "text" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreativeFeedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CreativeFeedback_alertClientId_createdAt_idx" ON "CreativeFeedback"("alertClientId", "createdAt");
CREATE INDEX IF NOT EXISTS "CreativeFeedback_templateId_idx" ON "CreativeFeedback"("templateId");
CREATE INDEX IF NOT EXISTS "CreativeFeedback_runId_idx" ON "CreativeFeedback"("runId");

CREATE TABLE IF NOT EXISTS "FactoryContext" (
    "alertClientId" TEXT NOT NULL,
    "md" TEXT NOT NULL,
    "sourcesJson" TEXT NOT NULL DEFAULT '[]',
    "hqPath" TEXT,
    "hqEtag" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FactoryContext_pkey" PRIMARY KEY ("alertClientId")
);
