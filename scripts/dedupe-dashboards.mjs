#!/usr/bin/env node
/**
 * Merges duplicated dashboards: a CLIENT is an ad account, so dashboards that
 * share a Meta account OR a Google customer (transitively, across owners) are
 * one client. Keeps the OLDEST dashboard of each group, links it to the union
 * of the accounts, moves members / threads / reports / data sources from the
 * copies onto it (a source the keeper already has — same kind + external id —
 * is dropped with the copy),
 * adds the other owners as members (so they keep access), then deletes the
 * copies. Copies that carry customised widgets are reported (their widgets
 * are NOT merged — the keeper keeps its own).
 *
 * Dry-run by default:  node scripts/dedupe-dashboards.mjs
 * Apply:               node scripts/dedupe-dashboards.mjs --apply
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

const normMeta = (id) => id.trim().replace(/^act_/, "");
const normGoogle = (id) => id.trim().replace(/-/g, "").replace(/^0+/, "");

const rows = await prisma.dashboard.findMany({
  orderBy: { createdAt: "asc" },
  include: {
    user: { select: { email: true } },
    _count: { select: { widgets: true, members: true, threads: true, reports: true, sources: true } },
  },
});

// ── Union-find by account (same algorithm as lib/portfolio.groupDashboardsByAccount)
const parent = new Map();
const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let c = x; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
const byMeta = new Map();
const byGoogle = new Map();
const unlinked = [];
for (const d of rows) {
  const meta = d.metaAccountId ? normMeta(d.metaAccountId) : "";
  const google = d.googleCustomerId ? normGoogle(d.googleCustomerId) : "";
  if (!meta && !google) { unlinked.push(d); continue; }
  parent.set(d.id, d.id);
  if (meta) { const f = byMeta.get(meta); if (f) union(f, d.id); else byMeta.set(meta, d.id); }
  if (google) { const f = byGoogle.get(google); if (f) union(f, d.id); else byGoogle.set(google, d.id); }
}
const groups = new Map();
for (const d of rows) {
  if (!parent.has(d.id)) continue;
  const root = find(d.id);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(d);
}

// ── Report
const table = [];
let toMerge = 0;
const plans = [];
for (const list of groups.values()) {
  list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const keep = list[0];
  const drop = list.slice(1);
  const meta = keep.metaAccountId ?? drop.find((d) => d.metaAccountId)?.metaAccountId ?? null;
  const google = keep.googleCustomerId ?? drop.find((d) => d.googleCustomerId)?.googleCustomerId ?? null;
  for (const d of list) {
    table.push({
      client: keep.name,
      dashboard: d.id,
      name: d.name,
      owner: d.user?.email ?? d.userId,
      meta: d.metaAccountId ?? "-",
      google: d.googleCustomerId ?? "-",
      created: d.createdAt.toISOString().slice(0, 10),
      widgets: d._count.widgets,
      members: d._count.members,
      threads: d._count.threads,
      reports: d._count.reports,
      sources: d._count.sources,
      action: d.id === keep.id ? (drop.length ? `KEEP → link meta=${meta ?? "-"} google=${google ?? "-"}` : "keep (unique)") : "MERGE INTO keeper + delete",
    });
  }
  if (drop.length) { toMerge += drop.length; plans.push({ keep, drop, meta, google }); }
}
for (const d of unlinked) {
  table.push({
    client: "(unlinked)", dashboard: d.id, name: d.name, owner: d.user?.email ?? d.userId, meta: "-", google: "-",
    created: d.createdAt.toISOString().slice(0, 10), widgets: d._count.widgets, members: d._count.members, threads: d._count.threads, reports: d._count.reports, sources: d._count.sources,
    action: "skip — no account (link it or delete it by hand)",
  });
}
console.table(table);
console.log(`${rows.length} dashboard(s), ${groups.size} client(s), ${toMerge} duplicate(s) to merge, ${unlinked.length} unlinked.`);

if (!apply) {
  console.log("\nDry-run only. Re-run with --apply to merge.");
  await prisma.$disconnect();
  process.exit(0);
}

// ── Apply
let merged = 0;
for (const { keep, drop, meta, google } of plans) {
  await prisma.$transaction(async (tx) => {
    await tx.dashboard.update({
      where: { id: keep.id },
      data: {
        metaAccountId: meta ? normMeta(meta) : null,
        googleCustomerId: google ? normGoogle(google) : null,
        // Keep the first configured budget / report frequency of the group.
        ...(keep.monthlyBudget == null ? { monthlyBudget: drop.find((d) => d.monthlyBudget != null)?.monthlyBudget ?? null } : {}),
        ...(keep.budgetCurrency == null ? { budgetCurrency: drop.find((d) => d.budgetCurrency)?.budgetCurrency ?? null } : {}),
        ...(keep.reportFrequency == null ? { reportFrequency: drop.find((d) => d.reportFrequency)?.reportFrequency ?? null } : {}),
      },
    });
    for (const d of drop) {
      // Members of the copy → members of the keeper; the copy's owner too when different.
      const members = await tx.dashboardMember.findMany({ where: { dashboardId: d.id } });
      const userIds = new Set(members.map((m) => m.userId));
      if (d.userId !== keep.userId) userIds.add(d.userId);
      for (const userId of userIds) {
        if (userId === keep.userId) continue;
        await tx.dashboardMember.upsert({
          where: { dashboardId_userId: { dashboardId: keep.id, userId } },
          update: {},
          create: { dashboardId: keep.id, userId },
        });
      }
      await tx.assistantThread.updateMany({ where: { dashboardId: d.id }, data: { dashboardId: keep.id } });
      await tx.clientReport.updateMany({ where: { dashboardId: d.id }, data: { dashboardId: keep.id } });
      // Data sources (HubSpot…) → keeper, unless it already has the same (kind, externalId):
      // the copy's row is then dropped with the copy (unique constraint), keeper wins.
      const keeperSources = await tx.dashboardSource.findMany({ where: { dashboardId: keep.id }, select: { kind: true, externalId: true } });
      const taken = new Set(keeperSources.map((s) => `${s.kind}:${s.externalId}`));
      const copySources = await tx.dashboardSource.findMany({ where: { dashboardId: d.id }, select: { id: true, kind: true, externalId: true } });
      const movable = copySources.filter((s) => !taken.has(`${s.kind}:${s.externalId}`)).map((s) => s.id);
      if (movable.length) await tx.dashboardSource.updateMany({ where: { id: { in: movable } }, data: { dashboardId: keep.id } });
      const skipped = copySources.length - movable.length;
      if (skipped) console.log(`  ${d.id}: ${skipped} source(s) already on keeper — dropped with the copy`);
      await tx.dashboard.delete({ where: { id: d.id } });
      merged++;
    }
  });
  console.log(`merged ${drop.length} → ${keep.id} (${keep.name})`);
}
console.log(`\nDone: ${merged} duplicate dashboard(s) merged.`);
await prisma.$disconnect();
