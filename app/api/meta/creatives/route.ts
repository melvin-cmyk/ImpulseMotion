import { auth } from "@/auth";
import {
  getAds,
  getAdInsights,
  getVideoSources,
  computeRoas,
  computeCpa,
  computeHookRate,
  computeHoldRate,
} from "@/lib/meta-api";
import { Creative, Status } from "@/lib/mock-data";
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

  if (!session || session.provider !== "facebook") {
    return NextResponse.json({ error: "Not authenticated with Meta" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const adAccountId = searchParams.get("accountId");

  if (!adAccountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  try {
    const accessToken = session.accessToken as string;
    const [ads, insights] = await Promise.all([
      getAds(accessToken, adAccountId),
      getAdInsights(accessToken, adAccountId),
    ]);

    const insightMap = new Map(insights.map((i) => [i.ad_id, i]));
    const filteredAds = ads.filter((ad) => insightMap.has(ad.id));

    // Batch-fetch video source URLs for all video creatives
    const videoIds = filteredAds
      .map((ad) => ad.creative?.video_id)
      .filter((id): id is string => Boolean(id));
    const videoSourceMap = await getVideoSources(accessToken, videoIds);

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

        const isVideo = Boolean(
          ad.creative?.video_id ||
          ad.creative?.object_type === "VIDEO"
        );

        // For image ads: prefer image_url (full-res) over thumbnail_url (low-res preview)
        // For video ads: use thumbnail_url as the poster image
        const thumbnailUrl = isVideo
          ? (ad.creative?.thumbnail_url || undefined)
          : (ad.creative?.image_url || ad.creative?.thumbnail_url || undefined);

        // Video playback URL fetched from /{video_id}?fields=source
        const videoUrl = ad.creative?.video_id
          ? videoSourceMap.get(ad.creative.video_id)
          : undefined;

        return {
          id: ad.id,
          name: ad.name,
          platform: "Meta" as const,
          format: isVideo ? "Video" as const : "Image" as const,
          status: determineStatus(roas, ctr, hookRate),
          thumbnailColor: THUMBNAIL_COLORS[idx % THUMBNAIL_COLORS.length],
          thumbnailUrl,
          videoUrl,
          spend: Math.round(spend),
          roas,
          cpa,
          ctr: Math.round(ctr * 100) / 100,
          hookRate,
          holdRate,
          impressions,
          clicks,
          conversions: Math.round(spend > 0 && cpa > 0 ? spend / cpa : 0),
          threeSecViews: Math.round(impressions * (hookRate / 100)),
          fifteenSecViews: Math.round(impressions * (holdRate / 100)),
          trend: [], // loaded lazily per-creative
        };
      });

    return NextResponse.json(creatives);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
