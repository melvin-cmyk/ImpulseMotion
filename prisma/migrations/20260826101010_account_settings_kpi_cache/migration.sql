-- CreateTable
CREATE TABLE "AccountSetting" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'meta',
    "accountId" TEXT NOT NULL,
    "aov" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiCache" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountSetting_platform_accountId_key" ON "AccountSetting"("platform", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "KpiCache_key_key" ON "KpiCache"("key");

-- CreateIndex
CREATE INDEX "KpiCache_expiresAt_idx" ON "KpiCache"("expiresAt");

