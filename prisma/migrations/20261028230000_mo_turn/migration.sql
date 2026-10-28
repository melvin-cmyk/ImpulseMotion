-- Mo measures (spec §6): one row per turn — path, time to first card, understood or not. Additive.
CREATE TABLE IF NOT EXISTS "MoTurn" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "boardId" TEXT NOT NULL,
  "jobId" TEXT,
  "path" TEXT NOT NULL,
  "kind" TEXT,
  "firstCardMs" INTEGER,
  "totalMs" INTEGER NOT NULL DEFAULT 0,
  "clarified" BOOLEAN NOT NULL DEFAULT false,
  "retried" BOOLEAN NOT NULL DEFAULT false,
  "misunderstood" BOOLEAN NOT NULL DEFAULT false,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MoTurn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MoTurn_at_idx" ON "MoTurn"("at");
CREATE INDEX IF NOT EXISTS "MoTurn_userId_at_idx" ON "MoTurn"("userId", "at");
CREATE INDEX IF NOT EXISTS "MoTurn_jobId_idx" ON "MoTurn"("jobId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MoTurn_userId_fkey') THEN
    ALTER TABLE "MoTurn" ADD CONSTRAINT "MoTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
