"use client";

/**
 * Pilotage — the creatives of a Meta account: visual, last 7 full days
 * against the 7 before, and what to look at (fatigue, spend without a
 * conversion, new winner). Per creative: pause, duplicate (in pause, to
 * relaunch with a change), both ordinary changes that go to « Modifier ».
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { money } from "@/lib/pilot/ops";
import type { CreativeRow } from "@/lib/pilot/creatives";
import { readJson, type PendingChange } from "@/components/pilot/model";

type Filter = "all" | "fatigue" | "burn" | "winner" | "new";
const FLAG: Record<string, { text: string; tone: "red" | "amber" | "emerald" | "blue" }> = { fatigue: { text: "fatigue", tone: "amber" }, burn: { text: "dépense sans conversion", tone: "red" }, winner: { text: "gagnante", tone: "emerald" }, new: { text: "nouvelle", tone: "blue" } };

const pct = (before: number | null, after: number | null) => (before === null || after === null || before === 0 ? null : Math.round(((after - before) / Math.abs(before)) * 100));

function Delta({ before, after, lowerIsBetter = false }: { before: number | null; after: number | null; lowerIsBetter?: boolean }) {
  const d = pct(before, after);
  if (d === null || Math.abs(d) < 5) return null;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return <span className={`ml-1 text-[10px] ${good ? "text-emerald-300" : "text-red-300"}`}>{d > 0 ? "+" : ""}{d} %</span>;
}

export function CreativesPanel({ clientId, accountId, currency, onAdd }: { clientId: string; accountId: string; currency: string; onAdd: (change: PendingChange) => void }) {
  const [data, setData] = useState<{ since: string; until: string; rows: CreativeRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pilot/creatives?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}`)
      .then(async (r) => { const j = await readJson<{ since: string; until: string; rows: CreativeRow[] }>(r); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [clientId, accountId]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => filter === "all" || r.flag === filter).slice(0, 60), [data, filter]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const r of data?.rows ?? []) if (r.flag) c[r.flag] = (c[r.flag] ?? 0) + 1; return c; }, [data]);
  const m = (v: number | null) => (v === null ? "—" : money(Math.round(v * 100), currency));

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des créas sur Meta (14 jours)…</p>;
  if (!data.rows.length) return <p className="text-sm text-gray-500">Aucune créa n&apos;a diffusé ces 14 derniers jours.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-400">{data.rows.length} créas · 7 jours ({data.since.slice(8, 10)}/{data.since.slice(5, 7)} → {data.until.slice(8, 10)}/{data.until.slice(5, 7)}) contre les 7 d&apos;avant</span>
        <span className="flex-1" />
        {([["all", "Toutes"], ["burn", "Sans conversion"], ["fatigue", "Fatigue"], ["winner", "Gagnantes"], ["new", "Nouvelles"]] as Array<[Filter, string]>).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={`px-2 py-1 rounded-md border ${filter === k ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}{k !== "all" && counts[k] ? ` (${counts[k]})` : ""}</button>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((r) => (
          <div key={r.adId} className={`rounded-xl border overflow-hidden bg-gray-950/60 ${r.flag === "burn" ? "border-red-900/60" : r.flag === "fatigue" ? "border-amber-900/60" : r.flag === "winner" ? "border-emerald-900/60" : "border-gray-800"}`}>
            <div className="flex gap-3 p-3">
              <div className="w-20 h-20 rounded-lg bg-gray-900 shrink-0 overflow-hidden">
                {r.imageUrl ? <img src={r.imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-600">{r.format === "video" ? "vidéo" : "image"}</div>}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm text-white truncate" title={r.name}>{r.name}</p>
                <p className="text-[11px] text-gray-500 truncate" title={`${r.campaignName} · ${r.adsetName}`}>{r.adsetName}{r.campaignName ? ` · ${r.campaignName}` : ""}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={r.effectiveStatus === "ACTIVE" ? "emerald" : "default"} className="text-[10px] normal-case">{r.effectiveStatus.toLowerCase().replace(/_/g, " ")}</Pill>
                  {r.flag && <Pill tone={FLAG[r.flag].tone} className="text-[10px]" >{FLAG[r.flag].text}</Pill>}
                </div>
                {r.flagText && <p className="text-[11px] text-gray-400">{r.flagText}</p>}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 px-3 pb-2 text-[11px]">
              <div><p className="text-gray-500">Dépense</p><p className="text-gray-200 tabular-nums">{m(r.last.spend)}<Delta before={r.prev?.spend ?? null} after={r.last.spend} /></p></div>
              <div><p className="text-gray-500">CTR</p><p className="text-gray-200 tabular-nums">{r.last.ctr === null ? "—" : `${r.last.ctr.toFixed(2)} %`}<Delta before={r.prev?.ctr ?? null} after={r.last.ctr} /></p></div>
              <div><p className="text-gray-500">Fréq.</p><p className="text-gray-200 tabular-nums">{r.last.frequency === null ? "—" : r.last.frequency.toFixed(1)}<Delta before={r.prev?.frequency ?? null} after={r.last.frequency} lowerIsBetter /></p></div>
              <div><p className="text-gray-500">CPA</p><p className="text-gray-200 tabular-nums">{m(r.last.cpa)}<Delta before={r.prev?.cpa ?? null} after={r.last.cpa} lowerIsBetter /></p></div>
            </div>
            <div className="flex items-center gap-3 px-3 pb-3 text-xs">
              {r.status === "ACTIVE" && (
                <button type="button" disabled={done.has(`p:${r.adId}`)} onClick={() => { onAdd({ kind: "set_status", objectType: "ad", objectId: r.adId, value: "PAUSED", label: `Annonce « ${r.name} » : mettre en pause` }); setDone((s) => new Set(s).add(`p:${r.adId}`)); }} className="text-gray-300 hover:text-white disabled:text-gray-600">{done.has(`p:${r.adId}`) ? "pause prévue" : "Mettre en pause"}</button>
              )}
              {r.status === "PAUSED" && (
                <button type="button" disabled={done.has(`a:${r.adId}`)} onClick={() => { onAdd({ kind: "set_status", objectType: "ad", objectId: r.adId, value: "ACTIVE", label: `Annonce « ${r.name} » : activer` }); setDone((s) => new Set(s).add(`a:${r.adId}`)); }} className="text-gray-300 hover:text-white disabled:text-gray-600">{done.has(`a:${r.adId}`) ? "activation prévue" : "Activer"}</button>
              )}
              <button type="button" disabled={done.has(`d:${r.adId}`)} onClick={() => { const name = window.prompt("Nom de la copie (créée en pause) :", `${r.name} — v2`); if (!name?.trim()) return; onAdd({ kind: "duplicate", objectType: "ad", objectId: r.adId, value: JSON.stringify({ name: name.trim() }), label: `Annonce « ${r.name} » : dupliquer en « ${name.trim()} » (créée en pause)` }); setDone((s) => new Set(s).add(`d:${r.adId}`)); }} className="text-gray-300 hover:text-white disabled:text-gray-600">{done.has(`d:${r.adId}`) ? "copie prévue" : "Dupliquer"}</button>
              <span className="flex-1" />
              <span className="text-gray-600">{r.last.conversions.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} conv. · {r.last.impressions.toLocaleString("fr-FR")} impr.</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
