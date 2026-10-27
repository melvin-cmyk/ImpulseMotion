/**
 * Creative warehouse backfill, run on the server (no 300 s function limit):
 *   node_modules/.bin/tsx --env-file=.env.local scripts/ads-backfill.ts [--platforms=meta,google,tiktok] [--accounts=123,456] [--full] [--minutes=120]
 * Repeats passes until every account is complete or the time budget is spent.
 *   --dry --accounts=123 [--days=7] → reads the platform for one account and
 *   prints what the adapter would store, WITHOUT writing anything.
 *   --thumbs [--accounts=…] → re-read the large previews of the catalogue
 *   (rows stored with 64 px thumbnails before 2026-10-27).
 */
import { runAdsSync, warehouseStatus } from "../lib/ads-warehouse/sync";
import { metaAdapter, refreshThumbnails } from "../lib/ads-warehouse/meta";
import { googleAdapter } from "../lib/ads-warehouse/google";
import { tiktokAdapter } from "../lib/ads-warehouse/tiktok";
import type { WarehousePlatform } from "../lib/ads-warehouse/types";
import { prisma } from "../lib/prisma";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? "1"] : [a, "1"]; }));
const minutes = parseFloat(args.minutes ?? "120");
const accountIds = args.accounts ? String(args.accounts).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const platforms = args.platforms ? (String(args.platforms).split(",").map((s) => s.trim()).filter(Boolean) as WarehousePlatform[]) : undefined;
const ADAPTERS = { meta: metaAdapter, google: googleAdapter, tiktok: tiktokAdapter } as const;
const end = Date.now() + minutes * 60_000;

async function dryRun() {
  const accountId = accountIds?.[0];
  if (!accountId) throw new Error("--dry demande --accounts=<id>");
  const days = parseInt(args.days ?? "7", 10) || 7;
  const until = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const t0 = Date.now();
  const platform = (platforms?.[0] ?? "meta") as keyof typeof ADAPTERS;
  const adapter = ADAPTERS[platform] ?? metaAdapter;
  const out = await adapter.sync({ accountId, window: { since, until }, fullMetadata: args.full === "1", metadataSince: null, knownAdIds: new Set(), deadline: Date.now() + 10 * 60_000 });
  console.log(`dry run ${platform}:${accountId} ${since}→${until} in ${Math.round((Date.now() - t0) / 1000)} s — ${out.daily.length} day rows, ${out.catalog.length} catalogue rows, truncated ${out.truncated}, currency ${out.currency}`);
  const byFormat: Record<string, number> = {};
  for (const c of out.catalog) byFormat[c.format] = (byFormat[c.format] ?? 0) + 1;
  console.log("formats:", byFormat);
  const withThumb = out.catalog.filter((c) => c.thumbnailUrl || c.imageUrl).length;
  const withTags = out.catalog.filter((c) => Object.keys(c.tags).some((k) => !/^(s|t)\d+$/.test(k))).length;
  console.log(`thumbnails ${withThumb}/${out.catalog.length}, convention tags ${withTags}/${out.catalog.length}`);
  const sums = out.daily.reduce((a, d) => ({ spend: a.spend + d.spend, impr: a.impr + d.impressions, conv: a.conv + d.conversions, val: a.val + d.conversionValue, v3: a.v3 + d.video3s, plays: a.plays + d.videoPlays, thru: a.thru + d.thruPlays, p100: a.p100 + d.videoP100 }), { spend: 0, impr: 0, conv: 0, val: 0, v3: 0, plays: 0, thru: 0, p100: 0 });
  console.log("sums:", JSON.stringify(sums));
  const adsWithDaily = new Set(out.daily.map((d) => d.adId));
  const known = new Set(out.catalog.map((c) => c.adId));
  console.log(`ads with delivery ${adsWithDaily.size}, of which without metadata ${Array.from(adsWithDaily).filter((id) => !known.has(id)).length}`);
  for (const c of out.catalog.filter((c) => adsWithDaily.has(c.adId)).slice(0, 3)) console.log(" sample:", JSON.stringify({ name: c.name, format: c.format, key: c.creativeKey, thumb: !!c.thumbnailUrl, image: !!c.imageUrl, video: c.videoId, title: c.title?.slice(0, 40), landing: c.landingUrl?.slice(0, 50), tags: c.tags, status: c.status, created: c.createdTime }));
  console.log(" sample day:", JSON.stringify(out.daily.sort((a, b) => b.spend - a.spend)[0]));
}

async function thumbs() {
  const accounts = accountIds ?? (await prisma.adCatalog.findMany({ where: { platform: "meta" }, select: { accountId: true }, distinct: ["accountId"] })).map((r) => r.accountId);
  for (const a of accounts) {
    const t0 = Date.now();
    const n = await refreshThumbnails(a, Math.min(end, Date.now() + 10 * 60_000));
    console.log(`thumbs meta:${a} ${n} previews in ${Math.round((Date.now() - t0) / 1000)} s`);
    if (Date.now() > end) break;
  }
}

async function main() {
  if (args.dry === "1") return dryRun();
  if (args.thumbs === "1") return thumbs();
  let pass = 0;
  while (Date.now() < end) {
    pass += 1;
    const report = await runAdsSync({ deadline: Math.min(end, Date.now() + 25 * 60_000), accountIds, platforms, fullMetadata: args.full === "1" && pass === 1, ignoreRecentRun: true });
    const ok = report.accounts.filter((a) => a.ok).length;
    const ko = report.accounts.filter((a) => !a.ok);
    console.log(`[pass ${pass}] ${ok} ok, ${ko.length} ko, ${report.accounts.reduce((s, a) => s + a.daily, 0)} day rows, pending ${report.pending}, timedOut ${report.timedOut}`);
    for (const a of ko) console.log(`  ✗ ${a.platform}:${a.accountId} — ${a.error}`);
    for (const a of report.accounts.filter((x) => x.ok)) console.log(`  ✓ ${a.platform}:${a.accountId} ${a.windows.map((w) => `${w.since}→${w.until}`).join(" + ")} ${a.daily} rows ${Math.round(a.ms / 1000)} s`);
    if (report.accounts.length === 0) break;
    const status = await warehouseStatus();
    if (status.every((s) => s.complete || !s.enabled)) { console.log("complete"); break; }
  }
  const status = await warehouseStatus();
  console.log(`${status.filter((s) => s.complete).length}/${status.length} accounts complete`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
