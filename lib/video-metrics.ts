/**
 * Video-view metrics of the ad platforms (accounts run on a video-view
 * objective), client-safe. One key per metric; what each platform counts
 * behind it differs, and the labels say so:
 *
 *   video_views     Meta: 3-second video views (actions.video_view)
 *                   Google: TrueView views (metrics.video_trueview_views)
 *                   TikTok: 2-second video views (video_watched_2s)
 *   video_thruplay  Meta only: ThruPlay (video_thruplay_watched_actions)
 *   video_p25…p100  watched to 25 / 50 / 75 / 100 %:
 *                   Meta video_pXX_watched_actions, TikTok video_views_pXX (counts);
 *                   Google gives rates (metrics.video_quartile_pXX_rate) — the
 *                   count shown is impressions × rate, per row.
 */

export const VIDEO_METRICS = ["video_views", "video_thruplay", "video_p25", "video_p50", "video_p75", "video_p100"] as const;
export type VideoMetric = (typeof VIDEO_METRICS)[number];

export const VIDEO_METRIC_LABELS: Record<VideoMetric, string> = {
  video_views: "Vues vidéo",
  video_thruplay: "ThruPlay",
  video_p25: "Vidéo vue à 25 %",
  video_p50: "Vidéo vue à 50 %",
  video_p75: "Vidéo vue à 75 %",
  video_p100: "Vidéo vue à 100 %",
};

/** What "Vues vidéo" counts on each platform (shown under the figure). */
export const VIDEO_VIEWS_DEFINITION: Record<"meta" | "google" | "tiktok", string> = {
  meta: "vues 3 s",
  google: "vues TrueView",
  tiktok: "vues 2 s",
};

export function isVideoMetric(metric: string): metric is VideoMetric {
  return (VIDEO_METRICS as readonly string[]).includes(metric);
}

/** Platforms that provide the metric (ThruPlay is Meta's own). */
export function videoMetricPlatforms(metric: VideoMetric): Array<"meta" | "google" | "tiktok"> {
  return metric === "video_thruplay" ? ["meta"] : ["meta", "google", "tiktok"];
}

/** One-line note for a video KPI: what the figure counts, per platform in the sum. */
export function videoMetricNote(metric: string, platforms: string[]): string | null {
  if (!isVideoMetric(metric)) return null;
  if (metric === "video_thruplay") return "Meta : vidéo vue en entier ou ≥ 15 s";
  if (metric === "video_views") {
    const parts = platforms
      .filter((p): p is "meta" | "google" | "tiktok" => p === "meta" || p === "google" || p === "tiktok")
      .map((p) => `${p === "meta" ? "Meta" : p === "google" ? "Google" : "TikTok"} : ${VIDEO_VIEWS_DEFINITION[p]}`);
    return parts.length ? parts.join(" · ") : null;
  }
  return platforms.includes("google") ? "Google : impressions × taux de visionnage" : null;
}

/** Google Ads: a quartile count from its rate (0–1 or 0–100) and the impressions. */
export function googleQuartileCount(rate: unknown, impressions: number): number {
  const r = typeof rate === "number" ? rate : typeof rate === "string" ? Number(rate) : 0;
  if (!Number.isFinite(r) || r <= 0 || impressions <= 0) return 0;
  // The API gives a fraction; a value above 1 can only be a percentage.
  return impressions * (r > 1 ? r / 100 : r);
}

/** Meta: the value of a `*_watched_actions` list (one row, action_type video_view). */
export function metaActionListValue(list: Array<{ action_type?: string; value?: string | number }> | undefined): number {
  if (!Array.isArray(list)) return 0;
  let total = 0;
  for (const x of list) {
    const n = typeof x?.value === "number" ? x.value : Number(x?.value ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}
