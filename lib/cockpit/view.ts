/**
 * Global Cockpit — what a given staff member sees of the latest snapshot:
 * admins everything, consultants the clients that have at least one account
 * in their scope. Totals are recomputed on what is shown.
 */

import { prisma } from "@/lib/prisma";
import { googleInScope, metaInScope, type AccountScope } from "@/lib/scope";
import { evolutionOf, type CockpitData, type EvolutionPoint } from "@/lib/cockpit/build";

export interface CockpitActionView { state: string; owner: string | null; due: string | null; note: string | null; updatedBy: string | null; updatedAt: string }

export interface CockpitView {
  data: CockpitData | null;
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

export function scopeData(data: CockpitData, scope: AccountScope): CockpitData {
  if ("all" in scope && scope.all) return data;
  const clients = data.clients.filter((c) =>
    Object.values(c.platforms).some((p) => (p.plat === "meta" ? metaInScope(scope, p.accountId) : googleInScope(scope, p.accountId))));
  const platforms = clients.flatMap((c) => Object.values(c.platforms));
  const tot = clients.reduce((s, c) => s + c.eur_w0, 0);
  const budgeted = clients.filter((c) => c.pacing).reduce((s, c) => s + c.eur_w0, 0);
  return {
    ...data,
    clients,
    tot_eur_w0: tot,
    tot_eur_base: clients.reduce((s, c) => s + c.eur_base, 0),
    quality: {
      accounts: platforms.length,
      issues: platforms.filter((p) => p.err).length,
      budgeted: platforms.filter((p) => p.pacing).length,
      budget_coverage: tot > 0 ? Math.round((budgeted / tot) * 10_000) / 10_000 : 0,
    },
    // Which clients of the sheet have no account is an admin matter.
    unmatched: [],
  };
}

export async function loadCockpitView(scope: AccountScope): Promise<CockpitView> {
  const [rows, actions] = await Promise.all([
    prisma.cockpitSnapshot.findMany({ orderBy: { createdAt: "desc" }, take: EVOLUTION_SNAPSHOTS, select: { createdAt: true, status: true, dataJson: true } }),
    prisma.cockpitAction.findMany(),
  ]);
  const parsed = rows
    .map((r) => ({ createdAt: r.createdAt, status: r.status, data: parse(r.dataJson) }))
    .filter((r): r is { createdAt: Date; status: string; data: CockpitData } => !!r.data);
  const latest = parsed[0] ?? null;
  if (!latest) return { data: null, snapshotAt: null, status: null, evolution: {}, actions: {} };

  const data = scopeData(latest.data, scope);
  const keys = new Set(data.clients.map((c) => c.key));
  const evolution = Object.fromEntries(Object.entries(evolutionOf(parsed)).filter(([k]) => keys.has(k)));
  return {
    data,
    snapshotAt: latest.createdAt.toISOString(),
    status: latest.status,
    evolution,
    actions: Object.fromEntries(actions.filter((a) => keys.has(a.clientKey)).map((a) => [a.clientKey, {
      state: a.state, owner: a.owner, due: a.due, note: a.note, updatedBy: a.updatedBy, updatedAt: a.updatedAt.toISOString(),
    }])),
  };
}
