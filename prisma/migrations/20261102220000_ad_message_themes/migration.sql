-- Analyse Ads : thèmes de message par client (comme Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "AdMessageTheme" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdMessageTheme_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdMessageTheme_accountKey_idx" ON "AdMessageTheme"("accountKey");
