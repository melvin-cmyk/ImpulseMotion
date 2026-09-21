#!/usr/bin/env node
/**
 * Resets the dashboards: exports every Dashboard (widgets, threads, members,
 * reports, sources, bot + accesses + conversations) to a JSON file, then
 * deletes them all. Everything attached goes with them (onDelete: Cascade).
 * Logins and their ad-account ACL rows are left untouched.
 *
 * After the reset, dashboards are re-created by an admin from /d, attaching
 * consultants and clients by email — nothing is provisioned automatically.
 *
 * Dry-run (export only):  node scripts/reset-dashboards.mjs
 * Apply:                  node scripts/reset-dashboards.mjs --apply
 */

import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const outDir = process.env.BACKUP_DIR || "/root/backups";

const dashboards = await prisma.dashboard.findMany({
  orderBy: { createdAt: "asc" },
  include: {
    user: { select: { email: true } },
    widgets: true, threads: true, members: true, reports: true, sources: true,
    bot: { include: { accesses: true, conversations: true } },
  },
});

fs.mkdirSync(outDir, { recursive: true });
const file = `${outDir}/dashboards-before-reset-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
fs.writeFileSync(file, JSON.stringify(dashboards, null, 1), { mode: 0o600 });

const sum = (k) => dashboards.reduce((n, d) => n + (d[k]?.length ?? 0), 0);
console.table(dashboards.map((d) => ({
  name: d.name, owner: d.user.email, meta: d.metaAccountId ?? "-", google: d.googleCustomerId ?? "-",
  widgets: d.widgets.length, threads: d.threads.length, reports: d.reports.length, members: d.members.length, bot: d.bot ? "yes" : "-",
})));
console.log(`Export: ${file}`);
console.log(`${dashboards.length} dashboard(s), ${sum("widgets")} widgets, ${sum("threads")} threads, ${sum("reports")} reports, ${sum("members")} members, ${dashboards.filter((d) => d.bot).length} bot(s).`);

if (!apply) {
  console.log("\nDry-run only. Re-run with --apply to delete them all.");
} else {
  const { count } = await prisma.dashboard.deleteMany({});
  console.log(`\nDeleted ${count} dashboard(s). Remaining: ${await prisma.dashboard.count()}.`);
}
await prisma.$disconnect();
