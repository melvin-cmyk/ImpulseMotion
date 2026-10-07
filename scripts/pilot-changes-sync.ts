/**
 * Reads the platforms' change logs of given accounts into PlatformChange (what
 * the daily cron and the page do), then prints what was stored. Real writes
 * in the database, nothing sent to the platforms.
 *   npx tsx --env-file=.env.local scripts/pilot-changes-sync.ts meta:1668772300254268 google:6823803493
 */
import { prisma } from "@/lib/prisma";
import { syncAccountChanges } from "@/lib/pilot/changes-ingest";

async function main() {
  const targets = process.argv.slice(2).map((arg) => { const [platform, accountId] = arg.split(":"); return { platform: platform as "meta" | "google", accountId }; });
  if (!targets.length) { console.log("usage: meta:<digits> google:<digits>"); return; }
  const clients = await prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, name: true, accountsJson: true } });
  for (const t of targets) {
    const client = clients.find((c) => c.accountsJson.includes(t.accountId));
    const t0 = Date.now();
    const o = await syncAccountChanges({ platform: t.platform, accountId: t.accountId, currency: "EUR", alertClientId: client?.id ?? null });
    console.log(client?.name ?? "(client inconnu)", JSON.stringify(o), `${Date.now() - t0} ms`);
    const rows = await prisma.platformChange.findMany({ where: { platform: t.platform, accountId: t.accountId }, orderBy: { at: "desc" }, take: 8 });
    for (const r of rows) console.log("  ", r.at.toISOString().slice(0, 16), r.source.padEnd(13), r.pilotActionId ? "action " + r.pilotActionId.slice(-6) : "-".padEnd(13), `[${r.actorName} via ${r.via}]`, r.significant ? "!" : " ", r.line.slice(0, 110));
  }
  console.log(await prisma.platformChange.groupBy({ by: ["platform", "source"], _count: true }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
