"use client";

/**
 * Staff-only left panel of /bot: every client of the viewer's scope with the
 * state of its assistant, so a consultant knows which client AI they are on
 * and whether clients can actually reach it. Mounted by app/bot/layout.tsx;
 * clients never see it (they only get their own bots, GET /api/bot).
 *
 * One row per client of the agency (GET /api/bot/overview, same list as
 * /admin/bots), grouped by its best bot:
 *   « Accessibles aux clients »     bot enabled  && accessCount > 0
 *   « Non accessibles aux clients » bot enabled  && accessCount === 0 (« aucun accès »)
 *                                   bot disabled                     (« inactif »)
 *   « Sans assistant »              no bot — admins get a « Créer » link to /admin/bots
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Bot, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/ui/surface";

type OverviewBot = { id: string; name: string; enabled: boolean; accessCount: number; dashboardId: string; dashboardName: string };
type OverviewItem = {
  key: string;
  clientId: string | null;
  name: string;
  dormant: boolean;
  accounts: Array<{ platform: "meta" | "google"; accountId: string; name: string }>;
  bots: OverviewBot[];
};

type Group = { key: string; title: string; hint: string; items: OverviewItem[] };

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function groupItems(items: OverviewItem[]): Group[] {
  const open: OverviewItem[] = [];
  const closed: OverviewItem[] = [];
  const none: OverviewItem[] = [];
  for (const it of items) {
    // The best bot of the client decides (bots come best first).
    const best = it.bots[0];
    if (!best) none.push(it);
    else if (best.enabled && best.accessCount > 0) open.push(it);
    else closed.push(it);
  }
  return [
    { key: "open", title: "Accessibles aux clients", hint: "Actifs, avec au moins un accès client", items: open },
    { key: "closed", title: "Non accessibles aux clients", hint: "Sans accès client ou désactivés", items: closed },
    { key: "none", title: "Sans assistant", hint: "Clients sans bot configuré", items: none },
  ];
}

const PLATFORM_SHORT: Record<string, string> = { meta: "Meta", google: "Google" };

function accountsLine(it: OverviewItem): string {
  if (!it.accounts.length) return "aucun compte";
  return it.accounts.map((a) => `${PLATFORM_SHORT[a.platform] ?? a.platform} · ${a.name}`).join("  ·  ");
}

function BotPill({ bot }: { bot: OverviewBot }) {
  if (!bot.enabled) return <Pill tone="red" className="!text-[10px] !px-1.5">inactif</Pill>;
  if (bot.accessCount === 0) return <Pill tone="amber" className="!text-[10px] !px-1.5">aucun accès</Pill>;
  return <Pill tone="emerald" className="!text-[10px] !px-1.5">{bot.accessCount} accès</Pill>;
}

export function BotsPanel() {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();
  // Setting up a client's private assistant is for the real admins (lib/roles.ts).
  const isAdmin = session?.baseRole === "admin";
  const [items, setItems] = useState<OverviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/bot/overview")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Erreur ${r.status}`);
        const j = (await r.json()) as { items: OverviewItem[] };
        if (!cancelled) setItems(j.items);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Erreur"); });
    return () => { cancelled = true; };
  }, []);

  const activeBotId = pathname.startsWith("/bot/") ? pathname.slice("/bot/".length).split("/")[0] : null;
  const q = fold(query.trim());
  const shown = (items ?? []).filter((it) => !q || [it.name, ...it.accounts.flatMap((a) => [a.name, a.accountId]), ...it.bots.map((b) => b.dashboardName)].some((s) => fold(s).includes(q)));
  const groups = groupItems(shown);

  return (
    <aside className="w-64 shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col min-h-0">
      <div className="px-4 pt-4 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-violet-500/15 text-violet-400 flex items-center justify-center shrink-0">
            <Bot className="w-4 h-4" />
          </div>
          <span className="text-sm font-semibold text-white">Assistants clients</span>
        </div>
        <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">
          Vue staff : tous les clients de l&apos;agence. Les clients ne voient que leur assistant.
        </p>
        <label className="mt-2 flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-2 py-1">
          <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={items ? `Chercher parmi ${items.length} clients` : "Chercher un client"}
            className="bg-transparent text-xs text-white outline-none flex-1 min-w-0"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {items === null && !error && (
          <div className="text-xs text-gray-500 px-4 py-3 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Chargement…
          </div>
        )}
        {error && <p className="text-xs text-red-400 px-4 py-3">{error}</p>}
        {items !== null && items.length === 0 && (
          <p className="text-xs text-gray-500 px-4 py-3">Aucun client dans votre périmètre.</p>
        )}
        {items !== null && items.length > 0 && shown.length === 0 && (
          <p className="text-xs text-gray-500 px-4 py-3">Aucun client trouvé.</p>
        )}

        {groups.map((g) => {
          if (g.items.length === 0) return null;
          return (
            <div key={g.key} className="mb-3">
              <div className="px-4 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-gray-600 font-semibold">{g.title}</span>
                <span className="block text-[10px] text-gray-700">{g.hint}</span>
              </div>
              <div className="flex flex-col gap-0.5 px-2">
                {g.items.map((it) => {
                  const best = it.bots[0];
                  const active = it.bots.some((b) => b.id === activeBotId);
                  const rowCls = cn(
                    "block rounded-lg px-2.5 py-2 transition-colors",
                    active ? "bg-violet-500/15 text-white" : "text-gray-400",
                    best ? "hover:bg-gray-900 hover:text-gray-200" : "",
                    best && !best.enabled && !active ? "opacity-70" : "",
                  );
                  const body = (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("text-sm truncate", active ? "font-semibold text-white" : "text-gray-200")}>
                          {it.name}
                        </span>
                        {best ? (
                          <BotPill bot={best} />
                        ) : isAdmin ? (
                          <Link
                            href={`/admin/bots?q=${encodeURIComponent(it.name)}`}
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-gray-700 text-gray-300 hover:text-white hover:border-violet-500 transition-colors"
                          >
                            Créer
                          </Link>
                        ) : (
                          <span className="text-[10px] text-gray-600">aucun</span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate mt-0.5" title={accountsLine(it)}>
                        {it.dormant ? "sans dépense récente · " : ""}{accountsLine(it)}
                      </div>
                    </>
                  );
                  if (!best) return <div key={it.key} className={cn(rowCls, "opacity-60")}>{body}</div>;
                  return (
                    <div key={it.key}>
                      <Link href={`/bot/${best.id}`} className={rowCls} aria-current={active && best.id === activeBotId ? "page" : undefined}>
                        {body}
                      </Link>
                      {/* A client with several dashboards may have several bots: each one stays reachable. */}
                      {it.bots.slice(1).map((b) => (
                        <Link
                          key={b.id}
                          href={`/bot/${b.id}`}
                          className={cn("ml-3 flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] hover:bg-gray-900", b.id === activeBotId ? "text-white" : "text-gray-500")}
                        >
                          <span className="truncate">{b.dashboardName}</span>
                          <BotPill bot={b} />
                        </Link>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
