"use client";

/**
 * What was changed on the client's accounts from Pilotage: who, when, each
 * change with its outcome, why, and whether HQ has it. An action sent can be
 * put back (« Annuler cette modification » prepares the undo, confirmed like
 * any other change); an HQ entry that failed can be written again.
 */

import { useState } from "react";
import { CheckCircle2, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { goalText } from "@/lib/pilot/ops";
import { OperationLines } from "@/components/pilot/change-panel";
import { readJson, type PilotActionView } from "@/components/pilot/model";

const STATUS: Record<string, { text: string; tone: "emerald" | "red" | "amber" | "default" | "violet" }> = {
  done: { text: "envoyée", tone: "emerald" },
  partial: { text: "envoyée en partie", tone: "amber" },
  failed: { text: "non appliquée", tone: "red" },
  running: { text: "en cours", tone: "violet" },
  draft: { text: "aperçu non envoyé", tone: "default" },
};

const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function PilotJournal({ actions, loading, showClient, onUndo, onChanged }: {
  actions: PilotActionView[];
  loading: boolean;
  showClient?: boolean;
  onUndo: (preview: PilotActionView) => void;
  onChanged: (action: PilotActionView) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});

  async function post(id: string, path: "undo" | "hq") {
    setBusy(`${id}:${path}`);
    setError((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/pilot/actions/${id}/${path}`, { method: "POST" });
      const j = await readJson<{ action?: PilotActionView }>(res);
      if (!res.ok || !j.action) { setError((e) => ({ ...e, [id]: j.errors?.join(" ") || j.error || `Erreur ${res.status}` })); return; }
      if (path === "undo") onUndo(j.action); else onChanged(j.action);
    } catch (e) {
      setError((x) => ({ ...x, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }

  const shown = actions.filter((a) => a.status !== "draft");
  if (loading && !shown.length) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture du journal…</p>;
  if (!shown.length) return <p className="text-sm text-gray-500">Aucune modification faite depuis ImpulseMotion pour le moment.</p>;

  return (
    <ul className="divide-y divide-gray-800">
      {shown.map((a) => {
        const s = STATUS[a.status] ?? { text: a.status, tone: "default" as const };
        const goal = goalText(a.goal);
        const undoable = (a.status === "done" || a.status === "partial") && !a.undoneById && a.operations.some((o) => o.status === "done" && !o.irreversible);
        return (
          <li key={a.id} className="py-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span className="text-gray-200 font-medium">{a.createdByName}</span>
              <span>· {when(a.executedAt ?? a.createdAt)}</span>
              {showClient && <span>· {a.clientName}</span>}
              <span>· Meta « {a.accountName || a.accountId} »</span>
              <Pill tone={s.tone} className="text-[10px]">{s.text}</Pill>
              {a.undoOfId && <Pill tone="violet" className="text-[10px]">annulation</Pill>}
              {a.undoneById && <Pill tone="default" className="text-[10px]">annulée depuis</Pill>}
            </div>
            <OperationLines action={a} showStatus />
            <p className="text-xs text-gray-400"><span className="text-gray-500">Pourquoi :</span> {a.why || "—"}{goal ? <> · <span className="text-gray-500">Objectif :</span> {goal}</> : null}</p>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {a.hqWrittenAt
                ? <span className="text-emerald-300/80 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Consigné dans HQ (projects/{a.hqProject})</span>
                : a.executedAt && a.status !== "running" && a.hqProject
                  ? <>
                    <span className="text-amber-300">HQ : {a.hqError ?? "pas encore consigné"}</span>
                    <button type="button" disabled={busy !== null} onClick={() => void post(a.id, "hq")} className="flex items-center gap-1 text-gray-300 hover:text-white disabled:opacity-40">
                      {busy === `${a.id}:hq` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Réécrire dans HQ
                    </button>
                  </>
                  : null}
              {undoable && (
                <button type="button" disabled={busy !== null} onClick={() => void post(a.id, "undo")} className="flex items-center gap-1 text-gray-300 hover:text-white disabled:opacity-40">
                  {busy === `${a.id}:undo` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Annuler cette modification
                </button>
              )}
            </div>
            {error[a.id] && <p className="text-xs text-red-300">{error[a.id]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
