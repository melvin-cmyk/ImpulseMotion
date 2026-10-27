/**
 * Meta adapter of the creative warehouse.
 *
 * sync(window):
 *   1. ONE paged call /act/insights level=ad time_increment=1 with the rich
 *      field set (reach, link clicks, actions, values, video quartiles) →
 *      DailyRow per ad × day (rows with neither spend nor impression are dropped);
 *   2. ads metadata /act/ads?fields=…creative{…} — every ad on the first sync
 *      and on the weekly full refresh, otherwise only `updated_since` the
 *      previous run, PLUS every ad seen in the window that the catalogue does
 *      not know yet (metadata is what gives the thumbnail, copy, format);
 *   3. conversions follow the account's configured conversion event
 *      (AccountSetting.conversionEvent via getAccountProfileSettings), the
 *      purchase columns are always the purchase family, leads always "lead".
 */

import { prisma } from "@/lib/prisma";
import {
  getMetaSystemToken,
  getAdDailyInsightsRichPaged,
  metaGraphGet,
  purchasesFor,
  computeRevenue,
  getActionValue,
  type MetaAd,
  type MetaCreativeInsightRich,
} from "@/lib/meta-api";
import { MetaApiError } from "@/lib/meta-errors";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { parseNamingTags } from "./naming";
import type { AdFormat, AdapterSyncInput, AdapterSyncOutput, CatalogRow, DailyRow, WarehouseAdapter } from "./types";

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};
const int = (v: unknown) => Math.round(num(v));

const ADS_META_FIELDS = [
  "id", "name", "status", "effective_status", "created_time", "updated_time",
  "adset{id,name}", "campaign{id,name}",
  "creative{id,thumbnail_url,image_url,video_id,object_type,image_hash,body,title,"
    + "object_story_spec{link_data{link,message,name,description,call_to_action,picture,image_hash,child_attachments{link,name,picture,image_hash,video_id}},"
    + "video_data{link_description,title,message,call_to_action,image_url,image_hash,video_id}},"
    + "asset_feed_spec{bodies,titles,descriptions,link_urls,images{hash,url},videos{video_id,thumbnail_url}}}",
].join(",");
const ADS_PAGE_LIMIT = 100;
const ADS_MAX = 10000;
const isTooMuchData = (e: unknown) => e instanceof MetaApiError && /reduce the amount of data/i.test(e.message);

type MetaAdX = MetaAd & {
  creative?: MetaAd["creative"] & {
    asset_feed_spec?: NonNullable<MetaAd["creative"]>["asset_feed_spec"] & { images?: Array<{ hash?: string; url?: string }>; videos?: Array<{ video_id?: string; thumbnail_url?: string }> };
    object_story_spec?: NonNullable<MetaAd["creative"]>["object_story_spec"] & {
      link_data?: { picture?: string; image_hash?: string; child_attachments?: Array<{ picture?: string; image_hash?: string; video_id?: string }> };
      video_data?: { image_url?: string; image_hash?: string; video_id?: string };
    };
  };
};

/** Large preview of creatives: GET /?ids=…&fields=thumbnail_url&thumbnail_width=1200&thumbnail_height=1200 (the plain thumbnail_url is 64 px). */
const THUMB_BATCH = 50;
export async function fetchLargeThumbnails(token: string, creativeIds: string[], deadline = Date.now() + 120_000): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(creativeIds.filter(Boolean)));
  for (let i = 0; i < ids.length; i += THUMB_BATCH) {
    if (Date.now() > deadline) break;
    const slice = ids.slice(i, i + THUMB_BATCH);
    try {
      const r = await metaGraphGet<Record<string, { thumbnail_url?: string }>>("/", token, { ids: slice.join(","), fields: "thumbnail_url", thumbnail_width: "1200", thumbnail_height: "1200" });
      for (const [id, v] of Object.entries(r)) if (v?.thumbnail_url) out.set(id, v.thumbnail_url);
    } catch (e) {
      // One bad id fails the whole batch: retry one by one, best effort.
      if (slice.length > 1 && Date.now() < deadline) for (const id of slice) {
        try {
          const v = await metaGraphGet<{ thumbnail_url?: string }>(`/${id}`, token, { fields: "thumbnail_url", thumbnail_width: "1200", thumbnail_height: "1200" });
          if (v?.thumbnail_url) out.set(id, v.thumbnail_url);
        } catch { /* skip */ }
      } else console.warn("[ads-warehouse] large thumbnails:", e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** Re-read the large previews of an account's catalogue (one-off backfill of rows stored with 64 px thumbnails). */
export async function refreshThumbnails(accountId: string, deadline = Date.now() + 10 * 60_000): Promise<number> {
  const token = getMetaSystemToken();
  const rows = await prisma.adCatalog.findMany({ where: { platform: "meta", accountId, creativeId: { not: null } }, select: { id: true, creativeId: true } });
  const large = await fetchLargeThumbnails(token, rows.map((r) => r.creativeId!), deadline);
  let n = 0;
  for (const r of rows) {
    const url = large.get(r.creativeId!);
    if (!url) continue;
    await prisma.adCatalog.update({ where: { id: r.id }, data: { thumbnailUrl: url } });
    n += 1;
  }
  return n;
}

/** Ads with creative metadata, cursor-paged (page size halves on "reduce the amount of data"). */
async function fetchAds(token: string, accountId: string, opts: { updatedSince?: Date | null; ids?: string[] | null; deadline: number }): Promise<{ ads: MetaAdX[]; truncated: boolean }> {
  const out: MetaAdX[] = [];
  let after: string | undefined;
  let limit = ADS_PAGE_LIMIT;
  let truncated = false;
  const base: Record<string, string> = { fields: ADS_META_FIELDS };
  if (opts.updatedSince) base.updated_since = String(Math.floor(opts.updatedSince.getTime() / 1000));
  if (opts.ids && opts.ids.length) base.filtering = JSON.stringify([{ field: "ad.id", operator: "IN", value: opts.ids }]);
  for (let page = 0; page < 200; page++) {
    if (Date.now() > opts.deadline) { truncated = true; break; }
    const params: Record<string, string> = { ...base, limit: String(limit) };
    if (after) params.after = after;
    let res: { data?: MetaAdX[]; paging?: { cursors?: { after?: string }; next?: string } };
    try {
      res = await metaGraphGet<typeof res>(`/act_${accountId}/ads`, token, params);
    } catch (e) {
      if (isTooMuchData(e) && limit > 25) { limit = Math.max(25, Math.floor(limit / 2)); page--; continue; }
      throw e;
    }
    out.push(...(Array.isArray(res.data) ? res.data : []));
    const next = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!next) break;
    if (out.length >= ADS_MAX) { truncated = true; break; }
    after = next;
  }
  return { ads: out, truncated };
}

function firstText(list?: Array<{ text?: string }>): string | undefined {
  return list?.find((t) => t.text?.trim())?.text?.trim();
}

/** Visual asset type (Motion's "ad type"); `dynamic` is carried separately. */
function formatOf(ad: MetaAdX): AdFormat {
  const c = ad.creative;
  if (!c) return "Unknown";
  const link = c.object_story_spec?.link_data;
  if (Array.isArray(link?.child_attachments) && link.child_attachments.length > 1) return "Carousel";
  const feed = c.asset_feed_spec;
  if (c.video_id || c.object_type === "VIDEO" || c.object_story_spec?.video_data || (feed?.videos?.length ?? 0) > 0) return "Video";
  if (c.image_hash || c.image_url || c.object_type === "PHOTO" || c.object_type === "SHARE" || (feed?.images?.length ?? 0) > 0) return "Image";
  if (c.thumbnail_url) return "Image";
  return "Unknown";
}

/** Dynamic creative / Advantage+ creative: several text or asset variants in one ad. */
function isDynamic(ad: MetaAdX): boolean {
  const feed = ad.creative?.asset_feed_spec;
  if (!feed) return false;
  return Math.max(feed.bodies?.length ?? 0, feed.titles?.length ?? 0, feed.images?.length ?? 0, feed.videos?.length ?? 0, feed.link_urls?.length ?? 0) > 1;
}

function catalogFromAd(accountId: string, ad: MetaAdX): CatalogRow {
  const c = ad.creative;
  const link = c?.object_story_spec?.link_data;
  const video = c?.object_story_spec?.video_data;
  const feed = c?.asset_feed_spec;
  const cta = link?.call_to_action?.type ?? video?.call_to_action?.type ?? null;
  const landingUrl = link?.link ?? link?.call_to_action?.value?.link ?? video?.call_to_action?.value?.link ?? feed?.link_urls?.find((l) => l.website_url)?.website_url ?? null;
  const feedVideo = feed?.videos?.find((v) => v.video_id)?.video_id ?? null;
  const feedImage = feed?.images?.find((im) => im.hash || im.url) ?? null;
  const child = link?.child_attachments?.[0];
  const videoId = c?.video_id ?? video?.video_id ?? feedVideo ?? child?.video_id ?? null;
  const imageHash = c?.image_hash ?? video?.image_hash ?? link?.image_hash ?? feedImage?.hash ?? child?.image_hash ?? null;
  // Full-size asset when the creative spec carries one (classic image, video cover, carousel first card, dynamic image).
  const fullImage = c?.image_url ?? video?.image_url ?? feedImage?.url ?? link?.picture ?? child?.picture ?? null;
  const creativeKey = videoId ? `v:${videoId}` : imageHash ? `i:${imageHash}` : c?.id ? `c:${c.id}` : null;
  return {
    platform: "meta",
    accountId,
    adId: ad.id,
    name: ad.name ?? ad.id,
    status: ad.effective_status ?? ad.status ?? null,
    adsetId: ad.adset?.id ?? null,
    adsetName: ad.adset?.name ?? null,
    campaignId: ad.campaign?.id ?? null,
    campaignName: ad.campaign?.name ?? null,
    format: formatOf(ad),
    dynamic: isDynamic(ad),
    creativeId: c?.id ?? null,
    creativeKey,
    thumbnailUrl: c?.thumbnail_url ?? feed?.videos?.find((v) => v.thumbnail_url)?.thumbnail_url ?? null,
    imageUrl: fullImage,
    videoId,
    previewUrl: `https://www.facebook.com/ads/library/?id=${ad.id}`,
    title: c?.title ?? link?.name ?? video?.title ?? firstText(feed?.titles) ?? null,
    body: c?.body ?? link?.message ?? video?.message ?? firstText(feed?.bodies) ?? null,
    cta,
    landingUrl,
    createdTime: ad.created_time ? new Date(ad.created_time) : null,
    platformUpdatedAt: ad.updated_time ? new Date(ad.updated_time) : null,
    tags: parseNamingTags(ad.name),
  };
}

/** Action types worth keeping per day (compact JSON) — conversions can be re-derived from them. */
const KEEP_ACTIONS = new Set([
  "purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "onsite_web_app_purchase",
  "lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "onsite_web_lead",
  "complete_registration", "offsite_conversion.fb_pixel_complete_registration",
  "add_to_cart", "omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart",
  "initiate_checkout", "omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout",
  "landing_page_view", "link_click", "post_engagement", "video_view", "onsite_conversion.messaging_conversation_started_7d",
  "subscribe", "schedule", "contact", "start_trial", "app_install", "omni_app_install",
]);

function dailyFromInsight(accountId: string, i: MetaCreativeInsightRich, conversionEvent: string): DailyRow | null {
  const spend = num(i.spend);
  const impressions = int(i.impressions);
  if (spend <= 0 && impressions <= 0) return null;
  const actions: Record<string, number> = {};
  for (const a of i.actions ?? []) {
    if (KEEP_ACTIONS.has(a.action_type) || a.action_type.startsWith("offsite_conversion.custom.")) {
      const v = num(a.value);
      if (v > 0) actions[a.action_type] = v;
    }
  }
  const tracked = computeRevenue(i, null, "purchase");
  const purchaseValue = tracked.estimated ? 0 : tracked.revenue;
  const purchases = purchasesFor(i, "purchase");
  const conversions = purchasesFor(i, conversionEvent);
  let conversionValue = 0;
  if (conversionEvent === "purchase") conversionValue = purchaseValue;
  else if (conversionEvent.startsWith("custom:")) conversionValue = getActionValue(i.action_values, conversionEvent.slice(7));
  else conversionValue = getActionValue(i.action_values, conversionEvent);
  const first = (list?: Array<{ action_type: string; value: string }>) => int(list?.[0]?.value);
  return {
    platform: "meta",
    accountId,
    adId: i.ad_id,
    date: i.date_start,
    currency: i.account_currency ?? null,
    spend,
    impressions,
    reach: int(i.reach),
    clicks: int(i.clicks),
    linkClicks: int(i.inline_link_clicks),
    conversions,
    conversionValue,
    purchases,
    purchaseValue,
    leads: purchasesFor(i, "lead"),
    videoPlays: first(i.video_play_actions),
    video3s: int(i.actions?.find((a) => a.action_type === "video_view")?.value),
    thruPlays: first(i.video_thruplay_watched_actions),
    videoP25: first(i.video_p25_watched_actions),
    videoP50: first(i.video_p50_watched_actions),
    videoP75: first(i.video_p75_watched_actions),
    videoP100: first(i.video_p100_watched_actions),
    actions,
    adName: i.ad_name,
    adsetId: i.adset_id,
    adsetName: i.adset_name,
    campaignId: i.campaign_id,
    campaignName: i.campaign_name,
  };
}

export const metaAdapter: WarehouseAdapter = {
  platform: "meta",

  /** Every ACTIVE Meta account the system token can read (the agency's whole portfolio) ∪ the dashboards' accounts. */
  async listAccounts() {
    const ids = new Set<string>();
    try {
      const { listMetaAccounts } = await import("@/lib/cockpit/fetch");
      for (const a of await listMetaAccounts()) if (a.active !== false && a.accountId) ids.add(a.accountId);
    } catch (e) {
      console.warn("[ads-warehouse] Meta account listing failed, dashboards only:", e instanceof Error ? e.message : e);
    }
    const rows = await prisma.dashboard.findMany({ where: { metaAccountId: { not: null } }, select: { metaAccountId: true }, distinct: ["metaAccountId"] });
    for (const r of rows) { const id = (r.metaAccountId ?? "").replace(/^act_/, ""); if (id) ids.add(id); }
    return Array.from(ids);
  },

  async sync({ accountId, window, fullMetadata, metadataSince, knownAdIds, deadline }: AdapterSyncInput): Promise<AdapterSyncOutput> {
    const token = getMetaSystemToken();
    const settings = await getAccountProfileSettings("meta", accountId);
    const insights = await getAdDailyInsightsRichPaged(token, accountId, window);
    const daily: DailyRow[] = [];
    const seen = new Set<string>();
    for (const i of insights.data) {
      const row = dailyFromInsight(accountId, i, settings.conversionEvent);
      if (!row) continue;
      daily.push(row);
      seen.add(row.adId);
    }
    // Account left on the default "purchase" event (Admin → Comptes not filled)
    // that has NEVER recorded a purchase, in this window nor in its stored
    // history: its conversions are its leads. The decision is account-wide so
    // every window agrees; an explicit setting is always honoured, and
    // changing it in the admin re-syncs the account (resync).
    if (settings.conversionEvent === "purchase") {
      const purchases = daily.reduce((a, d) => a + d.purchases, 0);
      const leads = daily.reduce((a, d) => a + d.leads, 0);
      if (purchases === 0 && leads > 0) {
        const hist = await prisma.adDaily.aggregate({ where: { platform: "meta", accountId }, _sum: { purchases: true } });
        if ((hist._sum.purchases ?? 0) === 0) for (const d of daily) { d.conversions = d.leads; d.conversionValue = 0; }
      }
    }

    // Metadata — only for ads that delivered in the window: all of them on the
    // weekly refresh, otherwise the unknown ones + the ones Meta says changed.
    const ads: MetaAdX[] = [];
    let truncated = insights.truncated;
    const got = new Set<string>();
    if (!fullMetadata && metadataSince) {
      const r = await fetchAds(token, accountId, { updatedSince: metadataSince, deadline });
      for (const a of r.ads) { ads.push(a); got.add(a.id); }
      truncated = truncated || r.truncated;
    }
    const wanted = Array.from(seen).filter((id) => !got.has(id) && (fullMetadata || !knownAdIds.has(id)));
    for (let i = 0; i < wanted.length; i += 50) {
      if (Date.now() > deadline) { truncated = true; break; }
      const r = await fetchAds(token, accountId, { ids: wanted.slice(i, i + 50), deadline });
      ads.push(...r.ads);
    }
    const catalog = ads.map((a) => catalogFromAd(accountId, a));
    // The creative's plain thumbnail_url is 64 px: replace it by the 1200 px rendition for every row.
    const large = await fetchLargeThumbnails(token, catalog.map((r) => r.creativeId ?? ""), deadline);
    for (const r of catalog) if (r.creativeId && large.has(r.creativeId)) r.thumbnailUrl = large.get(r.creativeId)!;
    return { daily, catalog, truncated, currency: settings.currency ?? daily.find((d) => d.currency)?.currency ?? null };
  },
};
