-- « Mes dashboards » : pages HTML libres du staff sur des jeux de données lus par le relay
CREATE TABLE "StaffDashboard" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "datasetsJson" TEXT NOT NULL DEFAULT '{}',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "html" TEXT NOT NULL DEFAULT '',
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffDashboard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffDashboard_ownerId_updatedAt_idx" ON "StaffDashboard"("ownerId", "updatedAt");
CREATE INDEX "StaffDashboard_shared_updatedAt_idx" ON "StaffDashboard"("shared", "updatedAt");
ALTER TABLE "StaffDashboard" ADD CONSTRAINT "StaffDashboard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
