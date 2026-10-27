/**
 * TikTok Ads adapter of the creative warehouse (through the relay's
 * mcp-tiktok-ads tools, like the dashboards).
 *
 * sync(window):
 *   1. get_report_integrated, data_level AUCTION_AD, dimensions ad_id ×
 *      stat_time_day, 30-day slices, all pages: spend, impressions, clicks,
 *      reach, conversions, purchase value, 2 s / 6 s views, quartiles, plus
 *      the ad / ad group / campaign names and the ad text;
 *   2. get_ads (paged) for the ads seen: format, statuses, creation date,
 *      landing page, CTA, video id / image ids;
 *   3. best effort: covers and image URLs from the media library
 *      (search_ad_videos / search_ad_images) when the relay allows them.
 */

import { prisma } from "@/lib/prisma";
import { relayDirectTool } from "@/lib/relay-tool";
import { TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { chunkRange, tiktokEnvelope } from "@/lib/tiktok-data";
import { parseNamingTags } from "./naming";
import type { AdFormat, AdapterSyncInput, AdapterSyncOutput, CatalogRow, DailyRow, WarehouseAdapter } from "./types";

type Row = Record<string, unknown>;
const num = (v: unknown): number => { const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0; return Number.isFinite(n) ? n : 0; };
const int = (v: unknown) => Math.round(num(v));
const str = (v: unknown): string | null => (typeof v === "string" && v && v !== "-" ? v : typeof v === "number" ? String(v) : null);
const obj = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const TIMEOUT = 60_000;
const MAX_PAGES = 40;
const REPORT_METRICS = ["ad_name", "adgroup_id", "adgroup_name", "campaign_id", "campaign_name", "spend", "impressions", "clicks", "reach", "conversion", "total_purchase_value", "video_play_actions", "video_watched_2s", "video_watched_6s", "video_views_p25", "video_views_p50", "video_views_p75", "video_views_p100", "image_mode", "ad_text", "call_to_action"];

function formatOf(adFormat: string | null, imageMode: string | null): AdFormat {
  const f = (adFormat ?? "").toUpperCase(), m = (imageMode ?? "").toUpperCase();
  if (f.includes("VIDEO") || m.includes("VIDEO")) return "Video";
  if (f.includes("CAROUSEL") || m.includes("CAROUSEL")) return "Carousel";
  if (f.includes("IMAGE") || m.includes("IMAGE")) return "Image";
  return "Unknown";
}

async function media(advertiserId: string, tool: "search_ad_videos" | "search_ad_images", key: "video_ids" | "image_ids", ids: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const res = await relayDirectTool(`${TIKTOK_SERVER}.${tool}`, { advertiser_id: advertiserId, filtering: { [key]: ids.slice(i, i + 20) }, page: "1", page_size: "20" }, 30_000);
      const { list } = tiktokEnvelope(res);
      for (const it of list) { const id = str(it.video_id) ?? str(it.image_id); if (id) out.set(id, it); }
    } catch { return out; /* not allowed on this relay: no covers */ }
  }
  return out;
}

export const tiktokAdapter: WarehouseAdapter = {
  platform: "tiktok",

  async listAccounts() {
    const ids = new Set<string>();
    try {
      const { listTikTokAdvertisers } = await import("@/lib/tiktok-data");
      for (const a of await listTikTokAdvertisers()) if (a.id) ids.add(a.id);
    } catch (e) { console.warn("[ads-warehouse] TikTok advertiser listing failed, dashboards only:", e instanceof Error ? e.message : e); }
    const rows = await prisma.dashboardSource.findMany({ where: { kind: "tiktok", status: { not: "disabled" } }, select: { externalId: true }, distinct: ["externalId"] });
    for (const r of rows) if (r.externalId) ids.add(r.externalId);
    return Array.from(ids);
  },

  async sync({ accountId, window, fullMetadata, knownAdIds, deadline }: AdapterSyncInput): Promise<AdapterSyncOutput> {
    const daily = new Map<string, DailyRow>();
    const info = new Map<string, Row>();
    let truncated = false;
    for (const range of chunkRange(window.since, window.until)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (Date.now() > deadline) { truncated = true; break; }
        const res = await relayDirectTool(`${TIKTOK_SERVER}.get_report_integrated`, { advertiser_id: accountId, data_level: "AUCTION_AD", dimensions: ["ad_id", "stat_time_day"], metrics: REPORT_METRICS, start_date: range.since, end_date: range.until, page: String(page) }, TIMEOUT);
        const { list, totalPage } = tiktokEnvelope(res);
        for (const r of list) {
          const d = obj(r.dimensions), m = obj(r.metrics);
          const adId = str(d.ad_id); const date = (str(d.stat_time_day) ?? "").slice(0, 10); if (!adId || !date) continue;
          const spend = num(m.spend), impressions = int(m.impressions);
          if (spend <= 0 && impressions <= 0) continue;
          info.set(adId, m);
          const conv = num(m.conversion), val = num(m.total_purchase_value);
          daily.set(`${adId}:${date}`, { platform: "tiktok", accountId, adId, date, currency: null, spend, impressions, reach: int(m.reach), clicks: int(m.clicks), linkClicks: int(m.clicks), conversions: conv, conversionValue: val, purchases: conv, purchaseValue: val, leads: 0, videoPlays: int(m.video_play_actions), video3s: int(m.video_watched_2s), thruPlays: int(m.video_watched_6s), videoP25: int(m.video_views_p25), videoP50: int(m.video_views_p50), videoP75: int(m.video_views_p75), videoP100: int(m.video_views_p100), actions: {}, adName: str(m.ad_name) ?? adId, adsetId: str(m.adgroup_id) ?? undefined, adsetName: str(m.adgroup_name) ?? undefined, campaignId: str(m.campaign_id) ?? undefined, campaignName: str(m.campaign_name) ?? undefined });
        }
        if (page >= totalPage) break;
      }
    }
    // Currency from the advertiser profile (cached 24 h by account-settings).
    let currency: string | null = null;
    try { const { getAccountProfileSettings } = await import("@/lib/account-settings"); currency = (await getAccountProfileSettings("tiktok", accountId)).currency; } catch { /* unknown */ }
    for (const row of daily.values()) row.currency = currency;

    const seen = Array.from(info.keys());
    const wanted = new Set(seen.filter((id) => fullMetadata || !knownAdIds.has(id)));
    const catalog: CatalogRow[] = [];
    if (wanted.size) {
      const ads = new Map<string, Row>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (Date.now() > deadline) { truncated = true; break; }
        let list: Row[] = [], totalPage = 1;
        try { const res = await relayDirectTool(`${TIKTOK_SERVER}.get_ads`, { advertiser_id: accountId, page: String(page), page_size: "100" }, TIMEOUT); ({ list, totalPage } = tiktokEnvelope(res)); } catch (e) { console.warn("[ads-warehouse] tiktok get_ads:", e instanceof Error ? e.message.slice(0, 120) : e); break; }
        for (const a of list) { const id = str(a.ad_id); if (id && wanted.has(id)) ads.set(id, a); }
        if (page >= totalPage || ads.size >= wanted.size) break;
      }
      const videoIds = Array.from(new Set(Array.from(ads.values()).map((a) => str(a.video_id)).filter((x): x is string => !!x)));
      const imageIds = Array.from(new Set(Array.from(ads.values()).flatMap((a) => (Array.isArray(a.image_ids) ? (a.image_ids as unknown[]).map(String) : [])))).slice(0, 400);
      const [videos, images] = await Promise.all([media(accountId, "search_ad_videos", "video_ids", videoIds), media(accountId, "search_ad_images", "image_ids", imageIds)]);
      for (const id of wanted) {
        const a = ads.get(id); const m = info.get(id) ?? {};
        const videoId = str(a?.video_id); const imageId = Array.isArray(a?.image_ids) ? String((a!.image_ids as unknown[])[0] ?? "") : "";
        const v = videoId ? videos.get(videoId) : undefined; const im = imageId ? images.get(imageId) : undefined;
        const cover = str(v?.video_cover_url) ?? str(v?.poster_url) ?? str(im?.image_url) ?? str(im?.url) ?? null;
        const name = str(a?.ad_name) ?? str(m.ad_name) ?? id;
        catalog.push({
          platform: "tiktok", accountId, adId: id, name,
          status: str(a?.operation_status) ?? null, adsetId: str(a?.adgroup_id) ?? str(m.adgroup_id), adsetName: str(a?.adgroup_name) ?? str(m.adgroup_name), campaignId: str(a?.campaign_id) ?? str(m.campaign_id), campaignName: str(a?.campaign_name) ?? str(m.campaign_name),
          format: formatOf(str(a?.ad_format), str(m.image_mode)), dynamic: false, creativeId: null,
          creativeKey: videoId ? `tv:${videoId}` : imageId ? `ti:${imageId}` : null,
          thumbnailUrl: cover, imageUrl: im ? (str(im.image_url) ?? str(im.url)) : null, videoId,
          previewUrl: str(v?.preview_url) ?? null,
          title: null, body: str(a?.ad_text) ?? str(m.ad_text), cta: str(a?.call_to_action) ?? str(m.call_to_action), landingUrl: str(a?.landing_page_url),
          createdTime: a?.create_time ? new Date(String(a.create_time).replace(" ", "T") + "Z") : null, platformUpdatedAt: a?.modify_time ? new Date(String(a.modify_time).replace(" ", "T") + "Z") : null,
          tags: parseNamingTags(name),
        });
      }
    }
    return { daily: Array.from(daily.values()), catalog, truncated, currency };
  },
};
