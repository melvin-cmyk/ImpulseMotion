import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadBotFor } from "@/lib/bot-access";
import { parseSources } from "@/lib/bot-types";
import { suggestionsForSources } from "@/lib/bot-prompt";
import { isStaff } from "@/lib/auth-helpers";
import { BotChat } from "@/components/bot/bot-chat";

/**
 * /bot/[botId] — the private assistant of one client brand.
 * Works for clients (client chrome) and staff (sidebar chrome) alike.
 */
export default async function BotPage({ params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const session = await auth();
  if (!session?.userId) redirect(`/login?callbackUrl=/bot/${botId}`);

  const loaded = await loadBotFor(session, botId);
  if (loaded.status === 404) notFound();
  if (loaded.status === 403) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center space-y-2">
        <h1 className="text-lg font-semibold text-white">Accès non autorisé</h1>
        <p className="text-sm text-gray-500">Cet assistant ne vous est pas attribué. Contactez votre interlocuteur chez Impulse Analytics.</p>
      </div>
    );
  }
  const { bot } = loaded;
  const sources = parseSources(bot.sourcesJson);

  const conversations = await prisma.botConversation.findMany({
    where: { botId: bot.id, userId: session.userId },
    select: { id: true, title: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return (
    <BotChat
      botId={bot.id}
      botName={bot.name}
      dashboardName={bot.dashboard.name}
      sources={sources}
      suggestions={suggestionsForSources(sources)}
      isStaff={isStaff(session)}
      initialConversations={conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString() }))}
    />
  );
}
