"use client";

/**
 * Pilotage — the search terms of a Google Ads account: what people typed,
 * what it cost, what it brought. Terms that spend without converting first.
 * Per term: « négatif » adds a negative keyword on its campaign, « mot-clé »
 * adds it as a keyword in its ad group — two ordinary changes that go to the
 * panel « Modifier ». Nothing is sent from here.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { money, type KeywordMatchType } from "@/lib/pilot/ops";
import type { SearchTermRow } from "@/lib/pilot/search-terms";
import { readJson, type PendingChange } from "@/components/pilot/model";

const STATUS_FR: Record<string, string> = { ADDED: "déjà mot-clé", EXCLUDED: "déjà négatif", ADDED_EXCLUDED: "mot-clé et négatif" };
type Sort = "waste" | "spend" | "conversions" | "clicks";

export function SearchTermsPanel({ clientId, accountId, currency, onAdd }: { clientId: string; accountId: string; currency: string; onAdd: (change: PendingChange) => void }) {
  const [data, setData] = useState<{ since: string; until: string; rows: SearchTermRow[]; days: number } | null>(null);
  const [failed, setFailed] = useState<{ days: number; message: string } | null>(null);
  const [days, setDays] = useState(30);
  // Loading = nothing yet for the period asked (no state set inside the effect itself).
  const error = failed && failed.days === days ? failed.message : null;
  const loading = !error && (!data || data.days !== days);
  const [sort, setSort] = useState<Sort>("waste");
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<KeywordMatchType>("EXACT");
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pilot/search-terms?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}&days=${days}`)
      .then(async (r) => { const j = await readJson<{ since: string; until: string; rows: SearchTermRow[] }>(r); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (!cancelled) setData({ ...j, days }); })
      .catch((e) => { if (!cancelled) setFailed({ days, message: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [clientId, accountId, days]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.rows ?? []).filter((r) => !q || r.term.includes(q) || r.campaignName.toLowerCase().includes(q) || r.adGroupName.toLowerCase().includes(q));
    const key = (r: SearchTermRow) => (sort === "waste" ? (r.conversions > 0 ? -1 : r.spend) : sort === "spend" ? r.spend : sort === "conversions" ? r.conversions : r.clicks);
    return [...list].sort((a, b) => key(b) - key(a)).slice(0, 150);
  }, [data, query, sort]);

  const totals = useMemo(() => {
    const all = data?.rows ?? [];
    const waste = all.filter((r) => r.conversions === 0).reduce((n, r) => n + r.spend, 0);
    return { terms: all.length, spend: all.reduce((n, r) => n + r.spend, 0), waste };
  }, [data]);

  const m = (v: number) => money(Math.round(v * 100), currency);
  const negative = (r: SearchTermRow) => {
    onAdd({ kind: "add_negative_keyword", objectType: "campaign", objectId: r.campaignId, value: JSON.stringify({ text: r.term, matchType: match }), label: `Campagne « ${r.campaignName} » : ajouter le mot-clé négatif « ${r.term} » [${match.toLowerCase()}]` });
    setAdded((s) => new Set(s).add(`n:${r.term}:${r.campaignId}`));
  };
  const keyword = (r: SearchTermRow) => {
    onAdd({ kind: "add_keyword", objectType: "adset", objectId: r.adGroupId, value: JSON.stringify({ text: r.term, matchType: match }), label: `Groupe d'annonces « ${r.adGroupName} » : ajouter le mot-clé « ${r.term} » [${match.toLowerCase()}]` });
    setAdded((s) => new Set(s).add(`k:${r.term}:${r.adGroupId}`));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {data && <span className="text-gray-400">{totals.terms} termes · {m(totals.spend)} dépensés · <span className={totals.waste > 0 ? "text-amber-300" : ""}>{m(totals.waste)} sans conversion</span> ({data.since.slice(8, 10)}/{data.since.slice(5, 7)} → {data.until.slice(8, 10)}/{data.until.slice(5, 7)})</span>}
        <span className="flex-1" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher un terme" className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-gray-200 w-44" />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-gray-200">
          <option value="waste">Dépense sans conversion d&apos;abord</option>
          <option value="spend">Dépense</option>
          <option value="conversions">Conversions</option>
          <option value="clicks">Clics</option>
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-gray-200">
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} jours</option>)}
        </select>
        <label className="flex items-center gap-1 text-gray-400">ajouter en
          <select value={match} onChange={(e) => setMatch(e.target.value as KeywordMatchType)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-gray-200">
            <option value="EXACT">exact</option><option value="PHRASE">expression</option><option value="BROAD">large</option>
          </select>
        </label>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
        {!loading && <RefreshCw className="w-3.5 h-3.5 text-gray-600" />}
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {!error && data && !rows.length && <p className="text-sm text-gray-500">Aucun terme de recherche sur la période.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 uppercase tracking-wide border-b border-gray-800">
                <th className="py-1.5 px-1 text-left font-medium">Terme</th>
                <th className="py-1.5 px-1 text-left font-medium hidden md:table-cell">Campagne · groupe</th>
                <th className="py-1.5 px-1 text-right font-medium">Impr.</th>
                <th className="py-1.5 px-1 text-right font-medium">Clics</th>
                <th className="py-1.5 px-1 text-right font-medium">Dépense</th>
                <th className="py-1.5 px-1 text-right font-medium">Conv.</th>
                <th className="py-1.5 px-1 text-right font-medium">CPA</th>
                <th className="py-1.5 px-1 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const waste = r.conversions === 0 && r.spend >= 5;
                const nk = `n:${r.term}:${r.campaignId}`, kk = `k:${r.term}:${r.adGroupId}`;
                return (
                  <tr key={`${r.term}|${r.adGroupId}`} className={`border-b border-gray-800/40 ${waste ? "bg-red-950/20" : ""}`}>
                    <td className="py-1.5 px-1 text-gray-200 max-w-[260px] truncate" title={r.term}>{r.term}{STATUS_FR[r.status] && <span className="ml-1 text-[10px] text-gray-500">({STATUS_FR[r.status]})</span>}</td>
                    <td className="py-1.5 px-1 text-gray-500 hidden md:table-cell max-w-[260px] truncate" title={`${r.campaignName} · ${r.adGroupName}`}>{r.campaignName} <span className="text-gray-600">·</span> {r.adGroupName}</td>
                    <td className="py-1.5 px-1 text-right text-gray-400 tabular-nums">{r.impressions.toLocaleString("fr-FR")}</td>
                    <td className="py-1.5 px-1 text-right text-gray-400 tabular-nums">{r.clicks.toLocaleString("fr-FR")}</td>
                    <td className="py-1.5 px-1 text-right text-gray-200 tabular-nums">{m(r.spend)}</td>
                    <td className="py-1.5 px-1 text-right text-gray-200 tabular-nums">{r.conversions.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}</td>
                    <td className="py-1.5 px-1 text-right text-gray-400 tabular-nums">{r.conversions > 0 ? m(r.spend / r.conversions) : "—"}</td>
                    <td className="py-1.5 px-1 text-right whitespace-nowrap">
                      {r.status !== "EXCLUDED" && r.status !== "ADDED_EXCLUDED" && (
                        <button type="button" disabled={added.has(nk)} onClick={() => negative(r)} className="text-amber-300 hover:text-white disabled:text-gray-600 mr-2" title="Ajouter en mot-clé négatif sur la campagne">{added.has(nk) ? "négatif prévu" : "négatif"}</button>
                      )}
                      {r.status !== "ADDED" && r.status !== "ADDED_EXCLUDED" && r.adGroupId && (
                        <button type="button" disabled={added.has(kk)} onClick={() => keyword(r)} className="text-violet-300 hover:text-white disabled:text-gray-600" title="Ajouter comme mot-clé dans le groupe d'annonces">{added.has(kk) ? "mot-clé prévu" : "mot-clé"}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
