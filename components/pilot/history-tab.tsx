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
import { Card } from "@/components/ui/surface";
import { HistoryPanel } from "@/components/pilot/history-panel";
import { buildPilotHref } from "@/lib/pilot/deep-link";
import type { HistoryView, PlatformChangeView } from "@/lib/pilot/history";
import type { PilotActionView } from "@/lib/pilot/service";

type Data = HistoryView & { clients: Array<{ id: string; name: string }>; hqProject: string | null; forDays: number };

export function PilotHistoryTab({ dashboardId }: { dashboardId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(60);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dashboards/${dashboardId}/pilot-history?days=${days}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (!cancelled) setData({ ...j, forDays: days }); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [dashboardId, days]);

  const clientNames = useMemo(() => Object.fromEntries((data?.clients ?? []).map((c) => [c.id, c.name])), [data]);

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data || data.forDays !== days) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture de l&apos;historique (journaux des plateformes compris)…</p>;

  return (
    <div className="space-y-4">
      <Card padded>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <History className="w-4 h-4 text-violet-300" />
          <span className="text-white font-semibold">Historique & impact</span>
          <span className="text-xs text-gray-500">Modifications depuis ImpulseMotion et depuis les plateformes, bilans à J+7 et J+14{data.hqProject ? <>, consignés dans HQ (projects/{data.hqProject})</> : null}.</span>
          <Link href="/pilotage" className="text-violet-300 hover:text-white text-xs ml-auto">Modifier dans le Pilotage →</Link>
        </div>
        {!data.clients.length && <p className="text-xs text-amber-300 mt-2">Aucun client de l&apos;agence n&apos;est rattaché aux comptes de ce dashboard.</p>}
      </Card>
      <Card padded>
        <HistoryPanel
          actions={data.actions}
          changes={data.changes}
          series={data.series}
          sync={data.sync}
          loading={false}
          days={days}
          onDays={setDays}
          showClient={data.clients.length > 1}
          clientNames={clientNames}
          // The undo is prepared (a draft of the viewer): opened in /pilotage on the client, as the preview.
          onUndo={(draft) => { window.location.href = buildPilotHref({ client: draft.alertClientId, platform: draft.platform as "meta" | "google", account: draft.accountId, preview: draft.id }); }}
          onActionChanged={(a: PilotActionView) => setData((d) => d && { ...d, actions: d.actions.map((x) => (x.id === a.id ? a : x)) })}
          onChangeChanged={(c: PlatformChangeView) => setData((d) => d && { ...d, changes: d.changes.map((x) => (x.id === c.id ? c : x)) })}
        />
      </Card>
    </div>
  );
}
