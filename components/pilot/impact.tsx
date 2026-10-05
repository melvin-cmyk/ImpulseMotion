"use client";

/**
 * Pilotage — the J+7 and J+14 analyses of a change, as cards: the verdict, the
 * paragraph (the same as in HQ) and, unfolded, the figures object by object.
 * Shown in the journal of /pilotage and in the onglet « Historique & impact »
 * of the client's dashboard. Read only.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Clock } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { objectLabel } from "@/lib/pilot/ops";
import { VERDICT_FR, figuresLine, type ImpactResult, type Verdict } from "@/lib/pilot/impact";
import type { PilotImpactView } from "@/lib/pilot/service";

const TONE: Record<string, "emerald" | "red" | "amber" | "default"> = {
  improved: "emerald", worse: "red", mixed: "amber", flat: "default", low_volume: "default", skipped: "default",
};

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

function ImpactCard({ impact, platform }: { impact: PilotImpactView; platform: string }) {
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
    <div className="rounded-lg border border-gray-800 px-3 py-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-white">Bilan J+{impact.horizon}</span>
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

export function ImpactCards({ impacts, platform }: { impacts: PilotImpactView[]; platform: string }) {
  if (!impacts.length) return null;
  return (
    <div className="grid sm:grid-cols-2 gap-2">
      {impacts.map((i) => <ImpactCard key={i.horizon} impact={i} platform={platform} />)}
    </div>
  );
}
