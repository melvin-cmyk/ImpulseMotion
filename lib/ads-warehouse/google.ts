/**
 * Google Ads adapter of the creative warehouse (through the relay's
 * mcp-google-ads GAQL tool, like the dashboards).
 *
 * sync(window):
 *   1. ad_group_ad × segments.date over the window (7-day slices): cost,
 *      impressions, clicks, conversions, conversion value, currency;
 *   2. best effort: video quartile rates for VIDEO / DEMAND_GEN campaigns
 *      (separate query; skipped when the API refuses it) — no hook rate on Google;
 *   3. metadata of the ads seen (IN batches of 100): type, name, status,
 *      final URLs and, per ad type, headlines / descriptions / image and
 *      video assets; image URLs and YouTube ids are resolved from `asset`.
 * Performance Max has no ad level in the API (asset groups): not covered yet.
 * Conversions = Google's configured conversions; the value feeds ROAS.
 */

import { prisma } from "@/lib/prisma";
import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows, costFrom } from "@/lib/dashboard-widgets";
import { parseNamingTags } from "./naming";
import type { AdFormat, AdapterSyncInput, AdapterSyncOutput, CatalogRow, DailyRow, WarehouseAdapter } from "./types";

type Row = Record<string, unknown>;
const num = (v: unknown): number => { const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0; return Number.isFinite(n) ? n : 0; };
const int = (v: unknown) => Math.round(num(v));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const obj = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const TIMEOUT = 90_000;
const SLICE_DAYS = 7;

async function gaql(customerId: string, query: string): Promise<Row[]> {
  const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ").trim() }) }, TIMEOUT);
  return extractRows(raw).filter((r) => !("fieldMask" in r && !("adGroupAd" in r || "asset" in r)));
}

function* slices(since: string, until: string) {
  let s = since;
  while (s <= until) {
    const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + SLICE_DAYS - 1);
    const e = d.toISOString().slice(0, 10);
    yield { since: s, until: e < until ? e : until };
    d.setUTCDate(d.getUTCDate() + 1); s = d.toISOString().slice(0, 10);
  }
}

const TEXT_TYPES = new Set(["RESPONSIVE_SEARCH_AD", "EXPANDED_TEXT_AD", "TEXT_AD", "CALL_AD", "EXPANDED_DYNAMIC_SEARCH_AD", "DYNAMIC_SEARCH_AD", "SHOPPING_PRODUCT_AD", "SHOPPING_SMART_AD", "HOTEL_AD", "TRAVEL_AD"]);
const VIDEO_TYPES = new Set(["VIDEO_AD", "VIDEO_RESPONSIVE_AD", "VIDEO_BUMPER_AD", "VIDEO_NON_SKIPPABLE_IN_STREAM_AD", "VIDEO_TRUEVIEW_IN_STREAM_AD", "VIDEO_OUTSTREAM_AD", "IN_FEED_VIDEO_AD", "DEMAND_GEN_VIDEO_RESPONSIVE_AD", "DISCOVERY_VIDEO_RESPONSIVE_AD"]);
const IMAGE_TYPES = new Set(["IMAGE_AD", "RESPONSIVE_DISPLAY_AD", "LEGACY_RESPONSIVE_DISPLAY_AD", "DEMAND_GEN_MULTI_ASSET_AD", "DISCOVERY_MULTI_ASSET_AD", "APP_AD", "HTML5_UPLOAD_AD", "LEGACY_APP_INSTALL_AD", "APP_ENGAGEMENT_AD"]);
const CAROUSEL_TYPES = new Set(["DEMAND_GEN_CAROUSEL_AD", "DISCOVERY_CAROUSEL_AD"]);

function formatOf(type: string | null): AdFormat {
  if (!type) return "Unknown";
  if (VIDEO_TYPES.has(type)) return "Video";
  if (CAROUSEL_TYPES.has(type)) return "Carousel";
  if (IMAGE_TYPES.has(type)) return "Image";
  if (TEXT_TYPES.has(type)) return "Text";
  return "Unknown";
}

const META_FIELDS = [
  "ad_group_ad.ad.id", "ad_group_ad.ad.name", "ad_group_ad.ad.type", "ad_group_ad.status", "ad_group_ad.ad.final_urls",
  "ad_group.id", "ad_group.name", "campaign.id", "campaign.name", "campaign.advertising_channel_type",
  "ad_group_ad.ad.responsive_search_ad.headlines", "ad_group_ad.ad.responsive_search_ad.descriptions",
  "ad_group_ad.ad.responsive_display_ad.headlines", "ad_group_ad.ad.responsive_display_ad.descriptions", "ad_group_ad.ad.responsive_display_ad.marketing_images", "ad_group_ad.ad.responsive_display_ad.youtube_videos",
  "ad_group_ad.ad.video_responsive_ad.headlines", "ad_group_ad.ad.video_responsive_ad.descriptions", "ad_group_ad.ad.video_responsive_ad.videos",
  "ad_group_ad.ad.demand_gen_video_responsive_ad.videos", "ad_group_ad.ad.demand_gen_video_responsive_ad.headlines", "ad_group_ad.ad.demand_gen_video_responsive_ad.descriptions",
  "ad_group_ad.ad.demand_gen_multi_asset_ad.marketing_images", "ad_group_ad.ad.demand_gen_multi_asset_ad.headlines", "ad_group_ad.ad.demand_gen_multi_asset_ad.descriptions",
  "ad_group_ad.ad.demand_gen_carousel_ad.headline",
  "ad_group_ad.ad.image_ad.image_url", "ad_group_ad.ad.video_ad.video.asset",
  "ad_group_ad.ad.app_ad.images", "ad_group_ad.ad.app_ad.youtube_videos", "ad_group_ad.ad.app_ad.headlines", "ad_group_ad.ad.app_ad.descriptions",
].join(", ");

function firstText(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const it of list) { const t = str(obj(it).text); if (t) return t; }
  return null;
}
function assetRefs(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((it) => str(obj(it).asset)).filter((x): x is string => !!x);
}

interface AssetInfo { imageUrl?: string; youtubeId?: string; text?: string }

async function resolveAssets(customerId: string, refs: string[]): Promise<Map<string, AssetInfo>> {
  const out = new Map<string, AssetInfo>();
  const ids = Array.from(new Set(refs)).map((r) => r.split("/").pop()!).filter(Boolean);
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    try {
      const rows = await gaql(customerId, `SELECT asset.resource_name, asset.id, asset.type, asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id, asset.text_asset.text FROM asset WHERE asset.id IN (${slice.join(",")})`);
      for (const r of rows) {
        const a = obj(r.asset);
        const key = str(a.resourceName) ?? "";
        out.set(key, { imageUrl: str(obj(obj(a.imageAsset).fullSize).url) ?? undefined, youtubeId: str(obj(a.youtubeVideoAsset).youtubeVideoId) ?? undefined, text: str(obj(a.textAsset).text) ?? undefined });
      }
    } catch (e) { console.warn("[ads-warehouse] google assets:", e instanceof Error ? e.message : e); }
  }
  return out;
}

function catalogFromRow(accountId: string, r: Row, assets: Map<string, AssetInfo>): CatalogRow {
  const aga = obj(r.adGroupAd), ad = obj(aga.ad), ag = obj(r.adGroup), camp = obj(r.campaign);
  const type = str(ad.type);
  const adId = String(ad.id ?? "");
  const rsa = obj(ad.responsiveSearchAd), rda = obj(ad.responsiveDisplayAd), vra = obj(ad.videoResponsiveAd), dgv = obj(ad.demandGenVideoResponsiveAd), dgm = obj(ad.demandGenMultiAssetAd), app = obj(ad.appAd), img = obj(ad.imageAd), vid = obj(ad.videoAd);
  const title = firstText(rsa.headlines) ?? firstText(rda.headlines) ?? firstText(vra.headlines) ?? firstText(dgv.headlines) ?? firstText(dgm.headlines) ?? firstText(app.headlines) ?? str(obj(ad.demandGenCarouselAd).headline) ?? null;
  const body = firstText(rsa.descriptions) ?? firstText(rda.descriptions) ?? firstText(vra.descriptions) ?? firstText(dgv.descriptions) ?? firstText(dgm.descriptions) ?? firstText(app.descriptions) ?? null;
  const imageRefs = [...assetRefs(rda.marketingImages), ...assetRefs(dgm.marketingImages), ...assetRefs(app.images)];
  const videoRefs = [...assetRefs(vra.videos), ...assetRefs(dgv.videos), ...assetRefs(rda.youtubeVideos), ...assetRefs(app.youtubeVideos), ...(str(obj(obj(vid).video).asset) ? [str(obj(obj(vid).video).asset)!] : [])];
  const imageUrl = str(img.imageUrl) ?? imageRefs.map((x) => assets.get(x)?.imageUrl).find(Boolean) ?? null;
  const youtubeId = videoRefs.map((x) => assets.get(x)?.youtubeId).find(Boolean) ?? null;
  const finalUrls = Array.isArray(ad.finalUrls) ? (ad.finalUrls as unknown[]).map(String) : [];
  // Search ads rarely carry a name: ad group + first headline keeps them tellable apart.
  const name = str(ad.name) ?? `${str(ag.name) ? str(ag.name) + " — " : ""}${title ?? type ?? "Annonce"} #${adId.slice(-5)}`;
  let format = formatOf(type);
  if (format === "Unknown" && youtubeId) format = "Video";
  if (format === "Unknown" && imageUrl) format = "Image";
  return {
    platform: "google", accountId, adId, name,
    status: str(aga.status), adsetId: str(ag.id), adsetName: str(ag.name), campaignId: str(camp.id), campaignName: str(camp.name),
    format, dynamic: false, creativeId: null,
    creativeKey: youtubeId ? `yt:${youtubeId}` : imageUrl ? `img:${imageUrl.split("/").pop()}` : null,
    thumbnailUrl: youtubeId ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : imageUrl, imageUrl,
    videoId: youtubeId, previewUrl: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : finalUrls[0] ?? null,
    title, body, cta: null, landingUrl: finalUrls[0] ?? null, createdTime: null, platformUpdatedAt: null,
    tags: parseNamingTags(name),
  };
}

export const googleAdapter: WarehouseAdapter = {
  platform: "google",

  async listAccounts() {
    const ids = new Set<string>();
    try {
      const { listGoogleAccounts } = await import("@/lib/cockpit/fetch");
      for (const a of await listGoogleAccounts()) if (a.active !== false && a.accountId) ids.add(a.accountId.replace(/-/g, ""));
    } catch (e) { console.warn("[ads-warehouse] Google account listing failed, dashboards only:", e instanceof Error ? e.message : e); }
    const rows = await prisma.dashboard.findMany({ where: { googleCustomerId: { not: null } }, select: { googleCustomerId: true }, distinct: ["googleCustomerId"] });
    for (const r of rows) { const id = (r.googleCustomerId ?? "").replace(/-/g, ""); if (id) ids.add(id); }
    return Array.from(ids);
  },

  async sync({ accountId, window, fullMetadata, knownAdIds, deadline }: AdapterSyncInput): Promise<AdapterSyncOutput> {
    const daily = new Map<string, DailyRow>();
    let currency: string | null = null;
    let truncated = false;
    const names = new Map<string, { adName: string; adsetId?: string; adsetName?: string; campaignId?: string; campaignName?: string }>();
    for (const sl of slices(window.since, window.until)) {
      if (Date.now() > deadline) { truncated = true; break; }
      const rows = await gaql(accountId, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group.id, ad_group.name, campaign.id, campaign.name, segments.date, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM ad_group_ad WHERE segments.date BETWEEN '${sl.since}' AND '${sl.until}' AND metrics.impressions > 0`);
      for (const r of rows) {
        const aga = obj(r.adGroupAd), ad = obj(aga.ad), m = obj(r.metrics), seg = obj(r.segments);
        const adId = String(ad.id ?? ""); const date = str(seg.date); if (!adId || !date) continue;
        currency = currency ?? str(obj(r.customer).currencyCode);
        const spend = costFrom(m), impressions = int(m.impressions), clicks = int(m.clicks), conv = num(m.conversions), val = num(m.conversionsValue ?? m.conversions_value);
        names.set(adId, { adName: str(ad.name) ?? adId, adsetId: str(obj(r.adGroup).id) ?? undefined, adsetName: str(obj(r.adGroup).name) ?? undefined, campaignId: str(obj(r.campaign).id) ?? undefined, campaignName: str(obj(r.campaign).name) ?? undefined });
        daily.set(`${adId}:${date}`, { platform: "google", accountId, adId, date, currency, spend, impressions, reach: 0, clicks, linkClicks: clicks, conversions: conv, conversionValue: val, purchases: conv, purchaseValue: val, leads: 0, videoPlays: 0, video3s: 0, thruPlays: 0, videoP25: 0, videoP50: 0, videoP75: 0, videoP100: 0, actions: {}, ...names.get(adId)! });
      }
      // Video metrics, best effort (the API refuses them on some accounts / channel types).
      try {
        // metrics.video_views is refused by the relay's client at ad level: the quartile rates (share of impressions) are enough.
        const vrows = await gaql(accountId, `SELECT ad_group_ad.ad.id, segments.date, metrics.impressions, metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate FROM ad_group_ad WHERE segments.date BETWEEN '${sl.since}' AND '${sl.until}' AND campaign.advertising_channel_type IN ('VIDEO','DEMAND_GEN','DISCOVERY') AND metrics.impressions > 0`);
        for (const r of vrows) {
          const adId = String(obj(obj(r.adGroupAd).ad).id ?? ""); const date = str(obj(r.segments).date); const m = obj(r.metrics);
          const row = adId && date ? daily.get(`${adId}:${date}`) : undefined; if (!row) continue;
          const impr = int(m.impressions) || row.impressions;
          row.videoP25 = Math.round(num(m.videoQuartileP25Rate) * impr); row.videoP50 = Math.round(num(m.videoQuartileP50Rate) * impr); row.videoP75 = Math.round(num(m.videoQuartileP75Rate) * impr); row.videoP100 = Math.round(num(m.videoQuartileP100Rate) * impr);
          row.videoPlays = row.videoP25; row.thruPlays = row.videoP100;
        }
      } catch (e) { console.warn("[ads-warehouse] google video metrics skipped:", e instanceof Error ? e.message.slice(0, 120) : e); }
    }
    const seen = Array.from(names.keys());
    const wanted = seen.filter((id) => fullMetadata || !knownAdIds.has(id));
    const catalog: CatalogRow[] = [];
    for (let i = 0; i < wanted.length; i += 100) {
      if (Date.now() > deadline) { truncated = true; break; }
      try {
        const rows = await gaql(accountId, `SELECT ${META_FIELDS} FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${wanted.slice(i, i + 100).join(",")})`);
        const refs: string[] = [];
        for (const r of rows) { const ad = obj(obj(r.adGroupAd).ad); for (const k of ["responsiveDisplayAd", "demandGenMultiAssetAd", "appAd", "videoResponsiveAd", "demandGenVideoResponsiveAd", "videoAd"]) { const o = obj(ad[k]); refs.push(...assetRefs(o.marketingImages), ...assetRefs(o.images), ...assetRefs(o.videos), ...assetRefs(o.youtubeVideos)); const va = str(obj(o.video).asset); if (va) refs.push(va); } }
        const assets = await resolveAssets(accountId, refs);
        for (const r of rows) catalog.push(catalogFromRow(accountId, r, assets));
      } catch (e) { console.warn("[ads-warehouse] google metadata:", e instanceof Error ? e.message.slice(0, 160) : e); truncated = true; }
    }
    return { daily: Array.from(daily.values()), catalog, truncated, currency };
  },
};
