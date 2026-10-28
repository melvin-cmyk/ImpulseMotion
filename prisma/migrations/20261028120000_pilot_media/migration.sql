-- Pilotage — publication vidéo Meta (lot 1) : médias envoyés avant la création d'une publicité.
-- Additif seulement. PilotOperation.status est une colonne texte : la nouvelle valeur « uploading »
-- ne demande aucun changement de schéma.
CREATE TABLE "PilotMedia" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "studioAssetId" TEXT,
    "thumbUrl" TEXT,
    "remoteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "error" TEXT,
    "actionId" TEXT,
    "operationId" TEXT,
    "createdById" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PilotMedia_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PilotMedia_status_createdAt_idx" ON "PilotMedia"("status", "createdAt");
CREATE INDEX "PilotMedia_actionId_idx" ON "PilotMedia"("actionId");
