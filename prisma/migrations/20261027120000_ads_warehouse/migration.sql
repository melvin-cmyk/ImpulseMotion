-- Creative warehouse (Analyse Ads v2): AdCatalog, AdDaily, AdSyncState
-- CreateTable
CREATE TABLE "AdCatalog" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "adsetId" TEXT,
    "adsetName" TEXT,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "format" TEXT NOT NULL DEFAULT 'Unknown',
    "dynamic" BOOLEAN NOT NULL DEFAULT false,
    "creativeId" TEXT,
    "creativeKey" TEXT,
    "thumbnailUrl" TEXT,
    "imageUrl" TEXT,
    "videoId" TEXT,
    "previewUrl" TEXT,
    "title" TEXT,
    "body" TEXT,
    "cta" TEXT,
    "landingUrl" TEXT,
    "createdTime" TIMESTAMP(3),
    "tagsJson" TEXT NOT NULL DEFAULT '{}',
    "platformUpdatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdDaily" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "currency" TEXT,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversionValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchases" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchaseValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "leads" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "videoPlays" INTEGER NOT NULL DEFAULT 0,
    "video3s" INTEGER NOT NULL DEFAULT 0,
    "thruPlays" INTEGER NOT NULL DEFAULT 0,
    "videoP25" INTEGER NOT NULL DEFAULT 0,
    "videoP50" INTEGER NOT NULL DEFAULT 0,
    "videoP75" INTEGER NOT NULL DEFAULT 0,
    "videoP100" INTEGER NOT NULL DEFAULT 0,
    "actionsJson" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSyncState" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "syncedFrom" DATE,
    "syncedTo" DATE,
    "metaFullAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "adCount" INTEGER NOT NULL DEFAULT 0,
    "dayRows" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdCatalog_platform_accountId_idx" ON "AdCatalog"("platform", "accountId");

-- CreateIndex
CREATE INDEX "AdCatalog_accountId_createdTime_idx" ON "AdCatalog"("accountId", "createdTime");

-- CreateIndex
CREATE INDEX "AdCatalog_creativeKey_idx" ON "AdCatalog"("creativeKey");

-- CreateIndex
CREATE INDEX "AdCatalog_campaignId_idx" ON "AdCatalog"("campaignId");

-- CreateIndex
CREATE INDEX "AdDaily_accountId_date_idx" ON "AdDaily"("accountId", "date");

-- CreateIndex
CREATE INDEX "AdDaily_platform_accountId_date_idx" ON "AdDaily"("platform", "accountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AdDaily_platform_adId_date_key" ON "AdDaily"("platform", "adId", "date");

-- CreateIndex
CREATE INDEX "AdSyncState_platform_syncedTo_idx" ON "AdSyncState"("platform", "syncedTo");
