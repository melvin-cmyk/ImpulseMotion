import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listBotsFor } from "@/lib/bot-access";
import { isStaff } from "@/lib/auth-helpers";

/**
 * /bot — entry point of the private client assistant.
 *   staff  → the left panel (app/bot/layout.tsx) is the picker; this page only
 *            says so, and never auto-redirects (staff must pick knowingly).
 *   client → one bot → straight to it; several → pick; none → explain.
 */
export default async function BotIndex() {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/bot");

  if (isStaff(session)) {
    return (
      <div className="h-full flex items-center justify-center px-6 py-16">
        <div className="text-center space-y-2 max-w-sm">
          <h1 className="text-lg font-semibold text-white">Choisissez un assistant dans le panneau de gauche</h1>
          <p className="text-sm text-gray-500">
            Chaque assistant répond à partir des données d&apos;un seul client. Le panneau indique lesquels sont visibles par les clients.
          </p>
        </div>
      </div>
    );
  }

  const bots = await listBotsFor(session);
  if (bots.length === 1) redirect(`/bot/${bots[0].id}`);

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Assistant IA</h1>
        <p className="text-sm text-gray-500 mt-1">Posez vos questions sur vos performances marketing et commerciales.</p>
      </div>
      <div className="grid gap-3">
        {bots.map((b) => (
          <Link
            key={b.id}
            href={`/bot/${b.id}`}
            className="flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-violet-700 rounded-xl px-5 py-4 transition-colors"
          >
            <span>
              <span className="block text-sm font-semibold text-white">{b.dashboardName}</span>
              <span className="block text-xs text-gray-500 mt-0.5">{b.name}</span>
            </span>
            <span className="text-gray-600 text-sm">→</span>
          </Link>
        ))}
        {bots.length === 0 && (
          <div className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-5 py-6">
            Aucun assistant ne vous est encore attribué — contactez votre interlocuteur chez Impulse Analytics.
          </div>
        )}
      </div>
    </div>
  );
}
