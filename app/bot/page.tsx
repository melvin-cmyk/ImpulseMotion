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
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <div>
        <h1 className="text-3xl font-normal text-ui-fg">Assistant IA</h1>
        <p className="text-[15px] text-ui-fg2 mt-2">Choisissez la marque sur laquelle poser vos questions</p>
      </div>
      <div className="border-t border-ui-line">
        {bots.map((b) => (
          <Link
            key={b.id}
            href={`/bot/${b.id}`}
            className="group flex items-center justify-between h-16 px-1 border-b border-ui-line transition-colors duration-150"
          >
            <span className="min-w-0">
              <span className="block text-sm text-ui-fg group-hover:text-ui-accent-ink transition-colors duration-150">{b.dashboardName}</span>
              <span className="block text-xs text-ui-muted mt-0.5">{b.name}</span>
            </span>
            <span className="text-ui-muted text-sm" aria-hidden>→</span>
          </Link>
        ))}
        {bots.length === 0 && (
          <p className="text-sm text-ui-fg2 py-6">
            Aucun assistant ne vous est encore attribué. Votre interlocuteur chez Impulse Analytics peut vous en ouvrir un.
          </p>
        )}
      </div>
    </div>
  );
}
