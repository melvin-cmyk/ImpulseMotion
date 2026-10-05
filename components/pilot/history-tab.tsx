"use client";

/**
 * Onglet « Historique & impact » of a client's dashboard (staff only): every
 * change sent from Pilotage on the client's accounts — who, when, what, why —
 * with its J+7 and J+14 analyses. The same entries are in the client's HQ
 * journal. Read only; changes are made in /pilotage.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { History, Loader2 } from "lucide-react";
import { Card, Pill } from "@/components/ui/surface";
import { OperationLines } from "@/components/pilot/change-panel";
import { ImpactCards } from "@/components/pilot/impact";
import { PLATFORM_FR, goalText } from "@/lib/pilot/ops";
import { VERDICT_FR, type Verdict } from "@/lib/pilot/impact";
import type { PilotActionView } from "@/lib/pilot/service";

const STATUS: Record<string, { text: string; tone: "emerald" | "amber" | "red" | "default" }> = {
  done: { text: "appliquée", tone: "emerald" }, partial: { text: "en partie", tone: "amber" },
  failed: { text: "refusée", tone: "red" }, running: { text: "en cours", tone: "default" },
};
const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function PilotHistoryTab({ dashboardId }: { dashboardId: string }) {
  const [data, setData] = useState<{ clients: Array<{ id: string; name: string }>; hqProject: string | null; actions: PilotActionView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dashboards/${dashboardId}/pilot-history`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [dashboardId]);

  // What the analyses say so far: the latest verdict of each change.
  const tally = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of data?.actions ?? []) {
      const last = [...(a.impacts ?? [])].reverse().find((i) => i.status === "done");
      if (last) out[last.verdict] = (out[last.verdict] ?? 0) + 1;
    }
    return out;
  }, [data]);

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture de l&apos;historique…</p>;

  return (
    <div className="space-y-4">
      <Card padded>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <History className="w-4 h-4 text-violet-300" />
          <span className="text-white font-semibold">{data.actions.length} modification{data.actions.length > 1 ? "s" : ""} depuis ImpulseMotion</span>
          {Object.entries(tally).map(([v, n]) => <Pill key={v} className="text-[10px]">{n} {VERDICT_FR[v as Verdict] ?? v}</Pill>)}
          <span className="text-xs text-gray-500 ml-auto">
            Bilans calculés à J+7 et J+14{data.hqProject ? <>, consignés dans HQ (projects/{data.hqProject})</> : null}.
          </span>
        </div>
        {!data.clients.length && <p className="text-xs text-amber-300 mt-2">Aucun client de l&apos;agence n&apos;est rattaché aux comptes de ce dashboard.</p>}
      </Card>

      {data.actions.length === 0 ? (
        <p className="text-sm text-gray-500">
          Aucune modification envoyée depuis le <Link href="/pilotage" className="text-violet-300 hover:text-white">Pilotage</Link> pour ce client pour le moment.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.actions.map((a) => {
            const s = STATUS[a.status] ?? { text: a.status, tone: "default" as const };
            const goal = goalText(a.goal);
            return (
              <li key={a.id}>
                <Card padded>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                      <span className="text-gray-200 font-medium">{a.createdByName}</span>
                      <span>· {when(a.executedAt ?? a.createdAt)}</span>
                      <span>· {PLATFORM_FR[a.platform] ?? a.platform} « {a.accountName || a.accountId} »</span>
                      <Pill tone={s.tone} className="text-[10px]">{s.text}</Pill>
                      {a.undoOfId && <Pill tone="violet" className="text-[10px]">annulation</Pill>}
                      {a.undoneById && <Pill className="text-[10px]">annulée depuis</Pill>}
                    </div>
                    <OperationLines action={a} showStatus />
                    <p className="text-xs text-gray-400"><span className="text-gray-500">Pourquoi :</span> {a.why || "—"}{goal ? <> · <span className="text-gray-500">Objectif :</span> {goal}</> : null}</p>
                    <ImpactCards impacts={a.impacts ?? []} platform={a.platform} />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
