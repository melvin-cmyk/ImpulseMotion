export type Platform = "Meta" | "TikTok";
export type Format = "Video" | "Image" | "Carousel";
export type Status = "Winner" | "Loser" | "Fatigued" | "Active";

export interface DayMetric {
  date: string;
  spend: number;
  roas: number;
  cpa: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface Creative {
  id: string;
  name: string;
  platform: Platform;
  format: Format;
  status: Status;
  thumbnailColor: string;
  /** URL of the thumbnail/preview image (from Meta or TikTok API) */
  thumbnailUrl?: string;
  /** URL of the full video (from Meta or TikTok API) */
  videoUrl?: string;
  /**
   * Meta video_id — used to embed the official Facebook iframe player.
   * Only present for Meta video creatives.
   */
  videoId?: string;
  /** Meta campaign_id — used for campaign filtering */
  campaignId?: string;
  spend: number;
  roas: number;
  cpa: number;
  ctr: number;
  hookRate: number;
  holdRate: number;
  /** Video view rates at each quartile (% of impressions). Video ads only. */
  videoP25Rate?: number;
  videoP50Rate?: number;
  videoP75Rate?: number;
  impressions: number;
  clicks: number;
  conversions: number;
  threeSecViews: number;
  fifteenSecViews: number;
  trend: DayMetric[];
}

function generateTrend(baseRoas: number, status: Status): DayMetric[] {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((date, i) => {
    let roasMultiplier = 1;
    if (status === "Fatigued") roasMultiplier = 1 - i * 0.08;
    if (status === "Winner") roasMultiplier = 1 + i * 0.03;
    if (status === "Loser") roasMultiplier = 0.8 + (i % 3) * 0.05;

    const roas = Math.max(0.2, baseRoas * roasMultiplier + ((i % 3) - 1) * 0.15);
    const spend = 50 + (i * 30) % 200;
    const conversions = Math.max(1, Math.round((spend * roas) / 20));
    const impressions = Math.round(spend * 80 + i * 500);
    const clicks = Math.round(impressions * 0.02);

    return {
      date,
      spend: Math.round(spend),
      roas: Math.round(roas * 100) / 100,
      cpa: Math.round((spend / conversions) * 100) / 100,
      impressions,
      clicks,
      conversions,
    };
  });
}

export const mockCreatives: Creative[] = [
  {
    id: "c1",
    name: "ACME_VIDEO_TESTIMONIAL",
    platform: "Meta",
    format: "Video",
    status: "Winner",
    thumbnailColor: "from-violet-500 to-purple-700",
    spend: 4820,
    roas: 5.8,
    cpa: 12.4,
    ctr: 3.7,
    hookRate: 65,
    holdRate: 42,
    impressions: 284000,
    clicks: 10508,
    conversions: 389,
    threeSecViews: 184600,
    fifteenSecViews: 119280,
    trend: generateTrend(5.8, "Winner"),
  },
  {
    id: "c2",
    name: "NOVA_VIDEO_UGCREVIEW",
    platform: "TikTok",
    format: "Video",
    status: "Winner",
    thumbnailColor: "from-pink-500 to-rose-700",
    spend: 3910,
    roas: 5.2,
    cpa: 14.1,
    ctr: 4.1,
    hookRate: 71,
    holdRate: 39,
    impressions: 520000,
    clicks: 21320,
    conversions: 277,
    threeSecViews: 369200,
    fifteenSecViews: 202960,
    trend: generateTrend(5.2, "Winner"),
  },
  {
    id: "c3",
    name: "ACME_IMAGE_PROMO",
    platform: "Meta",
    format: "Image",
    status: "Winner",
    thumbnailColor: "from-blue-500 to-indigo-700",
    spend: 2750,
    roas: 4.9,
    cpa: 18.2,
    ctr: 2.9,
    hookRate: 0,
    holdRate: 0,
    impressions: 192000,
    clicks: 5568,
    conversions: 151,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(4.9, "Winner"),
  },
  {
    id: "c4",
    name: "NOVA_CAROUSEL_PRODUCTLINE",
    platform: "Meta",
    format: "Carousel",
    status: "Active",
    thumbnailColor: "from-teal-500 to-emerald-700",
    spend: 1890,
    roas: 3.6,
    cpa: 24.5,
    ctr: 2.3,
    hookRate: 0,
    holdRate: 0,
    impressions: 143000,
    clicks: 3289,
    conversions: 77,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(3.6, "Active"),
  },
  {
    id: "c5",
    name: "SPARK_VIDEO_BEFOREAFTER",
    platform: "TikTok",
    format: "Video",
    status: "Active",
    thumbnailColor: "from-orange-500 to-red-700",
    spend: 2100,
    roas: 3.2,
    cpa: 29.8,
    ctr: 3.4,
    hookRate: 58,
    holdRate: 33,
    impressions: 390000,
    clicks: 13260,
    conversions: 70,
    threeSecViews: 226200,
    fifteenSecViews: 128700,
    trend: generateTrend(3.2, "Active"),
  },
  {
    id: "c6",
    name: "ACME_VIDEO_HOWTO",
    platform: "Meta",
    format: "Video",
    status: "Active",
    thumbnailColor: "from-cyan-500 to-blue-700",
    spend: 1450,
    roas: 3.0,
    cpa: 32.1,
    ctr: 2.6,
    hookRate: 44,
    holdRate: 27,
    impressions: 112000,
    clicks: 2912,
    conversions: 45,
    threeSecViews: 49280,
    fifteenSecViews: 30240,
    trend: generateTrend(3.0, "Active"),
  },
  {
    id: "c7",
    name: "SPARK_IMAGE_LIFESTYLE",
    platform: "Meta",
    format: "Image",
    status: "Active",
    thumbnailColor: "from-lime-500 to-green-700",
    spend: 980,
    roas: 2.8,
    cpa: 38.7,
    ctr: 1.9,
    hookRate: 0,
    holdRate: 0,
    impressions: 78000,
    clicks: 1482,
    conversions: 25,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(2.8, "Active"),
  },
  {
    id: "c8",
    name: "NOVA_VIDEO_CHALLENGE",
    platform: "TikTok",
    format: "Video",
    status: "Fatigued",
    thumbnailColor: "from-amber-500 to-yellow-700",
    spend: 3200,
    roas: 2.1,
    cpa: 47.2,
    ctr: 1.8,
    hookRate: 38,
    holdRate: 19,
    impressions: 410000,
    clicks: 7380,
    conversions: 68,
    threeSecViews: 155800,
    fifteenSecViews: 77900,
    trend: generateTrend(2.1, "Fatigued"),
  },
  {
    id: "c9",
    name: "ACME_CAROUSEL_FEATURES",
    platform: "Meta",
    format: "Carousel",
    status: "Fatigued",
    thumbnailColor: "from-fuchsia-500 to-pink-700",
    spend: 2600,
    roas: 1.9,
    cpa: 52.4,
    ctr: 1.5,
    hookRate: 0,
    holdRate: 0,
    impressions: 198000,
    clicks: 2970,
    conversions: 50,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(1.9, "Fatigued"),
  },
  {
    id: "c10",
    name: "SPARK_VIDEO_MEME",
    platform: "TikTok",
    format: "Video",
    status: "Fatigued",
    thumbnailColor: "from-sky-500 to-blue-700",
    spend: 1780,
    roas: 1.7,
    cpa: 61.0,
    ctr: 2.2,
    hookRate: 55,
    holdRate: 22,
    impressions: 320000,
    clicks: 7040,
    conversions: 29,
    threeSecViews: 176000,
    fifteenSecViews: 70400,
    trend: generateTrend(1.7, "Fatigued"),
  },
  {
    id: "c11",
    name: "ACME_IMAGE_SALE",
    platform: "Meta",
    format: "Image",
    status: "Loser",
    thumbnailColor: "from-red-500 to-rose-700",
    spend: 890,
    roas: 0.9,
    cpa: 74.2,
    ctr: 0.8,
    hookRate: 0,
    holdRate: 0,
    impressions: 66000,
    clicks: 528,
    conversions: 12,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(0.9, "Loser"),
  },
  {
    id: "c12",
    name: "NOVA_VIDEO_CELEB",
    platform: "TikTok",
    format: "Video",
    status: "Loser",
    thumbnailColor: "from-slate-500 to-gray-700",
    spend: 1200,
    roas: 0.7,
    cpa: 80.0,
    ctr: 0.6,
    hookRate: 25,
    holdRate: 11,
    impressions: 280000,
    clicks: 1680,
    conversions: 15,
    threeSecViews: 70000,
    fifteenSecViews: 30800,
    trend: generateTrend(0.7, "Loser"),
  },
  {
    id: "c13",
    name: "SPARK_CAROUSEL_COMPARE",
    platform: "Meta",
    format: "Carousel",
    status: "Loser",
    thumbnailColor: "from-stone-500 to-neutral-700",
    spend: 560,
    roas: 0.5,
    cpa: 78.5,
    ctr: 0.7,
    hookRate: 0,
    holdRate: 0,
    impressions: 44000,
    clicks: 308,
    conversions: 7,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(0.5, "Loser"),
  },
  {
    id: "c14",
    name: "NOVA_IMAGE_DISCOUNT",
    platform: "Meta",
    format: "Image",
    status: "Loser",
    thumbnailColor: "from-zinc-500 to-gray-700",
    spend: 340,
    roas: 0.6,
    cpa: 68.0,
    ctr: 0.9,
    hookRate: 0,
    holdRate: 0,
    impressions: 28000,
    clicks: 252,
    conversions: 5,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(0.6, "Loser"),
  },
  {
    id: "c15",
    name: "ACME_VIDEO_STORY",
    platform: "TikTok",
    format: "Video",
    status: "Winner",
    thumbnailColor: "from-violet-600 to-blue-700",
    spend: 2900,
    roas: 4.5,
    cpa: 16.8,
    ctr: 3.5,
    hookRate: 62,
    holdRate: 38,
    impressions: 430000,
    clicks: 15050,
    conversions: 173,
    threeSecViews: 266600,
    fifteenSecViews: 163400,
    trend: generateTrend(4.5, "Winner"),
  },
  {
    id: "c16",
    name: "SPARK_VIDEO_TUTORIAL",
    platform: "Meta",
    format: "Video",
    status: "Active",
    thumbnailColor: "from-green-500 to-teal-700",
    spend: 1100,
    roas: 2.4,
    cpa: 44.0,
    ctr: 2.1,
    hookRate: 41,
    holdRate: 24,
    impressions: 87000,
    clicks: 1827,
    conversions: 25,
    threeSecViews: 35670,
    fifteenSecViews: 20880,
    trend: generateTrend(2.4, "Active"),
  },
  {
    id: "c17",
    name: "NOVA_VIDEO_REACTION",
    platform: "TikTok",
    format: "Video",
    status: "Fatigued",
    thumbnailColor: "from-rose-500 to-pink-700",
    spend: 2400,
    roas: 1.5,
    cpa: 66.7,
    ctr: 1.6,
    hookRate: 33,
    holdRate: 15,
    impressions: 380000,
    clicks: 6080,
    conversions: 36,
    threeSecViews: 125400,
    fifteenSecViews: 57000,
    trend: generateTrend(1.5, "Fatigued"),
  },
  {
    id: "c18",
    name: "ACME_CAROUSEL_BUNDLE",
    platform: "Meta",
    format: "Carousel",
    status: "Active",
    thumbnailColor: "from-indigo-500 to-purple-700",
    spend: 1650,
    roas: 3.1,
    cpa: 31.7,
    ctr: 2.5,
    hookRate: 0,
    holdRate: 0,
    impressions: 132000,
    clicks: 3300,
    conversions: 52,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(3.1, "Active"),
  },
  {
    id: "c19",
    name: "SPARK_IMAGE_SEASONAL",
    platform: "TikTok",
    format: "Image",
    status: "Active",
    thumbnailColor: "from-emerald-500 to-green-700",
    spend: 720,
    roas: 2.6,
    cpa: 41.2,
    ctr: 1.4,
    hookRate: 0,
    holdRate: 0,
    impressions: 59000,
    clicks: 826,
    conversions: 17,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(2.6, "Active"),
  },
  {
    id: "c20",
    name: "NOVA_CAROUSEL_BRAND",
    platform: "Meta",
    format: "Carousel",
    status: "Winner",
    thumbnailColor: "from-blue-600 to-cyan-700",
    spend: 3450,
    roas: 4.2,
    cpa: 19.7,
    ctr: 3.0,
    hookRate: 0,
    holdRate: 0,
    impressions: 261000,
    clicks: 7830,
    conversions: 175,
    threeSecViews: 0,
    fifteenSecViews: 0,
    trend: generateTrend(4.2, "Winner"),
  },
];

export function getTotalSpend(): number {
  return mockCreatives.reduce((sum, c) => sum + c.spend, 0);
}

export function getAvgRoas(): number {
  return mockCreatives.reduce((sum, c) => sum + c.roas, 0) / mockCreatives.length;
}

export function getAvgCpa(): number {
  return mockCreatives.reduce((sum, c) => sum + c.cpa, 0) / mockCreatives.length;
}

export function getActiveCount(): number {
  return mockCreatives.filter((c) => c.status === "Active" || c.status === "Winner").length;
}

export function getTopByRoas(n = 5): Creative[] {
  return [...mockCreatives].sort((a, b) => b.roas - a.roas).slice(0, n);
}

export function getTopBySpend(n = 10): Creative[] {
  return [...mockCreatives].sort((a, b) => b.spend - a.spend).slice(0, n);
}

export function getWorstByCpa(n = 10): Creative[] {
  return [...mockCreatives].sort((a, b) => b.cpa - a.cpa).slice(0, n);
}

export function getFatigued(n = 10): Creative[] {
  return [...mockCreatives]
    .filter((c) => c.status === "Fatigued")
    .sort((a, b) => a.roas - b.roas)
    .slice(0, n);
}
