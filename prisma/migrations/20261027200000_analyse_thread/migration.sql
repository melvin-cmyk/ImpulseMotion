-- Analyse Ads copilot thread (detached replies): one per consultant and client
CREATE TABLE "AnalyseThread" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientParam" TEXT,
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalyseThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnalyseThread_accountKey_userId_key" ON "AnalyseThread"("accountKey", "userId");
CREATE INDEX "AnalyseThread_updatedAt_idx" ON "AnalyseThread"("updatedAt");
