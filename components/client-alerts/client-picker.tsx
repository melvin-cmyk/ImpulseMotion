"use client";

/**
 * First step of a new alert: which client. A search box over the clients the
 * person may see, with the platforms each one has; clients that spend nothing
 * stay out of the way behind a toggle.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { SHOW_DORMANT, pickOnEnter, platformCounts, type ClientOption } from "@/components/client-alerts/alert-model";

const plain = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function PlatformBadges({ accounts, className }: { accounts: Array<{ platform: string }>; className?: string }) {
  const n = platformCounts(accounts);
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {n.meta > 0 && <Pill tone="blue" className="text-[10px]">Meta{n.meta > 1 ? ` × ${n.meta}` : ""}</Pill>}
      {n.google > 0 && <Pill tone="emerald" className="text-[10px]">Google Ads{n.google > 1 ? ` × ${n.google}` : ""}</Pill>}
    </span>
  );
}

export function ClientPicker({ clients, busyId, error, focusKey, onPick }: {
  clients: ClientOption[];
  /** Client whose draft is being created. */
  busyId: string | null;
  error: string | null;
  /** Changes when « Nouvelle alerte » is clicked: the search box takes the focus again. */
  focusKey: number;
  onPick: (client: ClientOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [showDormant, setShowDormant] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, [focusKey]);

  const q = plain(query.trim());
  const matching = useMemo(
    () => clients.filter((c) => !q || plain(c.name).includes(q) || c.accounts.some((a) => plain(a.name).includes(q) || a.accountId.includes(q))),
    [clients, q],
  );
  const shown = matching.filter((c) => showDormant || !c.dormant);
  const hiddenDormant = matching.length - shown.length;
  const dormantTotal = clients.filter((c) => c.dormant).length;
  const busy = busyId !== null;

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl flex flex-col min-w-0">
      <header className="px-4 py-3 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">Nouvelle alerte</h2>
        <p className="text-[11px] text-gray-500">Pour quel client ? Vous direz ensuite, en une phrase, de quoi vous voulez être prévenu.</p>
      </header>

      <div className="px-4 py-3 flex flex-wrap items-center gap-3 border-b border-gray-800">
        <label className="relative flex-1 min-w-[12rem]">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              // Nothing typed, nothing chosen: Enter in an empty box must not open the first client of the list.
              const first = busy ? null : pickOnEnter(query, shown);
              if (first) onPick(first);
            }}
            placeholder="Chercher un client ou un compte"
            aria-label="Chercher un client"
            className="w-full pl-9 pr-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white placeholder:text-gray-600 focus:border-violet-500 focus:outline-none"
          />
        </label>
        {dormantTotal > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" className="accent-violet-500" checked={showDormant} onChange={(e) => setShowDormant(e.target.checked)} />
            {SHOW_DORMANT}
          </label>
        )}
      </div>

      {error && <p role="alert" className="px-4 py-2 text-xs text-red-400 border-b border-gray-800">{error}</p>}

      <ul className="overflow-y-auto max-h-[min(60vh,32rem)] divide-y divide-gray-800/70">
        {clients.length === 0 && <li className="px-4 py-6 text-sm text-gray-400">Aucun client à afficher : aucun compte publicitaire ne vous est attribué.</li>}
        {clients.length > 0 && shown.length === 0 && (
          <li className="px-4 py-6 text-sm text-gray-400">
            Aucun client ne correspond.
            {hiddenDormant > 0 && (
              <button type="button" onClick={() => setShowDormant(true)} className="ml-1 underline text-gray-300">
                {hiddenDormant} client{hiddenDormant > 1 ? "s" : ""} sans dépense correspond{hiddenDormant > 1 ? "ent" : ""} : l{hiddenDormant > 1 ? "es" : "e"} afficher.
              </button>
            )}
          </li>
        )}
        {shown.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(c)}
              className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-gray-800/40 focus:bg-gray-800/40 focus:outline-none disabled:opacity-60 transition-colors"
            >
              <span className="min-w-0 flex items-center gap-2">
                <span className="text-sm text-white truncate">{c.name}</span>
                {c.dormant && <span title="Aucune dépense sur les dix derniers jours"><Pill className="text-[10px]">sans dépense</Pill></span>}
                {q && i === 0 && !busy && <span className="hidden sm:inline text-[10px] text-gray-600">Entrée</span>}
              </span>
              <span className="shrink-0 inline-flex items-center gap-2">
                {busyId === c.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-300" />}
                <PlatformBadges accounts={c.accounts} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
