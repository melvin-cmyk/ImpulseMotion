-- Tâches IA détachées : la réponse d'un assistant continue quand le consultant change de page
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "botId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "title" TEXT NOT NULL DEFAULT '',
    "userMessageJson" TEXT NOT NULL DEFAULT '{}',
    "usageContextJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiJob_userId_status_idx" ON "AiJob"("userId", "status");
CREATE INDEX "AiJob_conversationId_status_idx" ON "AiJob"("conversationId", "status");
