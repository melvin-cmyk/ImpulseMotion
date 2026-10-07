/**
 * Read-only smoke test of the Pilotage adapters on real accounts: structure,
 * one object, ads / keywords, as the page reads them. Writes nothing.
 *   npx tsx --env-file=.env.local scripts/pilot-read-smoke.ts meta:1668772300254268 google:6823803493 tiktok:<advertiser>
 */
import { pilotAdapter } from "@/lib/pilot/adapters";
import { prisma } from "@/lib/prisma";

async function main() {
  let targets = process.argv.slice(2).map((arg) => { const [platform, accountId] = arg.split(":"); return { platform, accountId }; });
  if (targets.some((t) => t.platform === "tiktok" && !t.accountId)) {
    const clients = await prisma.alertClient.findMany({ where: { gone: false }, select: { name: true, accountsJson: true } });
    const found = clients.flatMap((c) => (JSON.parse(c.accountsJson) as Array<{ platform: string; accountId: string }>).filter((a) => a.platform === "tiktok").map((a) => ({ client: c.name, id: a.accountId })));
    console.log("TikTok advertisers:", found.slice(0, 5));
    targets = targets.filter((t) => t.accountId).concat(found[0] ? [{ platform: "tiktok", accountId: found[0].id }] : []);
  }
  for (const t of targets) {
    const adapter = pilotAdapter(t.platform)!;
    const key = adapter.accountKey(t.accountId)!;
    const t0 = Date.now();
    try {
      const currency = await adapter.readCurrency(key);
      const s = await adapter.readStructure(key, currency);
      console.log(`\n${adapter.name} ${key} ${currency}: ${s.campaigns.length} campagnes, ${s.adsets.length} groupes, ${s.negatives?.length ?? 0} négatifs, truncated=${s.truncated} (${Date.now() - t0} ms)`);
      const c = s.campaigns[0];
      if (c) console.log("  campagne:", JSON.stringify({ name: c.name, status: c.status, eff: c.effectiveStatus, daily: c.dailyBudget, start: c.startTime, end: c.endTime, strategy: c.bidStrategy, tcpa: c.targetCpa, troas: c.targetRoas, cap: c.spendCap, lock: c.strategyLock }));
      const g = s.adsets.find((a) => a.effectiveStatus === "ACTIVE") ?? s.adsets[0];
      if (g) {
        console.log("  groupe:", JSON.stringify({ name: g.name, status: g.status, daily: g.dailyBudget, bid: g.bidAmount, strategy: g.bidStrategy, tcpa: g.targetCpa, end: g.endTime, lock: g.strategyLock }));
        const one = await adapter.readObject(key, g.id, "adset", currency);
        console.log("  readObject(adset):", one ? JSON.stringify({ name: one.name, targeting: one.targeting ? `${one.targeting.length} chars` : null, bid: one.bidAmount, strategy: one.bidStrategy }) : null);
        if (adapter.readAds) {
          const children = await adapter.readAds(key, g.id, currency);
          console.log(`  ${children.length} sous-objets:`, children.slice(0, 3).map((x) => `${x.type}:${x.name.slice(0, 50)} [${x.status}${x.negative ? ",neg" : ""}${x.rsa ? ",rsa" : ""}${x.creativeId ? ",créa " + x.creativeId : ""}]`));
          const ad = children.find((x) => x.type === "ad");
          if (ad) { const o = await adapter.readObject(key, ad.id, "ad", currency); console.log("  readObject(ad):", o ? JSON.stringify({ name: o.name.slice(0, 40), creativeId: o.creativeId, texts: o.adTexts ? "oui" : null, rsa: o.rsa ? "oui" : null }) : null); }
          const kw = children.find((x) => x.type === "keyword");
          if (kw) { const o = await adapter.readObject(key, kw.id, "keyword", currency); console.log("  readObject(keyword):", o ? JSON.stringify({ name: o.name, status: o.status, bid: o.bidAmount, lock: o.strategyLock }) : null); }
        }
      }
    } catch (e) {
      console.log(`\n${adapter.name} ${key}: ERREUR`, e instanceof Error ? e.message : e);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
