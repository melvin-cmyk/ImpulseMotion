/**
 * Pure slide-building helpers extracted from app/deck/page.tsx.
 * These produce SlideData[] and SlideConfig[] used by the deck page and AI panel.
 */
import type { DeckData } from "@/lib/deck-data";
import type { SlideData } from "@/types/deck";
import {
  type SlideConfig,
  TOP_CREATIVES_PER_SLIDE,
  CAMPAIGNS_PER_SLIDE,
  BULLETS_PER_SLIDE,
} from "@/lib/deck-page-types";
import {
  CoverSlide,
  AgendaSlide,
  SectionDividerSlide,
  HighlightsSlide,
  GlobalTableSlide,
  NCSlide,
  KPIOverviewSlide,
  CampaignTableSlide,
  TopCreativesSlide,
  LearningsSlide,
  NextStepsSlide,
  BudgetSlide,
  GAOverviewSlide,
  GATopPagesSlide,
  GADeviceSourceSlide,
} from "@/components/deck/slides";

type EditCallbacks = {
  onEdit?: (field: string, slideIndex: number, newValue: string) => void;
  getOverride?: (slideIndex: number, field: string) => string | undefined;
};

// ── Build AI-style SlideData[] from DeckData (used as a client-side fallback) ─
export function buildSlidesFromDeckData(data: DeckData): SlideData[] {
  const fmtCur = (n: number) => `€${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const fmtX = (n: number) => `${n.toFixed(2)}x`;
  const slides: SlideData[] = [];

  slides.push({
    id: "auto-overview",
    type: "overview",
    title: `${data.client.name} — ${data.period.label}`,
    subtitle: "Vue d'ensemble des performances publicitaires",
    kpis: data.highlights.map(h => ({
      label: h.title,
      value: h.value,
      delta: h.delta != null ? `${h.delta >= 0 ? "+" : ""}${h.delta.toFixed(1)}%` : undefined,
      trend: h.delta != null ? (h.delta > 0 ? "up" as const : h.delta < 0 ? "down" as const : "flat" as const) : undefined,
    })),
    severity: "ok",
  });

  if (data.metaOverview.spend > 0) {
    const m = data.metaOverview;
    slides.push({
      id: "auto-meta-kpi",
      type: "performance",
      title: "Meta Ads — Performance",
      subtitle: data.period.label,
      kpis: [
        { label: "Spend", value: fmtCur(m.spend) },
        { label: "ROAS", value: fmtX(m.roas), trend: m.roas >= 1 ? "up" : "down" },
        { label: "CPA", value: fmtCur(m.cpa) },
        { label: "CTR", value: fmtPct(m.ctr) },
      ],
      insights: data.insightsMeta.length > 0 ? data.insightsMeta : [
        `${Math.round(m.conversions)} conversions pour ${fmtCur(m.spend)} de spend`,
        `Revenue total: ${fmtCur(m.revenue)}`,
      ],
      severity: m.roas < 1 ? "alert" : m.roas < 2 ? "warning" : "ok",
    });
  }

  if (data.metaCampaigns.length > 0) {
    slides.push({
      id: "auto-meta-campaigns",
      type: "performance",
      title: "Meta Ads — Top Campagnes",
      subtitle: `${data.metaCampaigns.length} campagnes actives`,
      kpis: data.metaCampaigns.slice(0, 4).map(c => ({
        label: c.name.length > 25 ? c.name.slice(0, 22) + "…" : c.name,
        value: fmtX(c.current.roas),
        delta: fmtCur(c.current.spend),
        trend: c.current.roas >= 1 ? "up" as const : "down" as const,
      })),
      insights: data.metaCampaigns.slice(0, 3).map(c =>
        `${c.name}: ${fmtCur(c.current.spend)} spend, ${Math.round(c.current.conversions)} conv., ROAS ${fmtX(c.current.roas)}`
      ),
    });
  }

  if (data.topCreatives.length > 0) {
    slides.push({
      id: "auto-creatives",
      type: "creative",
      title: "Top Créatives — Performance",
      subtitle: `Top ${Math.min(data.topCreatives.length, 6)} créatives par spend`,
      images: data.topCreatives.slice(0, 6).filter(c => c.thumbnailUrl).map(c => ({
        url: c.thumbnailUrl!,
        label: c.name,
        metrics: `Spend ${fmtCur(c.spend)} · ROAS ${fmtX(c.roas)} · CTR ${fmtPct(c.ctr)} · CPA ${fmtCur(c.cpa)}`,
      })),
      kpis: data.topCreatives.slice(0, 4).map(c => ({
        label: c.name.length > 20 ? c.name.slice(0, 17) + "…" : c.name,
        value: fmtX(c.roas),
        delta: fmtCur(c.spend),
        trend: c.roas >= 1 ? "up" as const : "down" as const,
      })),
    });
  }

  if (data.googleOverview.spend > 0) {
    const g = data.googleOverview;
    slides.push({
      id: "auto-google-kpi",
      type: "performance",
      title: "Google Ads — Performance",
      subtitle: data.period.label,
      kpis: [
        { label: "Spend", value: fmtCur(g.spend) },
        { label: "ROAS", value: fmtX(g.roas), trend: g.roas >= 1 ? "up" : "down" },
        { label: "CPA", value: fmtCur(g.cpa) },
        { label: "CTR", value: fmtPct(g.ctr) },
      ],
      insights: data.insightsGoogle.length > 0 ? data.insightsGoogle : [
        `${Math.round(g.conversions)} conversions pour ${fmtCur(g.spend)} de spend`,
        `Revenue total: ${fmtCur(g.revenue)}`,
      ],
      severity: g.roas < 1 ? "alert" : g.roas < 2 ? "warning" : "ok",
    });
  }

  if (data.learnings.length > 0) {
    slides.push({
      id: "auto-learnings",
      type: "recommendation",
      title: "Learnings & Insights",
      insights: data.learnings,
      recommendation: data.nextStepsGlobal[0] ?? undefined,
    });
  }

  if (data.nextStepsGlobal.length > 0 || data.nextStepsMeta.length > 0 || data.nextStepsGoogle.length > 0) {
    const allSteps = [
      ...data.nextStepsGlobal,
      ...data.nextStepsMeta.slice(0, 2),
      ...data.nextStepsGoogle.slice(0, 2),
    ];
    slides.push({
      id: "auto-next-steps",
      type: "recommendation",
      title: "Next Steps & Recommandations",
      subtitle: "Actions prioritaires pour la prochaine période",
      insights: allSteps.slice(0, 6),
    });
  }

  return slides;
}

// ── Generate contextual Markdown for a given slide id ────────────────────────
export function extractSlideMarkdown(slideId: string, label: string, data: DeckData): string {
  const fmtCur = (n: number) => `€${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const fmtDec = (n: number) => n.toFixed(2);
  const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

  switch (slideId) {
    case "cover":
      return `# ${data.client.name} — ${data.period.label}\n\nMonthly Business Review — Rapport de performance publicitaire.\n\n**Période :** ${data.period.startDate} → ${data.period.endDate}`;

    case "highlights": {
      const lines = data.highlights.map(h =>
        `- **${h.title}** : ${h.value}${h.delta != null ? ` (${h.delta >= 0 ? "+" : ""}${h.delta.toFixed(1)}%)` : ""} — ${h.description}`
      );
      return `# Highlights — ${data.period.label}\n\n${lines.join("\n")}`;
    }

    case "global-table": {
      const rows = data.globalTable.map(r =>
        `| ${r.platform} | ${fmtCur(r.current.spend)} | ${fmtK(r.current.impressions)} | ${fmtK(r.current.clicks)} | ${Math.round(r.current.conversions)} | ${fmtDec(r.current.roas)}× | ${fmtPct(r.current.ctr)} |`
      );
      return `# Tableau Global — ${data.period.label}\n\n| Plateforme | Spend | Impressions | Clicks | Conv. | ROAS | CTR |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}`;
    }

    case "nc-table": {
      const rows = data.ncTable.map(r =>
        `| ${r.platform} | ${Math.round(r.current.newClients)} | ${fmtCur(r.current.cpNc)} | ${fmtPct(r.current.percentNc)} |`
      );
      return `# Nouveaux Clients — ${data.period.label}\n\n| Plateforme | NC | CP-NC | % NC |\n|---|---|---|\n${rows.join("\n")}`;
    }

    case "learnings-global":
      return `# Points Clés Global — ${data.period.label}\n\n${data.learnings.map(l => `- ${l}`).join("\n")}`;

    case "google-kpi": {
      const m = data.googleOverview;
      return `# Google Ads — KPIs — ${data.period.label}\n\n| Métrique | Valeur |\n|---|---|\n| Spend | ${fmtCur(m.spend)} |\n| Impressions | ${fmtK(m.impressions)} |\n| Clicks | ${fmtK(m.clicks)} |\n| Conversions | ${Math.round(m.conversions)} |\n| Revenue | ${fmtCur(m.revenue)} |\n| ROAS | ${fmtDec(m.roas)}× |\n| CPA | ${fmtCur(m.cpa)} |\n| CTR | ${fmtPct(m.ctr)} |`;
    }

    case "google-campaigns": {
      const rows = data.googleCampaigns.map(c =>
        `| ${c.name} | ${c.status} | ${fmtCur(c.current.spend)} | ${Math.round(c.current.conversions)} | ${fmtDec(c.current.roas)}× |`
      );
      return `# Campagnes Google Ads — ${data.period.label}\n\n| Campagne | Statut | Spend | Conv. | ROAS |\n|---|---|---|---|---|\n${rows.join("\n")}`;
    }

    case "insights-google":
      return `# Insights Google — ${data.period.label}\n\n${data.insightsGoogle.map(l => `- ${l}`).join("\n")}`;

    case "next-google":
      return `# Next Steps Google — ${data.period.label}\n\n${data.nextStepsGoogle.map(l => `- ${l}`).join("\n")}`;

    case "meta-kpi": {
      const m = data.metaOverview;
      return `# Meta Ads — KPIs — ${data.period.label}\n\n| Métrique | Valeur |\n|---|---|\n| Spend | ${fmtCur(m.spend)} |\n| Impressions | ${fmtK(m.impressions)} |\n| Clicks | ${fmtK(m.clicks)} |\n| Conversions | ${Math.round(m.conversions)} |\n| Revenue | ${fmtCur(m.revenue)} |\n| ROAS | ${fmtDec(m.roas)}× |\n| CPA | ${fmtCur(m.cpa)} |\n| CTR | ${fmtPct(m.ctr)} |`;
    }

    case "meta-campaigns": {
      const rows = data.metaCampaigns.map(c =>
        `| ${c.name} | ${c.status} | ${fmtCur(c.current.spend)} | ${Math.round(c.current.conversions)} | ${fmtDec(c.current.roas)}× |`
      );
      return `# Campagnes Meta Ads — ${data.period.label}\n\n| Campagne | Statut | Spend | Conv. | ROAS |\n|---|---|---|---|---|\n${rows.join("\n")}`;
    }

    case "top-creatives": {
      const rows = data.topCreatives.map(c =>
        `| ${c.name} | ${c.format} | ${fmtCur(c.spend)} | ${fmtDec(c.roas)}× | ${fmtPct(c.ctr)} |`
      );
      return `# Top Créatives — ${data.period.label}\n\n| Créative | Format | Spend | ROAS | CTR |\n|---|---|---|---|---|\n${rows.join("\n")}`;
    }

    case "insights-meta":
      return `# Insights Meta — ${data.period.label}\n\n${data.insightsMeta.map(l => `- ${l}`).join("\n")}`;

    case "next-meta":
      return `# Next Steps Meta — ${data.period.label}\n\n${data.nextStepsMeta.map(l => `- ${l}`).join("\n")}`;

    case "next-global":
      return `# Next Steps Global — ${data.period.label}\n\n${data.nextStepsGlobal.map(l => `- ${l}`).join("\n")}`;

    case "budget": {
      const rows = data.budget.map(b =>
        `| ${b.platform} | ${fmtCur(b.planned)} | ${fmtCur(b.actual)} | ${b.variance >= 0 ? "+" : ""}${b.variance.toFixed(1)}% |`
      );
      return `# Budget — ${data.period.label}\n\n| Plateforme | Planifié | Réel | Écart |\n|---|---|---|---|\n${rows.join("\n")}`;
    }

    default:
      return `# ${label} (copie)\n\n_Personnalisez cette slide._`;
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (!arr?.length) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Build the canonical SlideConfig[] for the /deck page ─────────────────────
export function buildSlides(hasGoogle: boolean, data: DeckData | null, hasGA = false): SlideConfig[] {
  const metaNum = hasGoogle ? "03" : "02";
  const gaNum = String((hasGoogle ? 3 : 2) + 1).padStart(2, "0");
  const budgetNum = String((hasGoogle ? 3 : 2) + (hasGA ? 1 : 0) + 1).padStart(2, "0");

  const topCreativesPages = data ? chunk(data.topCreatives, TOP_CREATIVES_PER_SLIDE).length : 1;
  const googleCampaignsPages = data ? chunk(data.googleCampaigns, CAMPAIGNS_PER_SLIDE).length : 1;
  const metaCampaignsPages = data ? chunk(data.metaCampaigns, CAMPAIGNS_PER_SLIDE).length : 1;

  const topCreativesSlides: SlideConfig[] = Array.from({ length: topCreativesPages }, (_, i) => ({
    id: topCreativesPages > 1 ? `top-creatives-${i + 1}` : "top-creatives",
    label: topCreativesPages > 1 ? `Top Créatives ${i + 1}/${topCreativesPages}` : "Top Créatives",
    section: 3,
    render: (d, n) => (
      <TopCreativesSlide
        title={topCreativesPages > 1 ? `Top Créatifs (${i + 1}/${topCreativesPages})` : "Top Créatifs"}
        creatives={d.topCreatives.slice(i * TOP_CREATIVES_PER_SLIDE, (i + 1) * TOP_CREATIVES_PER_SLIDE)}
        slideNumber={n}
      />
    ),
  }));

  const googleCampaignsSlides: SlideConfig[] = Array.from({ length: googleCampaignsPages }, (_, i) => ({
    id: googleCampaignsPages > 1 ? `google-campaigns-${i + 1}` : "google-campaigns",
    label: googleCampaignsPages > 1 ? `Campagnes Google ${i + 1}/${googleCampaignsPages}` : "Campagnes Google",
    section: 2,
    render: (d, n, cb) => (
      <CampaignTableSlide
        title={googleCampaignsPages > 1 ? `Google Ads — Campagnes (${i + 1}/${googleCampaignsPages})` : "Google Ads — Campagnes"}
        campaigns={d.googleCampaigns.slice(i * CAMPAIGNS_PER_SLIDE, (i + 1) * CAMPAIGNS_PER_SLIDE)}
        slideNumber={n}
        periodLabel={`${d.period.label} vs ${d.previousPeriod.label}`}
        {...cb}
      />
    ),
  }));

  const paginateBullets = (
    idBase: string,
    labelBase: string,
    section: number,
    pick: (d: DeckData) => string[],
    makeTitle: (page: number, total: number) => string,
    Comp: "learnings" | "next-steps",
    accent?: "blue" | "violet",
    nextStepTitle?: string,
  ): SlideConfig[] => {
    const pageCount = data ? Math.max(1, chunk(pick(data), BULLETS_PER_SLIDE).length) : 1;
    return Array.from({ length: pageCount }, (_, i) => ({
      id: pageCount > 1 ? `${idBase}-${i + 1}` : idBase,
      label: pageCount > 1 ? `${labelBase} ${i + 1}/${pageCount}` : labelBase,
      section,
      render: (d, n, cb) => {
        const slice = pick(d).slice(i * BULLETS_PER_SLIDE, (i + 1) * BULLETS_PER_SLIDE);
        if (Comp === "learnings") {
          return <LearningsSlide learnings={slice} accent={accent} slideNumber={n} {...cb} />;
        }
        return (
          <NextStepsSlide
            title={pageCount > 1 ? `${makeTitle(i + 1, pageCount)}` : (nextStepTitle ?? labelBase)}
            steps={slice}
            accent={accent}
            slideNumber={n}
            {...cb}
          />
        );
      },
    }));
  };

  const learningsGlobalSlides = paginateBullets(
    "learnings-global", "Points Clés Global", 1,
    (d) => d.learnings,
    (p, t) => `Points Clés — Global (${p}/${t})`,
    "learnings",
  );
  const insightsGoogleSlides = paginateBullets(
    "insights-google", "Points Clés Google", 2,
    (d) => d.insightsGoogle,
    (p, t) => `Points Clés — Google (${p}/${t})`,
    "learnings",
  );
  const insightsMetaSlides = paginateBullets(
    "insights-meta", "Points Clés Meta", 3,
    (d) => d.insightsMeta,
    (p, t) => `Points Clés — Meta (${p}/${t})`,
    "learnings",
    "violet",
  );
  const nextGoogleSlides = paginateBullets(
    "next-google", "Next Steps Google", 2,
    (d) => d.nextStepsGoogle,
    (p, t) => `Next Steps — Google Ads (${p}/${t})`,
    "next-steps",
    undefined,
    "Next Steps — Google Ads",
  );
  const nextMetaSlides = paginateBullets(
    "next-meta", "Next Steps Meta", 3,
    (d) => d.nextStepsMeta,
    (p, t) => `Next Steps — Meta Ads (${p}/${t})`,
    "next-steps",
    "violet",
    "Next Steps — Meta Ads",
  );
  const nextGlobalSlides = paginateBullets(
    "next-global", "Next Steps Global", 4,
    (d) => d.nextStepsGlobal,
    (p, t) => `Next Steps — Global (${p}/${t})`,
    "next-steps",
    undefined,
    "Next Steps — Global",
  );

  const metaCampaignsSlides: SlideConfig[] = Array.from({ length: metaCampaignsPages }, (_, i) => ({
    id: metaCampaignsPages > 1 ? `meta-campaigns-${i + 1}` : "meta-campaigns",
    label: metaCampaignsPages > 1 ? `Campagnes Meta ${i + 1}/${metaCampaignsPages}` : "Campagnes Meta",
    section: 3,
    render: (d, n, cb) => (
      <CampaignTableSlide
        title={metaCampaignsPages > 1 ? `Meta Ads — Campagnes (${i + 1}/${metaCampaignsPages})` : "Meta Ads — Campagnes"}
        campaigns={d.metaCampaigns.slice(i * CAMPAIGNS_PER_SLIDE, (i + 1) * CAMPAIGNS_PER_SLIDE)}
        accent="violet"
        slideNumber={n}
        periodLabel={`${d.period.label} vs ${d.previousPeriod.label}`}
        {...cb}
      />
    ),
  }));

  return [
    { id: "cover", label: "Cover", section: 0, dark: true, render: (d, n, cb) => <CoverSlide data={d} slideNumber={n} {...cb} /> },
    { id: "agenda", label: "Agenda", section: 0, render: (d) => <AgendaSlide data={d} /> },

    { id: "s1-div", label: "Section 1", section: 1, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber="01" title="Vue Globale" subtitle="Highlights · Performance · Nouveaux Clients" slideNumber={n} {...cb} /> },
    { id: "highlights", label: "Highlights", section: 1, render: (d, n, cb) => <HighlightsSlide data={d} slideNumber={n} {...cb} /> },
    { id: "global-table", label: "Tableau Global", section: 1, render: (d, n, cb) => <GlobalTableSlide data={d} slideNumber={n} {...cb} /> },
    { id: "nc-table", label: "NC / CP-NC", section: 1, render: (d, n, cb) => <NCSlide data={d} slideNumber={n} {...cb} /> },
    ...learningsGlobalSlides,

    { id: "s2-div", label: "Section 2", section: 2, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber="02" title="Focus Google Ads" subtitle="Vue globale · Campagnes · Brand Search · Pmax" slideNumber={n} {...cb} /> },
    { id: "google-kpi", label: "Google KPIs", section: 2, render: (d, n, cb) => <KPIOverviewSlide title="Google Ads — Vue Globale" metrics={d.googleOverview} slideNumber={n} {...cb} /> },
    ...googleCampaignsSlides,
    ...insightsGoogleSlides,
    ...nextGoogleSlides,

    { id: "s3-div", label: `Section ${hasGoogle ? 3 : 2}`, section: 3, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber={metaNum} title="Focus Meta Ads" subtitle="Vue globale · Campagnes · Top Créas · Points Clés" slideNumber={n} {...cb} /> },
    { id: "meta-kpi", label: "Meta KPIs", section: 3, render: (d, n, cb) => <KPIOverviewSlide title="Meta Ads — Vue Globale" metrics={d.metaOverview} accent="violet" slideNumber={n} {...cb} /> },
    ...metaCampaignsSlides,
    ...topCreativesSlides,
    ...insightsMetaSlides,
    ...nextMetaSlides,

    ...(hasGA ? [
      { id: "sga-div", label: "Section GA", section: 5, dark: true, render: (_: DeckData, n: number, cb?: EditCallbacks) => <SectionDividerSlide sectionNumber={gaNum} title="Analyse Site Web" subtitle="Google Analytics · Top Pages · Appareils · Sources" slideNumber={n} {...cb} /> } as SlideConfig,
      { id: "ga-overview", label: "GA Overview", section: 5, render: (d: DeckData, n: number, cb?: EditCallbacks) => <GAOverviewSlide overview={d.gaOverview!} prevOverview={d.gaPrevOverview} slideNumber={n} {...cb} /> } as SlideConfig,
      { id: "ga-top-pages", label: "Top Pages", section: 5, render: (d: DeckData, n: number, cb?: EditCallbacks) => <GATopPagesSlide pages={d.gaTopPages ?? []} slideNumber={n} {...cb} /> } as SlideConfig,
      { id: "ga-devices-sources", label: "Appareils & Sources", section: 5, render: (d: DeckData, n: number, cb?: EditCallbacks) => <GADeviceSourceSlide devices={d.gaDevices ?? []} sources={d.gaSources ?? []} slideNumber={n} {...cb} /> } as SlideConfig,
    ] : []),

    { id: "s4-div", label: "Section Budget", section: 4, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber={budgetNum} title="Next Steps & Budget" subtitle="Actions globales · Budget mensuel" slideNumber={n} {...cb} /> },
    ...nextGlobalSlides,
    { id: "budget", label: "Budget", section: 4, render: (d, n, cb) => <BudgetSlide budget={d.budget} period={d.period.label} slideNumber={n} {...cb} /> },
  ];
}
