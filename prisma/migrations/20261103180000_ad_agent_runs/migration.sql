-- Agents IA de l'Analyse Ads (comme les AI agent workflows de Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "AdAgentRun" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "creativeKey" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "input" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT NOT NULL DEFAULT '',
    "sectionsJson" TEXT NOT NULL DEFAULT '[]',
    "scoresJson" TEXT NOT NULL DEFAULT '{}',
    "followupsJson" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdAgentRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdAgentRun_accountKey_createdAt_idx" ON "AdAgentRun"("accountKey", "createdAt");
CREATE INDEX IF NOT EXISTS "AdAgentRun_accountKey_creativeKey_idx" ON "AdAgentRun"("accountKey", "creativeKey");
