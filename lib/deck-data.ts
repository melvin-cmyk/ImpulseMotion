/**
 * Deck data types, mock data, and helpers for the Monthly Business Review builder.
 * Supports Meta Ads + Google Ads with M vs M-1 delta calculations.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeckClient {
  id: string;
  name: string;
  logo?: string;
  industry?: string;
  platform?: "meta" | "google" | "both";
  metaAccountId?: string;
  googleCustomerId?: string;
}

export interface DeckPeriod {
  month: string;       // "2026-02" format
  label: string;       // "Février 2026"
  startDate: string;   // "2026-02-01"
  endDate: string;     // "2026-02-28"
}

export type DeckPlatform = "Google" | "Meta" | "Total";

export interface PlatformMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  cpm: number;
  ctr: number;
  cpc: number;
  cpa: number;
  roas: number;
}

export interface PlatformRow {
  platform: DeckPlatform;
  current: PlatformMetrics;
  previous: PlatformMetrics;
  delta: Record<keyof PlatformMetrics, number>; // % change
}

export interface NCMetrics {
  newClients: number;
  cpNc: number;       // Cost per new client
  percentNc: number;  // % of total conversions
}

export interface NCRow {
  platform: DeckPlatform;
  current: NCMetrics;
  previous: NCMetrics;
  delta: Record<keyof NCMetrics, number>;
}

export interface CampaignRow {
  id: string;
  name: string;
  type?: string;       // "Brand Search", "Pmax Shopping", etc.
  status: "Active" | "Paused" | "Completed";
  current: PlatformMetrics;
  previous: PlatformMetrics;
  delta: Record<keyof PlatformMetrics, number>;
}

export interface TopCreative {
  id: string;
  name: string;
  thumbnailUrl?: string;
  format: "Video" | "Image" | "Carousel";
  spend: number;
  roas: number;
  ctr: number;
  cpa: number;
  impressions: number;
  hookRate?: number;
}

export interface DeckHighlight {
  title: string;
  value: string;
  delta?: number;
  description: string;
  icon: "spend" | "roas" | "cpa" | "conversions";
}

export interface BudgetLine {
  platform: DeckPlatform;
  planned: number;
  actual: number;
  variance: number; // %
}

export interface DeckData {
  client: DeckClient;
  period: DeckPeriod;
  previousPeriod: DeckPeriod;

  // Section 1 — Global
  highlights: DeckHighlight[];
  globalTable: PlatformRow[];
  ncTable: NCRow[];

  // Section 2 — Google Ads
  googleOverview: PlatformMetrics;
  googleCampaigns: CampaignRow[];

  // Section 3 — Meta Ads
  metaOverview: PlatformMetrics;
  metaCampaigns: CampaignRow[];
  topCreatives: TopCreative[];

  // Section 4 — Next Steps & Budget
  budget: BudgetLine[];

  // AI-generated text
  learnings: string[];
  insightsGoogle: string[];
  insightsMeta: string[];
  nextStepsGlobal: string[];
  nextStepsGoogle: string[];
  nextStepsMeta: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeMetrics(base: Omit<PlatformMetrics, "cpm" | "ctr" | "cpc" | "cpa" | "roas">  & { revenue: number }): PlatformMetrics {
  const { spend, impressions, clicks, conversions, revenue } = base;
  return {
    spend,
    impressions,
    clicks,
    conversions,
    revenue,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? revenue / spend : 0,
  };
}

function computeDelta(current: PlatformMetrics, previous: PlatformMetrics): Record<keyof PlatformMetrics, number> {
  const delta = {} as Record<keyof PlatformMetrics, number>;
  for (const key of Object.keys(current) as (keyof PlatformMetrics)[]) {
    const prev = previous[key];
    const curr = current[key];
    delta[key] = prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : curr !== 0 ? 100 : 0;
  }
  return delta;
}

function sumMetrics(a: PlatformMetrics, b: PlatformMetrics): PlatformMetrics {
  return computeMetrics({
    spend: a.spend + b.spend,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    conversions: a.conversions + b.conversions,
    revenue: a.revenue + b.revenue,
  });
}

// ── Mock clients ─────────────────────────────────────────────────────────────

export const mockClients: DeckClient[] = [
  { id: "cl-1", name: "ACME Nutrition", industry: "Health & Wellness" },
  { id: "cl-2", name: "NovaSkin", industry: "Beauty & Skincare" },
  { id: "cl-3", name: "SparkFit", industry: "Fitness" },
  { id: "cl-4", name: "TechGadgets Pro", industry: "Electronics" },
];

// ── Period helpers ────────────────────────────────────────────────────────────

const MONTH_NAMES_FR = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

export function buildPeriod(year: number, month: number): DeckPeriod {
  const m = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return {
    month: `${year}-${m}`,
    label: `${MONTH_NAMES_FR[month - 1]} ${year}`,
    startDate: `${year}-${m}-01`,
    endDate: `${year}-${m}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function getPreviousPeriod(period: DeckPeriod): DeckPeriod {
  const [y, m] = period.month.split("-").map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return buildPeriod(prevYear, prevMonth);
}

export function getAvailablePeriods(): DeckPeriod[] {
  const periods: DeckPeriod[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(buildPeriod(d.getFullYear(), d.getMonth() + 1));
  }
  return periods;
}

// ── Mock data generator ──────────────────────────────────────────────────────

export function generateMockDeckData(client: DeckClient, period: DeckPeriod): DeckData {
  const previousPeriod = getPreviousPeriod(period);

  // Google current
  const googleCurrent = computeMetrics({
    spend: 12450, impressions: 845000, clicks: 18200, conversions: 312, revenue: 48960,
  });
  const googlePrevious = computeMetrics({
    spend: 11800, impressions: 790000, clicks: 16800, conversions: 285, revenue: 42180,
  });

  // Meta current
  const metaCurrent = computeMetrics({
    spend: 18200, impressions: 1250000, clicks: 28500, conversions: 468, revenue: 72540,
  });
  const metaPrevious = computeMetrics({
    spend: 16900, impressions: 1180000, clicks: 25200, conversions: 412, revenue: 61880,
  });

  // Total
  const totalCurrent = sumMetrics(googleCurrent, metaCurrent);
  const totalPrevious = sumMetrics(googlePrevious, metaPrevious);

  const globalTable: PlatformRow[] = [
    { platform: "Google", current: googleCurrent, previous: googlePrevious, delta: computeDelta(googleCurrent, googlePrevious) },
    { platform: "Meta", current: metaCurrent, previous: metaPrevious, delta: computeDelta(metaCurrent, metaPrevious) },
    { platform: "Total", current: totalCurrent, previous: totalPrevious, delta: computeDelta(totalCurrent, totalPrevious) },
  ];

  const ncTable: NCRow[] = [
    {
      platform: "Google",
      current: { newClients: 187, cpNc: 66.58, percentNc: 59.9 },
      previous: { newClients: 165, cpNc: 71.52, percentNc: 57.9 },
      delta: { newClients: 13.3, cpNc: -6.9, percentNc: 3.5 },
    },
    {
      platform: "Meta",
      current: { newClients: 312, cpNc: 58.33, percentNc: 66.7 },
      previous: { newClients: 278, cpNc: 60.79, percentNc: 67.5 },
      delta: { newClients: 12.2, cpNc: -4.0, percentNc: -1.2 },
    },
    {
      platform: "Total",
      current: { newClients: 499, cpNc: 61.42, percentNc: 63.9 },
      previous: { newClients: 443, cpNc: 64.80, percentNc: 63.5 },
      delta: { newClients: 12.6, cpNc: -5.2, percentNc: 0.6 },
    },
  ];

  const googleCampaigns: CampaignRow[] = [
    {
      id: "gc-1", name: "Brand Search — Exact", type: "Brand Search", status: "Active",
      current: computeMetrics({ spend: 3200, impressions: 280000, clicks: 8400, conversions: 142, revenue: 18460 }),
      previous: computeMetrics({ spend: 3000, impressions: 260000, clicks: 7800, conversions: 128, revenue: 16000 }),
      delta: computeDelta(
        computeMetrics({ spend: 3200, impressions: 280000, clicks: 8400, conversions: 142, revenue: 18460 }),
        computeMetrics({ spend: 3000, impressions: 260000, clicks: 7800, conversions: 128, revenue: 16000 })
      ),
    },
    {
      id: "gc-2", name: "Pmax Shopping — Bestsellers", type: "Pmax Shopping", status: "Active",
      current: computeMetrics({ spend: 5800, impressions: 380000, clicks: 6200, conversions: 108, revenue: 21460 }),
      previous: computeMetrics({ spend: 5400, impressions: 350000, clicks: 5600, conversions: 95, revenue: 17820 }),
      delta: computeDelta(
        computeMetrics({ spend: 5800, impressions: 380000, clicks: 6200, conversions: 108, revenue: 21460 }),
        computeMetrics({ spend: 5400, impressions: 350000, clicks: 5600, conversions: 95, revenue: 17820 })
      ),
    },
    {
      id: "gc-3", name: "Generic Search — Nutrition", type: "Generic Search", status: "Active",
      current: computeMetrics({ spend: 2200, impressions: 125000, clicks: 2400, conversions: 38, revenue: 5720 }),
      previous: computeMetrics({ spend: 2100, impressions: 120000, clicks: 2200, conversions: 35, revenue: 5040 }),
      delta: computeDelta(
        computeMetrics({ spend: 2200, impressions: 125000, clicks: 2400, conversions: 38, revenue: 5720 }),
        computeMetrics({ spend: 2100, impressions: 120000, clicks: 2200, conversions: 35, revenue: 5040 })
      ),
    },
    {
      id: "gc-4", name: "Display Retargeting", type: "Display", status: "Paused",
      current: computeMetrics({ spend: 1250, impressions: 60000, clicks: 1200, conversions: 24, revenue: 3320 }),
      previous: computeMetrics({ spend: 1300, impressions: 60000, clicks: 1200, conversions: 27, revenue: 3320 }),
      delta: computeDelta(
        computeMetrics({ spend: 1250, impressions: 60000, clicks: 1200, conversions: 24, revenue: 3320 }),
        computeMetrics({ spend: 1300, impressions: 60000, clicks: 1200, conversions: 27, revenue: 3320 })
      ),
    },
  ];

  const metaCampaigns: CampaignRow[] = [
    {
      id: "mc-1", name: "Conversions — Lookalike 1%", type: "Conversions", status: "Active",
      current: computeMetrics({ spend: 6800, impressions: 420000, clicks: 9800, conversions: 178, revenue: 28480 }),
      previous: computeMetrics({ spend: 6200, impressions: 380000, clicks: 8600, conversions: 152, revenue: 23560 }),
      delta: computeDelta(
        computeMetrics({ spend: 6800, impressions: 420000, clicks: 9800, conversions: 178, revenue: 28480 }),
        computeMetrics({ spend: 6200, impressions: 380000, clicks: 8600, conversions: 152, revenue: 23560 })
      ),
    },
    {
      id: "mc-2", name: "Conversions — Retargeting", type: "Retargeting", status: "Active",
      current: computeMetrics({ spend: 4200, impressions: 310000, clicks: 8200, conversions: 142, revenue: 21300 }),
      previous: computeMetrics({ spend: 3800, impressions: 290000, clicks: 7400, conversions: 128, revenue: 18560 }),
      delta: computeDelta(
        computeMetrics({ spend: 4200, impressions: 310000, clicks: 8200, conversions: 142, revenue: 21300 }),
        computeMetrics({ spend: 3800, impressions: 290000, clicks: 7400, conversions: 128, revenue: 18560 })
      ),
    },
    {
      id: "mc-3", name: "Broad — UGC Créatives", type: "Broad", status: "Active",
      current: computeMetrics({ spend: 5100, impressions: 380000, clicks: 7600, conversions: 108, revenue: 16260 }),
      previous: computeMetrics({ spend: 4800, impressions: 370000, clicks: 6800, conversions: 95, revenue: 13680 }),
      delta: computeDelta(
        computeMetrics({ spend: 5100, impressions: 380000, clicks: 7600, conversions: 108, revenue: 16260 }),
        computeMetrics({ spend: 4800, impressions: 370000, clicks: 6800, conversions: 95, revenue: 13680 })
      ),
    },
    {
      id: "mc-4", name: "Awareness — Video Views", type: "Awareness", status: "Active",
      current: computeMetrics({ spend: 2100, impressions: 140000, clicks: 2900, conversions: 40, revenue: 6500 }),
      previous: computeMetrics({ spend: 2100, impressions: 140000, clicks: 2400, conversions: 37, revenue: 6080 }),
      delta: computeDelta(
        computeMetrics({ spend: 2100, impressions: 140000, clicks: 2900, conversions: 40, revenue: 6500 }),
        computeMetrics({ spend: 2100, impressions: 140000, clicks: 2400, conversions: 37, revenue: 6080 })
      ),
    },
  ];

  const topCreatives: TopCreative[] = [
    { id: "tc-1", name: "UGC_Testimonial_Sarah_V2", format: "Video", spend: 3200, roas: 5.8, ctr: 3.7, cpa: 12.4, impressions: 284000, hookRate: 65, thumbnailUrl: "https://picsum.photos/seed/tc1/400/300" },
    { id: "tc-2", name: "Promo_40OFF_Weekend", format: "Image", spend: 2750, roas: 4.9, ctr: 2.9, cpa: 18.2, impressions: 192000, thumbnailUrl: "https://picsum.photos/seed/tc2/400/300" },
    { id: "tc-3", name: "BeforeAfter_30Days_V1", format: "Video", spend: 2100, roas: 4.2, ctr: 3.4, cpa: 22.1, impressions: 178000, hookRate: 58, thumbnailUrl: "https://picsum.photos/seed/tc3/400/300" },
    { id: "tc-4", name: "Carousel_BestSellers_Q1", format: "Carousel", spend: 1890, roas: 3.6, ctr: 2.3, cpa: 24.5, impressions: 143000, thumbnailUrl: "https://picsum.photos/seed/tc4/400/300" },
    { id: "tc-5", name: "Story_HowTo_3Steps", format: "Video", spend: 1450, roas: 3.0, ctr: 2.6, cpa: 32.1, impressions: 112000, hookRate: 44, thumbnailUrl: "https://picsum.photos/seed/tc5/400/300" },
    { id: "tc-6", name: "Static_Lifestyle_Spring", format: "Image", spend: 980, roas: 2.8, ctr: 1.9, cpa: 38.7, impressions: 78000, thumbnailUrl: "https://picsum.photos/seed/tc6/400/300" },
  ];

  const highlights: DeckHighlight[] = [
    {
      title: "Revenus Totaux",
      value: "121 500 €",
      delta: 16.4,
      description: `Revenus en hausse +16,4% vs ${previousPeriod.label}, portés par les campagnes Lookalike Meta et Pmax Google.`,
      icon: "roas",
    },
    {
      title: "ROAS Global",
      value: "3,96×",
      delta: 8.2,
      description: "ROAS en amélioration sur les deux plateformes grâce à une meilleure rotation créative.",
      icon: "roas",
    },
    {
      title: "Nouveaux Clients",
      value: "499",
      delta: 12.6,
      description: `NC en hausse +12,6% MoM. Meta a généré 62,5% des nouveaux clients à un CP-NC inférieur.`,
      icon: "conversions",
    },
    {
      title: "CPA Global",
      value: "39,28 €",
      delta: -7.1,
      description: "CPA en baisse -7,1% grâce à l'amélioration des taux de conversion sur les campagnes retargeting.",
      icon: "cpa",
    },
  ];

  const budget: BudgetLine[] = [
    { platform: "Google", planned: 13000, actual: 12450, variance: -4.2 },
    { platform: "Meta", planned: 18000, actual: 18200, variance: 1.1 },
    { platform: "Total", planned: 31000, actual: 30650, variance: -1.1 },
  ];

  return {
    client,
    period,
    previousPeriod,
    highlights,
    globalTable,
    ncTable,
    googleOverview: googleCurrent,
    googleCampaigns,
    metaOverview: metaCurrent,
    metaCampaigns,
    topCreatives,
    budget,
    learnings: [
      "Les campagnes Lookalike 1% Meta restent le meilleur levier d'acquisition avec un ROAS de 4.19× et un CPA de 38.20€, en amélioration de -6.9% vs M-1.",
      "Le Pmax Shopping Google surperforme avec +13.7% de conversions et un ROAS de 3.70×. Les flux produits optimisés en début de mois ont porté leurs fruits.",
      "Les créatives UGC vidéo (témoignages) dominent le top 3 avec un hook rate moyen de 61.5% — à continuer de décliner.",
      "Le retargeting Meta (CPA 29.58€) est 2× plus efficace que le Display Google (CPA 52.08€). Recommandation : réallouer budget Display vers Meta retargeting.",
    ],
    insightsGoogle: [
      "Brand Search reste le pilier avec 45.5% des conversions Google à un CPA de 22.54€.",
      "Pmax Shopping en hausse : +13.7% conversions, ROAS 3.70× (+20.4% vs M-1).",
      "Generic Search stable mais CPA élevé (57.89€) — à optimiser via negative keywords.",
    ],
    insightsMeta: [
      "Lookalike 1% = meilleur ratio volume/coût avec 178 conversions à 38.20€ CPA.",
      "Les vidéos UGC surpassent les images statiques : CTR +48%, hook rate 58% moyen.",
      "Le retargeting affiche le meilleur ROAS (5.07×) — fenêtre 7j optimale confirmée.",
    ],
    nextStepsGlobal: [
      "Augmenter le budget Meta de +15% sur les campagnes Lookalike pour scaler l'acquisition NC.",
      "Tester un nouveau segment Pmax Shopping avec les produits printemps.",
      "Réallouer 500€/mois du Display Google vers le retargeting Meta.",
    ],
    nextStepsGoogle: [
      "Ajouter 50 negative keywords sur Generic Search pour réduire le CPA.",
      "Lancer une campagne Pmax dédiée aux nouveaux produits Q2.",
      "Optimiser les extensions d'annonces Brand Search (sitelinks + callouts).",
    ],
    nextStepsMeta: [
      "Produire 3 nouvelles créatives UGC vidéo basées sur le format témoignage (top performer).",
      "Tester un angle 'before/after' sur la Lookalike pour diversifier les créatives.",
      "Passer les créatives fatiguées (hook rate < 30%) en pause et remplacer par des itérations.",
    ],
  };
}
