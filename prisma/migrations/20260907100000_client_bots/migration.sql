-- CreateTable
CREATE TABLE "ClientBot" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'Assistant',
    "clientKey" TEXT NOT NULL,
    "businessContext" TEXT NOT NULL DEFAULT '',
    "sourcesJson" TEXT NOT NULL DEFAULT '{}',
    "ingestTokenHash" TEXT,
    "lastIngestAt" TIMESTAMP(3),
    "lastIngestRows" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientBot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientBotAccess" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientBotAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConversation" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientBot_dashboardId_key" ON "ClientBot"("dashboardId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientBot_clientKey_key" ON "ClientBot"("clientKey");

-- CreateIndex
CREATE INDEX "ClientBotAccess_userId_idx" ON "ClientBotAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientBotAccess_botId_userId_key" ON "ClientBotAccess"("botId", "userId");

-- CreateIndex
CREATE INDEX "BotConversation_botId_userId_updatedAt_idx" ON "BotConversation"("botId", "userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ClientBot" ADD CONSTRAINT "ClientBot_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBotAccess" ADD CONSTRAINT "ClientBotAccess_botId_fkey" FOREIGN KEY ("botId") REFERENCES "ClientBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBotAccess" ADD CONSTRAINT "ClientBotAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "ClientBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

