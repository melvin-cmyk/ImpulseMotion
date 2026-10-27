"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, Command } from "lucide-react";
import { useAccountList } from "@/lib/use-account-list";
import { ClientPalette, type ClientRow } from "@/components/client-palette";
import { useCreativesContext, setStoredMetaAccount } from "@/lib/creatives-context";
import { isAnalysePath } from "@/lib/nav-routes";

/**
 * Global client search (⌘K) for the staff chrome. It never filters the page
 * it is opened from — it navigates:
 *   - outside Analyse Ads: ↵ opens the client sheet (/portfolio/[id]),
 *     → sends to the creative analysis with that account selected;
 *   - inside Analyse Ads: ↵ switches the analysed account, → opens the sheet.
 */
export function CommandPalette({ userId }: { userId: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const inAnalyse = isAnalysePath(pathname);
  const { metaAccountId } = useCreativesContext();
  // Lazy: the list is fetched the first time the palette opens.
  const { accounts, loading, reload, loaded } = useAccountList(userId, false);
  // The clients (deduped dashboards) with every identifier: fetched once per session, refreshed when the palette opens.
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const loadClients = useCallback(async () => {
    setClientsLoading(true);
    try {
      const res = await fetch("/api/clients", { cache: "no-store" });
      if (res.ok) setClients(((await res.json()) as { clients: ClientRow[] }).clients ?? []);
    } catch { /* the Meta accounts still show */ }
    finally { setClientsLoading(false); }
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  useEffect(() => {
    if (open) { void reload(loaded); void Promise.resolve().then(() => loadClients()); }
  }, [open, reload, loaded, loadClients]);

  // Warm the list once the page has settled so the first ⌘K opens instantly
  // (one request per session: the result is cached 5 min per user).
  useEffect(() => {
    if (!userId) return;
    const t = setTimeout(() => void reload(true), 4000);
    return () => clearTimeout(t);
  }, [userId, reload]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 hover:bg-gray-900 hover:border-gray-700 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors w-64 max-w-[50vw]"
        title="Rechercher un client (⌘K)"
      >
        <Search className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 text-left truncate">Rechercher un client…</span>
        <kbd className="hidden md:inline-flex items-center gap-0.5 text-[10px] text-gray-500 bg-gray-950 border border-gray-800 rounded px-1 py-0.5">
          <Command className="w-2.5 h-2.5" />K
        </kbd>
      </button>

      <ClientPalette
        open={open}
        onClose={() => setOpen(false)}
        clients={clients}
        accounts={accounts}
        loading={(loading || clientsLoading) && clients.length === 0}
        currentAccountId={inAnalyse ? metaAccountId : null}
        primary={inAnalyse ? "analyse" : "client"}
        title={inAnalyse ? "Changer le compte analysé, ou aller à un client…" : "Client, compte Meta (act_…), Google Ads (123-456-7890), TikTok…"}
        onPickClient={(c) => {
          setOpen(false);
          // Cockpit when the client has a dashboard, its Analyse Ads otherwise (Google-only clients…).
          router.push(c.dashboardId ? `/portfolio/${c.dashboardId}` : `/analyse?client=${c.clientId}`);
        }}
        onPickAccount={(a, action) => {
          setOpen(false);
          if (action === "client" && a.clientId) {
            router.push(`/portfolio/${a.clientId}`);
            return;
          }
          setStoredMetaAccount(a.id, a.name);
          if (!inAnalyse) router.push("/creatives");
        }}
      />
    </>
  );
}
