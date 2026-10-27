-- Analyse Ads v2: saved reports (AnalyseView) + consultant notes / custom tags per ad (AdAnnotation)
-- CreateTable
CREATE TABLE "AnalyseView" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '🏆',
    "configJson" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyseView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdAnnotation" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyseView_accountKey_updatedAt_idx" ON "AnalyseView"("accountKey", "updatedAt");

-- CreateIndex
CREATE INDEX "AdAnnotation_accountId_idx" ON "AdAnnotation"("accountId");
