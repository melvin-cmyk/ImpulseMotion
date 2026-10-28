-- Mo (/mo): one voice session of a consultant = one board of floating cards
CREATE TABLE "MoBoard" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "dock" BOOLEAN NOT NULL DEFAULT false,
    "cardsJson" TEXT NOT NULL DEFAULT '[]',
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MoBoard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MoBoard_userId_updatedAt_idx" ON "MoBoard"("userId", "updatedAt");
ALTER TABLE "MoBoard" ADD CONSTRAINT "MoBoard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
