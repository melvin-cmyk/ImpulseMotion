/**
 * Creative warehouse — orchestrator.
 *
 * runAdsSync() walks the platform accounts the agency manages (never-synced
 * first, then the least recently run), and for each one within the deadline:
 *   - incremental window: from (syncedTo − 2 days) to yesterday UTC — the last
 *     days are re-read because platform attribution keeps moving for ~3 days;
 *   - one BACKFILL chunk (30 days) going backwards until WAREHOUSE_BACKFILL_DAYS
 *     (default 365) is covered, so the first pass gives a usable 30 days
 *     quickly and the history fills in over the following runs;
 *   - metadata: full on the first sync and every 7 days, otherwise only the
 *     ads updated since the previous run + the ads unknown to the catalogue.
 * Rows are UPSERTed in batches (INSERT … ON CONFLICT DO UPDATE); an account
 * failure is recorded in AdSyncState.lastError and never stops the pass.
 * Called by the hourly cron (app/api/cron/ads-sync), the admin button and
 * scripts/ads-backfill.ts on the server.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { metaAdapter } from "./meta";
import { catalogId, dailyId, stateId, type CatalogRow, type DailyRow, type SyncWindow, type WarehouseAdapter, type WarehousePlatform } from "./types";

const ADAPTERS: Partial<Record<WarehousePlatform, WarehouseAdapter>> = { meta: metaAdapter };
export const WAREHOUSE_ENABLED_PLATFORMS = Object.keys(ADAPTERS) as WarehousePlatform[];

const BACKFILL_DAYS = Math.max(30, parseInt(process.env.WAREHOUSE_BACKFILL_DAYS ?? "365", 10) || 365);
const CHUNK_DAYS = 30;
const FULL_META_EVERY_MS = 7 * 24 * 3600 * 1000;
const OVERLAP_DAYS = 2;
const RECENT_RUN_MS = 3 * 60 * 1000;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const yesterdayUtc = () => addDays(iso(new Date()), -1);

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  accounts: Array<{ platform: string; accountId: string; windows: SyncWindow[]; daily: number; catalog: number; ok: boolean; error?: string; ms: number }>;
  pending: number;
  timedOut: boolean;
}

export interface RunOptions {
  deadline: number;
  platforms?: WarehousePlatform[];
  accountIds?: string[];
  /** Force a full metadata refresh for every processed account. */
  fullMetadata?: boolean;
}

/** Accounts to process this pass, never-synced first then least recently run. */
async function plan(platforms: WarehousePlatform[], accountIds?: string[]) {
  const items: Array<{ platform: WarehousePlatform; accountId: string }> = [];
  for (const p of platforms) {
    const adapter = ADAPTERS[p];
    if (!adapter) continue;
    let ids = await adapter.listAccounts();
    if (accountIds?.length) ids = ids.filter((id) => accountIds.includes(id));
    for (const accountId of ids) items.push({ platform: p, accountId });
  }
  const states = await prisma.adSyncState.findMany({ where: { id: { in: items.map((i) => stateId(i.platform, i.accountId)) } } });
  const byId = new Map(states.map((s) => [s.id, s]));
  const now = Date.now();
  const ready = items.filter((i) => {
    const s = byId.get(stateId(i.platform, i.accountId));
    if (!s) return true;
    if (!s.enabled) return false;
    if (s.lastRunAt && now - s.lastRunAt.getTime() < RECENT_RUN_MS) return false; // overlapping pass
    return needsWork(s);
  });
  ready.sort((a, b) => {
    const sa = byId.get(stateId(a.platform, a.accountId));
    const sb = byId.get(stateId(b.platform, b.accountId));
    const ta = sa?.lastRunAt?.getTime() ?? 0;
    const tb = sb?.lastRunAt?.getTime() ?? 0;
    return ta - tb;
  });
  return { ready, byId };
}

type State = Prisma.AdSyncStateGetPayload<object>;

/** True when yesterday is not synced yet, the history is not complete, or the daily re-read has not run today. */
function needsWork(s: State): boolean {
  const y = yesterdayUtc();
  if (!s.syncedTo || iso(s.syncedTo) < y) return true;
  if (!s.syncedFrom || iso(s.syncedFrom) > addDays(y, -(BACKFILL_DAYS - 1))) return true;
  if (!s.lastOkAt || iso(s.lastOkAt) < iso(new Date())) return true;
  return false;
}

function windowsFor(s: State | undefined): SyncWindow[] {
  const y = yesterdayUtc();
  const target = addDays(y, -(BACKFILL_DAYS - 1));
  if (!s?.syncedTo || !s.syncedFrom) return [{ since: addDays(y, -(CHUNK_DAYS - 1)), until: y }];
  const out: SyncWindow[] = [];
  const to = iso(s.syncedTo);
  const from = iso(s.syncedFrom);
  const incSince = addDays(to < y ? to : y, -OVERLAP_DAYS);
  out.push({ since: incSince < from ? from : incSince, until: y });
  if (from > target) {
    const chunkUntil = addDays(from, -1);
    const chunkSince = addDays(chunkUntil, -(CHUNK_DAYS - 1));
    out.push({ since: chunkSince < target ? target : chunkSince, until: chunkUntil });
  }
  return out;
}

export async function runAdsSync(opts: RunOptions): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const platforms = (opts.platforms ?? WAREHOUSE_ENABLED_PLATFORMS).filter((p) => ADAPTERS[p]);
  const { ready, byId } = await plan(platforms, opts.accountIds);
  const report: SyncReport = { startedAt, finishedAt: "", accounts: [], pending: ready.length, timedOut: false };

  for (const item of ready) {
    if (Date.now() > opts.deadline - 15_000) { report.timedOut = true; break; }
    const adapter = ADAPTERS[item.platform]!;
    const id = stateId(item.platform, item.accountId);
    const state = byId.get(id);
    const windows = windowsFor(state);
    const t0 = Date.now();
    const fullMetadata = !!opts.fullMetadata || !state?.metaFullAt || Date.now() - state.metaFullAt.getTime() > FULL_META_EVERY_MS;
    const metadataSince = state?.lastOkAt ? new Date(state.lastOkAt.getTime() - 3600_000) : null;
    await prisma.adSyncState.upsert({ where: { id }, create: { id, platform: item.platform, accountId: item.accountId, lastRunAt: new Date() }, update: { lastRunAt: new Date() } });
    let daily = 0, catalog = 0;
    try {
      const knownAdIds = new Set((await prisma.adCatalog.findMany({ where: { platform: item.platform, accountId: item.accountId }, select: { adId: true } })).map((k) => k.adId));
      let syncedFrom = state?.syncedFrom ? iso(state.syncedFrom) : null;
      let syncedTo = state?.syncedTo ? iso(state.syncedTo) : null;
      let first = true;
      for (const w of windows) {
        if (Date.now() > opts.deadline - 15_000) { report.timedOut = true; break; }
        // Metadata is read with the first window only (it is not window-bound).
        const out = await adapter.sync({ accountId: item.accountId, window: w, fullMetadata: first && fullMetadata, metadataSince: first ? metadataSince : null, knownAdIds, deadline: opts.deadline - 10_000 });
        for (const c of out.catalog) knownAdIds.add(c.adId);
        await persist(out.daily, out.catalog, item.platform, item.accountId, w);
        daily += out.daily.length; catalog += out.catalog.length;
        if (!out.truncated) {
          syncedFrom = !syncedFrom || w.since < syncedFrom ? w.since : syncedFrom;
          syncedTo = !syncedTo || w.until > syncedTo ? w.until : syncedTo;
        }
        first = false;
      }
      const counts = await prisma.adCatalog.count({ where: { platform: item.platform, accountId: item.accountId } });
      await prisma.adSyncState.update({
        where: { id },
        data: {
          syncedFrom: syncedFrom ? new Date(syncedFrom + "T00:00:00Z") : null,
          syncedTo: syncedTo ? new Date(syncedTo + "T00:00:00Z") : null,
          metaFullAt: fullMetadata ? new Date() : undefined,
          lastOkAt: new Date(), lastError: null, adCount: counts, dayRows: { increment: daily },
        },
      });
      report.accounts.push({ platform: item.platform, accountId: item.accountId, windows, daily, catalog, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.adSyncState.update({ where: { id }, data: { lastError: msg.slice(0, 2000) } }).catch(() => undefined);
      report.accounts.push({ platform: item.platform, accountId: item.accountId, windows, daily, catalog, ok: false, error: msg.slice(0, 300), ms: Date.now() - t0 });
    }
    report.pending -= 1;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// ── Persistence (batched UPSERTs) ────────────────────────────────────────────

const DAILY_BATCH = 400;
const CATALOG_BATCH = 200;

async function persist(daily: DailyRow[], catalog: CatalogRow[], platform: string, accountId: string, w: SyncWindow) {
  // 1) catalogue rows from the platform metadata
  for (let i = 0; i < catalog.length; i += CATALOG_BATCH) await upsertCatalog(catalog.slice(i, i + CATALOG_BATCH));
  // 2) minimal catalogue rows for ads that have delivery but no metadata (deleted / beyond the caps)
  const known = new Set((await prisma.adCatalog.findMany({ where: { platform, accountId }, select: { adId: true } })).map((k) => k.adId));
  const minimal = new Map<string, CatalogRow>();
  for (const d of daily) {
    if (known.has(d.adId) || minimal.has(d.adId)) continue;
    minimal.set(d.adId, { platform: d.platform, accountId, adId: d.adId, name: d.adName ?? d.adId, adsetId: d.adsetId ?? null, adsetName: d.adsetName ?? null, campaignId: d.campaignId ?? null, campaignName: d.campaignName ?? null, format: "Unknown", tags: {} });
  }
  const minimalRows = Array.from(minimal.values());
  for (let i = 0; i < minimalRows.length; i += CATALOG_BATCH) await upsertCatalog(minimalRows.slice(i, i + CATALOG_BATCH));
  // 3) daily rows
  for (let i = 0; i < daily.length; i += DAILY_BATCH) await upsertDaily(daily.slice(i, i + DAILY_BATCH));
  // 4) lastSeenAt for every ad delivered in the window
  const ids = Array.from(new Set(daily.map((d) => catalogId(d.platform, d.adId))));
  for (let i = 0; i < ids.length; i += 1000) {
    await prisma.adCatalog.updateMany({ where: { id: { in: ids.slice(i, i + 1000) } }, data: { lastSeenAt: new Date(w.until + "T00:00:00Z") > new Date() ? new Date() : new Date() } });
  }
}

async function upsertCatalog(rows: CatalogRow[]) {
  if (!rows.length) return;
  const values = rows.map((r) => Prisma.sql`(${catalogId(r.platform, r.adId)}, ${r.platform}, ${r.accountId}, ${r.adId}, ${r.name}, ${r.status ?? null}, ${r.adsetId ?? null}, ${r.adsetName ?? null}, ${r.campaignId ?? null}, ${r.campaignName ?? null}, ${r.format}, ${r.dynamic ?? false}, ${r.creativeId ?? null}, ${r.creativeKey ?? null}, ${r.thumbnailUrl ?? null}, ${r.imageUrl ?? null}, ${r.videoId ?? null}, ${r.previewUrl ?? null}, ${r.title ?? null}, ${r.body ?? null}, ${r.cta ?? null}, ${r.landingUrl ?? null}, ${r.createdTime ?? null}, ${JSON.stringify(r.tags ?? {})}, ${r.platformUpdatedAt ?? null}, NOW())`);
  await prisma.$executeRaw`
    INSERT INTO "AdCatalog" ("id","platform","accountId","adId","name","status","adsetId","adsetName","campaignId","campaignName","format","dynamic","creativeId","creativeKey","thumbnailUrl","imageUrl","videoId","previewUrl","title","body","cta","landingUrl","createdTime","tagsJson","platformUpdatedAt","updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("id") DO UPDATE SET
      "name" = EXCLUDED."name",
      "status" = COALESCE(EXCLUDED."status", "AdCatalog"."status"),
      "adsetId" = COALESCE(EXCLUDED."adsetId", "AdCatalog"."adsetId"),
      "adsetName" = COALESCE(EXCLUDED."adsetName", "AdCatalog"."adsetName"),
      "campaignId" = COALESCE(EXCLUDED."campaignId", "AdCatalog"."campaignId"),
      "campaignName" = COALESCE(EXCLUDED."campaignName", "AdCatalog"."campaignName"),
      "format" = CASE WHEN EXCLUDED."format" = 'Unknown' THEN "AdCatalog"."format" ELSE EXCLUDED."format" END,
      "dynamic" = EXCLUDED."dynamic" OR "AdCatalog"."dynamic",
      "creativeId" = COALESCE(EXCLUDED."creativeId", "AdCatalog"."creativeId"),
      "creativeKey" = COALESCE(EXCLUDED."creativeKey", "AdCatalog"."creativeKey"),
      "thumbnailUrl" = COALESCE(EXCLUDED."thumbnailUrl", "AdCatalog"."thumbnailUrl"),
      "imageUrl" = COALESCE(EXCLUDED."imageUrl", "AdCatalog"."imageUrl"),
      "videoId" = COALESCE(EXCLUDED."videoId", "AdCatalog"."videoId"),
      "previewUrl" = COALESCE(EXCLUDED."previewUrl", "AdCatalog"."previewUrl"),
      "title" = COALESCE(EXCLUDED."title", "AdCatalog"."title"),
      "body" = COALESCE(EXCLUDED."body", "AdCatalog"."body"),
      "cta" = COALESCE(EXCLUDED."cta", "AdCatalog"."cta"),
      "landingUrl" = COALESCE(EXCLUDED."landingUrl", "AdCatalog"."landingUrl"),
      "createdTime" = COALESCE(EXCLUDED."createdTime", "AdCatalog"."createdTime"),
      "tagsJson" = CASE WHEN EXCLUDED."tagsJson" = '{}' THEN "AdCatalog"."tagsJson" ELSE EXCLUDED."tagsJson" END,
      "platformUpdatedAt" = COALESCE(EXCLUDED."platformUpdatedAt", "AdCatalog"."platformUpdatedAt"),
      "updatedAt" = NOW()`;
}

async function upsertDaily(rows: DailyRow[]) {
  if (!rows.length) return;
  const values = rows.map((r) => Prisma.sql`(${dailyId(r.platform, r.adId, r.date)}, ${r.platform}, ${r.accountId}, ${r.adId}, ${r.date}::date, ${r.currency ?? null}, ${r.spend}, ${r.impressions}, ${r.reach}, ${r.clicks}, ${r.linkClicks}, ${r.conversions}, ${r.conversionValue}, ${r.purchases}, ${r.purchaseValue}, ${r.leads}, ${r.videoPlays}, ${r.video3s}, ${r.thruPlays}, ${r.videoP25}, ${r.videoP50}, ${r.videoP75}, ${r.videoP100}, ${JSON.stringify(r.actions)}, NOW())`);
  await prisma.$executeRaw`
    INSERT INTO "AdDaily" ("id","platform","accountId","adId","date","currency","spend","impressions","reach","clicks","linkClicks","conversions","conversionValue","purchases","purchaseValue","leads","videoPlays","video3s","thruPlays","videoP25","videoP50","videoP75","videoP100","actionsJson","updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("id") DO UPDATE SET
      "currency" = COALESCE(EXCLUDED."currency", "AdDaily"."currency"),
      "spend" = EXCLUDED."spend", "impressions" = EXCLUDED."impressions", "reach" = EXCLUDED."reach",
      "clicks" = EXCLUDED."clicks", "linkClicks" = EXCLUDED."linkClicks",
      "conversions" = EXCLUDED."conversions", "conversionValue" = EXCLUDED."conversionValue",
      "purchases" = EXCLUDED."purchases", "purchaseValue" = EXCLUDED."purchaseValue", "leads" = EXCLUDED."leads",
      "videoPlays" = EXCLUDED."videoPlays", "video3s" = EXCLUDED."video3s", "thruPlays" = EXCLUDED."thruPlays",
      "videoP25" = EXCLUDED."videoP25", "videoP50" = EXCLUDED."videoP50", "videoP75" = EXCLUDED."videoP75", "videoP100" = EXCLUDED."videoP100",
      "actionsJson" = EXCLUDED."actionsJson", "updatedAt" = NOW()`;
}

/** Sync status per account, for the admin page and the Analyse Ads freshness line. */
export async function warehouseStatus(platform?: WarehousePlatform) {
  const states = await prisma.adSyncState.findMany({ where: platform ? { platform } : undefined, orderBy: [{ platform: "asc" }, { accountId: "asc" }] });
  return states.map((s) => ({
    platform: s.platform, accountId: s.accountId, enabled: s.enabled,
    syncedFrom: s.syncedFrom ? iso(s.syncedFrom) : null, syncedTo: s.syncedTo ? iso(s.syncedTo) : null,
    lastRunAt: s.lastRunAt?.toISOString() ?? null, lastOkAt: s.lastOkAt?.toISOString() ?? null, lastError: s.lastError,
    adCount: s.adCount, complete: !needsWork(s),
  }));
}
