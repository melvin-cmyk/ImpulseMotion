/**
 * Ad previews for Analyse Ads v2 — the official platform preview iframe of an
 * ad (Meta: GET /{ad_id}/previews?ad_format=…), which plays videos even when
 * the video object itself is not readable by the system user (the common
 * case: the video belongs to the client's Page). Cached 12 h (Meta signs the
 * iframe URL for 24 h). Formats mirror Motion's placement previews.
 */

import { metaGraphGet, getMetaSystemToken, getVideoSources } from "@/lib/meta-api";
import { cached } from "@/lib/kpi-cache";
import { prisma } from "@/lib/prisma";
import { fbcdnUsable, fetchLargeThumbnails } from "./meta";

export const META_PREVIEW_FORMATS = ["MOBILE_FEED_STANDARD", "INSTAGRAM_STANDARD", "INSTAGRAM_STORY", "INSTAGRAM_REELS", "DESKTOP_FEED_STANDARD"] as const;
export type MetaPreviewFormat = (typeof META_PREVIEW_FORMATS)[number];
export const META_PREVIEW_LABELS: Record<MetaPreviewFormat, string> = {
  MOBILE_FEED_STANDARD: "Feed Facebook",
  INSTAGRAM_STANDARD: "Feed Instagram",
  INSTAGRAM_STORY: "Story",
  INSTAGRAM_REELS: "Reels",
  DESKTOP_FEED_STANDARD: "Bureau",
};

export interface AdPreview {
  src: string | null;
  width: number | null;
  height: number | null;
  format: MetaPreviewFormat;
}

const TTL_MS = 12 * 3600 * 1000;

export async function getMetaAdPreview(adId: string, format: MetaPreviewFormat): Promise<AdPreview> {
  return cached(`ads:preview:meta:${adId}:${format}`, async () => {
    const token = getMetaSystemToken();
    const res = await metaGraphGet<{ data?: Array<{ body?: string }> }>(`/${adId}/previews`, token, { ad_format: format });
    const body = res.data?.[0]?.body ?? "";
    const src = body.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null;
    const width = Number(body.match(/width="(\d+)"/)?.[1] ?? 0) || null;
    const height = Number(body.match(/height="(\d+)"/)?.[1] ?? 0) || null;
    return { src, width, height, format };
  }, { ttlMs: TTL_MS });
}

/**
 * Page access tokens of the Pages assigned to the system user (/me/accounts),
 * kept in memory only (never stored), 10 min. A video is readable with the
 * token of the Page that owns it, not with the system user's own token.
 */
let pageTokenCache: { at: number; map: Map<string, string> } | null = null;
async function pageTokens(): Promise<Map<string, string>> {
  if (pageTokenCache && Date.now() - pageTokenCache.at < 10 * 60_000) return pageTokenCache.map;
  const map = new Map<string, string>();
  const res = await metaGraphGet<{ data?: Array<{ id?: string; access_token?: string }> }>("/me/accounts", getMetaSystemToken(), { fields: "id,access_token", limit: "200" }).catch(() => null);
  for (const p of res?.data ?? []) if (p.id && p.access_token) map.set(p.id, p.access_token);
  pageTokenCache = { at: Date.now(), map };
  return map;
}

/**
 * Direct MP4 of a video (Motion's inline card player): with the token of the
 * Page that published the ad (found through the ad's story id) when that Page
 * is assigned to the system user, else /{video_id}?fields=source and the ad
 * account's video library. Null when Meta refuses. The CDN URL is signed for
 * several days; cached 12 h.
 */
export async function getMetaVideoSource(videoId: string, accountId?: string | null, adId?: string | null): Promise<string | null> {
  // Only found files are cached: a refusal may be lifted (Page newly assigned to the system user).
  return cached(`ads:video3:meta:${videoId}`, async () => {
    const found = await resolveVideoSource(videoId, accountId, adId);
    if (!found) throw new Error("no-video-source");
    return found;
  }, { ttlMs: TTL_MS }).catch(() => null);
}

async function resolveVideoSource(videoId: string, accountId?: string | null, adId?: string | null): Promise<string | null> {
  {
    const token = getMetaSystemToken();
    if (adId) {
      const ad = await metaGraphGet<{ creative?: { effective_object_story_id?: string } }>(`/${adId}`, token, { fields: "creative{effective_object_story_id}" }).catch(() => null);
      const pageId = ad?.creative?.effective_object_story_id?.split("_")[0];
      const pageToken = pageId ? (await pageTokens()).get(pageId) : undefined;
      if (pageToken) {
        const v = await metaGraphGet<{ source?: string }>(`/${videoId}`, pageToken, { fields: "source" }).catch(() => null);
        if (v?.source) return v.source;
      }
    }
    const map = await getVideoSources(token, [videoId]).catch(() => new Map<string, string>());
    const direct = map.get(videoId);
    if (direct) return direct;
    if (!accountId) return null;
    const res = await metaGraphGet<{ data?: Array<{ id?: string; source?: string }> }>(`/act_${accountId.replace(/^act_/, "")}/advideos`, token, {
      fields: "id,source",
      filtering: JSON.stringify([{ field: "id", operator: "IN", value: [videoId] }]),
    }).catch(() => null);
    return res?.data?.find((v) => v.id === videoId)?.source ?? null;
  }
}

/**
 * Usable image of a catalogued Meta ad. Stored CDN URLs expire about 5 days
 * after the sync that read them; when both the full visual and the thumbnail
 * are expired, re-read the creative's 1200 px thumbnail and store it back, so
 * the next views use the fresh URL directly.
 */
export async function freshMetaAdImage(adId: string): Promise<{ accountId: string; url: string | null } | null> {
  const row = await prisma.adCatalog.findUnique({ where: { id: `meta:${adId}` }, select: { accountId: true, imageUrl: true, thumbnailUrl: true, creativeId: true } });
  if (!row) return null;
  if (fbcdnUsable(row.imageUrl)) return { accountId: row.accountId, url: row.imageUrl };
  if (fbcdnUsable(row.thumbnailUrl)) return { accountId: row.accountId, url: row.thumbnailUrl };
  if (!row.creativeId) return { accountId: row.accountId, url: null };
  const got = await fetchLargeThumbnails(getMetaSystemToken(), [row.creativeId]).catch(() => new Map<string, string>());
  const url = got.get(row.creativeId) ?? null;
  if (url) await prisma.adCatalog.update({ where: { id: `meta:${adId}` }, data: { thumbnailUrl: url, imageUrl: null } }).catch(() => {});
  return { accountId: row.accountId, url };
}
