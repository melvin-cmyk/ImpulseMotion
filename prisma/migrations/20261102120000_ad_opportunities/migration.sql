-- Analyse Ads : opportunités (itérations suggérées sur les créas scalées, comme Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "AdOpportunity" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "creativeKey" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "description" TEXT NOT NULL DEFAULT '',
    "strengthsJson" TEXT NOT NULL DEFAULT '[]',
    "weaknessesJson" TEXT NOT NULL DEFAULT '[]',
    "metricsJson" TEXT NOT NULL DEFAULT '{}',
    "aiSuggestionJson" TEXT,
    "aiScore" INTEGER,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusById" TEXT,
    "statusByName" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdOpportunity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdOpportunity_platform_accountId_assignedAt_idx" ON "AdOpportunity"("platform", "accountId", "assignedAt");
CREATE INDEX IF NOT EXISTS "AdOpportunity_creativeKey_idx" ON "AdOpportunity"("creativeKey");
