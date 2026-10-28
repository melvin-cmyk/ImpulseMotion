"use client";

/**
 * What one visual of a creatives card lets you do, shown on hover / focus:
 * Garder · Couper · Chiffres · FigCraft · PhotoCraft · Drive · Publier — and
 * the verdict badge (green kept, grey cut) once a verdict is given. Keyboard
 * on the selected card: G garder, X couper, P publier (the hovered or focused
 * visual). The page runs the action (POST /api/mo/[id]/act).
 */

import { BarChart3, Check, HardDrive, Loader2, PenTool, Scissors, Send, Wand2 } from "lucide-react";
import type { MoCreative } from "@/lib/mo/model";

export type CreativeAction = "keep" | "cut" | "metrics" | "figcraft" | "photocraft" | "drive" | "publish";

export const ACTION_LABELS: Record<CreativeAction, string> = {
  keep: "Garder (G)", cut: "Couper (X)", metrics: "Chiffres", figcraft: "FigCraft", photocraft: "PhotoCraft", drive: "Drive", publish: "Publier (P)",
};

const ICONS: Record<CreativeAction, typeof Check> = { keep: Check, cut: Scissors, metrics: BarChart3, figcraft: PenTool, photocraft: Wand2, drive: HardDrive, publish: Send };

/** The actions that make sense for this visual: figures need a platform ad, publishing needs a file of ours. */
export function actionsFor(item: Pick<MoCreative, "adId" | "assetId" | "link">): CreativeAction[] {
  const platformAd = !!item.adId && !item.adId.startsWith("adlib:");
  const out: CreativeAction[] = ["keep", "cut"];
  if (platformAd) out.push("metrics");
  out.push("figcraft", "photocraft", "drive");
  if (item.assetId) out.push("publish");
  return out;
}

/** The key pressed on the selected card → the action, or null. */
export function actionForKey(key: string): CreativeAction | null {
  const k = key.toLowerCase();
  return k === "g" ? "keep" : k === "x" ? "cut" : k === "p" ? "publish" : null;
}

export function CardActions({ item, busy, onAction }: { item: MoCreative; busy: CreativeAction | null; onAction: (action: CreativeAction) => void }) {
  const actions = actionsFor(item);
  return (
    <div data-card-actions className="absolute inset-x-1.5 bottom-1.5 flex flex-wrap items-center justify-center gap-0.5 rounded-xl border border-white/10 bg-[#0d0a1a]/90 backdrop-blur px-1 py-1 opacity-0 translate-y-1 transition-all group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
      {actions.map((a) => {
        const Icon = ICONS[a];
        const active = (a === "keep" && item.verdict === "keep") || (a === "cut" && item.verdict === "cut");
        const tone = a === "keep" ? "hover:bg-emerald-500/25 hover:text-emerald-200" : a === "cut" ? "hover:bg-white/15 hover:text-gray-100" : a === "publish" ? "hover:bg-violet-500/30 hover:text-violet-100" : "hover:bg-white/10 hover:text-white";
        return (
          <button key={a} type="button" data-action={a} title={ACTION_LABELS[a]} aria-label={ACTION_LABELS[a]} disabled={!!busy}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAction(a); }}
            className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-gray-300 transition-colors disabled:opacity-50 ${tone} ${active ? (a === "keep" ? "bg-emerald-500/25 text-emerald-200" : "bg-white/15 text-gray-100") : ""}`}>
            {busy === a ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
          </button>
        );
      })}
    </div>
  );
}

/** Green « Gardée » / grey « Coupée » on the visual once judged. */
export function VerdictBadge({ verdict }: { verdict: MoCreative["verdict"] }) {
  if (!verdict) return null;
  return (
    <span data-verdict={verdict} className={`absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold shadow ${verdict === "keep" ? "bg-emerald-500/90 text-white" : "bg-gray-600/90 text-gray-100"}`}>
      {verdict === "keep" ? <Check className="w-3 h-3" /> : <Scissors className="w-3 h-3" />} {verdict === "keep" ? "Gardée" : "Coupée"}
    </span>
  );
}
