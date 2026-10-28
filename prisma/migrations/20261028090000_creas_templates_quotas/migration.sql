-- Créas par client : templates (swipe file), lien asset → template, verdict du consultant, quotas admin
ALTER TABLE "CreativeAsset" ADD COLUMN "templateId" TEXT;
ALTER TABLE "CreativeAsset" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE "CreativeAsset" ADD COLUMN "feedback" TEXT;
ALTER TABLE "CreativeAsset" ADD COLUMN "feedbackNote" TEXT;
CREATE INDEX "CreativeAsset_templateId_idx" ON "CreativeAsset"("templateId");

CREATE TABLE "CreativeTemplate" (
    "id" TEXT NOT NULL,
    "alertClientId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "sourceRef" TEXT,
    "sourceUrl" TEXT,
    "imageUrl" TEXT,
    "file" TEXT,
    "title" TEXT,
    "body" TEXT,
    "analysisJson" TEXT NOT NULL DEFAULT '{}',
    "tags" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreativeTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreativeTemplate_alertClientId_createdAt_idx" ON "CreativeTemplate"("alertClientId", "createdAt");
CREATE INDEX "CreativeTemplate_createdAt_idx" ON "CreativeTemplate"("createdAt");

CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "ClientBot" ADD COLUMN "dailyMessages" INTEGER;
