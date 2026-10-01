"use client";

/**
 * First step of a new alert: which clients. A search box over the clients the
 * person may see, with the platforms each one has; clients that spend nothing
 * stay out of the way behind a toggle. One client or several: the rule asked
 * next is put in service on each of them (a lot, lib/client-alerts/lot.ts).
 * Enter ticks the first client found and empties the box, to pick several by typing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Loader2, Search, X } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { SHOW_DORMANT, pickOnEnter, platformCounts, type ClientOption } from "@/components/client-alerts/alert-model";
import { LOT_MAX_CLIENTS } from "@/lib/client-alerts/types";

const plain = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function PlatformBadges({ accounts, className }: { accounts: Array<{ platform: string }>; className?: string }) {
  const n = platformCounts(accounts);
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {n.meta > 0 && <Pill tone="blue" className="text-[10px]">Meta{n.meta > 1 ? ` × ${n.meta}` : ""}</Pill>}
      {n.google > 0 && <Pill tone="emerald" className="text-[10px]">Google Ads{n.google > 1 ? ` × ${n.google}` : ""}</Pill>}
      {n.tiktok > 0 && <Pill tone="violet" className="text-[10px]">TikTok Ads{n.tiktok > 1 ? ` × ${n.tiktok}` : ""}</Pill>}
    </span>
  );
}

export function ClientPicker({ clients, busy, error, focusKey, onPick }: {
  clients: ClientOption[];
  /** The draft is being created. */
  busy: boolean;
  error: string | null;
  /** Changes when « Nouvelle alerte » is clicked: the search box takes the focus again. */
  focusKey: number;
  onPick: (clients: ClientOption[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [showDormant, setShowDormant] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, [focusKey]);

  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const chosen = picked.map((id) => byId.get(id)).filter((c): c is ClientOption => !!c);
  const full = chosen.length >= LOT_MAX_CLIENTS;
  const toggle = (c: ClientOption) => setPicked((list) => (
    list.includes(c.id) ? list.filter((id) => id !== c.id) : list.length >= LOT_MAX_CLIENTS ? list : [...list, c.id]
  ));

  const q = plain(query.trim());
  const matching = useMemo(
    () => clients.filter((c) => !q || plain(c.name).includes(q) || c.accounts.some((a) => plain(a.name).includes(q) || a.accountId.includes(q))),
    [clients, q],
  );
  const shown = matching.filter((c) => showDormant || !c.dormant);
  const hiddenDormant = matching.length - shown.length;
  const dormantTotal = clients.filter((c) => c.dormant).length;

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl flex flex-col min-w-0">
      <header className="px-4 py-3 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">Nouvelle alerte</h2>
        <p className="text-[11px] text-gray-500">
          Pour quels clients ? Cochez-en un ou plusieurs ({LOT_MAX_CLIENTS} au plus), puis dites en une phrase de quoi vous voulez être prévenu :
          la même alerte est créée pour chaque client, jugé sur ses propres comptes.
        </p>
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
              // Nothing typed: Enter goes on with the clients ticked. Something typed: the first client found is ticked.
              if (!query.trim()) { if (chosen.length && !busy) onPick(chosen); return; }
              const first = pickOnEnter(query, shown.filter((c) => !picked.includes(c.id)));
              if (first && !full) { toggle(first); setQuery(""); }
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

      {chosen.length > 0 && (
        <div className="px-4 py-2.5 border-b border-gray-800 flex flex-wrap items-center gap-2">
          {chosen.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c)}
              disabled={busy}
              aria-label={`Retirer ${c.name}`}
              className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full text-xs bg-violet-500/15 border border-violet-500/40 text-violet-100 hover:bg-violet-500/25 disabled:opacity-60"
            >
              <span className="truncate max-w-[12rem]">{c.name}</span><X className="w-3 h-3 shrink-0" />
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setPicked([])} disabled={busy} className="text-[11px] text-gray-500 hover:text-gray-300 underline disabled:opacity-60">Tout retirer</button>
            <button
              type="button"
              onClick={() => onPick(chosen)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              {chosen.length > 1 ? `Écrire l'alerte pour ${chosen.length} clients` : "Écrire l'alerte"}
            </button>
          </div>
          {full && <p className="w-full text-[11px] text-amber-400">{LOT_MAX_CLIENTS} clients au plus dans une même alerte.</p>}
        </div>
      )}

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
        {shown.map((c) => {
          const on = picked.includes(c.id);
          const firstFree = q && !busy && !full && shown.find((s) => !picked.includes(s.id))?.id === c.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={busy || (!on && full)}
                onClick={() => toggle(c)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-gray-800/40 focus:bg-gray-800/40 focus:outline-none disabled:opacity-60 transition-colors ${on ? "bg-violet-500/10" : ""}`}
              >
                <span className="min-w-0 flex items-center gap-2">
                  <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${on ? "bg-violet-600 border-violet-500" : "border-gray-600"}`}>
                    {on && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span className="text-sm text-white truncate">{c.name}</span>
                  {c.dormant && <span title="Aucune dépense sur les dix derniers jours"><Pill className="text-[10px]">sans dépense</Pill></span>}
                  {firstFree && <span className="hidden sm:inline text-[10px] text-gray-600">Entrée</span>}
                </span>
                <span className="shrink-0 inline-flex items-center gap-2">
                  <PlatformBadges accounts={c.accounts} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
