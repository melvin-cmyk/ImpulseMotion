-- Client feedback on their private assistant (box of the bot chat).
CREATE TABLE "BotFeedback" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" TEXT,
    "message" TEXT NOT NULL,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFeedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BotFeedback_botId_createdAt_idx" ON "BotFeedback"("botId", "createdAt");
ALTER TABLE "BotFeedback" ADD CONSTRAINT "BotFeedback_botId_fkey" FOREIGN KEY ("botId") REFERENCES "ClientBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotFeedback" ADD CONSTRAINT "BotFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
