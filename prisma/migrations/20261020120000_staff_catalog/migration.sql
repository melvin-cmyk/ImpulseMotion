-- Catalogue « Métriques & dimensions » des dashboards du staff
CREATE TABLE "StaffMetric" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT 'any',
    "formula" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'number',
    "unit" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffMetric_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffMetric_key_key" ON "StaffMetric"("key");
ALTER TABLE "StaffMetric" ADD CONSTRAINT "StaffMetric_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffDimension" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT 'any',
    "field" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'field',
    "ruleJson" TEXT NOT NULL DEFAULT '{}',
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffDimension_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffDimension_key_key" ON "StaffDimension"("key");
ALTER TABLE "StaffDimension" ADD CONSTRAINT "StaffDimension_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
