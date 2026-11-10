-- Thumbs under each answer of the bot chat: what was asked and the answer rated.
ALTER TABLE "BotFeedback" ADD COLUMN "question" TEXT;
ALTER TABLE "BotFeedback" ADD COLUMN "answerExcerpt" TEXT;
