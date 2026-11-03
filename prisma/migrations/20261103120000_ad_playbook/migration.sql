-- Playbook du client (comme le Playbook de Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "AdPlaybookEntry" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'saved',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "title" TEXT NOT NULL,
    "userNote" TEXT NOT NULL DEFAULT '',
    "aiNote" TEXT NOT NULL DEFAULT '',
    "refJson" TEXT NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "statusById" TEXT,
    "statusByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdPlaybookEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdPlaybookEntry_accountKey_status_idx" ON "AdPlaybookEntry"("accountKey", "status");
