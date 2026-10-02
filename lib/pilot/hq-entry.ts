/**
 * Pilotage → HQ: the entry written in the client's journal once a change was
 * sent. Who did it (name and email) first, then each change with its value
 * before and after and what became of it, then why and what it should move.
 * Pure.
 */

import { describeOperation, goalText, type PilotGoal, type PilotValue } from "@/lib/pilot/ops";

const PLATFORM_FR: Record<string, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };

const OUTCOME_FR: Record<string, string> = {
  done: "✅ appliqué",
  failed: "❌ refusé",
  uncertain: "⚠️ issue inconnue",
  conflict: "⏭ non envoyé (valeur changée entre-temps)",
  unchanged: "➖ déjà à cette valeur",
  skipped: "⏭ non envoyé",
  pending: "⏭ non envoyé",
};

export interface HqEntryInput {
  id: string;
  clientName: string;
  platform: string;
  accountName: string;
  accountId: string;
  currency: string;
  authorName: string;
  authorEmail: string | null;
  executedAt: Date;
  why: string;
  goal: PilotGoal;
  undoOf: { date: Date; author: string } | null;
  operations: Array<{ kind: string; objectType: string; objectName: string; parentName: string; field: string; before: PilotValue; after: PilotValue; status: string; error: string | null }>;
}

const parisDateTime = (d: Date) => d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function hqEntrySlug(input: { id: string; executedAt: Date }): string {
  return `pilotage-${input.executedAt.toISOString().slice(0, 10)}-${input.id.slice(-8)}`;
}

export function buildHqEntry(input: HqEntryInput): string {
  const who = input.authorEmail && input.authorEmail !== input.authorName ? `${input.authorName} (${input.authorEmail})` : input.authorName;
  const platform = PLATFORM_FR[input.platform] ?? input.platform;
  const lines = input.operations.map((op) => {
    const outcome = OUTCOME_FR[op.status] ?? op.status;
    return `- ${describeOperation(op, input.currency)} — ${outcome}${op.error && op.status !== "done" ? ` (${op.error})` : ""}`;
  });
  const goal = goalText(input.goal);
  return [
    `## ${input.undoOf ? "Annulation d'une modification" : "Modification"} ${platform} — ${input.clientName}`,
    "",
    `**Fait par ${who}** le ${parisDateTime(input.executedAt)}, depuis ImpulseMotion (Pilotage).`,
    `Compte : ${platform} « ${input.accountName || input.accountId} » (${input.accountId})`,
    ...(input.undoOf ? [`Remet en place ce qu'avait changé ${input.undoOf.author} le ${parisDateTime(input.undoOf.date)}.`] : []),
    "",
    "### Changements",
    ...lines,
    "",
    `**Pourquoi** : ${input.why || "non précisé"}`,
    ...(goal ? [`**Objectif** : ${goal}`] : []),
    "",
    "---",
    `_Consigné automatiquement par ImpulseMotion, action ${input.id}._`,
  ].join("\n");
}
