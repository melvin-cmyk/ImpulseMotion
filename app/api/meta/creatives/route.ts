import { auth } from "@/auth";
import {
  getAds,
  getAdInsights,
  getVideoSources,
  getVideoSourcesViaAdCreatives,
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

/**
 * Attempt to upgrade a Meta CDN image URL to a higher resolution.
 *
 * Meta CDN URLs (scontent-*.fbcdn.net) accept width/height query parameters.
 * If the URL already contains size parameters we replace them; otherwise we
 * append them.  We request 1200 px wide which is the typical full-resolution
 * available from the Marketing API.
 */
function upgradeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    // Only mangle fbcdn / fbsbx CDN URLs — leave other URLs untouched.
    if (
      parsed.hostname.endsWith(".fbcdn.net") ||
      parsed.hostname.endsWith(".fbsbx.com")
    ) {
      // Remove any existing low-res size parameters that Meta embeds in the path.
      // Meta CDN URLs encode dimensions like "s320x320" or "p320x320" in the
      // path segments — replace the first such segment with a 1200-wide variant.
      parsed.pathname = parsed.pathname.replace(
        /\/(s|p)\d+x\d+\//,
        "/s1200x1200/"
      );
      return parsed.toString();
    }
  } catch {
    // If URL parsing fails just return the original
  }
  return url;
}

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

      // For image ads: prefer image_url (full-res) over thumbnail_url (low-res
      // preview). Also try to upgrade the CDN URL to 1200-px wide.
      // For video ads: use thumbnail_url as the poster image (also upgraded).
      const rawThumbnailUrl = isVideo
        ? (ad.creative?.thumbnail_url || undefined)
        : (ad.creative?.image_url || ad.creative?.thumbnail_url || undefined);

      const thumbnailUrl = upgradeImageUrl(rawThumbnailUrl);

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
    console.error("[creatives route] unhandled error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
