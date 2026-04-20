import { auth } from "@/auth";
import {
  getAds,
  getAdInsights,
  getAdDailyInsights,
  getCampaigns,
  getVideoSources,
  getVideoSourcesViaAdCreatives,
  computeRoas,
  computeCpa,
  computeHookRate,
  computeHoldRate,
  computeVideoDropoff,
} from "@/lib/meta-api";
import { Creative, DayMetric, Status } from "@/lib/mock-data";
import { upgradeImageUrl } from "@/lib/image-upgrade";
import { NextRequest, NextResponse } from "next/server";

function determineStatus(roas: number, ctr: number, hookRate: number): Status {
  if (roas >= 4 && ctr >= 2.5) return "Winner";
  if (roas <= 1.5 || ctr <= 0.8) return "Loser";
  if (hookRate < 20) return "Fatigued";
  return "Active";
}

const THUMBNAIL_COLORS = [
  "from-violet-500 to-purple-700",
  "from-blue-500 to-cyan-600",
  "from-pink-500 to-rose-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-indigo-500 to-violet-600",
];

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session || !session.metaAccessToken) {
    return NextResponse.json({ error: "Not authenticated with Meta" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const adAccountId = searchParams.get("accountId");
  const since = searchParams.get("since") ?? undefined;
  const until = searchParams.get("until") ?? undefined;
  const campaignId = searchParams.get("campaignId") ?? undefined;
  const campaignStatus = searchParams.get("campaignStatus") ?? undefined;

  if (!adAccountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  try {
    const accessToken = session.metaAccessToken as string;
    const [ads, insights, allCampaigns] = await Promise.all([
      getAds(accessToken, adAccountId),
      getAdInsights(accessToken, adAccountId, since && until ? { since, until } : undefined),
      campaignStatus ? getCampaigns(accessToken, adAccountId) : Promise.resolve([]),
    ]);

    // Build a set of campaign IDs matching the requested status filter
    const statusFilteredCampaignIds: Set<string> | null = campaignStatus
      ? new Set(
          allCampaigns
            .filter((c) => c.status === campaignStatus)
            .map((c) => c.id)
        )
      : null;

    const insightMap = new Map(insights.map((i) => [i.ad_id, i]));
    // Filter to ads that have insight data, and optionally by campaign / status
    const filteredAds = ads.filter((ad) => {
      if (!insightMap.has(ad.id)) return false;
      const insight = insightMap.get(ad.id)!;
      if (campaignId && insight.campaign_id !== campaignId) return false;
      if (statusFilteredCampaignIds && !statusFilteredCampaignIds.has(insight.campaign_id)) {
        return false;
      }
      return true;
    });

    // Batch-fetch video source URLs for all video creatives.
    // Primary path: GET /{video_id}?fields=source
    const videoIds = filteredAds
      .map((ad) => ad.creative?.video_id)
      .filter((id): id is string => Boolean(id));

    const videoSourceMap = await getVideoSources(accessToken, videoIds);

    // Fallback path: for video ads whose source URL is still missing, try the
    // adcreatives edge: GET /{ad_id}/adcreatives?fields=video_data
    const adsWithMissingVideoSource = filteredAds.filter((ad) => {
      const videoId = ad.creative?.video_id;
      return videoId && !videoSourceMap.get(videoId);
    });

    if (adsWithMissingVideoSource.length > 0) {
      console.warn(
        `[creatives route] ${adsWithMissingVideoSource.length} video ad(s) had no source URL from primary fetch; trying adcreatives fallback`
      );
      const fallbackMap = await getVideoSourcesViaAdCreatives(
        accessToken,
        adsWithMissingVideoSource.map((ad) => ad.id)
      );
      // Merge fallback results into the primary map
      for (const [videoId, src] of fallbackMap) {
        if (!videoSourceMap.has(videoId)) {
          videoSourceMap.set(videoId, src);
        }
      }
    }

    // Fetch 14 days of daily data for all ads in parallel (for trend sparklines)
    const dailyInsightsResults = await Promise.allSettled(
      filteredAds.map((ad) => getAdDailyInsights(accessToken, ad.id, 14))
    );
    const dailyInsightsMap = new Map<string, DayMetric[]>();
    filteredAds.forEach((ad, idx) => {
      const result = dailyInsightsResults[idx];
      if (result.status === "fulfilled" && result.value.length > 0) {
        dailyInsightsMap.set(
          ad.id,
          result.value.map((d) => {
            const daySpend = parseFloat(d.spend ?? "0");
            const dayImpressions = parseInt(d.impressions ?? "0", 10);
            const dayClicks = parseInt(d.clicks ?? "0", 10);
            const dayRoas = computeRoas(d);
            const dayCpa = computeCpa(d);
            const dayConversions = Math.round(daySpend > 0 && dayCpa > 0 ? daySpend / dayCpa : 0);
            return {
              date: d.date_start,
              spend: Math.round(daySpend),
              roas: dayRoas,
              cpa: dayCpa,
              impressions: dayImpressions,
              clicks: dayClicks,
              conversions: dayConversions,
            };
          })
        );
      }
    });

    const creatives: Creative[] = filteredAds.map((ad, idx) => {
      const insight = insightMap.get(ad.id)!;
      const spend = parseFloat(insight.spend);
      const impressions = parseInt(insight.impressions, 10);
      const clicks = parseInt(insight.clicks, 10);
      const ctr = parseFloat(insight.ctr);
      const roas = computeRoas(insight);
      const cpa = computeCpa(insight);
      const hookRate = computeHookRate(insight);
      const holdRate = computeHoldRate(insight);
      const { p25, p50, p75 } = computeVideoDropoff(insight);

      const isVideo = Boolean(
        ad.creative?.video_id ||
        ad.creative?.object_type === "VIDEO"
      );

      // For image ads: prefer image_url (full-res) over thumbnail_url (low-res
      // preview). Also try to upgrade the CDN URL to 1200-px wide.
      // For video ads: use thumbnail_url as the poster image (also upgraded).
      const rawThumbnailUrl = isVideo
        ? (ad.creative?.thumbnail_url || undefined)
        : (ad.creative?.image_url || ad.creative?.thumbnail_url || undefined);

      const thumbnailUrl = rawThumbnailUrl ? upgradeImageUrl(rawThumbnailUrl) : undefined;

      // Video playback URL fetched from /{video_id}?fields=source (with
      // adcreatives fallback applied above).
      const videoUrl = ad.creative?.video_id
        ? videoSourceMap.get(ad.creative.video_id)
        : undefined;

      // Debug logging so video failures surface in server logs
      if (isVideo && !videoUrl) {
        console.warn(
          `[creatives route] ad ${ad.id} ("${ad.name}"): video_id=${ad.creative?.video_id ?? "none"} — no playable source URL resolved`
        );
      }

      return {
        id: ad.id,
        name: ad.name,
        platform: "Meta" as const,
        format: isVideo ? "Video" as const : "Image" as const,
        status: determineStatus(roas, ctr, hookRate),
        thumbnailColor: THUMBNAIL_COLORS[idx % THUMBNAIL_COLORS.length],
        thumbnailUrl,
        videoUrl,
        videoId: ad.creative?.video_id ?? undefined,
        campaignId: insight.campaign_id ?? undefined,
        spend: Math.round(spend),
        roas,
        cpa,
        ctr: Math.round(ctr * 100) / 100,
        hookRate,
        holdRate,
        videoP25Rate: isVideo ? p25 : undefined,
        videoP50Rate: isVideo ? p50 : undefined,
        videoP75Rate: isVideo ? p75 : undefined,
        impressions,
        clicks,
        conversions: Math.round(spend > 0 && cpa > 0 ? spend / cpa : 0),
        threeSecViews: Math.round(impressions * (hookRate / 100)),
        fifteenSecViews: Math.round(impressions * (holdRate / 100)),
        trend: dailyInsightsMap.get(ad.id) ?? [],
      };
    });

    return NextResponse.json(creatives);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[creatives route] unhandled error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
