"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  Trash2,
  GripVertical,
  Plus,
  Edit2,
} from "lucide-react";
import {
  SlideEditorToolbar,
  SlideElementItem,
  useSlideEditor,
  type SlideElement,
} from "@/components/deck/slide-editor";
import {
  getAvailablePeriods,
  getPreviousPeriod,
  type DeckClient,
  type DeckPeriod,
  type DeckData,
} from "@/lib/deck-data";
// fetchDeckData removed — now using /api/deck/data (server-side, avoids mixed content)
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
import { AIPanel } from "@/components/deck/ai-panel";
import { exportDeckToPptx } from "@/lib/deck-export";
import { SlideStyleContext, type TextStyle } from "@/components/deck/slide-style-context";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DynamicDeck } from "@/components/deck/DynamicDeck";
import type { SlideData } from "@/types/deck";

// ── Section config ───────────────────────────────────────────────────────────

/** Generate contextual Markdown from real deck data for a given slide id. */
function extractSlideMarkdown(slideId: string, label: string, data: DeckData): string {
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
      return `# Learnings Global — ${data.period.label}\n\n${data.learnings.map(l => `- ${l}`).join("\n")}`;

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

interface SlideConfig {
  id: string;
  label: string;
  section: number;
  dark?: boolean; // true for dark-background slides (cover, section dividers)
  render: (data: DeckData, slideNumber: number, editCallbacks?: {
    onEdit?: (field: string, slideIndex: number, newValue: string) => void;
    getOverride?: (slideIndex: number, field: string) => string | undefined;
  }) => React.ReactNode;
}

function buildSlides(): SlideConfig[] {
  return [
    // Cover & Agenda
    { id: "cover", label: "Cover", section: 0, dark: true, render: (d, n, cb) => <CoverSlide data={d} slideNumber={n} {...cb} /> },
    { id: "agenda", label: "Agenda", section: 0, render: (d) => <AgendaSlide data={d} /> },

    // Section 1 — Global Overview
    { id: "s1-div", label: "Section 1", section: 1, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber="01" title="Global Overview" subtitle="Highlights · Performance · Nouveaux Clients" slideNumber={n} {...cb} /> },
    { id: "highlights", label: "Highlights", section: 1, render: (d, n, cb) => <HighlightsSlide data={d} slideNumber={n} {...cb} /> },
    { id: "global-table", label: "Tableau Global", section: 1, render: (d, n, cb) => <GlobalTableSlide data={d} slideNumber={n} {...cb} /> },
    { id: "nc-table", label: "NC / CP-NC", section: 1, render: (d, n, cb) => <NCSlide data={d} slideNumber={n} {...cb} /> },
    { id: "learnings-global", label: "Learnings Global", section: 1, render: (d, n, cb) => <LearningsSlide learnings={d.learnings} slideNumber={n} {...cb} /> },

    // Section 2 — Google Ads
    { id: "s2-div", label: "Section 2", section: 2, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber="02" title="Focus Google Ads" subtitle="Vue globale · Campagnes · Brand Search · Pmax" slideNumber={n} {...cb} /> },
    { id: "google-kpi", label: "Google KPIs", section: 2, render: (d, n, cb) => <KPIOverviewSlide title="Google Ads — Vue Globale" metrics={d.googleOverview} slideNumber={n} {...cb} /> },
    { id: "google-campaigns", label: "Campagnes Google", section: 2, render: (d, n, cb) => <CampaignTableSlide title="Google Ads — Campagnes" campaigns={d.googleCampaigns} slideNumber={n} periodLabel={`${d.period.label} vs ${d.previousPeriod.label}`} {...cb} /> },
    { id: "insights-google", label: "Insights Google", section: 2, render: (d, n, cb) => <LearningsSlide learnings={d.insightsGoogle} slideNumber={n} {...cb} /> },
    { id: "next-google", label: "Next Steps Google", section: 2, render: (d, n, cb) => <NextStepsSlide title="Next Steps — Google Ads" steps={d.nextStepsGoogle} slideNumber={n} {...cb} /> },

    // Section 3 — Meta Ads
    { id: "s3-div", label: "Section 3", section: 3, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber="03" title="Focus Meta Ads" subtitle="Vue globale · Campagnes · Top Créas · Learnings" slideNumber={n} {...cb} /> },
    { id: "meta-kpi", label: "Meta KPIs", section: 3, render: (d, n, cb) => <KPIOverviewSlide title="Meta Ads — Vue Globale" metrics={d.metaOverview} accent="violet" slideNumber={n} {...cb} /> },
    { id: "meta-campaigns", label: "Campagnes Meta", section: 3, render: (d, n, cb) => <CampaignTableSlide title="Meta Ads — Campagnes" campaigns={d.metaCampaigns} accent="violet" slideNumber={n} periodLabel={`${d.period.label} vs ${d.previousPeriod.label}`} {...cb} /> },
    { id: "top-creatives", label: "Top Créatives", section: 3, render: (d, n) => <TopCreativesSlide creatives={d.topCreatives} slideNumber={n} /> },
    { id: "insights-meta", label: "Insights Meta", section: 3, render: (d, n, cb) => <LearningsSlide learnings={d.insightsMeta} accent="violet" slideNumber={n} {...cb} /> },
    { id: "next-meta", label: "Next Steps Meta", section: 3, render: (d, n, cb) => <NextStepsSlide title="Next Steps — Meta Ads" steps={d.nextStepsMeta} accent="violet" slideNumber={n} {...cb} /> },

    // Section 4 — Next Steps & Budget
    { id: "s4-div", label: "Section 4", section: 4, dark: true, render: (_, n, cb) => <SectionDividerSlide sectionNumber="04" title="Next Steps & Budget" subtitle="Actions globales · Budget mensuel" slideNumber={n} {...cb} /> },
    { id: "next-global", label: "Next Steps Global", section: 4, render: (d, n, cb) => <NextStepsSlide title="Next Steps — Global" steps={d.nextStepsGlobal} slideNumber={n} {...cb} /> },
    { id: "budget", label: "Budget", section: 4, render: (d, n, cb) => <BudgetSlide budget={d.budget} period={d.period.label} slideNumber={n} {...cb} /> },
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

interface DroppedBlock {
  id: string;
  content: string;
  slideIndex: number;
  x: number; // % of canvas width
  y: number; // % of canvas height
  w: number; // % of canvas width
  h?: number; // % of canvas height (auto if undefined)
  fontFamily?: string;
  textColor?: string;
  fontSize?: number;
}

interface SlideOverride {
  slideIndex: number;
  field: string;
  value: string;
}

export default function DeckPage() {
  const searchParams = useSearchParams();
  const [clients, setClients] = useState<DeckClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsNeedAuth, setClientsNeedAuth] = useState(false);
  const [metaNeedsReconnect, setMetaNeedsReconnect] = useState(false);
  const [selectedClient, setSelectedClient] = useState<DeckClient | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<DeckPeriod>(() => {
    const periodParam = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("period") : null;
    const periods = getAvailablePeriods();
    if (periodParam) {
      const found = periods.find((p) => p.month === periodParam);
      if (found) return found;
    }
    return periods[1];
  });

  // Load real clients from Meta Ads + Google Ads on mount
  useEffect(() => {
    const clientParam = searchParams.get("client");
    fetch("/api/deck/clients")
      .then((r) => r.json())
      .then((data: { clients: DeckClient[]; needsAuth?: boolean; metaNeedsReconnect?: boolean }) => {
        if (data.needsAuth) {
          setClientsNeedAuth(true);
          return;
        }
        if (data.metaNeedsReconnect) setMetaNeedsReconnect(true);
        if (data.clients && data.clients.length > 0) {
          setClients(data.clients);
          if (clientParam) {
            const found = data.clients.find((c) => c.id === clientParam);
            setSelectedClient(found ?? data.clients[0]);
          } else {
            setSelectedClient(data.clients[0]);
          }
        }
      })
      .catch(() => {/* relay not available */})
      .finally(() => setClientsLoading(false));
  }, [searchParams]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [sharedDeckBanner, setSharedDeckBanner] = useState<{ client: string; period: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const p = new URLSearchParams(window.location.search);
    const c = p.get("client");
    const period = p.get("period");
    return c && period ? { client: c, period } : null;
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [deckGenerated, setDeckGenerated] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isPrintingPdf, setIsPrintingPdf] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [droppedBlocks, setDroppedBlocks] = useState<DroppedBlock[]>([]);
  const [slideOverrides, setSlideOverrides] = useState<SlideOverride[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [draggingBlock, setDraggingBlock] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [textStyles, setTextStyles] = useState<Record<string, TextStyle>>({});
  const [customSlides, setCustomSlides] = useState<{ id: string; label: string; content: string; fontFamily?: string }[]>([]);
  const [aiSlidesMode, setAiSlidesMode] = useState(false);
  // ── AI Dynamic Deck mode ─────────────────────────────────────────────────
  const [slideMode, setSlideMode] = useState<"static" | "ai">(() => {
    if (typeof window === "undefined") return "static";
    return new URLSearchParams(window.location.search).get("mode") === "ai" ? "ai" : "static";
  });
  const [aiDynamicSlides, setAiDynamicSlides] = useState<SlideData[]>([]);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiGenerateError, setAiGenerateError] = useState<string | null>(null);
  const [filmstripDragging, setFilmstripDragging] = useState<number | null>(null);
  const [filmstripDropTarget, setFilmstripDropTarget] = useState<number | null>(null);
  const [slideNotes, setSlideNotes] = useState<Record<string, string>>({});
  const [notePanelOpen, setNotePanelOpen] = useState(false);
  const [showOnlyWithNotes, setShowOnlyWithNotes] = useState(false);
  const [filmstripSearch, setFilmstripSearch] = useState("");
  const filmstripSearchRef = useRef<HTMLInputElement>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [showAddClientModal, setShowAddClientModal] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientMeta, setNewClientMeta] = useState("");
  const [newClientGoogle, setNewClientGoogle] = useState("");
  const commandPaletteInputRef = useRef<HTMLInputElement>(null);
  const lastGTimeRef = useRef<number>(0);
  const [userContext, setUserContext] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("context") ?? "";
  });
  const prevSlideRef = useRef<number>(-1);
  const slideContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const activeFilmstripItemRef = useRef<HTMLButtonElement>(null);
  const [slideTransition, setSlideTransition] = useState(false);
  const [editMode, setEditMode] = useState(true);
  const [editingCustomSlideId, setEditingCustomSlideId] = useState<string | null>(null);
  const [selectedGoogleCustomerId, setSelectedGoogleCustomerId] = useState<string>("");
  const [blockStyles, setBlockStyles] = useState<Record<string, { headerColor: string; rowColor: string; fontSize: number; fontFamily: string; textColor: string; borderColor: string; borderWidth: number }>>({});
  const [slideElements, setSlideElements] = useState<Record<number, SlideElement[]>>({});

  const periods = useMemo(() => getAvailablePeriods(), []);

  // ── Slide editor hook (elements / tools / drag) ───────────────────────────
  const slideEditor = useSlideEditor(
    canvasRef,
    slideElements[currentSlide] ?? [],
    (els) => setSlideElements((prev) => ({ ...prev, [currentSlide]: els }))
  );
  const staticSlides = useMemo(() => buildSlides(), []);
  const slides = useMemo(() => aiSlidesMode ? [] : staticSlides, [aiSlidesMode, staticSlides]);

  const currentSlideId = currentSlide < slides.length
    ? (slides[currentSlide]?.id ?? `slide-${currentSlide}`)
    : (customSlides[currentSlide - slides.length]?.id ?? `custom-${currentSlide}`);
  const currentSlideNote = slideNotes[currentSlideId] ?? "";

  const slidesWithNotesCount = useMemo(
    () => [...slides, ...customSlides].filter(s => !!slideNotes[s.id]).length,
    [slides, customSlides, slideNotes]
  );

  const [deckData, setDeckData] = useState<DeckData | null>(null);
  const [dataSource, setDataSource] = useState<"real" | "mock" | null>(null);
  const [dataSourceReason, setDataSourceReason] = useState<string | null>(null);

  const generateDeck = useCallback(async (client: DeckClient, period: DeckPeriod, contextOverride?: string, googleIdOverride?: string) => {
    setIsGenerating(true);
    setDataSource(null);
    setDataSourceReason(null);
    const prompt = contextOverride ?? userContext;
    const hasPrompt = prompt.trim().length > 0;

    // Merge manual Google Customer ID if provided and client doesn't already have one
    const effectiveClient: DeckClient = googleIdOverride && !client.googleCustomerId
      ? { ...client, googleCustomerId: googleIdOverride }
      : client;

    try {
      // Fetch real data via server-side route (avoids browser mixed content issues)
      const dataRes = await fetch("/api/deck/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: effectiveClient, period, userContext: prompt || undefined }),
      });

      let realData: DeckData | null = null;
      let source: "real" | "mock" = "mock";
      let reason: string | null = null;

      if (dataRes.ok) {
        const dataJson = await dataRes.json() as { data: DeckData; source: string; reason?: string };
        realData = dataJson.data ?? null;
        source = (dataJson.source === "real" ? "real" : "mock") as "real" | "mock";
        reason = dataJson.reason ?? null;
      } else {
        reason = `Erreur serveur: ${dataRes.status}`;
      }

      if (realData && source === "real") {
        setDeckData(realData);
        setDataSource("real");
        setDataSourceReason(null);
      } else {
        setDeckData(null);
        setDataSource("mock");
        setDataSourceReason(reason ?? "Relay non connecté — vérifiez que le relay tourne sur localhost:3457");
      }

      if (hasPrompt) {
        // AI mode: generate slides from user prompt + real data
        setAiSlidesMode(true);
        setCustomSlides([]);

        if (realData) {
          const genRes = await fetch("/api/deck/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: effectiveClient, period, userPrompt: prompt }),
          });

          if (genRes.ok) {
            const genJson = await genRes.json() as {
              slides: Array<{ id: string; title: string; content: string; notes?: string }>;
            };
            if (genJson.slides && genJson.slides.length > 0) {
              setCustomSlides(genJson.slides.map((s) => ({ id: s.id, label: s.title, content: s.content })));
              const noteEntries: Record<string, string> = {};
              genJson.slides.forEach((s) => { if (s.notes) noteEntries[s.id] = s.notes; });
              if (Object.keys(noteEntries).length > 0) {
                setSlideNotes((prev) => ({ ...prev, ...noteEntries }));
              }
            }
          }
        }
      } else {
        // Basic mode: static slides with real data
        setAiSlidesMode(false);
        setCustomSlides([]);
      }
    } catch (err) {
      setDeckData(null);
      setDataSource("mock");
      setDataSourceReason(String(err));
    }
    setDeckGenerated(true);
    setCurrentSlide(0);
    setIsGenerating(false);
  }, [userContext]);

  const autoGenerateRef = useRef(false);

  const handleGenerate = () => {
    if (selectedClient) generateDeck(selectedClient, selectedPeriod, undefined, selectedGoogleCustomerId || undefined);
  };

  // ── AI Dynamic Deck generation ──────────────────────────────────────────
  const handleGenerateAiDeck = useCallback(async () => {
    if (!selectedClient) return;
    setIsGeneratingAi(true);
    setAiGenerateError(null);
    try {
      const sectionsParam = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("sections")
        : null;
      const sections = sectionsParam ? sectionsParam.split(",") : ["global", "google", "meta", "budget", "learnings"];
      const budgetsParam = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("budgets")
        : null;
      const budgets = budgetsParam ? JSON.parse(budgetsParam) : {};

      const res = await fetch("/api/deck/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: selectedClient.id,
          platform: selectedClient.platform ?? "both",
          dateRange: { startDate: selectedPeriod.startDate, endDate: selectedPeriod.endDate, label: selectedPeriod.label },
          sections,
          context: userContext || undefined,
          budgets,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => `Erreur ${res.status}`);
        throw new Error(errText || `Erreur ${res.status}`);
      }

      const json = await res.json() as { slides?: SlideData[] };
      if (!json.slides || json.slides.length === 0) {
        throw new Error("L'IA n'a retourné aucune slide. Réessayez.");
      }
      setAiDynamicSlides(json.slides);
    } catch (err) {
      setAiGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGeneratingAi(false);
    }
  }, [selectedClient, selectedPeriod, userContext]);

  // Auto-generate if coming from builder (client + period in URL params)
  // OR load from history if historyId is in URL params
  useEffect(() => {
    if (autoGenerateRef.current) return;
    const p = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    if (!p) return;

    // History mode: load a previously saved deck
    const historyId = p.get("historyId");
    if (historyId) {
      autoGenerateRef.current = true;
      setSlideMode("ai");
      setIsGeneratingAi(true);
      fetch(`/api/deck/history?id=${encodeURIComponent(historyId)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.entry?.slides?.length > 0) {
            setAiDynamicSlides(d.entry.slides);
          } else {
            setAiGenerateError("Deck introuvable ou vide.");
          }
        })
        .catch((err) => setAiGenerateError(String(err)))
        .finally(() => setIsGeneratingAi(false));
      return;
    }

    const hasBuilderParams = p.has("client") && p.has("period");
    if (!hasBuilderParams || !selectedClient || clientsLoading) return;
    autoGenerateRef.current = true;
    const isAiMode = p.get("mode") === "ai";
    if (isAiMode) {
      handleGenerateAiDeck();
    } else {
      generateDeck(selectedClient, selectedPeriod, userContext || undefined, selectedGoogleCustomerId || undefined);
    }
  }, [selectedClient, clientsLoading, generateDeck, handleGenerateAiDeck, selectedPeriod, userContext, selectedGoogleCustomerId]);

  const handleExportPptx = async () => {
    if (!deckData) return;
    setIsExporting(true);
    try {
      const blob = await exportDeckToPptx(deckData, customSlides, droppedBlocks, slideElements);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `MBR_${deckData.client.name.replace(/\s+/g, "_")}_${deckData.period.month}.pptx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      console.error("Export PPTX failed:", err);
      alert("Erreur lors de l'export PPTX : " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsExporting(false);
    }
  };

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  }, []);

  const handleExportPdf = useCallback(() => {
    if (!deckData) return;
    setIsPrintingPdf(true);
  }, [deckData]);

  const handleExportCsvNotes = useCallback(() => {
    const totalSlides = slides.length + customSlides.length;
    if (totalSlides === 0) return;
    const rows: string[][] = [["#", "Titre", "Type", "Note"]];
    slides.forEach((slide, i) => {
      const note = slideNotes[slide.id] ?? "";
      rows.push([String(i + 1), slide.label ?? `Slide ${i + 1}`, "standard", note]);
    });
    customSlides.forEach((cs, i) => {
      const note = slideNotes[cs.id] ?? "";
      rows.push([String(slides.length + i + 1), cs.label ?? `Custom ${i + 1}`, "custom", note]);
    });
    const csv = rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const clientName = deckData?.client?.name?.replace(/\s+/g, "_") ?? "deck";
    const period = deckData?.period?.month ?? "notes";
    a.download = `Notes_${clientName}_${period}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, [slides, customSlides, slideNotes, deckData]);

  useEffect(() => {
    if (!isPrintingPdf) return;
    const handleAfterPrint = () => {
      setIsPrintingPdf(false);
      showToast("✅ PDF généré — vérifiez votre dossier Téléchargements");
      window.removeEventListener("afterprint", handleAfterPrint);
    };
    window.addEventListener("afterprint", handleAfterPrint);
    const t = setTimeout(() => {
      window.print();
    }, 400);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, [isPrintingPdf, showToast]);

  const handleResetDeck = useCallback(() => {
    setSlideOverrides([]);
    setCustomSlides([]);
    setCurrentSlide(0);
    showToast("♻️ Deck réinitialisé");
  }, [showToast]);

  const handleDuplicateSlide = useCallback(() => {
    const isCustom = currentSlide >= slides.length;
    let label: string;
    let content: string;
    if (isCustom) {
      const cs = customSlides[currentSlide - slides.length];
      label = `${cs?.label ?? "Slide"} (copie)`;
      content = cs?.content ?? "";
    } else {
      const sl = slides[currentSlide];
      label = `${sl?.label ?? "Slide"} (copie)`;
      // Generate contextual Markdown from real deck data when available
      content = deckData
        ? extractSlideMarkdown(sl?.id ?? "", sl?.label ?? "Slide", deckData)
        : `# ${sl?.label ?? "Slide"} (copie)\n\n_Personnalisez cette slide._`;
    }
    const newSlide = { id: `custom-${Date.now()}`, label, content };
    setCustomSlides((prev) => {
      const next = [...prev, newSlide];
      setTimeout(() => setCurrentSlide(slides.length + next.length - 1), 50);
      return next;
    });
    showToast(`📋 "${label}" ajoutée`);
  }, [currentSlide, slides, customSlides, deckData, showToast]);

  const handleAddCustomSlide = useCallback((label: string, content: string, fontFamily?: string) => {
    const newSlide = {
      id: `custom-${Date.now()}`,
      label,
      content,
      fontFamily,
    };
    setCustomSlides((prev) => {
      const next = [...prev, newSlide];
      // Navigate to the new slide after state update
      setTimeout(() => setCurrentSlide(slides.length + next.length - 1), 50);
      return next;
    });
    showToast(`✅ Slide "${label}" ajoutée`);
  }, [slides.length, showToast]);

  const handleRenameSlide = useCallback((newLabel: string) => {
    const customIndex = currentSlide - slides.length;
    if (customIndex < 0) {
      showToast("⚠️ Seules les slides personnalisées peuvent être renommées");
      return;
    }
    setCustomSlides((prev) => {
      const next = [...prev];
      next[customIndex] = { ...next[customIndex], label: newLabel };
      return next;
    });
    showToast(`✏️ Slide renommée en "${newLabel}"`);
  }, [currentSlide, slides.length, showToast]);

  const handleDeleteSlide = useCallback(() => {
    const customIndex = currentSlide - slides.length;
    if (customIndex < 0) {
      showToast("⚠️ Seules les slides personnalisées peuvent être supprimées");
      return;
    }
    setCustomSlides((prev) => {
      const next = prev.filter((_, i) => i !== customIndex);
      // Navigate to the previous slide to avoid out-of-bounds
      const newIndex = Math.max(0, slides.length + customIndex - 1);
      setTimeout(() => setCurrentSlide(newIndex), 50);
      return next;
    });
    showToast("🗑️ Slide supprimée");
  }, [currentSlide, slides.length, showToast]);

  const handleSetNote = useCallback((note: string) => {
    const slideId = currentSlide < slides.length
      ? (slides[currentSlide]?.id ?? `slide-${currentSlide}`)
      : (customSlides[currentSlide - slides.length]?.id ?? `custom-${currentSlide}`);
    setSlideNotes(prev => ({ ...prev, [slideId]: note }));
    if (note) {
      setNotePanelOpen(true);
      showToast("📝 Note enregistrée");
    } else {
      showToast("🗑️ Note effacée");
    }
  }, [currentSlide, slides, customSlides, showToast]);

  const handleMoveSlide = useCallback((direction: "up" | "down") => {
    const customIndex = currentSlide - slides.length;
    if (customIndex < 0) {
      showToast("⚠️ Seules les slides personnalisées peuvent être réordonnées");
      return;
    }
    setCustomSlides((prev) => {
      const next = [...prev];
      if (direction === "up" && customIndex > 0) {
        [next[customIndex - 1], next[customIndex]] = [next[customIndex], next[customIndex - 1]];
        setTimeout(() => setCurrentSlide(slides.length + customIndex - 1), 50);
      } else if (direction === "down" && customIndex < next.length - 1) {
        [next[customIndex], next[customIndex + 1]] = [next[customIndex + 1], next[customIndex]];
        setTimeout(() => setCurrentSlide(slides.length + customIndex + 1), 50);
      } else {
        showToast("⚠️ La slide ne peut pas être déplacée dans cette direction");
        return prev;
      }
      return next;
    });
  }, [currentSlide, slides.length, showToast]);

  const handleFilmstripDragStart = useCallback((e: React.DragEvent, customIdx: number) => {
    setFilmstripDragging(customIdx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(customIdx));
  }, []);

  const handleFilmstripDragOver = useCallback((e: React.DragEvent, customIdx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setFilmstripDropTarget(customIdx);
  }, []);

  const handleFilmstripDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    const fromIdx = filmstripDragging;
    if (fromIdx === null || fromIdx === targetIdx) {
      setFilmstripDragging(null);
      setFilmstripDropTarget(null);
      return;
    }
    setCustomSlides((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      const insertAt = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      next.splice(insertAt, 0, moved);
      const newAbsIdx = slides.length + insertAt;
      setTimeout(() => setCurrentSlide(newAbsIdx), 50);
      return next;
    });
    setFilmstripDragging(null);
    setFilmstripDropTarget(null);
    showToast("↕️ Slide réordonnée");
  }, [filmstripDragging, slides.length, showToast]);

  const handleFilmstripDragEnd = useCallback(() => {
    setFilmstripDragging(null);
    setFilmstripDropTarget(null);
  }, []);

  const handleShareDeck = useCallback(() => {
    if (!selectedClient || !selectedPeriod) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("client", selectedClient.id);
    url.searchParams.set("period", selectedPeriod.month);
    const shareUrl = url.toString();
    navigator.clipboard.writeText(shareUrl).catch(() => {});
    showToast("🔗 Lien copié dans le presse-papiers");
    return shareUrl;
  }, [selectedClient, selectedPeriod, showToast]);

  const goToSlide = (idx: number) => {
    const newIdx = Math.max(0, Math.min(slides.length + customSlides.length - 1, idx));
    if (newIdx !== currentSlide) {
      setSlideTransition(true);
      setTimeout(() => {
        setCurrentSlide(newIdx);
        setTimeout(() => setSlideTransition(false), 50);
      }, 150);
    }
  };

  // ── Auto-open notes panel when navigating to a slide with a note ─────────
  useEffect(() => {
    if (prevSlideRef.current === currentSlide) return;
    prevSlideRef.current = currentSlide;
    if (currentSlideNote) {
      setNotePanelOpen(true);
    }
  }, [currentSlide, currentSlideNote]);

  // ── Auto-scroll filmstrip to active slide ────────────────────────────────
  useEffect(() => {
    activeFilmstripItemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentSlide]);

  // ── Auto-reset filter when navigating to a slide without notes ────────────
  useEffect(() => {
    if (!showOnlyWithNotes) return;
    const currentId = currentSlide < slides.length
      ? slides[currentSlide]?.id
      : customSlides[currentSlide - slides.length]?.id;
    if (currentId && !slideNotes[currentId]) {
      setShowOnlyWithNotes(false);
    }
  }, [currentSlide, showOnlyWithNotes, slides, customSlides, slideNotes]);

  // ── Focus palette input when opened ─────────────────────────────────────
  useEffect(() => {
    if (commandPaletteOpen) {
      setTimeout(() => commandPaletteInputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    if (!deckGenerated) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const inInput = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
      // Navigation ←/↑ = slide précédente, →/↓ = slide suivante
      if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (inInput) return;
        e.preventDefault();
        goToSlide(currentSlide - 1);
      } else if ((e.key === "ArrowRight" || e.key === "ArrowDown") && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (inInput) return;
        e.preventDefault();
        goToSlide(currentSlide + 1);
      }
      // Ctrl+K / Cmd+K : ouvre/ferme la palette de commandes
      else if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setCommandPaletteOpen(prev => {
          if (!prev) { setCommandPaletteQuery(""); setCommandPaletteIndex(0); }
          return !prev;
        });
      }
      // Delete/Backspace : supprime le bloc sélectionné sur le canvas
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedBlockId && !inInput) {
        e.preventDefault();
        setDroppedBlocks((prev) => prev.filter((b) => b.id !== selectedBlockId));
        setSelectedBlockId(null);
      }
      // Escape : déselectionne le bloc actif ou ferme les panels
      else if (e.key === "Escape") {
        if (selectedBlockId) {
          // Escape = déselectionner seulement (Delete/Backspace = supprimer)
          setSelectedBlockId(null);
        } else if (shortcutHelpOpen) {
          setShortcutHelpOpen(false);
        } else if (commandPaletteOpen) {
          setCommandPaletteOpen(false);
        } else if (notePanelOpen) {
          setNotePanelOpen(false);
        } else if (inInput) {
          (document.activeElement as HTMLElement)?.blur();
          setFilmstripSearch("");
        }
      }
      // / : focus la barre de recherche filmstrip (vim-style)
      else if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        if (inInput) return;
        e.preventDefault();
        filmstripSearchRef.current?.focus();
        filmstripSearchRef.current?.select();
      }
      // Ctrl+Shift+E : exporter le deck en PDF
      else if ((e.key === "e" || e.key === "E") && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        handleExportPdf();
      }
      // Ctrl+Shift+N : exporter les notes speaker en CSV
      else if ((e.key === "n" || e.key === "N") && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        handleExportCsvNotes();
      }
      // N : toggle panneau de notes (sans Ctrl/Meta)
      else if ((e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey) {
        if (inInput) return;
        e.preventDefault();
        setNotePanelOpen((prev) => !prev);
      }
      // F : toggle filtre filmstrip (slides avec notes uniquement)
      else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) {
        if (inInput) return;
        e.preventDefault();
        setShowOnlyWithNotes((prev) => !prev);
      }
      // G : aller à la dernière slide / gg (double G) : aller à la première (vim-style)
      else if ((e.key === "g" || e.key === "G") && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (inInput) return;
        e.preventDefault();
        const now = Date.now();
        const totalSlides = slides.length + customSlides.length;
        if (e.key === "g" && now - lastGTimeRef.current < 400) {
          // gg → first slide
          goToSlide(0);
          lastGTimeRef.current = 0;
        } else if (e.key === "G") {
          // G → last slide
          goToSlide(totalSlides - 1);
        } else {
          lastGTimeRef.current = now;
        }
      }
      // ? : ouvre/ferme le panneau d'aide des raccourcis clavier
      else if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        if (inInput) return;
        e.preventDefault();
        setShortcutHelpOpen((prev) => !prev);
      }
      // [ : début de la section précédente, ] : début de la section suivante
      else if ((e.key === "[" || e.key === "]") && !e.ctrlKey && !e.metaKey) {
        if (inInput) return;
        e.preventDefault();
        // Build list of section start indices from standard slides
        const sectionStarts: number[] = [];
        let lastSec = -1;
        slides.forEach((s, i) => {
          if (s.section !== lastSec) {
            sectionStarts.push(i);
            lastSec = s.section;
          }
        });
        if (e.key === "]") {
          const nextStart = sectionStarts.find(i => i > currentSlide);
          if (nextStart !== undefined) {
            goToSlide(nextStart);
            showToast(`→ ${SECTION_LABELS[slides[nextStart].section] ?? "Section suivante"}`);
          }
        } else {
          const prevStart = [...sectionStarts].reverse().find(i => i < currentSlide);
          if (prevStart !== undefined) {
            goToSlide(prevStart);
            showToast(`← ${SECTION_LABELS[slides[prevStart].section] ?? "Section précédente"}`);
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deckGenerated, currentSlide, slides, customSlides.length, notePanelOpen, setNotePanelOpen, handleExportCsvNotes, handleExportPdf, setShowOnlyWithNotes, commandPaletteOpen, shortcutHelpOpen, showToast]);

  // ── Drag & drop handlers ─────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/json"));
      if (data.type === "data-block" && data.content) {
        const canvas = canvasRef.current;
        let xPct = 5, yPct = 10;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          xPct = Math.max(0, Math.min(60, ((e.clientX - rect.left) / rect.width) * 100));
          yPct = Math.max(0, Math.min(60, ((e.clientY - rect.top) / rect.height) * 100));
        }
        const newBlock: DroppedBlock = {
          id: crypto.randomUUID(),
          content: data.content,
          slideIndex: currentSlide,
          x: xPct,
          y: yPct,
          w: 60,
          fontFamily: data.fontFamily,
          textColor: data.textColor,
          fontSize: data.fontSize,
        };
        setDroppedBlocks((prev) => [...prev, newBlock]);
        setSelectedBlockId(newBlock.id);
      }
    } catch (err) {
      console.error("Drop failed:", err);
    }
  };

  // Block drag-to-reposition — drag only starts after 5px movement (avoids accidental drag on click)
  const handleBlockMouseDown = useCallback((e: React.MouseEvent, blockId: string) => {
    e.stopPropagation();
    const block = droppedBlocks.find(b => b.id === blockId);
    if (!block) return;
    setSelectedBlockId(blockId);
    // Don't start drag immediately — wait for significant mouse movement
    const startX = e.clientX;
    const startY = e.clientY;
    let dragStarted = false;
    const onMove = (ev: MouseEvent) => {
      if (!dragStarted) {
        const dist = Math.sqrt((ev.clientX - startX) ** 2 + (ev.clientY - startY) ** 2);
        if (dist < 5) return; // threshold: 5px before drag begins
        dragStarted = true;
        setDraggingBlock({ id: blockId, startX, startY, origX: block.x, origY: block.y });
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [droppedBlocks]);

  useEffect(() => {
    if (!draggingBlock) return;
    const canvas = canvasRef.current;
    const onMove = (e: MouseEvent) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dx = ((e.clientX - draggingBlock.startX) / rect.width) * 100;
      const dy = ((e.clientY - draggingBlock.startY) / rect.height) * 100;
      setDroppedBlocks(prev => prev.map(b => b.id === draggingBlock.id
        ? { ...b, x: Math.max(0, Math.min(65, draggingBlock.origX + dx)), y: Math.max(0, Math.min(70, draggingBlock.origY + dy)) }
        : b
      ));
    };
    const onUp = () => setDraggingBlock(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [draggingBlock]);

  const removeBlock = (blockId: string) => {
    setDroppedBlocks((prev) => prev.filter((b) => b.id !== blockId));
  };

  // ── Inline editing handlers ──────────────────────────────────────────────

  const handleInlineEdit = (field: string, slideIndex: number, newValue: string) => {
    setSlideOverrides((prev) => {
      const filtered = prev.filter((o) => !(o.slideIndex === slideIndex && o.field === field));
      return [...filtered, { slideIndex, field, value: newValue }];
    });
  };

  const handleSlideUpdate = (slideIndex: number, field: string, newValue: string) => {
    handleInlineEdit(field, slideIndex, newValue);
  };

  const getSlideOverride = (slideIndex: number, field: string): string | undefined => {
    return slideOverrides.find((o) => o.slideIndex === slideIndex && o.field === field)?.value;
  };

  const getTextStyle = (slideIndex: number, field: string): TextStyle => {
    return textStyles[`${slideIndex}:${field}`] ?? {};
  };

  const setTextStyle = (slideIndex: number, field: string, style: Partial<TextStyle>) => {
    const key = `${slideIndex}:${field}`;
    setTextStyles((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...style },
    }));
  };

  const addCustomSlide = () => {
    const newSlide = {
      id: `custom-${Date.now()}`,
      label: `Slide ${slides.length + customSlides.length + 1}`,
      content: "# Nouveau slide\n\nAjoutez votre contenu ici.",
    };
    setCustomSlides((prev) => [...prev, newSlide]);
    // Navigate to the new slide
    goToSlide(slides.length + customSlides.length);
  };

  // Blocs pour la slide actuelle
  const currentSlideBlocks = droppedBlocks.filter((b) => b.slideIndex === currentSlide);

  // Group slides by section for the filmstrip
  const sectionSlides = useMemo(() => {
    const groups: Record<number, { idx: number; slide: SlideConfig }[]> = {};
    slides.forEach((s, i) => {
      if (!groups[s.section]) groups[s.section] = [];
      groups[s.section].push({ idx: i, slide: s });
    });
    return groups;
  }, [slides]);

  // Count visible filmstrip slides (standard + custom) under current search+notes filter
  const filmstripResultCount = useMemo(() => {
    const q = filmstripSearch.trim().toLowerCase();
    const stdCount = slides.filter(s => {
      if (showOnlyWithNotes && !slideNotes[s.id]) return false;
      if (q && !s.label.toLowerCase().includes(q)) return false;
      return true;
    }).length;
    const csCount = customSlides.filter(cs => {
      if (showOnlyWithNotes && !slideNotes[cs.id]) return false;
      if (q && !cs.label.toLowerCase().includes(q)) return false;
      return true;
    }).length;
    return stdCount + csCount;
  }, [filmstripSearch, showOnlyWithNotes, slides, customSlides, slideNotes]);

  // ── Setup view (before generation) ──────────────────────────────────────
  if (!deckGenerated) {
    return (
      <div className="h-full bg-gray-50 overflow-auto">
        <div className="max-w-2xl mx-auto py-12 px-6">
          {/* Shared deck banner */}
          {sharedDeckBanner && (
            <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-6 text-sm">
              <span className="text-blue-700">
                🔗 Deck partagé chargé — client&nbsp;<strong>{sharedDeckBanner.client}</strong>, période&nbsp;<strong>{sharedDeckBanner.period}</strong>
              </span>
              <button
                onClick={() => {
                  setSharedDeckBanner(null);
                  if (typeof window !== "undefined") {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("client");
                    url.searchParams.delete("period");
                    window.history.replaceState({}, "", url.toString());
                  }
                }}
                className="ml-4 text-blue-400 hover:text-blue-600 transition-colors"
                aria-label="Fermer la bannière"
              >
                ✕
              </button>
            </div>
          )}
          <div className="text-center mb-8">
            <div className="mb-3 flex items-center justify-center gap-4">
              <a href="/deck/builder" className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                ← Configurer le deck
              </a>
              <span className="text-gray-300 text-xs">|</span>
              <a href="/deck/history" className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                Historique
              </a>
            </div>
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
            {clientsLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Chargement des comptes...
              </div>
            ) : clientsNeedAuth ? (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                <p className="text-sm font-semibold text-red-700 mb-2">Session Meta expirée — reconnexion requise</p>
                <button
                  onClick={() => signIn("facebook", { callbackUrl: "/deck" })}
                  className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
                  style={{ background: "#1877F2" }}
                >
                  Reconnecter Meta Ads
                </button>
              </div>
            ) : clients.length === 0 ? (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <p className="text-sm text-amber-700 mb-2">Aucun compte Meta trouvé</p>
                <button
                  onClick={() => signIn("facebook", { callbackUrl: "/deck" })}
                  className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
                  style={{ background: "#1877F2" }}
                >
                  Connecter Meta Ads
                </button>
              </div>
            ) : (
              <select
                value={selectedClient?.id ?? ""}
                onChange={(e) => {
                  const c = clients.find((cl) => cl.id === e.target.value);
                  if (c) setSelectedClient(c);
                }}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.platform ? `— ${c.platform}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Meta reconnect banner — shown when Meta token expired but Google still works */}
          {metaNeedsReconnect && !clientsNeedAuth && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-4">
              <p className="text-sm text-amber-700">Token Meta Ads expiré — les comptes Google Ads restent disponibles</p>
              <button
                onClick={() => signIn("facebook", { callbackUrl: "/deck" })}
                className="shrink-0 inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg text-white transition-all hover:opacity-90"
                style={{ background: "#1877F2" }}
              >
                Reconnecter Meta
              </button>
            </div>
          )}

          {/* Google Ads manual association — show when selected client has no Google Customer ID */}
          {selectedClient && !selectedClient.googleCustomerId && clients.some(c => c.platform === "google" || c.platform === "both") && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                Compte Google Ads (optionnel)
              </label>
              <select
                value={selectedGoogleCustomerId}
                onChange={(e) => setSelectedGoogleCustomerId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
              >
                <option value="">— Aucun compte Google Ads —</option>
                {clients
                  .filter(c => (c.platform === "google" || c.platform === "both") && c.googleCustomerId)
                  .map(c => (
                    <option key={c.id} value={c.googleCustomerId!}>
                      {c.name} ({c.googleCustomerId})
                    </option>
                  ))}
              </select>
              <div className="mt-2 text-xs text-gray-400">
                Associez un compte Google Ads manuellement si le nom ne correspond pas automatiquement.
              </div>
            </div>
          )}

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
              {(() => {
                const hasGoogle = clients.some(c => c.platform === "google");
                const hasMeta = clients.some(c => c.platform === "meta");
                const badge = (connected: boolean) => connected
                  ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Connecté</span>
                  : clientsLoading
                    ? <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 font-medium">Chargement…</span>
                    : <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Non connecté</span>;
                return <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500" />
                      Google Ads
                    </span>
                    {badge(hasGoogle)}
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#7F5AFD" }} />
                      Meta Ads
                    </span>
                    {badge(hasMeta)}
                  </div>
                </>;
              })()}
            </div>
            {!clientsLoading && clients.length === 0 && (
              <div className="mt-3 text-xs text-gray-400">
                Connectez vos comptes dans Settings pour utiliser des données réelles.
              </div>
            )}
          </div>

          {/* User context / slide request */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <Sparkles className="w-4 h-4" />
              Ce que vous voulez dans la présentation
            </label>
            <textarea
              value={userContext}
              onChange={(e) => setUserContext(e.target.value)}
              placeholder="Ex: Vue d'ensemble Meta + top créatifs + analyse campagnes + prochaines étapes"
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
            />
            <div className="mt-2 text-xs text-gray-400">
              L&apos;IA construira des slides dynamiques basées sur les données réelles et votre demande.
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

  // ── Relay error — no data ────────────────────────────────────────────────
  if (deckGenerated && !deckData) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-950 text-white gap-4 p-8">
        <div className="text-5xl">⚠️</div>
        <h2 className="text-xl font-semibold">Relay non connecté</h2>
        <p className="text-gray-400 text-center max-w-md text-sm">
          {dataSourceReason ?? "Impossible de récupérer les données. Vérifiez que le relay OpenClaw tourne sur localhost:3457 et réessayez."}
        </p>
        <button
          onClick={() => setDeckGenerated(false)}
          className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
        >
          ← Retour
        </button>
      </div>
    );
  }

  // ── Deck viewer — Split layout ─────────────────────────────────────────
  if (!deckData) return null;

  /** Highlight matching search term in a slide label */
  function HighlightLabel({ label, search }: { label: string; search: string }) {
    if (!search.trim()) return <>{label}</>;
    const idx = label.toLowerCase().indexOf(search.trim().toLowerCase());
    if (idx === -1) return <>{label}</>;
    return (
      <>
        {label.slice(0, idx)}
        <mark className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5 not-italic font-semibold">
          {label.slice(idx, idx + search.trim().length)}
        </mark>
        {label.slice(idx + search.trim().length)}
      </>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-100 overflow-hidden">
      {/* ── Full-width Header ────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-3">
        {/* Back button */}
        <button
          onClick={() => setDeckGenerated(false)}
          className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1 flex-shrink-0"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Retour
        </button>
        <div className="h-4 w-px bg-gray-200" />

        {/* Client selector */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Building2 className="w-3.5 h-3.5 text-gray-400" />
          <select
            value={selectedClient?.id ?? ""}
            onChange={(e) => {
              const cl = clients.find((c) => c.id === e.target.value);
              if (cl) setSelectedClient(cl);
            }}
            className="text-xs font-semibold text-gray-900 bg-transparent border-none focus:outline-none cursor-pointer pr-4"
          >
            {clients.map((cl) => (
              <option key={cl.id} value={cl.id}>{cl.name}</option>
            ))}
          </select>
        </div>
        <div className="h-4 w-px bg-gray-200" />

        {/* Period selector */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Calendar className="w-3.5 h-3.5 text-gray-400" />
          <select
            value={selectedPeriod.month}
            onChange={(e) => {
              const p = periods.find((pp) => pp.month === e.target.value);
              if (p) setSelectedPeriod(p);
            }}
            className="text-xs text-gray-600 bg-transparent border-none focus:outline-none cursor-pointer pr-4"
          >
            {periods.map((p) => (
              <option key={p.month} value={p.month}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* Section breadcrumb */}
        {currentSlide < slides.length && (
          <>
            <div className="h-4 w-px bg-gray-200" />
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 transition-all duration-300"
              style={{
                color: SECTION_COLORS[slides[currentSlide].section] ?? "#2CA6F9",
                backgroundColor: `${SECTION_COLORS[slides[currentSlide].section] ?? "#2CA6F9"}18`,
                border: `1px solid ${SECTION_COLORS[slides[currentSlide].section] ?? "#2CA6F9"}40`,
              }}
            >
              {SECTION_LABELS[slides[currentSlide].section] ?? "—"}
            </span>
          </>
        )}

        <div className="flex-1" />

        {/* Data source badge */}
        {dataSource && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 cursor-default ${
              dataSource === "real"
                ? "bg-green-50 text-green-700 border border-green-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}
            title={dataSourceReason ?? undefined}
          >
            {dataSource === "real" ? "✓ Données réelles" : `⚠ Données fictives${dataSourceReason ? " (hover pour détails)" : ""}`}
          </span>
        )}

        {/* Mode toggle: Slides statiques | Slides IA */}
        <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden flex-shrink-0 text-xs font-medium">
          <button
            onClick={() => setSlideMode("static")}
            className={`px-2.5 py-1.5 transition-colors ${slideMode === "static" ? "bg-[#0944A1] text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            Slides statiques
          </button>
          <button
            onClick={() => setSlideMode("ai")}
            className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors ${slideMode === "ai" ? "bg-[#0944A1] text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            <Sparkles className="w-3 h-3" />
            Slides IA
          </button>
        </div>

        {/* Slide counter */}
        <span className="text-xs text-gray-400 flex-shrink-0">
          Slide {currentSlide + 1} / {slides.length + customSlides.length}
        </span>

        {/* Generate button — static mode */}
        {slideMode === "static" && (
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white flex-shrink-0"
            style={{ backgroundColor: "#0944A1" }}
          >
            {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Générer
          </button>
        )}

        {/* Generate button — AI mode */}
        {slideMode === "ai" && (
          <button
            onClick={handleGenerateAiDeck}
            disabled={isGeneratingAi}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white flex-shrink-0"
            style={{ backgroundColor: "#7F5AFD" }}
          >
            {isGeneratingAi ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {isGeneratingAi ? "L'IA analyse..." : "Générer le deck"}
          </button>
        )}

        {/* Export PPTX */}
        <button
          onClick={handleExportPptx}
          disabled={isExporting}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors text-gray-700 flex-shrink-0"
        >
          {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
          .pptx
        </button>

        {/* Export PDF */}
        <button
          onClick={handleExportPdf}
          disabled={!deckData}
          title="Exporter en PDF (Ctrl+Shift+E)"
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors text-gray-700 flex-shrink-0 disabled:opacity-40"
        >
          <FileDown className="w-3.5 h-3.5" />
          .pdf
        </button>

        {/* Export CSV Notes */}
        <button
          onClick={handleExportCsvNotes}
          disabled={slides.length + customSlides.length === 0}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors text-gray-700 flex-shrink-0 disabled:opacity-40"
          title="Exporter les notes speaker en CSV"
        >
          <FileDown className="w-3.5 h-3.5" />
          Notes .csv
        </button>

        {/* Export Google Slides */}
        <button
          onClick={() => alert("Google Slides export coming soon — connect your Google account in Settings.")}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white flex-shrink-0"
          style={{ backgroundColor: "#0944A1" }}
        >
          <Download className="w-3.5 h-3.5" />
          Google Slides
        </button>

        {/* Edit mode toggle */}
        <button
          onClick={() => setEditMode((v) => !v)}
          title={editMode ? "Quitter le mode édition" : "Mode édition — ajouter formes, textes…"}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors flex-shrink-0 ${
            editMode
              ? "bg-amber-500 text-white"
              : "bg-gray-100 hover:bg-gray-200 text-gray-700"
          }`}
        >
          <Edit2 className="w-3.5 h-3.5" />
          {editMode ? "Édition ON" : "Éditer"}
        </button>
      </div>

      {/* ── Split layout: Slides (left) + AI Panel (right) ───────────────── */}
      <SlideStyleContext.Provider value={{ getStyle: getTextStyle, setStyle: setTextStyle }}>
      <div className="flex-1 flex overflow-hidden">

        {/* ── LEFT: Filmstrip + Slide Viewer (60-65%) ───────────────────── */}
        <div className="flex-1 flex overflow-hidden" style={{ flex: "0 0 62%" }}>
          {/* Filmstrip sidebar */}
          <div className="w-48 flex-shrink-0 bg-white border-r border-gray-200 overflow-y-auto flex flex-col">
            {/* Filmstrip progress indicator */}
            {(slides.length + customSlides.length) > 0 && (
              <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider">Progression</span>
                  <span className="text-[10px] font-bold text-gray-600">
                    {currentSlide + 1} / {slides.length + customSlides.length}
                  </span>
                </div>
                <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${((currentSlide + 1) / (slides.length + customSlides.length)) * 100}%`,
                      backgroundColor: "#7F5AFD",
                    }}
                  />
                </div>
              </div>
            )}
            {/* Search filmstrip by slide name */}
            <div className="mx-3 mb-1 mt-1">
              <input
                ref={filmstripSearchRef}
                type="text"
                value={filmstripSearch}
                onChange={(e) => setFilmstripSearch(e.target.value)}
                placeholder="Rechercher… (/)"
                title="Raccourci clavier : / pour focus"
                className="w-full text-[10px] px-2 py-1 rounded-md border border-gray-200 bg-gray-50 text-gray-600 placeholder-gray-300 focus:outline-none focus:border-blue-300 focus:bg-white transition-colors"
              />
              {filmstripSearch.trim() && (
                <div className={`mt-0.5 text-[9px] px-1 ${filmstripResultCount === 0 ? "text-red-400" : "text-gray-400"}`}>
                  {filmstripResultCount === 0 ? "Aucun résultat" : `${filmstripResultCount} résultat${filmstripResultCount !== 1 ? "s" : ""}`}
                </div>
              )}
            </div>
            {/* Filter: show only slides with notes */}
            <button
              onClick={() => setShowOnlyWithNotes((prev) => !prev)}
              className={`mx-3 mb-2 mt-1 flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md border transition-colors ${
                showOnlyWithNotes
                  ? "bg-blue-50 border-blue-300 text-blue-700 font-semibold"
                  : "bg-gray-50 border-gray-200 text-gray-400 hover:text-gray-600"
              }`}
              title="Afficher uniquement les slides avec notes (F)"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 inline-block" />
              {showOnlyWithNotes
                ? `${slidesWithNotesCount} slide${slidesWithNotesCount !== 1 ? "s" : ""} avec notes`
                : `Toutes les slides (${slides.length + customSlides.length})`}
            </button>
            <div key={String(showOnlyWithNotes)} className="flex-1 animate-in fade-in duration-150">
            <TooltipProvider delayDuration={300}>
            {Object.entries(sectionSlides).map(([secStr, items]) => {
              const sec = Number(secStr);
              const secColor = SECTION_COLORS[sec] ?? "#2CA6F9";
              const searchLower = filmstripSearch.trim().toLowerCase();
              const visibleItems = items.filter(({ slide }) => {
                if (showOnlyWithNotes && !slideNotes[slide.id]) return false;
                if (searchLower && !slide.label.toLowerCase().includes(searchLower)) return false;
                return true;
              });
              if (visibleItems.length === 0) return null;
              return (
                <div key={sec}>
                  <div
                    className={`px-2 pt-3 pb-1 text-[9px] font-bold uppercase tracking-wider rounded-sm transition-colors ${
                      showOnlyWithNotes ? "bg-blue-50 border-l-2 border-blue-300 mx-1" : ""
                    }`}
                    style={{ color: showOnlyWithNotes ? "#3b82f6" : secColor }}
                  >
                    {SECTION_LABELS[sec]}
                  </div>
                  {visibleItems.map(({ idx, slide }) => {
                    const isActive = currentSlide === idx;
                    const bg = slide.dark ? "#0944A1" : "#f1f5f9";
                    const textColor = slide.dark ? "rgba(255,255,255,0.5)" : "#94a3b8";
                    return (
                      <Tooltip key={slide.id}>
                        <TooltipTrigger asChild>
                          <button
                            ref={isActive ? activeFilmstripItemRef : undefined}
                            onClick={() => goToSlide(idx)}
                            className={`w-full text-left px-2 py-1.5 transition-all ${isActive ? "bg-blue-50" : "hover:bg-gray-50"}`}
                            style={isActive ? { borderLeft: `3px solid ${secColor}`, paddingLeft: "5px" } : undefined}
                          >
                            {/* Mini visual thumbnail */}
                            <div
                              className="w-full aspect-[16/9] rounded overflow-hidden relative mb-1"
                              style={{ background: bg, boxShadow: isActive ? `0 0 0 1.5px ${secColor}` : "0 0 0 1px rgba(0,0,0,0.08)" }}
                            >
                              <span className="absolute top-0.5 left-1 text-[7px] font-bold" style={{ color: textColor }}>
                                {idx + 1}
                              </span>
                              {/* Section accent bar */}
                              <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background: secColor, opacity: 0.7 }} />
                              {/* Layout hint lines */}
                              {!slide.dark && (
                                <>
                                  <div className="absolute top-[28%] left-[10%] right-[10%] h-[8%] rounded-sm" style={{ background: secColor, opacity: 0.15 }} />
                                  <div className="absolute top-[45%] left-[10%] right-[30%] h-[5%] rounded-sm bg-gray-300 opacity-40" />
                                  <div className="absolute top-[55%] left-[10%] right-[20%] h-[5%] rounded-sm bg-gray-300 opacity-30" />
                                </>
                              )}
                              {slide.dark && (
                                <>
                                  <div className="absolute top-[30%] left-[10%] right-[15%] h-[10%] rounded-sm bg-white opacity-15" />
                                  <div className="absolute top-[50%] left-[10%] right-[25%] h-[6%] rounded-sm bg-white opacity-10" />
                                </>
                              )}
                              {slideNotes[slide.id] && (
                                <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-blue-400" />
                              )}
                            </div>
                            {/* Label */}
                            <span className={`block text-[10px] leading-tight truncate ${isActive ? "text-blue-700 font-semibold" : "text-gray-500"}`}>
                              <HighlightLabel label={slide.label} search={filmstripSearch} />
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[160px]">
                          <p className="font-semibold">{slide.label}</p>
                          <p className="text-gray-300 text-[10px]">{SECTION_LABELS[sec]}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              );
            })}
            </TooltipProvider>

            {/* Custom slides */}
            {customSlides.length > 0 && (!showOnlyWithNotes || customSlides.some(cs => !!slideNotes[cs.id])) && (
              <div>
                <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  {aiSlidesMode ? "Slides IA" : "Personnalisés"}
                </div>
                <TooltipProvider delayDuration={300}>
                {customSlides.filter(cs => {
                  if (showOnlyWithNotes && !slideNotes[cs.id]) return false;
                  const sl = filmstripSearch.trim().toLowerCase();
                  if (sl && !cs.label.toLowerCase().includes(sl)) return false;
                  return true;
                }).map((cs, i) => {
                  i = customSlides.indexOf(cs);
                  const idx = slides.length + i;
                  const isDragging = filmstripDragging === i;
                  const isDropTarget = filmstripDropTarget === i && filmstripDragging !== null && filmstripDragging !== i;
                  return (
                    <div key={cs.id}>
                      {/* Drop indicator line above this item */}
                      {isDropTarget && (
                        <div className="mx-3 h-0.5 rounded-full bg-violet-500 transition-all" />
                      )}
                      <div
                        draggable
                        onDragStart={(e) => handleFilmstripDragStart(e, i)}
                        onDragOver={(e) => handleFilmstripDragOver(e, i)}
                        onDrop={(e) => handleFilmstripDrop(e, i)}
                        onDragEnd={handleFilmstripDragEnd}
                        className={`flex items-center gap-1 w-full text-left px-2 py-1.5 text-xs transition-all group ${
                          isDragging ? "opacity-40" :
                          currentSlide === idx ? "bg-blue-50 text-blue-700 font-semibold" : "text-gray-600 hover:bg-gray-50"
                        }`}
                        style={currentSlide === idx && !isDragging ? { borderLeft: "3px solid #7F5AFD", paddingLeft: "5px" } : undefined}
                      >
                        {/* Drag handle */}
                        <GripVertical className="w-3 h-3 flex-shrink-0 text-gray-300 group-hover:text-gray-400 cursor-grab active:cursor-grabbing transition-colors" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => goToSlide(idx)}
                              className="flex-1 text-left truncate flex items-center gap-1"
                            >
                              <span className="text-gray-400 mr-1">{idx + 1}.</span>
                              <span className="flex-1 truncate"><HighlightLabel label={cs.label} search={filmstripSearch} /></span>
                              {slideNotes[cs.id] && (
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 inline-block" title="Note" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[160px]">
                            <p className="font-semibold">{cs.label}</p>
                            <p className="text-gray-300 text-[10px]">Slide personnalisée</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
                </TooltipProvider>
                {/* Drop zone at the end */}
                {filmstripDragging !== null && filmstripDropTarget === null && (
                  <div
                    className="mx-3 h-0.5 rounded-full bg-violet-300"
                    onDragOver={(e) => { e.preventDefault(); setFilmstripDropTarget(customSlides.length); }}
                    onDrop={(e) => handleFilmstripDrop(e, customSlides.length)}
                  />
                )}
              </div>
            )}
            </div>

            {/* Add slide button */}
            <button
              onClick={addCustomSlide}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 text-xs text-gray-500 hover:text-[#0944A1] hover:bg-blue-50 border-t border-gray-200 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Ajouter une slide
            </button>
          </div>

          {/* Slide preview */}
          <div
            className="flex-1 flex flex-col items-center justify-center p-4 overflow-auto"
            ref={slideContainerRef}
            onClick={() => { setSelectedBlockId(null); slideEditor.setSelectedId(null); }}
          >
            {/* ── AI Dynamic Deck rendering ───────────────────────────────── */}
            {slideMode === "ai" && (
              <div className="w-full max-w-3xl">
                {isGeneratingAi ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-4 text-gray-500">
                    <Loader2 className="w-8 h-8 animate-spin text-[#7F5AFD]" />
                    <p className="text-sm font-medium">L&apos;IA analyse vos données...</p>
                    <p className="text-xs text-gray-400">Cela peut prendre 10–15 secondes</p>
                  </div>
                ) : aiGenerateError ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                    <div className="text-3xl">⚠️</div>
                    <p className="text-sm font-semibold text-red-600">Erreur lors de la génération IA</p>
                    <p className="text-xs text-gray-500 max-w-sm">{aiGenerateError}</p>
                    <button
                      onClick={handleGenerateAiDeck}
                      className="mt-2 text-xs px-4 py-2 rounded-lg bg-[#7F5AFD] text-white font-medium hover:bg-[#6b48e8] transition-colors"
                    >
                      Réessayer
                    </button>
                  </div>
                ) : aiDynamicSlides.length > 0 ? (
                  <DynamicDeck
                    slides={aiDynamicSlides}
                    title={selectedClient ? `${selectedClient.name} — ${selectedPeriod.label}` : "Performance Deck"}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center py-20 gap-4 text-gray-400">
                    <Sparkles className="w-10 h-10 opacity-30" />
                    <p className="text-sm font-medium">Aucune slide IA générée</p>
                    <p className="text-xs opacity-70">Cliquez sur &quot;Générer le deck&quot; pour créer des slides avec l&apos;IA</p>
                    <button
                      onClick={handleGenerateAiDeck}
                      className="mt-1 text-xs px-4 py-2 rounded-lg bg-[#7F5AFD] text-white font-medium hover:bg-[#6b48e8] transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5 inline mr-1" />
                      Générer le deck IA
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Static slide rendering ──────────────────────────────────── */}
            {slideMode === "static" && (
            <>
            {/* Edit toolbar — outside canvas so it doesn't affect % position calculations */}
            <div className="w-full max-w-3xl mb-0">
              <SlideEditorToolbar
                activeTool={slideEditor.activeTool}
                onToolChange={slideEditor.setActiveTool}
                selectedElement={slideEditor.selectedElement}
                onUpdateElement={(patch) => slideEditor.selectedElement && slideEditor.updateElWithHistory(slideEditor.selectedElement.id, patch)}
                onDeleteElement={slideEditor.deleteSelected}
                onDuplicateElement={slideEditor.duplicateSelected}
                onBringToFront={slideEditor.bringToFront}
                onSendToBack={slideEditor.sendToBack}
                onUndo={slideEditor.undo}
                onRedo={slideEditor.redo}
                canUndo={slideEditor.canUndo}
                canRedo={slideEditor.canRedo}
                onImageUpload={slideEditor.handleImageUpload}
              />
            </div>

            {/* 16:9 canvas */}
            <div
              className="w-full max-w-3xl transition-opacity duration-300 ease-in-out relative"
              style={{ opacity: slideTransition ? 0 : 1, cursor: editMode ? slideEditor.canvasCursor : "default" }}
              ref={canvasRef}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={editMode ? slideEditor.handleCanvasClick : undefined}
            >
              {/* Slide content */}
              {currentSlide < slides.length ? (
                slides[currentSlide].render(deckData, currentSlide + 1, {
                  onEdit: handleInlineEdit,
                  getOverride: getSlideOverride,
                })
              ) : (
                // Custom slide
                (() => {
                  const cs = customSlides[currentSlide - slides.length];
                  const isEditingThis = editingCustomSlideId === cs?.id;
                  return cs ? (
                    <div className="relative" style={{ paddingBottom: "56.25%" }}>
                      <div className={`absolute inset-0 rounded-lg shadow-sm flex flex-col overflow-hidden ${isEditingThis ? "bg-white border border-gray-200" : "bg-gray-900 border border-gray-700"}`}>
                        {/* Toolbar */}
                        <div className={`flex items-center gap-2 px-4 py-2 border-b ${isEditingThis ? "border-gray-100" : "border-gray-700"}`}>
                          <span className={`text-xs font-semibold uppercase tracking-wider ${isEditingThis ? "text-gray-400" : "text-gray-500"}`}>Slide IA</span>
                          {isEditingThis ? (
                            <input
                              type="text"
                              value={cs.label}
                              onChange={(e) => setCustomSlides(prev => prev.map((s, i) => i === currentSlide - slides.length ? { ...s, label: e.target.value } : s))}
                              className="text-sm font-semibold text-gray-800 bg-transparent border-none focus:outline-none flex-1"
                              placeholder="Titre de la slide"
                            />
                          ) : (
                            <span className="text-sm font-semibold text-gray-300 flex-1 truncate">{cs.label}</span>
                          )}
                          <button
                            onClick={() => setEditingCustomSlideId(isEditingThis ? null : cs.id)}
                            className={`text-xs px-2 py-0.5 rounded transition-colors ${isEditingThis ? "bg-gray-100 text-gray-600 hover:bg-gray-200" : "bg-gray-700 text-gray-300 hover:bg-gray-600"}`}
                          >{isEditingThis ? "Aperçu" : "Éditer"}</button>
                          <button
                            onClick={() => { setCustomSlides(prev => prev.filter((_, i) => i !== currentSlide - slides.length)); goToSlide(Math.max(0, currentSlide - 1)); }}
                            className="text-xs text-red-400 hover:text-red-600 transition-colors"
                          >Supprimer</button>
                        </div>
                        {/* Content */}
                        {isEditingThis ? (
                          <textarea
                            value={cs.content}
                            onChange={(e) => setCustomSlides(prev => prev.map((s, i) => i === currentSlide - slides.length ? { ...s, content: e.target.value } : s))}
                            className="flex-1 p-4 text-sm text-gray-700 resize-none focus:outline-none"
                            style={{ fontFamily: cs.fontFamily || "inherit" }}
                            placeholder="Contenu en Markdown…"
                          />
                        ) : (
                          <div
                            className="flex-1 p-5 overflow-auto deck-custom-preview"
                            style={{ fontFamily: cs.fontFamily || "inherit" }}
                          >
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{cs.content}</ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null;
                })()
              )}

              {/* Slide editor elements — positioned ON the canvas */}
              {(slideElements[currentSlide] ?? []).map((el) => (
                <SlideElementItem
                  key={el.id}
                  el={el}
                  isSelected={slideEditor.selectedId === el.id}
                  isEditing={slideEditor.editingId === el.id}
                  onMouseDown={(e) => { if (editMode) slideEditor.handleElementMouseDown(e, el); }}
                  onDoubleClick={(e) => { if (editMode) slideEditor.handleElementDoubleClick(e, el); }}
                  onTextChange={(text) => slideEditor.updateEl(el.id, { text })}
                  onBlur={() => slideEditor.setEditingId(null)}
                  onResizeMouseDown={(e) => { if (editMode) slideEditor.handleResizeMouseDown(e, el); }}
                />
              ))}

              {/* Overlay blocks — positioned ON the canvas */}
              {currentSlideBlocks.map((block) => {
                const isSelected = selectedBlockId === block.id;
                return (
                  <div
                    key={block.id}
                    data-block-id={block.id}
                    onClick={(e) => { e.stopPropagation(); setSelectedBlockId(block.id); }}
                    onMouseDown={(e) => { e.stopPropagation(); if (!isSelected) handleBlockMouseDown(e, block.id); }}
                    style={{
                      position: "absolute",
                      left: `${block.x}%`,
                      top: `${block.y}%`,
                      width: `${block.w}%`,
                      ...(block.h !== undefined ? { height: `${block.h}%` } : {}),
                      cursor: draggingBlock?.id === block.id ? "grabbing" : "default",
                      zIndex: isSelected ? 20 : 10,
                      overflow: "visible",
                    }}
                    className={`rounded-lg shadow-lg bg-white border-2 transition-all ${
                      isSelected ? "border-[#2CA6F9]" : "border-transparent hover:border-[#2CA6F9]/40"
                    }`}
                  >
                    {/* Toolbar */}
                    {isSelected && (
                      <div className="absolute -top-8 left-0 flex items-center gap-1 bg-[#0944A1] rounded-lg px-2 py-1 shadow-md z-30">
                        <GripVertical
                          className="w-3.5 h-3.5 text-white/70 cursor-grab"
                          onMouseDown={(e) => handleBlockMouseDown(e, block.id)}
                        />
                        <span className="text-[10px] text-white/70 font-medium select-none">Bloc données</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeBlock(block.id); }}
                          className="ml-1 p-0.5 rounded hover:bg-white/20 text-white/80 hover:text-white transition-colors"
                          title="Supprimer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                    {/* Drag handle — only top bar (8px) to avoid blocking content interaction */}
                    <div
                      className="absolute top-0 left-0 right-0 h-2 z-10"
                      onMouseDown={(e) => handleBlockMouseDown(e, block.id)}
                      style={{ cursor: draggingBlock?.id === block.id ? "grabbing" : "grab" }}
                    />
                    {/* Content */}
                    {(() => {
                      const bStyle = blockStyles[block.id] ?? {
                        headerColor: "#0070C0",
                        rowColor: "#F3F3F3",
                        fontSize: block.fontSize ?? 10,
                        fontFamily: block.fontFamily ?? "Inter",
                        textColor: block.textColor ?? "#1a1a1a",
                        borderColor: "#e5e7eb",
                        borderWidth: 1,
                      };
                      const isTable = block.content.includes("|");
                      const fontFamilyCss = bStyle.fontFamily === "Mono" ? "monospace" : bStyle.fontFamily === "Georgia" ? "Georgia, serif" : bStyle.fontFamily + ", sans-serif";
                      return (
                        <>
                          <style>{`
                            .block-md-${block.id} th { background-color: ${bStyle.headerColor} !important; color: white; padding: 3px 8px; border: ${bStyle.borderWidth}px solid ${bStyle.borderColor}; }
                            .block-md-${block.id} td { padding: 3px 8px; color: ${bStyle.textColor}; border: ${bStyle.borderWidth}px solid ${bStyle.borderColor}; }
                            .block-md-${block.id} tr:nth-child(even) td { background-color: ${bStyle.rowColor}; }
                            .block-md-${block.id} table { font-size: ${bStyle.fontSize}px; font-family: ${fontFamilyCss}; border-collapse: collapse; width: 100%; }
                          `}</style>
                          <div className={`relative z-20 p-3 text-xs text-gray-700 prose prose-sm max-w-none block-md-${block.id}`}
                            style={block.h !== undefined ? { height: "100%", overflow: "auto" } : {}}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
                          </div>
                          {/* Table style panel */}
                          {isSelected && isTable && (
                            <div
                              className="absolute left-0 z-40 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 flex items-center gap-3 flex-wrap"
                              style={{ top: "calc(100% + 4px)", minWidth: 420, pointerEvents: "all" }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                            >
                              <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                                En-tête
                                <input type="color" value={bStyle.headerColor}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, headerColor: e.target.value } }))}
                                  className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                                Lignes paires
                                <input type="color" value={bStyle.rowColor}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, rowColor: e.target.value } }))}
                                  className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                                Texte
                                <input type="color" value={bStyle.textColor}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, textColor: e.target.value } }))}
                                  className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                                Bordure
                                <input type="color" value={bStyle.borderColor}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, borderColor: e.target.value } }))}
                                  className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                                <input type="number" min={0} max={4} value={bStyle.borderWidth}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, borderWidth: Number(e.target.value) } }))}
                                  className="w-10 text-[10px] border border-gray-200 rounded px-1 py-0.5" />
                                px
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                                Taille
                                <input type="number" min={7} max={18} value={bStyle.fontSize}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, fontSize: Number(e.target.value) } }))}
                                  className="w-12 text-[10px] border border-gray-200 rounded px-1 py-0.5" />
                                px
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                                Police
                                <select value={bStyle.fontFamily}
                                  onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, fontFamily: e.target.value } }))}
                                  className="text-[10px] border border-gray-200 rounded px-1 py-0.5">
                                  <option value="Inter">Inter</option>
                                  <option value="Raleway">Raleway</option>
                                  <option value="Georgia">Georgia</option>
                                  <option value="Playfair">Playfair</option>
                                  <option value="Mono">Mono</option>
                                </select>
                              </label>
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {/* Resize handle (bottom-right) — width + height */}
                    {isSelected && (
                      <div
                        className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize z-30 flex items-end justify-end"
                        style={{ background: "linear-gradient(135deg, transparent 50%, #2CA6F9 50%)", borderBottomRightRadius: 6 }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const canvas = canvasRef.current;
                          if (!canvas) return;
                          const startX = e.clientX;
                          const startY = e.clientY;
                          const origW = block.w;
                          const rect = canvas.getBoundingClientRect();
                          const currentBlockEl = canvas.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null;
                          const currentHpx = currentBlockEl?.offsetHeight ?? rect.height * 0.3;
                          const startHpct = block.h ?? (currentHpx / rect.height) * 100;
                          const onMove = (ev: MouseEvent) => {
                            const dw = ((ev.clientX - startX) / rect.width) * 100;
                            const dh = ((ev.clientY - startY) / rect.height) * 100;
                            setDroppedBlocks(prev => prev.map(b => b.id === block.id
                              ? { ...b, w: Math.max(5, Math.min(95, origW + dw)), h: Math.max(5, Math.min(90, startHpct + dh)) }
                              : b
                            ));
                          };
                          const onUp = (ev: MouseEvent) => {
                            ev.stopPropagation();
                            window.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mouseup", onUp);
                          };
                          window.addEventListener("mousemove", onMove);
                          window.addEventListener("mouseup", onUp);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Navigation */}
            <div className="flex items-center gap-4 mt-3">
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
                      width: currentSlide === i ? 14 : 5,
                      height: 5,
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
                disabled={currentSlide === slides.length + customSlides.length - 1}
                className="p-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </button>

              {/* Slide counter */}
              <span className="text-xs text-gray-400 ml-1 tabular-nums select-none">
                {currentSlide + 1} / {slides.length + customSlides.length}
              </span>
            </div>

            {/* Notes panel */}
            <div className="mt-3 w-full max-w-3xl print:hidden">
              <button
                onClick={() => setNotePanelOpen(o => !o)}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors w-full"
              >
                <span className={`transition-transform inline-block ${notePanelOpen ? "rotate-90" : ""}`}>▶</span>
                Notes de présentation
                {currentSlideNote && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />}
              </button>
              {notePanelOpen && (
                <textarea
                  value={currentSlideNote}
                  onChange={(e) => {
                    setSlideNotes(prev => ({ ...prev, [currentSlideId]: e.target.value }));
                  }}
                  placeholder="Ajoutez des notes pour cette slide… (masquées à l'impression)"
                  className="mt-1.5 w-full text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-2.5 resize-none focus:outline-none focus:border-blue-300 transition-colors"
                  rows={3}
                />
              )}
            </div>
            </>
            )}
          </div>
        </div>

        {/* ── RIGHT: AI Panel (38%) ─────────────────────────────────────── */}
        <div style={{ flex: "0 0 38%" }} className="overflow-hidden">
          <AIPanel
            deckData={deckData}
            currentSlideIndex={currentSlide}
            currentSlideLabel={currentSlide < slides.length ? (slides[currentSlide]?.label ?? "") : (customSlides[currentSlide - slides.length]?.label ?? "")}
            onSlideUpdate={handleSlideUpdate}
            onRefreshDeckData={handleGenerate}
            onExportPptx={handleExportPptx}
            onExportPdf={handleExportPdf}
            onShareDeck={handleShareDeck}
            onResetDeck={handleResetDeck}
            onAddCustomSlide={handleAddCustomSlide}
            onDuplicateSlide={handleDuplicateSlide}
            onMoveSlide={handleMoveSlide}
            onRenameSlide={handleRenameSlide}
            onDeleteSlide={handleDeleteSlide}
            onSetNote={handleSetNote}
            currentSlideNote={currentSlideNote}
          />
        </div>
      </div>
      </SlideStyleContext.Provider>

      {/* ── Toast notification ──────────────────────────────────────────── */}
      {toastMsg && (
        <div
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white animate-in fade-in slide-in-from-bottom-2"
          style={{ backgroundColor: "#1a1a2e", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          {toastMsg}
        </div>
      )}

      {/* ── Keyboard shortcut help modal ────────────────────────────────── */}
      {shortcutHelpOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShortcutHelpOpen(false)}>
          <div className="bg-[#1a1a2e] border border-gray-700 rounded-2xl shadow-2xl w-[480px] max-w-[95vw] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Raccourcis clavier</h2>
              <button onClick={() => setShortcutHelpOpen(false)} className="text-gray-500 hover:text-white text-xs">Esc</button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              {([
                ["←  /  ↑", "Slide précédente"],
                ["→  /  ↓", "Slide suivante"],
                ["[", "Début section précédente"],
                ["]", "Début section suivante"],
                ["G", "Dernière slide"],
                ["gg", "Première slide"],
                ["/", "Chercher dans filmstrip"],
                ["N", "Panneau de notes"],
                ["F", "Filtrer slides avec notes"],
                ["Ctrl+K", "Palette de commandes"],
                ["Tab / ⇧Tab", "Section suiv./préc. (palette)"],
                ["Ctrl+Shift+E", "Exporter PDF"],
                ["Ctrl+Shift+N", "Exporter notes CSV"],
                ["?", "Cette aide"],
              ] as [string, string][]).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-2 py-1 border-b border-gray-800/50">
                  <kbd className="font-mono text-[10px] bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-gray-300 whitespace-nowrap">{key}</kbd>
                  <span className="text-gray-400 text-right">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Print-only: all slides rendered for PDF export ─────────────── */}
      {isPrintingPdf && deckData && (
        <div className="deck-print-all">
          {slides.map((slide, i) => {
            const note = slideNotes[slide.id];
            return (
              <div key={slide.id} className="deck-print-page">
                {slide.render(deckData, i + 1, { getOverride: getSlideOverride })}
                {note && (
                  <div className="deck-print-notes">
                    <span className="deck-print-notes-label">Notes</span>
                    {note}
                  </div>
                )}
              </div>
            );
          })}
          {customSlides.map((cs, i) => {
            const note = slideNotes[cs.id];
            return (
              <div key={cs.id} className="deck-print-page">
                <div className="w-full aspect-[16/9] bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm p-6" style={{ fontFamily: cs.fontFamily || "'Open Sans', sans-serif" }}>
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{cs.label}</div>
                  <div className="prose prose-sm max-w-none text-gray-800"><ReactMarkdown remarkPlugins={[remarkGfm]}>{cs.content}</ReactMarkdown></div>
                </div>
                {note && (
                  <div className="deck-print-notes">
                    <span className="deck-print-notes-label">Notes</span>
                    {note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Command Palette (Ctrl+K) ─────────────────────────────────────── */}
      {commandPaletteOpen && (() => {
        const q = commandPaletteQuery.trim().toLowerCase();
        const allSlides = [
          ...slides.map((s, i) => ({ idx: i, label: s.label, section: s.section })),
          ...customSlides.map((cs, i) => ({ idx: slides.length + i, label: cs.label, section: -1 })),
        ];
        // If query is a pure number, prioritise by slide number (1-based) first, then by label
        const isNumericQuery = /^\d+$/.test(q);
        const filtered = q
          ? isNumericQuery
            ? allSlides
                .filter(s => String(s.idx + 1).includes(q) || s.label.toLowerCase().includes(q))
                .sort((a, b) => (String(a.idx + 1) === q ? -1 : String(b.idx + 1) === q ? 1 : 0))
            : allSlides.filter(s => s.label.toLowerCase().includes(q))
          : allSlides;
        return (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60"
            onClick={() => setCommandPaletteOpen(false)}
          >
            <div
              className="w-full max-w-md bg-gray-900 rounded-xl shadow-2xl overflow-hidden border border-gray-700"
              onClick={e => e.stopPropagation()}
            >
              {/* Input */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700">
                <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 111 11a6 6 0 0116 0z" />
                </svg>
                <input
                  ref={commandPaletteInputRef}
                  type="text"
                  value={commandPaletteQuery}
                  onChange={e => { setCommandPaletteQuery(e.target.value); setCommandPaletteIndex(0); }}
                  onKeyDown={e => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setCommandPaletteIndex(i => Math.min(i + 1, filtered.length - 1)); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setCommandPaletteIndex(i => Math.max(i - 1, 0)); }
                    else if (e.key === "Tab" && e.shiftKey) {
                      e.preventDefault();
                      const curSec = filtered[commandPaletteIndex]?.section;
                      const curSecStart = filtered.findIndex(s => s.section === curSec);
                      if (curSecStart > 0) {
                        const prevSec = filtered[curSecStart - 1]?.section;
                        const prevSecStart = filtered.findIndex(s => s.section === prevSec);
                        setCommandPaletteIndex(prevSecStart);
                      }
                    }
                    else if (e.key === "Tab") {
                      e.preventDefault();
                      const curSec = filtered[commandPaletteIndex]?.section;
                      const nextIdx = filtered.findIndex((s, i) => i > commandPaletteIndex && s.section !== curSec);
                      if (nextIdx !== -1) setCommandPaletteIndex(nextIdx);
                    }
                    else if (e.key === "Enter") {
                      const target = filtered[commandPaletteIndex];
                      if (target) { goToSlide(target.idx); setCommandPaletteOpen(false); }
                    } else if (e.key === "Escape") { setCommandPaletteOpen(false); }
                  }}
                  placeholder="Aller à une slide… (Ctrl+K)"
                  className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none"
                />
                <kbd className="text-[9px] text-gray-500 bg-gray-800 border border-gray-600 rounded px-1 py-0.5">Esc</kbd>
              </div>
              {/* Results */}
              <div className="max-h-72 overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-gray-500">Aucune slide trouvée</div>
                ) : filtered.map((s, i) => {
                  const showSectionDivider = i === 0 || filtered[i - 1]?.section !== s.section;
                  const secLabel = s.section === -1 ? "Custom" : (SECTION_LABELS[s.section] ?? `Section ${s.section}`);
                  const secColor = s.section === -1 ? "#9CA3AF" : (SECTION_COLORS[s.section] ?? "#2CA6F9");
                  return (
                    <div key={s.idx}>
                      {showSectionDivider && (
                        <div className="px-4 pt-2 pb-1 flex items-center gap-2">
                          <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: secColor }}>{secLabel}</span>
                          <div className="flex-1 h-px" style={{ backgroundColor: `${secColor}30` }} />
                        </div>
                      )}
                      <button
                        onClick={() => { goToSlide(s.idx); setCommandPaletteOpen(false); }}
                        className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors ${
                          i === commandPaletteIndex ? "bg-blue-600 text-white" : "text-gray-200 hover:bg-gray-800"
                        }`}
                      >
                        <span className={`text-[10px] font-mono w-6 flex-shrink-0 text-right ${i === commandPaletteIndex ? "text-blue-200" : "text-gray-500"}`}>
                          {s.idx + 1}
                        </span>
                        <HighlightLabel label={s.label} search={commandPaletteQuery} />
                      </button>
                    </div>
                  );
                })}
              </div>
              {filtered.length > 0 && (
                <div className="px-4 py-2 border-t border-gray-700 text-[9px] text-gray-500 flex gap-3 flex-wrap">
                  <span>↑↓ naviguer</span>
                  <span>Tab/⇧Tab section suivante/précédente</span>
                  <span>↵ aller</span>
                  <span>Esc fermer</span>
                  <span>· numéro pour aller direct</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
