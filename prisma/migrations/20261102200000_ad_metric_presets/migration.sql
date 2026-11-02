-- Analyse Ads : préréglages de colonnes nommés (comme Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "AdMetricPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL DEFAULT '[]',
    "columnsJson" TEXT NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdMetricPreset_pkey" PRIMARY KEY ("id")
);
