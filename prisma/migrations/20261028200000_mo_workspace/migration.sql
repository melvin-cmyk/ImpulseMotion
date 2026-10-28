-- Mo workspace: pages (home | client | free), client pages, archive, order in the rail. Additive.
ALTER TABLE "MoBoard" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "MoBoard" ADD COLUMN IF NOT EXISTS "clientId" TEXT;
ALTER TABLE "MoBoard" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "MoBoard" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "MoBoard_userId_kind_idx" ON "MoBoard"("userId", "kind");
-- The existing « Mo partout » board of each consultant is their home page.
UPDATE "MoBoard" SET "kind" = 'home' WHERE "dock" = true;
