import { auth } from "@/auth";
import { isStaff } from "@/lib/auth-helpers";
import { BotsPanel } from "@/components/bot/bots-panel";

/**
 * /bot chrome. Staff get a left panel listing every client assistant of their
 * scope (components/bot/bots-panel.tsx) so they know which client AI they are
 * on; clients keep the bare page — their bots are the only ones they can see.
 */
export default async function BotLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId || !isStaff(session)) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0">
      <BotsPanel />
      <div className="flex-1 min-w-0 min-h-0 overflow-auto">{children}</div>
    </div>
  );
}
