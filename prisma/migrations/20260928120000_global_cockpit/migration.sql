-- CreateTable
CREATE TABLE "CockpitClient" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "kpiMode" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CockpitClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CockpitAccount" (
    "id" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT,
    "label" TEXT,
    "mode" TEXT,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CockpitAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CockpitSnapshot" (
    "id" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'full',
    "clients" INTEGER NOT NULL DEFAULT 0,
    "dataJson" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CockpitSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CockpitAction" (
    "id" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT '',
    "owner" TEXT,
    "due" TEXT,
    "note" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CockpitAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CockpitClient_key_key" ON "CockpitClient"("key");

-- CreateIndex
CREATE INDEX "CockpitAccount_clientKey_idx" ON "CockpitAccount"("clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "CockpitAccount_platform_accountId_key" ON "CockpitAccount"("platform", "accountId");

-- CreateIndex
CREATE INDEX "CockpitSnapshot_createdAt_idx" ON "CockpitSnapshot"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CockpitAction_clientKey_key" ON "CockpitAction"("clientKey");

