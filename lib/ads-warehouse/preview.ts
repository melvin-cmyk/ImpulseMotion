/**
 * Ad previews for Analyse Ads v2 — the official platform preview iframe of an
 * ad (Meta: GET /{ad_id}/previews?ad_format=…), which plays videos even when
 * the video object itself is not readable by the system user (the common
 * case: the video belongs to the client's Page). Cached 12 h (Meta signs the
 * iframe URL for 24 h). Formats mirror Motion's placement previews.
 */

import { metaGraphGet, getMetaSystemToken, getVideoSources } from "@/lib/meta-api";
import { cached } from "@/lib/kpi-cache";

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

/** Direct MP4 of a video when Meta lets the system user read it (best effort, null otherwise). */
export async function getMetaVideoSource(videoId: string): Promise<string | null> {
  return cached(`ads:video:meta:${videoId}`, async () => {
    const token = getMetaSystemToken();
    const map = await getVideoSources(token, [videoId]).catch(() => new Map<string, string>());
    return map.get(videoId) ?? null;
  }, { ttlMs: TTL_MS });
}
