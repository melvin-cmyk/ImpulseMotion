-- AlterTable
ALTER TABLE "ClientAlert" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupJson" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "groupPlatforms" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "ClientAlert_groupId_idx" ON "ClientAlert"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAlert_groupId_alertClientId_key" ON "ClientAlert"("groupId", "alertClientId");
