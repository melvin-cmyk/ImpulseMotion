"use client";
/**
 * /deck/preview — visual preview of all static slides with mock data.
 * Useful for quickly reviewing slide design without going through the full deck flow.
 * Add ?slide=<id> to render a single slide full-bleed (handy for screenshots).
 */
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  CoverSlide,
  AgendaSlide,
  SectionDividerSlide,
  HighlightsSlide,
  GlobalTableSlide,
  NCSlide,
  CampaignTableSlide,
  TopCreativesSlide,
  LearningsSlide,
  NextStepsSlide,
  BudgetSlide,
  KPIOverviewSlide,
} from "@/components/deck/slides";
import { mockClients, buildPeriod, generateMockDeckData } from "@/lib/deck-data";

export default function DeckPreviewPage() {
  const searchParams = useSearchParams();
  const onlyId = searchParams.get("slide");
  const data = useMemo(() => {
    const client = mockClients[0];
    const period = buildPeriod(2026, 3);
    return generateMockDeckData(client, period);
  }, []);

  const slides: { id: string; title: string; node: React.ReactNode }[] = [
    { id: "cover", title: "Cover", node: <CoverSlide data={data} slideNumber={1} /> },
    { id: "agenda", title: "Agenda", node: <AgendaSlide data={data} /> },
    { id: "section1", title: "Section divider 1", node: <SectionDividerSlide sectionNumber="01" title="Vue d'ensemble" subtitle="Performance globale" slideNumber={3} /> },
    { id: "highlights", title: "Highlights", node: <HighlightsSlide data={data} slideNumber={4} /> },
    { id: "globalTable", title: "Global table", node: <GlobalTableSlide data={data} slideNumber={5} /> },
    { id: "nc", title: "Nouveaux clients", node: <NCSlide data={data} slideNumber={6} /> },
    { id: "kpiGoogle", title: "Google KPIs", node: <KPIOverviewSlide title="Google Ads — Vue Globale" metrics={data.googleOverview} slideNumber={7} /> },
    { id: "campGoogle", title: "Google campagnes", node: <CampaignTableSlide title="Google Ads — Campagnes" campaigns={data.googleCampaigns} slideNumber={8} /> },
    { id: "learnGoogle", title: "Learnings (Google accent)", node: <LearningsSlide learnings={data.learnings} slideNumber={9} /> },
    { id: "nextGoogle", title: "Google next steps", node: <NextStepsSlide title="Next Steps — Google Ads" steps={data.nextStepsGoogle} slideNumber={10} /> },
    { id: "kpiMeta", title: "Meta KPIs", node: <KPIOverviewSlide title="Meta Ads — Vue Globale" metrics={data.metaOverview} accent="violet" slideNumber={11} /> },
    { id: "campMeta", title: "Meta campagnes", node: <CampaignTableSlide title="Meta Ads — Campagnes" campaigns={data.metaCampaigns} accent="violet" slideNumber={12} /> },
    { id: "creativeMeta", title: "Meta créatifs", node: <TopCreativesSlide creatives={data.topCreatives} slideNumber={13} /> },
    { id: "learnMeta", title: "Learnings (Meta accent)", node: <LearningsSlide learnings={data.learnings} accent="violet" slideNumber={14} /> },
    { id: "nextMeta", title: "Meta next steps", node: <NextStepsSlide title="Next Steps — Meta Ads" steps={data.nextStepsMeta} accent="violet" slideNumber={15} /> },
    { id: "budget", title: "Budget", node: <BudgetSlide budget={data.budget} period={data.period.label} slideNumber={16} /> },
    { id: "nextGlobal", title: "Next steps global", node: <NextStepsSlide title="Next Steps — Global" steps={data.nextStepsGlobal} slideNumber={17} /> },
  ];

  if (onlyId) {
    const single = slides.find((s) => s.id === onlyId);
    if (!single) return <div className="p-8">Slide &quot;{onlyId}&quot; introuvable</div>;
    return (
      <div className="min-h-screen bg-white">
        <div className="w-screen" style={{ aspectRatio: "16 / 9" }}>{single.node}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <h1 className="text-2xl font-bold mb-6">Deck — preview statique (mock data)</h1>
      <div className="space-y-12 max-w-[1280px] mx-auto">
        {slides.map((s) => (
          <section key={s.id} id={s.id}>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{s.title}</div>
            <div className="bg-white shadow-lg rounded-lg overflow-hidden" style={{ aspectRatio: "16 / 9" }}>
              {s.node}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
