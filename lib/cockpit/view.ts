/**
 * Global Cockpit — what a given staff member sees of the latest snapshot:
 * admins everything, consultants the clients that have at least one account
 * in their scope. Totals are recomputed on what is shown.
 */

import { prisma } from "@/lib/prisma";
import { googleInScope, metaInScope, type AccountScope } from "@/lib/scope";
import { evolutionOf, totalsOf, type CockpitData, type EvolutionPoint } from "@/lib/cockpit/build";
import type { PeriodKind } from "@/lib/cockpit/engine";

export interface CockpitActionView { state: string; owner: string | null; due: string | null; note: string | null; updatedBy: string | null; updatedAt: string }

export interface CockpitView {
  data: CockpitData | null;
  /** readings the latest build holds */
  periods: PeriodKind[];
  snapshotAt: string | null;
  status: string | null;
  /** per client, oldest first — the memory of the previous builds */
  evolution: Record<string, EvolutionPoint[]>;
  actions: Record<string, CockpitActionView>;
}

const EVOLUTION_SNAPSHOTS = 20;

function parse(json: string): CockpitData | null {
  try { return JSON.parse(json) as CockpitData; } catch { return null; }
}

/** The reading asked for, in the shape the page has always read. Older builds only hold the week. */
export function pickPeriod(data: CockpitData, period: PeriodKind): CockpitData {
  const view = period === "week" ? null : data.views?.[period];
  const { views: _views, ...base } = data;
  return view ? { ...base, ...view, period } : { ...base, period: "week" };
}

/** Readings this build holds. */
export function periodsOf(data: CockpitData): PeriodKind[] {
  return ["day", "week", "month"].filter((p): p is PeriodKind => p === "week" || !!data.views?.[p as "day" | "month"]);
}

export function scopeData(data: CockpitData, scope: AccountScope): CockpitData {
  if ("all" in scope && scope.all) return data;
  const clients = data.clients.filter((c) =>
    Object.values(c.platforms).some((p) => (p.plat === "meta" ? metaInScope(scope, p.accountId) : googleInScope(scope, p.accountId))));
  return {
    ...data,
    clients,
    ...totalsOf(clients),
    // Which clients of the sheet have no account is an admin matter.
    unmatched: [],
  };
}

export async function loadCockpitView(scope: AccountScope, period: PeriodKind = "week"): Promise<CockpitView> {
  const [rows, actions] = await Promise.all([
    prisma.cockpitSnapshot.findMany({ orderBy: { createdAt: "desc" }, take: EVOLUTION_SNAPSHOTS, select: { createdAt: true, status: true, dataJson: true } }),
    prisma.cockpitAction.findMany(),
  ]);
  const parsed = rows
    .map((r) => ({ createdAt: r.createdAt, status: r.status, data: parse(r.dataJson) }))
    .filter((r): r is { createdAt: Date; status: string; data: CockpitData } => !!r.data);
  const latest = parsed[0] ?? null;
  if (!latest) return { data: null, periods: ["week"], snapshotAt: null, status: null, evolution: {}, actions: {} };

  const data = scopeData(pickPeriod(latest.data, period), scope);
  const keys = new Set(data.clients.map((c) => c.key));
  // The memory of the previous builds follows the reading asked for.
  const history = parsed.map((r) => ({ createdAt: r.createdAt, data: pickPeriod(r.data, period) })).filter((r) => (r.data.period ?? "week") === period);
  const evolution = Object.fromEntries(Object.entries(evolutionOf(history)).filter(([k]) => keys.has(k)));
  return {
    data,
    periods: periodsOf(latest.data),
    snapshotAt: latest.createdAt.toISOString(),
    status: latest.status,
    evolution,
    actions: Object.fromEntries(actions.filter((a) => keys.has(a.clientKey)).map((a) => [a.clientKey, {
      state: a.state, owner: a.owner, due: a.due, note: a.note, updatedBy: a.updatedBy, updatedAt: a.updatedAt.toISOString(),
    }])),
  };
}
