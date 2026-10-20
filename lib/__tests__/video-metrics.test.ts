import { describe, expect, it } from "vitest";
import { googleQuartileCount, isVideoMetric, metaActionListValue, videoMetricNote, videoMetricPlatforms, VIDEO_METRICS } from "@/lib/video-metrics";
import { KPI_METRICS, SERIES_METRICS, validateWidgetConfig } from "@/lib/dashboard-types";
import { googleVideoOf, metaVideoValue } from "@/lib/dashboard-widgets";
import { tiktokMetric } from "@/lib/tiktok-dashboard";
import { emptyTikTokStats, statsOf } from "@/lib/tiktok-data";

describe("métriques vidéo — catalogue", () => {
  it("sont des métriques de KPI et de courbe, validées par les widgets", () => {
    for (const m of VIDEO_METRICS) {
      expect(KPI_METRICS).toContain(m);
      expect(SERIES_METRICS).toContain(m);
      expect(validateWidgetConfig("kpi", { metric: m, source: "tiktok" })).toEqual({ metric: m, source: "tiktok" });
      expect(validateWidgetConfig("timeseries", { metric: m, source: "google" })).toEqual({ metric: m, source: "google" });
    }
    expect(isVideoMetric("spend")).toBe(false);
    expect(videoMetricPlatforms("video_thruplay")).toEqual(["meta"]);
    expect(videoMetricPlatforms("video_p50")).toEqual(["meta", "google", "tiktok"]);
  });

  it("dit ce que compte « Vues vidéo » sur chaque plateforme", () => {
    expect(videoMetricNote("video_views", ["meta", "tiktok"])).toBe("Meta : vues 3 s · TikTok : vues 2 s");
    expect(videoMetricNote("video_p25", ["google"])).toContain("impressions × taux");
    expect(videoMetricNote("video_p25", ["meta"])).toBeNull();
    expect(videoMetricNote("spend", ["meta"])).toBeNull();
  });
});

describe("métriques vidéo — Meta", () => {
  const insight = {
    account_id: "1", spend: "10", impressions: "1000", clicks: "10", ctr: "1", cpm: "10", date_start: "2026-10-01", date_stop: "2026-10-07",
    actions: [{ action_type: "link_click", value: "10" }, { action_type: "video_view", value: "420" }],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: "150" }],
    video_p25_watched_actions: [{ action_type: "video_view", value: "300" }],
    video_p100_watched_actions: [{ action_type: "video_view", value: "60" }],
  };
  it("lit les vues 3 s dans actions, ThruPlay et quartiles dans leurs listes", () => {
    expect(metaVideoValue(insight, "video_views")).toBe(420);
    expect(metaVideoValue(insight, "video_thruplay")).toBe(150);
    expect(metaVideoValue(insight, "video_p25")).toBe(300);
    expect(metaVideoValue(insight, "video_p50")).toBe(0);
    expect(metaVideoValue(insight, "video_p100")).toBe(60);
    expect(metaActionListValue(undefined)).toBe(0);
    expect(metaActionListValue([{ action_type: "video_view", value: "x" }])).toBe(0);
  });
});

describe("métriques vidéo — Google Ads", () => {
  it("prend les vues TrueView telles quelles et calcule les quartiles depuis les taux", () => {
    expect(googleQuartileCount(0.25, 1000)).toBe(250);
    expect(googleQuartileCount("40", 1000)).toBe(400); // a percentage
    expect(googleQuartileCount(0.5, 0)).toBe(0);
    expect(googleQuartileCount(null, 1000)).toBe(0);
    const v = googleVideoOf({ impressions: 2000, videoTrueviewViews: "800", videoQuartileP25Rate: 0.5, video_quartile_p100_rate: 0.1 });
    expect(v).toEqual({ video_views: 800, video_thruplay: 0, video_p25: 1000, video_p50: 0, video_p75: 0, video_p100: 200 });
  });
});

describe("métriques vidéo — TikTok", () => {
  it("lit les vues 2 s et les quartiles du rapport, ThruPlay reste à Meta", () => {
    const s = statsOf({ metrics: { spend: "10", impressions: "1000", video_play_actions: "900", video_watched_2s: "500", video_views_p25: "400", video_views_p50: "300", video_views_p75: "200", video_views_p100: "100" } });
    expect(s).toMatchObject({ videoViews: 900, videoViews2s: 500, videoP25: 400, videoP50: 300, videoP75: 200, videoP100: 100 });
    expect(tiktokMetric(s, "video_views")).toBe(500);
    expect(tiktokMetric(s, "video_p75")).toBe(200);
    expect(tiktokMetric(s, "video_thruplay")).toBe(0);
    expect(Object.keys(emptyTikTokStats())).toEqual(expect.arrayContaining(["videoViews2s", "videoP25", "videoP100"]));
  });
});
