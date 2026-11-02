"use client";

/**
 * « Audience » tab of the creative modal (Motion's demographic breakdown):
 * spend per age, women vs men, and per segment the cost per conversion and
 * the CTR, best segment highlighted. Meta only.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DemoCell, DemoResult } from "@/lib/ads-warehouse/demographics";
import { fmtMetric } from "@/lib/ads-warehouse/metrics-ui";

const AGES = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
const G: Array<{ id: DemoCell["gender"]; label: string; bar: string }> = [
  { id: "female", label: "Femmes", bar: "bg-fuchsia-400" },
  { id: "male", label: "Hommes", bar: "bg-sky-400" },
];

interface Props { accountId: string; adIds: string[]; range: { since: string; until: string }; currency: string | null }

export function DemographicsPane({ accountId, adIds, range, currency }: Props) {
  const key = JSON.stringify([accountId, adIds, range]);
  const [state, setState] = useState<{ key: string; data: DemoResult | null; error: string | null } | null>(null);
  const current = state && state.key === key ? state : null;
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/demographics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, adIds, range }) })
      .then(async (r) => (r.ok ? ((await r.json()) as DemoResult) : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`))))
      .then((data) => { if (!cancelled) setState({ key, data, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState({ key, data: null, error: e.message }); });
    return () => { cancelled = true; };
  }, [accountId, adIds, range, key]);

  if (!current) return <div className="py-10 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Répartition par âge et sexe…</div>;
  if (current.error || !current.data) return <div className="py-10 text-center text-sm text-red-300">Répartition indisponible : {current.error}</div>;
  const { cells, conversionLabel } = current.data;
  const cell = (age: string, g: DemoCell["gender"]) => cells.find((c) => c.age === age && c.gender === g);
  const total = cells.reduce((s, c) => s + c.spend, 0);
  if (total <= 0) return <div className="py-10 text-center text-sm text-gray-500">Aucune dépense sur la période.</div>;
  const max = Math.max(...cells.filter((c) => c.gender !== "unknown").map((c) => c.spend), 0.01);
  const share = (g: DemoCell["gender"]) => cells.filter((c) => c.gender === g).reduce((s, c) => s + c.spend, 0) / total;
  // Best segment: lowest cost per conversion among segments with at least 2 conversions, else best CTR.
  const seg = cells.filter((c) => c.gender !== "unknown" && c.spend > 0);
  const withConv = seg.filter((c) => c.conversions >= 2);
  const best = withConv.length ? withConv.sort((a, b) => a.spend / a.conversions - b.spend / b.conversions)[0] : seg.filter((c) => c.impressions >= 500).sort((a, b) => b.linkClicks / b.impressions - a.linkClicks / a.impressions)[0];
  const gl = (g: string) => (g === "female" ? "Femmes" : g === "male" ? "Hommes" : "Inconnu");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {G.map((g) => (
          <div key={g.id} className="rounded-xl border border-gray-800 p-3">
            <div className="text-xs text-gray-500">{g.label}</div>
            <div className="text-lg font-semibold text-white tabular-nums">{Math.round(share(g.id) * 100)} %<span className="ml-1 text-xs font-normal text-gray-500">des dépenses</span></div>
          </div>
        ))}
      </div>
      {best && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-gray-200">
          Meilleur segment : <span className="font-semibold text-white">{gl(best.gender)} {best.age}</span>
          {best.conversions >= 2 ? <> · {fmtMetric("cpa", best.spend / best.conversions, currency)} par {conversionLabel.replace(/s$/, "")}</> : <> · CTR {(best.linkClicks / best.impressions * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %</>}
        </div>
      )}
      <div className="rounded-xl border border-gray-800">
        <div className="grid grid-cols-[64px_1fr_1fr] gap-2 px-3 py-2 border-b border-gray-800 text-[11px] text-gray-500">
          <span>Âge</span><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-fuchsia-400" />Femmes</span><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-sky-400" />Hommes</span>
        </div>
        {AGES.map((age) => (
          <div key={age} className="grid grid-cols-[64px_1fr_1fr] gap-2 px-3 py-2 border-b border-gray-800 last:border-0 items-center">
            <span className="text-sm text-gray-300">{age}</span>
            {G.map((g) => {
              const c = cell(age, g.id);
              const isBest = !!best && c === best;
              return (
                <div key={g.id} className={`rounded-lg p-1.5 ${isBest ? "bg-emerald-500/10" : ""}`}>
                  <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden"><div className={`h-full ${g.bar}`} style={{ width: `${c ? Math.max(2, (c.spend / max) * 100) : 0}%` }} /></div>
                  <div className="mt-1 text-[11px] text-gray-400 tabular-nums">
                    {c && c.spend > 0 ? <>{fmtMetric("spend", c.spend, currency)} · {c.conversions > 0 ? `${Math.round(c.conversions)} ${conversionLabel} · ${fmtMetric("cpa", c.spend / c.conversions, currency)}` : `CTR ${c.impressions ? (c.linkClicks / c.impressions * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : 0} %`}</> : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-500">Répartition Meta des annonces de cette créa sur la période. Conversions comptées en {conversionLabel}, comme le reste du rapport.</p>
    </div>
  );
}
