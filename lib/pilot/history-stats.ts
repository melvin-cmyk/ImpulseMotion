/**
 * Pilotage — what the history says, counted: the changes of the period by
 * source, by person, by object and by kind of setting, the verdicts of the
 * analyses, the figures of the last seven days against the seven before, a
 * moving average for the curve, a CSV of the lines. Pure.
 */

import type { PilotActionView } from "@/lib/pilot/service";
import type { DailyPoint, PlatformChangeView } from "@/lib/pilot/history";
import { VERDICT_FR, type Verdict } from "@/lib/pilot/impact";

/** A kind of setting, as the filters and the session summaries name it. */
export type ChangeCategory = "budget" | "statut" | "enchère" | "ciblage" | "créa" | "mots-clés" | "dates" | "création" | "suppression" | "nom" | "autre";
export const CATEGORIES: ChangeCategory[] = ["budget", "statut", "enchère", "ciblage", "créa", "mots-clés", "dates", "création", "suppression", "nom", "autre"];

const FIELD_CATEGORY: Record<string, ChangeCategory> = {
  daily_budget: "budget", lifetime_budget: "budget", budget: "budget", spend_cap: "budget",
  status: "statut",
  bid: "enchère", bid_amount: "enchère", bid_strategy: "enchère", cost_cap: "enchère", roas_floor: "enchère", target_cpa: "enchère", target_roas: "enchère", optimization: "enchère",
  targeting: "ciblage",
  creative: "créa", ad_texts: "créa", rsa: "créa", new_ad: "créa",
  keyword: "mots-clés", new_keyword: "mots-clés", new_negative: "mots-clés",
  schedule: "dates", end_time: "dates", stop_time: "dates", start_time: "dates", end_date: "dates", start_date: "dates",
  created: "création", copy: "création",
  deleted: "suppression",
  name: "nom", settings: "autre", other: "autre",
};

export function categoryOf(field: string, after?: unknown): ChangeCategory {
  if (field === "status" && after === "DELETED") return "suppression";
  return FIELD_CATEGORY[field] ?? "autre";
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const CATEGORY_WORDS: Record<ChangeCategory, [string, string]> = {
  budget: ["budget", "budgets"], statut: ["statut", "statuts"], enchère: ["enchère", "enchères"], ciblage: ["ciblage", "ciblages"], créa: ["créa", "créas"],
  "mots-clés": ["mot-clé", "mots-clés"], dates: ["date", "dates"], création: ["création", "créations"], suppression: ["suppression", "suppressions"], nom: ["renommage", "renommages"], autre: ["autre réglage", "autres réglages"],
};

/** « 12 créas, 3 budgets, 2 statuts » — a session of many changes in one line. */
export function summarizeSession(changes: Array<{ field: string; after?: unknown; objectType?: string }>): string {
  const counts = new Map<ChangeCategory, number>();
  for (const c of changes) { const k = categoryOf(c.field, c.after); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const objects = new Set(changes.map((c) => c.objectType).filter(Boolean));
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => plural(n, CATEGORY_WORDS[k][0], CATEGORY_WORDS[k][1]));
  return `${parts.join(", ")}${objects.size > 1 ? ` · ${objects.size} niveaux` : ""}`;
}

export interface Figures { spend: number; conversions: number; cpa: number | null; roas: number | null; days: number }

function figuresOf(points: DailyPoint[]): Figures {
  const spend = points.reduce((n, p) => n + p.spend, 0);
  const conversions = points.reduce((n, p) => n + p.conversions, 0);
  const revenue = points.some((p) => p.revenue !== null) ? points.reduce((n, p) => n + (p.revenue ?? 0), 0) : null;
  return { spend, conversions, cpa: conversions > 0 ? spend / conversions : null, roas: revenue !== null && spend > 0 ? revenue / spend : null, days: points.length };
}

export interface HistoryStats {
  /** Changes of the period, actions and platform changes together, by source. */
  bySource: { impulsemotion: number; external: number; automated: number };
  /** Who changed the most (actions and platform changes), top first. */
  actors: Array<{ name: string; count: number; source: "impulsemotion" | "external" | "automated" }>;
  /** Objects touched the most. */
  objects: Array<{ name: string; count: number }>;
  byCategory: Array<{ category: ChangeCategory; count: number }>;
  /** Latest verdict of each judged change. */
  verdicts: Array<{ verdict: Verdict; label: string; count: number }>;
  /** Last 7 full days against the 7 before, when the curve has them. */
  last7: Figures | null;
  prev7: Figures | null;
}

export function historyStats(actions: PilotActionView[], changes: PlatformChangeView[], points: DailyPoint[] | null): HistoryStats {
  const sent = actions.filter((a) => a.status !== "draft" && a.status !== "expired");
  const actionIds = new Set(sent.map((a) => a.id));
  // A change that belongs to an action shown is the action: counted once.
  const loose = changes.filter((c) => !(c.pilotActionId && actionIds.has(c.pilotActionId)));
  const bySource = { impulsemotion: sent.length, external: 0, automated: 0 };
  for (const c of loose) { if (c.source === "impulsemotion") bySource.impulsemotion++; else if (c.source === "automated") bySource.automated++; else bySource.external++; }

  const actorMap = new Map<string, { count: number; source: "impulsemotion" | "external" | "automated" }>();
  for (const a of sent) { const k = a.createdByName; actorMap.set(k, { count: (actorMap.get(k)?.count ?? 0) + a.operations.length, source: "impulsemotion" }); }
  for (const c of loose) { const k = c.actorName; const prev = actorMap.get(k); actorMap.set(k, { count: (prev?.count ?? 0) + 1, source: prev?.source ?? (c.source as "impulsemotion" | "external" | "automated") }); }
  const actors = [...actorMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count).slice(0, 5);

  const objectMap = new Map<string, number>();
  for (const a of sent) for (const o of a.operations) if (o.objectName) objectMap.set(o.objectName, (objectMap.get(o.objectName) ?? 0) + 1);
  for (const c of loose) if (c.objectName) objectMap.set(c.objectName, (objectMap.get(c.objectName) ?? 0) + 1);
  const objects = [...objectMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5);

  const catMap = new Map<ChangeCategory, number>();
  for (const a of sent) for (const o of a.operations) { const k = categoryOf(o.field, o.after); catMap.set(k, (catMap.get(k) ?? 0) + 1); }
  for (const c of loose) { const k = categoryOf(c.field, c.after); catMap.set(k, (catMap.get(k) ?? 0) + 1); }
  const byCategory = [...catMap.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);

  const verdictMap = new Map<Verdict, number>();
  const judged = [...sent.map((a) => a.impacts ?? []), ...loose.map((c) => c.impacts)];
  for (const impacts of judged) {
    const last = [...impacts].reverse().find((i) => i.status === "done");
    if (last && last.verdict) verdictMap.set(last.verdict as Verdict, (verdictMap.get(last.verdict as Verdict) ?? 0) + 1);
  }
  const verdicts = [...verdictMap.entries()].map(([verdict, count]) => ({ verdict, label: VERDICT_FR[verdict] ?? verdict, count })).sort((a, b) => b.count - a.count);

  let last7: Figures | null = null, prev7: Figures | null = null;
  if (points && points.length >= 15) {
    // Today is left out: it is not a full day.
    const full = points.slice(0, -1);
    last7 = figuresOf(full.slice(-7));
    prev7 = figuresOf(full.slice(-14, -7));
  }
  return { bySource, actors, objects, byCategory, verdicts, last7, prev7 };
}

/** The change in %, null when it cannot be said. */
export const deltaPct = (before: number | null | undefined, after: number | null | undefined): number | null =>
  before === null || before === undefined || after === null || after === undefined || before === 0 ? null : ((after - before) / Math.abs(before)) * 100;

/** A centred moving average over `window` days of one key of the curve (null where the window is not full). */
export function movingAverage(points: DailyPoint[], key: "spend" | "conversions" | "cpa" | "roas", window = 7): Array<number | null> {
  const values = points.map((p) => {
    if (key === "cpa") return p.conversions > 0 ? p.spend / p.conversions : null;
    if (key === "roas") return p.revenue !== null && p.spend > 0 ? p.revenue / p.spend : null;
    return p[key];
  });
  return values.map((_, i) => {
    if (i < window - 1) return null;
    const slice = values.slice(i - window + 1, i + 1);
    if (key === "cpa" || key === "roas") {
      // Ratios are averaged on their sums, not on their daily values.
      const pts = points.slice(i - window + 1, i + 1);
      const spend = pts.reduce((n, p) => n + p.spend, 0);
      if (key === "cpa") { const conv = pts.reduce((n, p) => n + p.conversions, 0); return conv > 0 ? spend / conv : null; }
      const rev = pts.reduce((n, p) => n + (p.revenue ?? 0), 0);
      return spend > 0 && pts.some((p) => p.revenue !== null) ? rev / spend : null;
    }
    return slice.reduce<number>((n, v) => n + (v ?? 0), 0) / window;
  });
}

/** The lines of the history as a CSV (UTF-8, semicolons, Excel-friendly). */
export function historyCsv(actions: PilotActionView[], changes: PlatformChangeView[]): string {
  const esc = (v: unknown) => { const s = String(v ?? "").replace(/"/g, '""'); return /[;"\n]/.test(s) ? `"${s}"` : s; };
  const rows: string[][] = [["date", "source", "auteur", "via", "plateforme", "compte", "niveau", "objet", "réglage", "avant", "après", "pourquoi", "bilan J+7", "bilan J+14"]];
  const verdict = (impacts: Array<{ horizon: number; status: string; verdict: string }>, h: number) => { const i = impacts.find((x) => x.horizon === h); return i && i.status === "done" ? VERDICT_FR[i.verdict as Verdict] ?? i.verdict : ""; };
  const actionIds = new Set(actions.map((a) => a.id));
  for (const a of actions) {
    if (a.status === "draft" || a.status === "expired") continue;
    for (const o of a.operations) rows.push([a.executedAt ?? a.createdAt, "ImpulseMotion", a.createdByName, "Pilotage", a.platform, a.accountName || a.accountId, o.objectType, o.objectName, o.field, String(o.before ?? ""), String(o.after ?? ""), a.why, verdict(a.impacts ?? [], 7), verdict(a.impacts ?? [], 14)]);
  }
  for (const c of changes) {
    if (c.pilotActionId && actionIds.has(c.pilotActionId)) continue;
    rows.push([c.at, c.sourceText, c.actorName, c.via, c.platform, c.accountId, c.objectType, c.objectName, c.field, String(c.before ?? ""), String(c.after ?? ""), c.note, verdict(c.impacts, 7), verdict(c.impacts, 14)]);
  }
  rows.sort((a, b) => (a === rows[0] ? -1 : b === rows[0] ? 1 : b[0].localeCompare(a[0])));
  return `﻿${rows.map((r) => r.map(esc).join(";")).join("\n")}`;
}
