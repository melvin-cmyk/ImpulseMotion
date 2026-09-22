"use client";

/**
 * Staff-only left panel of /bot: every client of the viewer's scope with the
 * state of its assistant, so a consultant knows which client AI they are on
 * and whether clients can actually reach it. Mounted by app/bot/layout.tsx;
 * clients never see it (they only get their own bots, GET /api/bot).
 *
 * Grouping (from GET /api/bot/overview):
 *   « Accessibles aux clients »     bot enabled  && accessCount > 0
 *   « Non accessibles aux clients » bot enabled  && accessCount === 0 (« aucun accès »)
 *                                   bot disabled                     (« inactif »)
 *   « Sans assistant »              no bot — admins get a « Créer » link
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Bot, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/ui/surface";

type OverviewItem = {
  dashboardId: string;
  dashboardName: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  bot: { id: string; name: string; enabled: boolean; accessCount: number } | null;
};

type Group = { key: string; title: string; hint: string; items: OverviewItem[] };

function groupItems(items: OverviewItem[]): Group[] {
  const open: OverviewItem[] = [];
  const closed: OverviewItem[] = [];
  const none: OverviewItem[] = [];
  for (const it of items) {
    if (!it.bot) none.push(it);
    else if (it.bot.enabled && it.bot.accessCount > 0) open.push(it);
    else closed.push(it);
  }
  return [
    { key: "open", title: "Accessibles aux clients", hint: "Actifs, avec au moins un accès client", items: open },
    { key: "closed", title: "Non accessibles aux clients", hint: "Sans accès client ou désactivés", items: closed },
    { key: "none", title: "Sans assistant", hint: "Clients sans bot configuré", items: none },
  ];
}

function accountsLine(it: OverviewItem): string {
  const parts: string[] = [];
  if (it.metaAccountId) parts.push(`Meta · ${it.metaAccountId}`);
  if (it.googleCustomerId) parts.push(`Google · ${it.googleCustomerId}`);
  return parts.length ? parts.join("  ·  ") : "aucun compte";
}

function BotPill({ bot }: { bot: NonNullable<OverviewItem["bot"]> }) {
  if (!bot.enabled) return <Pill tone="red" className="!text-[10px] !px-1.5">inactif</Pill>;
  if (bot.accessCount === 0) return <Pill tone="amber" className="!text-[10px] !px-1.5">aucun accès</Pill>;
  return <Pill tone="emerald" className="!text-[10px] !px-1.5">{bot.accessCount} accès</Pill>;
}

export function BotsPanel() {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();
  const isAdmin = session?.role === "admin";
  const [items, setItems] = useState<OverviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const groups = items ? groupItems(items) : [];

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
          Vue staff : les clients ne voient que leur assistant.
        </p>
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
                  const active = !!it.bot && it.bot.id === activeBotId;
                  const rowCls = cn(
                    "block rounded-lg px-2.5 py-2 transition-colors",
                    active ? "bg-violet-500/15 text-white" : "text-gray-400",
                    it.bot ? "hover:bg-gray-900 hover:text-gray-200" : "",
                    it.bot && !it.bot.enabled && !active ? "opacity-70" : "",
                  );
                  const body = (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("text-sm truncate", active ? "font-semibold text-white" : "text-gray-200")}>
                          {it.dashboardName}
                        </span>
                        {it.bot ? (
                          <BotPill bot={it.bot} />
                        ) : isAdmin ? (
                          <Link
                            href={`/admin/bots/${it.dashboardId}`}
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-gray-700 text-gray-300 hover:text-white hover:border-violet-500 transition-colors"
                          >
                            Créer
                          </Link>
                        ) : (
                          <span className="text-[10px] text-gray-600">aucun</span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate mt-0.5" title={accountsLine(it)}>
                        {accountsLine(it)}
                      </div>
                    </>
                  );
                  return it.bot ? (
                    <Link key={it.dashboardId} href={`/bot/${it.bot.id}`} className={rowCls} aria-current={active ? "page" : undefined}>
                      {body}
                    </Link>
                  ) : (
                    <div key={it.dashboardId} className={cn(rowCls, "opacity-60")}>
                      {body}
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
