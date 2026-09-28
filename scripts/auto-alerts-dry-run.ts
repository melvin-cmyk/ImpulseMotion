/**
 * Detect-only run of the automatic alerts: reads the ad accounts, prints what
 * would be raised. Writes no incident, sends nothing, calls no AI.
 *   npx tsx --env-file=.env.local scripts/auto-alerts-dry-run.ts [clientId…]
 */
import { runAutoAlerts } from "@/lib/auto-alerts/run";

async function main() {
  const ids = process.argv.slice(2);
  const t0 = Date.now();
  const res = await runAutoAlerts({ dryRun: true, clientIds: ids.length ? ids : undefined });
  for (const r of res.runs) {
    console.log(`\n■ ${r.name} (${r.accounts} compte${r.accounts > 1 ? "s" : ""}${r.dormant ? ", sans dépense" : ""}) — canal ${r.channel ?? "aucun"}`);
    if (!r.findings.length) console.log("  rien à signaler");
    for (const f of r.findings) console.log(`  [${f.severity}] ${f.title}\n      ${f.detail}`);
    for (const e of r.errors) console.log(`  ! ${e}`);
  }
  console.log(`\n${res.scanned}/${res.clients} clients lus, ${res.withFindings} avec au moins un point, ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
