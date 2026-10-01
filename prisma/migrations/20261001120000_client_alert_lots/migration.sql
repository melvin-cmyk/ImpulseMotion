-- AlterTable
ALTER TABLE "ClientAlert" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupJson" TEXT NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "ClientAlert_groupId_idx" ON "ClientAlert"("groupId");
