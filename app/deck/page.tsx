"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
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
} from "lucide-react";
import {
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
import { AIPanel } from "@/components/deck/ai-panel";
import { exportDeckToPptx } from "@/lib/deck-export";
import { SlideStyleContext, type TextStyle } from "@/components/deck/slide-style-context";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
      .then((data: { clients: DeckClient[] }) => {
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
  const [filmstripDragging, setFilmstripDragging] = useState<number | null>(null);
  const [filmstripDropTarget, setFilmstripDropTarget] = useState<number | null>(null);
  const [slideNotes, setSlideNotes] = useState<Record<string, string>>({});
  const [notePanelOpen, setNotePanelOpen] = useState(false);
  const prevSlideRef = useRef<number>(-1);
  const slideContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const activeFilmstripItemRef = useRef<HTMLButtonElement>(null);
  const [slideTransition, setSlideTransition] = useState(false);

  const periods = useMemo(() => getAvailablePeriods(), []);
  const slides = useMemo(() => buildSlides(), []);

  const currentSlideId = currentSlide < slides.length
    ? (slides[currentSlide]?.id ?? `slide-${currentSlide}`)
    : (customSlides[currentSlide - slides.length]?.id ?? `custom-${currentSlide}`);
  const currentSlideNote = slideNotes[currentSlideId] ?? "";

  const [deckData, setDeckData] = useState<DeckData | null>(null);
  const [dataSource, setDataSource] = useState<"real" | "mock" | null>(null);

  const generateDeck = useCallback(async (client: DeckClient, period: DeckPeriod) => {
    setIsGenerating(true);
    try {
      const res = await fetch("/api/deck/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client, period }),
      });
      if (res.ok) {
        const json = await res.json() as { data: DeckData; source: "real" | "mock" };
        setDeckData(json.data);
        setDataSource(json.source);
      } else {
        setDeckData(generateMockDeckData(client, period));
        setDataSource("mock");
      }
    } catch {
      setDeckData(generateMockDeckData(client, period));
      setDataSource("mock");
    }
    setDeckGenerated(true);
    setCurrentSlide(0);
    setIsGenerating(false);
  }, []);

  // Auto-generate when client or period changes
  useEffect(() => {
    if (selectedClient) {
      generateDeck(selectedClient, selectedPeriod);
    }
  }, [selectedClient?.id, selectedPeriod.month]);

  const handleGenerate = () => {
    if (selectedClient) generateDeck(selectedClient, selectedPeriod);
  };

  const handleExportPptx = async () => {
    if (!deckData) return;
    setIsExporting(true);
    try {
      const blob = await exportDeckToPptx(deckData);
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
      // Escape : ferme le panneau de notes s'il est ouvert
      else if (e.key === "Escape") {
        if (notePanelOpen) setNotePanelOpen(false);
      }
      // N : toggle panneau de notes
      else if (e.key === "n" || e.key === "N") {
        if (inInput) return;
        e.preventDefault();
        setNotePanelOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deckGenerated, currentSlide, slides.length, notePanelOpen, setNotePanelOpen]);

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
        };
        setDroppedBlocks((prev) => [...prev, newBlock]);
        setSelectedBlockId(newBlock.id);
      }
    } catch (err) {
      console.error("Drop failed:", err);
    }
  };

  // Block drag-to-reposition
  const handleBlockMouseDown = useCallback((e: React.MouseEvent, blockId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const block = droppedBlocks.find(b => b.id === blockId);
    if (!block) return;
    setSelectedBlockId(blockId);
    setDraggingBlock({ id: blockId, startX: e.clientX, startY: e.clientY, origX: block.x, origY: block.y });
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
            ) : clients.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                Aucun compte trouvé — connecte-toi à Meta ou Google Ads
              </p>
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

  // ── Deck viewer — Split layout ─────────────────────────────────────────
  if (!deckData) return null;

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

        <div className="flex-1" />

        {/* Data source badge */}
        {dataSource && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
            dataSource === "real"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-amber-50 text-amber-700 border border-amber-200"
          }`}>
            {dataSource === "real" ? "✓ Données réelles" : "⚠ Données fictives"}
          </span>
        )}

        {/* Slide counter */}
        <span className="text-xs text-gray-400 flex-shrink-0">
          Slide {currentSlide + 1} / {slides.length + customSlides.length}
        </span>

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white flex-shrink-0"
          style={{ backgroundColor: "#0944A1" }}
        >
          {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Générer
        </button>

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
            <div className="flex-1">
            <TooltipProvider delayDuration={300}>
            {Object.entries(sectionSlides).map(([secStr, items]) => {
              const sec = Number(secStr);
              const secColor = SECTION_COLORS[sec] ?? "#2CA6F9";
              return (
                <div key={sec}>
                  <div
                    className="px-2 pt-3 pb-1 text-[9px] font-bold uppercase tracking-wider"
                    style={{ color: secColor }}
                  >
                    {SECTION_LABELS[sec]}
                  </div>
                  {items.map(({ idx, slide }) => {
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
                              {slide.label}
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
            {customSlides.length > 0 && (
              <div>
                <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Personnalisés
                </div>
                <TooltipProvider delayDuration={300}>
                {customSlides.map((cs, i) => {
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
                              <span className="flex-1 truncate">{cs.label}</span>
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
            onClick={() => setSelectedBlockId(null)}
          >
            {/* 16:9 canvas */}
            <div
              className="w-full max-w-3xl transition-opacity duration-300 ease-in-out relative"
              style={{ opacity: slideTransition ? 0 : 1 }}
              ref={canvasRef}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
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
                  return cs ? (
                    <div className="relative" style={{ paddingBottom: "56.25%" }}>
                      <div className="absolute inset-0 bg-white border border-gray-200 rounded-lg shadow-sm flex flex-col">
                        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Slide personnalisée</span>
                          <input
                            type="text"
                            value={cs.label}
                            onChange={(e) => setCustomSlides(prev => prev.map((s, i) => i === currentSlide - slides.length ? { ...s, label: e.target.value } : s))}
                            className="text-sm font-semibold text-gray-800 bg-transparent border-none focus:outline-none flex-1"
                            placeholder="Titre de la slide"
                          />
                          <button
                            onClick={() => { setCustomSlides(prev => prev.filter((_, i) => i !== currentSlide - slides.length)); goToSlide(Math.max(0, currentSlide - 1)); }}
                            className="text-xs text-red-400 hover:text-red-600 transition-colors"
                          >Supprimer</button>
                        </div>
                        <textarea
                          value={cs.content}
                          onChange={(e) => setCustomSlides(prev => prev.map((s, i) => i === currentSlide - slides.length ? { ...s, content: e.target.value } : s))}
                          className="flex-1 p-4 text-sm text-gray-700 resize-none focus:outline-none"
                          style={{ fontFamily: cs.fontFamily || "inherit" }}
                          placeholder="Contenu en Markdown…"
                        />
                      </div>
                    </div>
                  ) : null;
                })()
              )}

              {/* Overlay blocks — positioned ON the canvas */}
              {currentSlideBlocks.map((block) => {
                const isSelected = selectedBlockId === block.id;
                return (
                  <div
                    key={block.id}
                    onClick={(e) => { e.stopPropagation(); setSelectedBlockId(block.id); }}
                    style={{
                      position: "absolute",
                      left: `${block.x}%`,
                      top: `${block.y}%`,
                      width: `${block.w}%`,
                      cursor: draggingBlock?.id === block.id ? "grabbing" : "grab",
                      zIndex: isSelected ? 20 : 10,
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
                    {/* Drag handle (full block) */}
                    <div
                      className="absolute inset-0 z-10"
                      onMouseDown={(e) => handleBlockMouseDown(e, block.id)}
                      style={{ cursor: draggingBlock?.id === block.id ? "grabbing" : "grab" }}
                    />
                    {/* Content */}
                    <div className="relative z-20 p-3 text-xs text-gray-700 prose prose-sm max-w-none pointer-events-none [&_table]:text-[10px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-0.5 [&_th]:bg-[#0070C0] [&_th]:text-white [&_tr:nth-child(even)_td]:bg-[#F3F3F3]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
                    </div>
                    {/* Resize handle (bottom-right) */}
                    {isSelected && (
                      <div
                        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-30"
                        style={{ background: "linear-gradient(135deg, transparent 50%, #2CA6F9 50%)", borderBottomRightRadius: 6 }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const canvas = canvasRef.current;
                          if (!canvas) return;
                          const startX = e.clientX;
                          const origW = block.w;
                          const onMove = (ev: MouseEvent) => {
                            const rect = canvas.getBoundingClientRect();
                            const dw = ((ev.clientX - startX) / rect.width) * 100;
                            setDroppedBlocks(prev => prev.map(b => b.id === block.id
                              ? { ...b, w: Math.max(15, Math.min(95, origW + dw)) }
                              : b
                            ));
                          };
                          const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
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
    </div>
  );
}
