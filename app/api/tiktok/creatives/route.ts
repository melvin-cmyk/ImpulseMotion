import { auth } from "@/auth";
import {
  getTikTokAds,
  getTikTokInsights,
  computeTikTokRoas,
  computeTikTokHookRate,
  computeTikTokHoldRate,
} from "@/lib/tiktok-api";
import { Creative, Status } from "@/lib/mock-data";
import { NextRequest, NextResponse } from "next/server";

function determineStatus(roas: number, ctr: number, hookRate: number): Status {
  if (roas >= 4 && ctr >= 2.5) return "Winner";
  if (roas <= 1.5 || ctr <= 0.8) return "Loser";
  if (hookRate < 20) return "Fatigued";
  return "Active";
}

const THUMBNAIL_COLORS = [
  "from-pink-500 to-rose-600",
  "from-violet-500 to-purple-700",
  "from-orange-500 to-amber-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-indigo-500 to-violet-600",
];

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session || !session.tiktokAccessToken) {
    return NextResponse.json({ error: "Not authenticated with TikTok" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const advertiserId = searchParams.get("accountId");

  if (!advertiserId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  try {
    const accessToken = session.tiktokAccessToken as string;
    const end = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const [ads, insights] = await Promise.all([
      getTikTokAds(accessToken, advertiserId),
      getTikTokInsights(accessToken, advertiserId, start, end),
    ]);

    const insightMap = new Map(insights.map((i) => [i.ad_id, i]));

    const creatives: Creative[] = ads
      .filter((ad) => insightMap.has(ad.ad_id))
      .map((ad, idx) => {
        const insight = insightMap.get(ad.ad_id)!;
        const spend = parseFloat(insight.spend ?? "0");
        const impressions = parseFloat(insight.impressions ?? "0");
        const clicks = parseFloat(insight.clicks ?? "0");
        const ctr = parseFloat(insight.ctr ?? "0");
        const roas = computeTikTokRoas(insight);
        const cpa = parseFloat(insight.cost_per_conversion ?? "0");
        const hookRate = computeTikTokHookRate(insight);
        const holdRate = computeTikTokHoldRate(insight);
        const conversions = parseFloat(insight.conversions ?? "0");

        const isVideo = !!ad.video_id;

        return {
          id: ad.ad_id,
          name: ad.ad_name,
          platform: "TikTok" as const,
          format: isVideo ? "Video" as const : "Image" as const,
          status: determineStatus(roas, ctr, hookRate),
          thumbnailColor: THUMBNAIL_COLORS[idx % THUMBNAIL_COLORS.length],
          thumbnailUrl: ad.image_url || undefined,
          spend: Math.round(spend),
          roas,
          cpa: Math.round(cpa * 100) / 100,
          ctr: Math.round(ctr * 100) / 100,
          hookRate,
          holdRate,
          impressions: Math.round(impressions),
          clicks: Math.round(clicks),
          conversions: Math.round(conversions),
          threeSecViews: Math.round(impressions * (hookRate / 100)),
          fifteenSecViews: Math.round(impressions * (holdRate / 100)),
          trend: [],
        };
      });

    return NextResponse.json(creatives);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
