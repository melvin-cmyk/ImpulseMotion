-- Analyse Ads : liens de partage publics (snapshots, comme Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "AdSnapshot" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '🏆',
    "description" TEXT NOT NULL DEFAULT '',
    "payloadJson" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AdSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdSnapshot_accountKey_createdAt_idx" ON "AdSnapshot"("accountKey", "createdAt");
