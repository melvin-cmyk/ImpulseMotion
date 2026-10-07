"use client";

/**
 * Onglet « Historique & impact » of a client's dashboard (staff only): every
 * change on the client's accounts — sent from Pilotage or read in the
 * platforms' logs (Ads Manager, Google Ads, rules, scripts) — who, when, what,
 * why, with the J+7 and J+14 analyses, and the curve of the dashboard's account
 * with each change marked. The same entries are in the client's HQ journal.
 * Changes are made in /pilotage; a change made elsewhere can be explained here.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { History, Loader2 } from "lucide-react";
import { Card, Pill } from "@/components/ui/surface";
import { HistoryTimeline, type SourceFilter } from "@/components/pilot/timeline";
import { ChangeChart, marksOf } from "@/components/pilot/change-chart";
import { PLATFORM_FR } from "@/lib/pilot/ops";
import { VERDICT_FR, type Verdict } from "@/lib/pilot/impact";
import type { HistoryView, PlatformChangeView } from "@/lib/pilot/history";
import type { PilotActionView } from "@/lib/pilot/service";

type Data = HistoryView & { clients: Array<{ id: string; name: string }>; hqProject: string | null };

export function PilotHistoryTab({ dashboardId }: { dashboardId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [days, setDays] = useState(60);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/dashboards/${dashboardId}/pilot-history?days=${days}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [dashboardId, days]);

  // What the analyses say so far: the latest verdict of each change.
  const tally = useMemo(() => {
    const out: Record<string, number> = {};
    const all = [...(data?.actions ?? []).map((a) => a.impacts ?? []), ...(data?.changes ?? []).map((c) => c.impacts)];
    for (const impacts of all) {
      const last = [...impacts].reverse().find((i) => i.status === "done");
      if (last) out[last.verdict] = (out[last.verdict] ?? 0) + 1;
    }
    return out;
  }, [data]);

  const clientNames = useMemo(() => Object.fromEntries((data?.clients ?? []).map((c) => [c.id, c.name])), [data]);
  const external = (data?.changes ?? []).filter((c) => !(c.pilotActionId && data?.actions.some((a) => a.id === c.pilotActionId)));

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture de l&apos;historique (journaux des plateformes compris)…</p>;

  return (
    <div className="space-y-4">
      <Card padded>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <History className="w-4 h-4 text-violet-300" />
          <span className="text-white font-semibold">{data.actions.length} depuis ImpulseMotion · {external.length} hors ImpulseMotion</span>
          {Object.entries(tally).map(([v, n]) => <Pill key={v} className="text-[10px]">{n} {VERDICT_FR[v as Verdict] ?? v}</Pill>)}
          <span className="text-xs text-gray-500 ml-auto">
            Bilans à J+7 et J+14{data.hqProject ? <>, consignés dans HQ (projects/{data.hqProject})</> : null}.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
          {([["all", "Tout"], ["impulsemotion", "ImpulseMotion"], ["external", "Hors ImpulseMotion"], ["automated", "Automatique"]] as Array<[SourceFilter, string]>).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} className={`px-2 py-1 rounded-md border ${filter === k ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
          ))}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-gray-200">
            {[14, 30, 60, 90, 120].map((d) => <option key={d} value={d}>{d} jours</option>)}
          </select>
          <Link href="/pilotage" className="text-violet-300 hover:text-white ml-auto">Modifier dans le Pilotage →</Link>
        </div>
        {!data.clients.length && <p className="text-xs text-amber-300 mt-2">Aucun client de l&apos;agence n&apos;est rattaché aux comptes de ce dashboard.</p>}
        {data.sync.some((s) => s.lastError) && <p className="text-xs text-amber-300 mt-2">{data.sync.filter((s) => s.lastError).map((s) => `${PLATFORM_FR[s.platform]} ${s.accountId} : ${s.lastError}`).join(" · ")}</p>}
      </Card>

      {data.series && (
        <Card padded>
          <p className="text-xs text-gray-500 mb-1">{PLATFORM_FR[data.series.platform]} · compte {data.series.accountId} — dépense et CPA par jour, chaque modification marquée.</p>
          {data.series.error ? <p className="text-xs text-amber-300">Courbe indisponible : {data.series.error}</p> : (
            <ChangeChart
              points={data.series.points}
              currency={data.series.currency}
              marks={marksOf([
                ...data.actions.filter((a) => a.executedAt && a.platform === data.series!.platform && a.accountId === data.series!.accountId).map((a) => ({ at: a.executedAt!, source: "impulsemotion" as const, text: `${a.createdByName} : ${a.operations.map((o) => o.line).join(" ; ")}` })),
                ...external.filter((c) => c.platform === data.series!.platform && c.accountId === data.series!.accountId).map((c) => ({ at: c.at, source: c.source, text: `${c.actorName} : ${c.line}` })),
              ])}
            />
          )}
        </Card>
      )}

      <Card padded>
        <HistoryTimeline
          actions={data.actions}
          changes={data.changes}
          loading={false}
          filter={filter}
          showClient={data.clients.length > 1}
          clientNames={clientNames}
          onUndo={() => { window.location.href = "/pilotage"; }}
          onActionChanged={(a: PilotActionView) => setData((d) => d && { ...d, actions: d.actions.map((x) => (x.id === a.id ? a : x)) })}
          onChangeChanged={(c: PlatformChangeView) => setData((d) => d && { ...d, changes: d.changes.map((x) => (x.id === c.id ? c : x)) })}
        />
      </Card>
    </div>
  );
}
