"use client";

/**
 * The « Fabrique » tab of /creas: the client's fabriques (list), the
 * three-step assistant (factory-wizard.tsx) and the grid of one run
 * (factory-grid.tsx). Deep link: /creas?client=…&tab=fabrique&run=<id>.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { FACTORY_KIND_LABEL, RUN_STATUS_LABEL } from "@/lib/creas/model";
import { BTN_PRIMARY, usd, when, type Asset, type ClientOption, type Engine, type FactoryRun, type QuotaInfo, type Template } from "./shared";
import { FactoryWizard } from "./factory-wizard";
import { FactoryGrid, type Editor } from "./factory-grid";

type View = { mode: "list" } | { mode: "wizard"; preselected: string[]; run: FactoryRun | null } | { mode: "run"; runId: string };

export function FactoryTab({ client, templates, engines, quota, initialRunId, preselected, onPreselectedUsed, onRunUrl, onNotice, onError, onOpenTemplate, onOpenIn, onVariation, onAssetsCreated, onQuotaChanged }: {
  client: ClientOption; templates: Template[]; engines: Engine[]; quota: QuotaInfo | null; initialRunId: string | null; preselected: string[]; onPreselectedUsed: () => void;
  onRunUrl: (runId: string | null) => void; onNotice: (m: string) => void; onError: (m: string | null) => void; onOpenTemplate: (t: Template) => void; onOpenIn: (editor: Editor, src: { assetId?: string; templateId?: string }) => void; onVariation: (a: Asset) => void; onAssetsCreated: (a: Asset[]) => void; onQuotaChanged: () => void;
}) {
  const [runs, setRuns] = useState<FactoryRun[] | null>(null);
  const [view, setView] = useState<View>(() => (initialRunId ? { mode: "run", runId: initialRunId } : preselected.length ? { mode: "wizard", preselected, run: null } : { mode: "list" }));

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/creas/factory?client=${client.clientId}`, { cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { runs?: FactoryRun[] };
    setRuns(res.ok ? j.runs ?? [] : []);
  }, [client.clientId]);
  useEffect(() => { queueMicrotask(() => { void loadRuns(); }); }, [loadRuns]);
  useEffect(() => { if (preselected.length) { queueMicrotask(() => { setView({ mode: "wizard", preselected, run: null }); onPreselectedUsed(); }); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselected]);

  const go = (v: View) => { setView(v); onRunUrl(v.mode === "run" ? v.runId : v.mode === "wizard" && v.run ? v.run.id : null); };
  const upsertRun = (r: FactoryRun) => setRuns((l) => { const list = l ?? []; return list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? { ...x, ...r } : x)) : [r, ...list]; });

  if (view.mode === "run") {
    return <FactoryGrid runId={view.runId} client={client} onBack={() => { go({ mode: "list" }); void loadRuns(); }} onOpenTemplate={onOpenTemplate} onOpenIn={onOpenIn} onVariation={onVariation} onNotice={onNotice} onError={onError} onAssetsChanged={onAssetsCreated} onRunChanged={upsertRun} />;
  }
  if (view.mode === "wizard") {
    return <FactoryWizard client={client} templates={templates} engines={engines} quota={quota} preselected={view.preselected} run={view.run}
      onRunChange={(r) => { upsertRun(r); onRunUrl(r.id); }} onAssets={(a) => { onAssetsCreated(a); onQuotaChanged(); }} onNotice={onNotice}
      onDone={(r) => { upsertRun(r); go({ mode: "run", runId: r.id }); onQuotaChanged(); }} onCancel={() => { go({ mode: "list" }); void loadRuns(); }} />;
  }
  return (
    <div className="space-y-3" data-factory-list>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-gray-400 flex-1">Une fabrique = des templates du swipe file, lus par l&apos;IA → des copys sourcés dans la voix des clients, validés par vous → quelques visuels (0,06 $ l&apos;image) qui servent de base dans FigCraft / PhotoCraft → une grille à trier, copiée dans le dossier Drive « Créas » du client. Vos verdicts et retours nourrissent la mémoire HQ.</p>
        <button type="button" onClick={() => go({ mode: "wizard", preselected: [], run: null })} className={BTN_PRIMARY} data-factory-new><Plus className="w-4 h-4" /> Nouvelle fabrique</button>
      </div>
      {runs === null ? <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture…</p>
      : runs.length === 0 ? <p className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500">Aucune fabrique pour {client.name} pour l&apos;instant. Cochez des templates dans « Templates & concurrents » puis « Lancer une fabrique », ou commencez ici.</p>
      : (
        <ul className="divide-y divide-gray-800 rounded-xl border border-gray-800">
          {runs.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => (r.status === "copy_review" || r.status === "approved" ? go({ mode: "wizard", preselected: [], run: r }) : go({ mode: "run", runId: r.id }))} className="w-full text-left px-3 py-2.5 hover:bg-gray-900/60 flex flex-wrap items-center gap-x-3 gap-y-1" data-factory-run={r.id}>
                <span className="text-sm text-white">Fabrique {FACTORY_KIND_LABEL[r.kind].toLowerCase()} · {when(r.createdAt)}</span>
                <Pill tone={r.status === "review" ? "amber" : r.status === "done" ? "emerald" : "default"} className="text-[10px]">{RUN_STATUS_LABEL[r.status]}</Pill>
                <span className="text-xs text-gray-500">{r.templateIds.length} template{r.templateIds.length > 1 ? "s" : ""} · {r.copies.length ? `${r.copies.filter((c) => c.status === "approved").length}/${r.copies.length} copys · ` : ""}{r.generated} visuel{r.generated > 1 ? "s" : ""}{r.settings.n ? ` / ${r.settings.n}` : ""} · <span className="text-emerald-300">{r.kept} gardée{r.kept > 1 ? "s" : ""}</span> · <span className="text-rose-300">{r.cut} coupée{r.cut > 1 ? "s" : ""}</span> · {usd(r.costUsd)} · {r.createdByName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
