"use client";

/**
 * « Formats visuels » — Motion's visual format analysis: « Formats qui
 * marchent » (by spend) and « En test » (formats started in the last 30
 * days), each with an example creative, its number of creatives, spend and
 * hit rate. A card opens the creatives of that format. Creatives without the
 * AI tag can be analysed on demand.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import type { FormatStat } from "@/lib/ads-warehouse/formats";
import { fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import { AdMedia, MediaCaption } from "./ad-media";

interface Props { query: AdsQuery; onOpenFormat: (name: string) => void }
type Data = { top: FormatStat[]; testing: FormatStat[]; tagged: number; untagged: number; currency: string | null; justTagged?: number };

export function FormatsPanel({ query, onOpenFormat }: Props) {
  const body = useMemo(() => ({ platforms: query.platforms, accounts: query.accounts, accountIds: query.accountIds, range: query.range }), [query.platforms, query.accounts, query.accountIds, query.range]);
  const key = JSON.stringify(body);
  const [state, setState] = useState<{ key: string; data: Data | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = state && state.key === key ? state : null;

  async function run(action: "list" | "tag") {
    if (action === "tag") setBusy(true);
    try {
      const res = await fetch("/api/ads/formats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, action }) });
      const j = (await res.json().catch(() => ({}))) as Data & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setState({ key, data: j, error: null });
    } catch (e) { setState((s) => ({ key, data: s?.key === key ? s.data : null, error: e instanceof Error ? e.message : "Erreur" })); } finally { setBusy(false); }
  }
  useEffect(() => { queueMicrotask(() => { void run("list"); }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return <div className="px-6 py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Analyse des formats…</div>;
  const d = current.data;

  const grid = (items: FormatStat[], empty: string) => items.length === 0 ? <div className="py-8 text-center text-sm text-gray-500">{empty}</div> : (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {items.map((f) => (
        <div key={f.name} role="button" tabIndex={0} onClick={() => onOpenFormat(f.name)} onKeyDown={(e) => { if (e.key === "Enter") onOpenFormat(f.name); }} className="rounded-2xl border border-gray-800 bg-gray-900 hover:border-gray-700 overflow-hidden cursor-pointer">
          <AdMedia ad={f.example} ratio="4:5" onOpen={() => onOpenFormat(f.name)} caption={<MediaCaption>{f.creatives} créa{f.creatives > 1 ? "s" : ""}</MediaCaption>} />
          <div className="px-3 pt-2 pb-3">
            <div className="text-sm font-semibold text-white truncate" title={f.name}>{f.name}</div>
            <div className="mt-1 flex items-center justify-between text-[13px]"><span className="text-gray-500">Dépenses</span><span className="rounded-md bg-gray-800/60 p-1 tabular-nums text-gray-200">{fmtMetric("spend", f.spend, d?.currency ?? null)}</span></div>
            <div className="mt-1 flex items-center justify-between text-[13px]"><span className="text-gray-500">Taux de réussite</span><span className={`rounded-md p-1 tabular-nums ${f.hitRate >= 0.15 && f.winners > 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-gray-800/60 text-gray-200"}`}>{Math.round(f.hitRate * 100)} %</span></div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="px-6 pb-10 space-y-8">
      {d && d.untagged > 0 && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-violet-300 shrink-0" />
          <div className="flex-1 text-sm text-gray-200">{d.untagged} créa{d.untagged > 1 ? "s" : ""} de la période {d.untagged > 1 ? "ne sont" : "n'est"} pas encore analysée{d.untagged > 1 ? "s" : ""} par l&apos;IA (format visuel, accroche, audience…).{d.justTagged !== undefined && <span className="text-gray-400"> {d.justTagged} analysée{d.justTagged > 1 ? "s" : ""} à l&apos;instant.</span>}</div>
          <button type="button" onClick={() => void run("tag")} disabled={busy} className="h-8 inline-flex items-center gap-1.5 rounded-[10px] bg-white px-3 text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}{busy ? "Analyse (2 à 4 min)…" : "Analyser avec l'IA"}</button>
        </div>
      )}
      {current.error && <div className="text-sm text-red-300">{current.error}</div>}
      <section>
        <h2 className="text-base font-semibold text-white">Formats qui marchent</h2>
        <p className="mb-3 text-sm text-gray-500">Les formats visuels où le client met son budget, et leur taux de réussite.</p>
        {grid(d?.top ?? [], d?.tagged ? "Aucun format identifié sur cette période." : "Analyse les créas avec l'IA pour voir leurs formats.")}
      </section>
      <section>
        <h2 className="text-base font-semibold text-white">En test</h2>
        <p className="mb-3 text-sm text-gray-500">Les formats que le client a commencé à tester ces 30 derniers jours.</p>
        {grid(d?.testing ?? [], "Aucun nouveau format testé ces 30 derniers jours.")}
      </section>
    </div>
  );
}
