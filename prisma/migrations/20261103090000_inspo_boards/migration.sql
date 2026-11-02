-- Boards d'inspiration (comme l'Inspo de Motion). Additif, rejouable.
CREATE TABLE IF NOT EXISTS "InspoBoard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "clientId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InspoBoard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "InspoBoard_clientId_idx" ON "InspoBoard"("clientId");
CREATE TABLE IF NOT EXISTS "InspoItem" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "title" TEXT,
    "body" TEXT,
    "imageUrl" TEXT,
    "videoUrl" TEXT,
    "linkUrl" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "addedById" TEXT,
    "addedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InspoItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InspoItem_boardId_ref_key" ON "InspoItem"("boardId", "ref");
CREATE INDEX IF NOT EXISTS "InspoItem_boardId_idx" ON "InspoItem"("boardId");
DO $$ BEGIN
  ALTER TABLE "InspoItem" ADD CONSTRAINT "InspoItem_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "InspoBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
