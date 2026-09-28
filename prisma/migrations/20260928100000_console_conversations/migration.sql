-- CreateTable
CREATE TABLE "ConsoleConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsoleConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsoleConversation_userId_updatedAt_idx" ON "ConsoleConversation"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ConsoleConversation" ADD CONSTRAINT "ConsoleConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

