"use client";

import { useState, useMemo, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Presentation,
  Building2,
  Calendar,
  Loader2,
  Sparkles,
  FileDown,
} from "lucide-react";
import {
  mockClients,
  getAvailablePeriods,
  getPreviousPeriod,
  generateMockDeckData,
  type DeckClient,
  type DeckPeriod,
  type DeckData,
} from "@/lib/deck-data";
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
} from "@/components/deck/slides";

// ── Section config ───────────────────────────────────────────────────────────

interface SlideConfig {
  id: string;
  label: string;
  section: number;
  render: (data: DeckData, slideNumber: number) => React.ReactNode;
}

function buildSlides(): SlideConfig[] {
  return [
    // Cover & Agenda
    { id: "cover", label: "Cover", section: 0, render: (d) => <CoverSlide data={d} /> },
    { id: "agenda", label: "Agenda", section: 0, render: (d) => <AgendaSlide data={d} /> },

    // Section 1 — Global Overview
    { id: "s1-div", label: "Section 1", section: 1, render: (_, n) => <SectionDividerSlide sectionNumber="01" title="Global Overview" subtitle="Highlights · Performance · Nouveaux Clients" slideNumber={n} /> },
    { id: "highlights", label: "Highlights", section: 1, render: (d, n) => <HighlightsSlide data={d} slideNumber={n} /> },
    { id: "global-table", label: "Tableau Global", section: 1, render: (d, n) => <GlobalTableSlide data={d} slideNumber={n} /> },
    { id: "nc-table", label: "NC / CP-NC", section: 1, render: (d, n) => <NCSlide data={d} slideNumber={n} /> },
    { id: "learnings-global", label: "Learnings Global", section: 1, render: (d, n) => <LearningsSlide learnings={d.learnings} slideNumber={n} /> },

    // Section 2 — Google Ads
    { id: "s2-div", label: "Section 2", section: 2, render: (_, n) => <SectionDividerSlide sectionNumber="02" title="Focus Google Ads" subtitle="Vue globale · Campagnes · Brand Search · Pmax" slideNumber={n} /> },
    { id: "google-kpi", label: "Google KPIs", section: 2, render: (d, n) => <KPIOverviewSlide title="Google Ads — Vue Globale" metrics={d.googleOverview} slideNumber={n} /> },
    { id: "google-campaigns", label: "Campagnes Google", section: 2, render: (d, n) => <CampaignTableSlide title="Google Ads — Campagnes" campaigns={d.googleCampaigns} slideNumber={n} periodLabel={`${d.period.label} vs ${d.previousPeriod.label}`} /> },
    { id: "insights-google", label: "Insights Google", section: 2, render: (d, n) => <LearningsSlide learnings={d.insightsGoogle} slideNumber={n} /> },
    { id: "next-google", label: "Next Steps Google", section: 2, render: (d, n) => <NextStepsSlide title="Next Steps — Google Ads" steps={d.nextStepsGoogle} slideNumber={n} /> },

    // Section 3 — Meta Ads
    { id: "s3-div", label: "Section 3", section: 3, render: (_, n) => <SectionDividerSlide sectionNumber="03" title="Focus Meta Ads" subtitle="Vue globale · Campagnes · Top Créas · Learnings" slideNumber={n} /> },
    { id: "meta-kpi", label: "Meta KPIs", section: 3, render: (d, n) => <KPIOverviewSlide title="Meta Ads — Vue Globale" metrics={d.metaOverview} accent="violet" slideNumber={n} /> },
    { id: "meta-campaigns", label: "Campagnes Meta", section: 3, render: (d, n) => <CampaignTableSlide title="Meta Ads — Campagnes" campaigns={d.metaCampaigns} accent="violet" slideNumber={n} periodLabel={`${d.period.label} vs ${d.previousPeriod.label}`} /> },
    { id: "top-creatives", label: "Top Créatives", section: 3, render: (d, n) => <TopCreativesSlide creatives={d.topCreatives} slideNumber={n} /> },
    { id: "insights-meta", label: "Insights Meta", section: 3, render: (d, n) => <LearningsSlide learnings={d.insightsMeta} accent="violet" slideNumber={n} /> },
    { id: "next-meta", label: "Next Steps Meta", section: 3, render: (d, n) => <NextStepsSlide title="Next Steps — Meta Ads" steps={d.nextStepsMeta} accent="violet" slideNumber={n} /> },

    // Section 4 — Next Steps & Budget
    { id: "s4-div", label: "Section 4", section: 4, render: (_, n) => <SectionDividerSlide sectionNumber="04" title="Next Steps & Budget" subtitle="Actions globales · Budget mensuel" slideNumber={n} /> },
    { id: "next-global", label: "Next Steps Global", section: 4, render: (d, n) => <NextStepsSlide title="Next Steps — Global" steps={d.nextStepsGlobal} slideNumber={n} /> },
    { id: "budget", label: "Budget", section: 4, render: (d, n) => <BudgetSlide budget={d.budget} period={d.period.label} slideNumber={n} /> },
  ];
}

const SECTION_LABELS = [
  "Intro",
  "Global Overview",
  "Google Ads",
  "Meta Ads",
  "Next Steps & Budget",
];

const SECTION_COLORS: Record<number, string> = {
  0: "#2CA6F9",
  1: "#2CA6F9",
  2: "#2CA6F9",
  3: "#7F5AFD",
  4: "#2CA6F9",
};

// ── Main Page ────────────────────────────────────────────────────────────────

export default function DeckPage() {
  const [selectedClient, setSelectedClient] = useState<DeckClient>(mockClients[0]);
  const [selectedPeriod, setSelectedPeriod] = useState<DeckPeriod>(getAvailablePeriods()[1]); // previous month
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [deckGenerated, setDeckGenerated] = useState(false);
  const slideContainerRef = useRef<HTMLDivElement>(null);

  const periods = useMemo(() => getAvailablePeriods(), []);
  const slides = useMemo(() => buildSlides(), []);

  const deckData = useMemo(() => {
    if (!deckGenerated) return null;
    return generateMockDeckData(selectedClient, selectedPeriod);
  }, [deckGenerated, selectedClient, selectedPeriod]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    // Simulate AI generation delay
    await new Promise((r) => setTimeout(r, 2000));
    setDeckGenerated(true);
    setCurrentSlide(0);
    setIsGenerating(false);
  };

  const goToSlide = (idx: number) => {
    setCurrentSlide(Math.max(0, Math.min(slides.length - 1, idx)));
  };

  const currentSection = slides[currentSlide]?.section ?? 0;

  // Group slides by section for the filmstrip
  const sectionSlides = useMemo(() => {
    const groups: Record<number, { idx: number; slide: SlideConfig }[]> = {};
    slides.forEach((s, i) => {
      if (!groups[s.section]) groups[s.section] = [];
      groups[s.section].push({ idx: i, slide: s });
    });
    return groups;
  }, [slides]);

  // ── Setup view (before generation) ──────────────────────────────────────
  if (!deckGenerated) {
    return (
      <div className="h-full bg-gray-50 overflow-auto">
        <div className="max-w-2xl mx-auto py-12 px-6">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4" style={{ backgroundColor: "#0944A1" }}>
              <Presentation className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-extrabold text-gray-900" style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}>
              Monthly Business Review
            </h1>
            <p className="text-sm text-gray-500 mt-2">
              Génère un deck de 20+ slides à partir des données Meta Ads & Google Ads
            </p>
          </div>

          {/* Client selection */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <Building2 className="w-4 h-4" />
              Client
            </label>
            <select
              value={selectedClient.id}
              onChange={(e) => {
                const c = mockClients.find((cl) => cl.id === e.target.value);
                if (c) setSelectedClient(c);
              }}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {mockClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.industry ? `— ${c.industry}` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Period selection */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <Calendar className="w-4 h-4" />
              Période (M)
            </label>
            <select
              value={selectedPeriod.month}
              onChange={(e) => {
                const p = periods.find((pp) => pp.month === e.target.value);
                if (p) setSelectedPeriod(p);
              }}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {periods.map((p) => (
                <option key={p.month} value={p.month}>
                  {p.label} ({p.startDate} → {p.endDate})
                </option>
              ))}
            </select>
            <div className="mt-2 text-xs text-gray-400">
              Comparaison automatique avec {getPreviousPeriod(selectedPeriod).label} (M-1)
            </div>
          </div>

          {/* Data sources */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <div className="text-sm font-semibold text-gray-700 mb-3">Sources de données</div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  Google Ads
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                  Mock data
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#7F5AFD" }} />
                  Meta Ads
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                  Mock data
                </span>
              </div>
            </div>
            <div className="mt-3 text-xs text-gray-400">
              Connectez vos comptes dans Settings pour utiliser des données réelles.
            </div>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-60"
            style={{ backgroundColor: "#0944A1" }}
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Génération du deck en cours…
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Générer le deck ({slides.length} slides)
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // ── Deck viewer ─────────────────────────────────────────────────────────
  if (!deckData) return null;

  return (
    <div className="h-full flex flex-col bg-gray-100 overflow-hidden">
      {/* Top bar */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setDeckGenerated(false)}
            className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Retour
          </button>
          <div className="h-4 w-px bg-gray-200" />
          <div>
            <span className="text-sm font-semibold text-gray-900">{deckData.client.name}</span>
            <span className="text-xs text-gray-400 ml-2">{deckData.period.label}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            Slide {currentSlide + 1} / {slides.length}
          </span>
          <button
            onClick={() => {
              alert("Export PPTX coming soon. Le deck sera exporté au format PowerPoint avec le design system Impulse Analytics.");
            }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors text-gray-700"
          >
            <FileDown className="w-3.5 h-3.5" />
            .pptx
          </button>
          <button
            onClick={() => {
              alert("Google Slides export coming soon — connect your Google account in Settings.");
            }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white"
            style={{ backgroundColor: "#0944A1" }}
          >
            <Download className="w-3.5 h-3.5" />
            Google Slides
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel — section nav + filmstrip */}
        <div className="w-52 flex-shrink-0 bg-white border-r border-gray-200 overflow-y-auto">
          {Object.entries(sectionSlides).map(([secStr, items]) => {
            const sec = Number(secStr);
            return (
              <div key={sec}>
                <div
                  className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: SECTION_COLORS[sec] ?? "#2CA6F9" }}
                >
                  {SECTION_LABELS[sec]}
                </div>
                {items.map(({ idx, slide }) => (
                  <button
                    key={slide.id}
                    onClick={() => goToSlide(idx)}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                      currentSlide === idx
                        ? "bg-blue-50 text-blue-700 font-semibold"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <span className="text-gray-400 mr-1.5">{idx + 1}.</span>
                    {slide.label}
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        {/* Center — slide preview */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 overflow-auto" ref={slideContainerRef}>
          <div className="w-full max-w-4xl">
            {slides[currentSlide].render(deckData, currentSlide + 1)}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-4 mt-4">
            <button
              onClick={() => goToSlide(currentSlide - 1)}
              disabled={currentSlide === 0}
              className="p-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4 text-gray-600" />
            </button>

            {/* Section dots */}
            <div className="flex gap-1">
              {slides.map((_, i) => (
                <button
                  key={i}
                  onClick={() => goToSlide(i)}
                  className="transition-all"
                  style={{
                    width: currentSlide === i ? 16 : 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor:
                      currentSlide === i
                        ? SECTION_COLORS[slides[i].section] ?? "#2CA6F9"
                        : "#D1D5DB",
                  }}
                />
              ))}
            </div>

            <button
              onClick={() => goToSlide(currentSlide + 1)}
              disabled={currentSlide === slides.length - 1}
              className="p-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4 text-gray-600" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
