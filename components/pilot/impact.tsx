"use client";

/**
 * Pilotage — the J+7 and J+14 analyses of a change, as cards: the verdict, the
 * paragraph (the same as in HQ) and, unfolded, the figures object by object.
 * Shown in the journal of /pilotage and in the onglet « Historique & impact »
 * of the client's dashboard. Read only.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Clock, Loader2, Zap } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { objectLabel } from "@/lib/pilot/ops";
import { VERDICT_FR, figuresLine, type ImpactResult, type Verdict } from "@/lib/pilot/impact";
import type { PilotImpactView } from "@/lib/pilot/service";

const TONE: Record<string, "emerald" | "red" | "amber" | "default"> = {
  improved: "emerald", worse: "red", mixed: "amber", flat: "default", low_volume: "default", skipped: "default",
};

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

function ImpactCard({ impact, platform, title }: { impact: PilotImpactView; platform: string; title?: string }) {
  const [open, setOpen] = useState(false);
  if (impact.status === "pending") {
    return (
      <div className="rounded-lg border border-gray-800 px-3 py-2 text-xs text-gray-500 flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5" /> Bilan J+{impact.horizon} {impact.dueOn ? `le ${day(impact.dueOn)}` : "à venir"}
      </div>
    );
  }
  const result = impact.result as ImpactResult | null;
  return (
    <div className={`rounded-lg border px-3 py-2 space-y-1.5 ${title ? "border-violet-500/40 bg-violet-500/5" : "border-gray-800"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-white">{title ?? `Bilan J+${impact.horizon}`}</span>
        <Pill tone={TONE[impact.verdict] ?? "default"} className="text-[10px]">{VERDICT_FR[impact.verdict as Verdict] ?? impact.verdict}</Pill>
        {impact.hqWritten && <span className="text-[10px] text-gray-500">consigné dans HQ</span>}
      </div>
      <p className="text-xs text-gray-300 leading-relaxed">{impact.summary}</p>
      {result && result.objects?.length > 0 && (
        <>
          <button type="button" onClick={() => setOpen(!open)} className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Détail par objet
          </button>
          {open && (
            <ul className="space-y-1 text-[11px] text-gray-400">
              {result.objects.map((o) => (
                <li key={o.objectId}>
                  <span className="text-gray-200">{objectLabel(platform, o.objectType)} « {o.name} »</span>
                  {" — "}{o.error ? `illisible (${o.error})` : figuresLine(o.before, o.after, result.currency)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The analyses of a change; `subject` adds « Voir l'effet maintenant », a
 * provisional analysis as of yesterday (POST …/impact-now), shown but not kept.
 */
export function ImpactCards({ impacts, platform, subject }: { impacts: PilotImpactView[]; platform: string; subject?: { kind: "action" | "change"; id: string } }) {
  const [now, setNow] = useState<PilotImpactView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!impacts.length && !subject) return null;
  const pending = impacts.some((i) => i.status === "pending");

  async function seeNow() {
    if (!subject) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pilot/${subject.kind === "action" ? "actions" : "changes"}/${subject.id}/impact-now`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setNow({ horizon: j.horizon, status: "done", verdict: j.verdict, summary: j.summary, computedAt: new Date().toISOString(), dueOn: null, hqWritten: false, result: j.result });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid sm:grid-cols-2 gap-2">
        {impacts.map((i) => <ImpactCard key={i.horizon} impact={i} platform={platform} />)}
        {now && <ImpactCard impact={now} platform={platform} title={`Effet à J+${now.horizon} (provisoire, à hier)`} />}
      </div>
      {subject && pending && !now && (
        <div className="flex items-center gap-3 text-xs">
          <button type="button" disabled={busy} onClick={() => void seeNow()} className="flex items-center gap-1 text-gray-400 hover:text-white disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Voir l&apos;effet maintenant
          </button>
          {error && <span className="text-amber-300">{error}</span>}
        </div>
      )}
    </div>
  );
}
