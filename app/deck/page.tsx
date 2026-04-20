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
  GAOverviewSlide,
  GATopPagesSlide,
  GADeviceSourceSlide,
} from "@/components/deck/slides";
import { AIPanel } from "@/components/deck/ai-panel";
import { exportDeckToPptx, exportAiSlidesToPptx } from "@/lib/deck-export";
import { SlideStyleContext, type TextStyle } from "@/components/deck/slide-style-context";
import { DeckDataProvider } from "@/lib/deck-data-context";
import { DynamicSlide } from "@/components/deck/DynamicSlide";
import type { SlideData } from "@/types/deck";
import {
  type SlideConfig,
  type DroppedBlock,
  type SlideOverride,
  SECTION_LABELS,
  SECTION_COLORS,
  resolveSlideKind as resolveSlideKindPure,
} from "@/lib/deck-page-types";
import {
  buildSlidesFromDeckData,
  extractSlideMarkdown,
  buildSlides,
} from "@/lib/deck-slide-builder";
import { Filmstrip } from "@/components/deck/filmstrip";
import { HighlightLabel } from "@/components/deck/highlight-label";
import { snapRect, SNAP_GRID_STEP } from "@/lib/deck-snap";
import { useDeckDraft, type DeckDraftState } from "@/lib/use-deck-draft";
import { DroppedBlocksLayer } from "@/components/deck/dropped-blocks-layer";
import { DECK_THEMES, getTheme } from "@/lib/deck-theme";


// ── Main Page ────────────────────────────────────────────────────────────────

export default function DeckPage() {
  const searchParams = useSearchParams();
  const [clients, setClients] = useState<DeckClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsNeedAuth, setClientsNeedAuth] = useState(false);
  const [clientsFetchError, setClientsFetchError] = useState<string | null>(null);
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
      .catch((err) => {
        setClientsFetchError(err instanceof Error ? err.message : "Impossible de charger les comptes. Vérifiez votre connexion réseau.");
      })
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
  const [aiDynamicSlides, setAiDynamicSlides] = useState<SlideData[]>([]);
  const [currentAiSlide, setCurrentAiSlide] = useState(0);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiGenerateError, setAiGenerateError] = useState<string | null>(null);
  const [isDragOverCanvas, setIsDragOverCanvas] = useState(false);
  const [showAddSlideMenu, setShowAddSlideMenu] = useState(false);
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
  const commandPaletteListRef = useRef<HTMLDivElement>(null);
  const lastGTimeRef = useRef<number>(0);
  const [userContext, setUserContext] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("context") ?? "";
  });
  const prevSlideRef = useRef<number>(-1);
  const slideContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const activeFilmstripItemRef = useRef<HTMLButtonElement>(null);
  const [slideTransition, setSlideTransition] = useState<"none" | "fade-out" | "fade-in">("none");
  const [editMode, setEditMode] = useState(true);
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [editingCustomSlideId, setEditingCustomSlideId] = useState<string | null>(null);
  const [selectedGoogleCustomerId, setSelectedGoogleCustomerId] = useState<string>("");
  const [blockStyles, setBlockStyles] = useState<Record<string, { headerColor: string; rowColor: string; fontSize: number; fontFamily: string; textColor: string; borderColor: string; borderWidth: number }>>({});
  const [slideElements, setSlideElements] = useState<Record<number, SlideElement[]>>({});
  const [masterElements, setMasterElements] = useState<SlideElement[]>([]);
  const [editingMaster, setEditingMaster] = useState(false);
  const [askAiFromSelection, setAskAiFromSelection] = useState(false);
  const [themeId, setThemeId] = useState<string>("impulse");
  const deckTheme = useMemo(() => getTheme(themeId), [themeId]);

  const periods = useMemo(() => getAvailablePeriods(), []);

  // Auto-match Google Ads account: if selected client has no googleCustomerId,
  // find a client with matching name that does have one
  useEffect(() => {
    if (!selectedClient) return;
    if (selectedClient.googleCustomerId) {
      // Client already has a Google Ads ID — auto-set it
      setSelectedGoogleCustomerId(selectedClient.googleCustomerId);
      return;
    }
    // Try to find a matching Google Ads account by name
    const baseName = selectedClient.name.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
    const match = clients.find(
      (c) =>
        c.id !== selectedClient.id &&
        c.googleCustomerId &&
        c.name.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase() === baseName
    );
    if (match?.googleCustomerId) {
      setSelectedGoogleCustomerId(match.googleCustomerId);
    } else {
      setSelectedGoogleCustomerId("");
    }
  }, [selectedClient, clients]);

  const [deckData, setDeckData] = useState<DeckData | null>(null);
  const [dataSource, setDataSource] = useState<"real" | "mock" | null>(null);
  const [dataSourceReason, setDataSourceReason] = useState<string | null>(null);

  // ── Server-side deck draft persistence (sync across devices) ─────────────
  const draftState = useMemo<DeckDraftState>(() => ({
    droppedBlocks, slideOverrides, customSlides, slideNotes,
    blockStyles, slideElements, textStyles, aiDynamicSlides, masterElements, themeId,
  }), [droppedBlocks, slideOverrides, customSlides, slideNotes, blockStyles, slideElements, textStyles, aiDynamicSlides, masterElements, themeId]);

  const applyLoadedDraft = useCallback((draft: typeof draftState) => {
    setDroppedBlocks(draft.droppedBlocks ?? []);
    setSlideOverrides(draft.slideOverrides ?? []);
    setCustomSlides(draft.customSlides ?? []);
    setSlideNotes(draft.slideNotes ?? {});
    setBlockStyles(draft.blockStyles ?? {});
    setSlideElements(draft.slideElements ?? {});
    setTextStyles(draft.textStyles ?? {});
    setAiDynamicSlides(draft.aiDynamicSlides ?? []);
    setMasterElements(draft.masterElements ?? []);
    if (draft.themeId) setThemeId(draft.themeId);
  }, []);

  const { status: draftStatus } = useDeckDraft(
    selectedClient?.id ?? null,
    selectedPeriod?.month ?? null,
    draftState,
    applyLoadedDraft,
  );

  const staticSlides = useMemo(() => {
    // If the selected client has no Google Ads, hide Google Ads section (slides 8-12)
    const hasGoogle = !!(selectedClient?.googleCustomerId || selectedGoogleCustomerId || selectedClient?.platform === "google" || selectedClient?.platform === "both");
    const hasGA = !!(selectedClient?.gaPropertyId) && !!(deckData?.gaOverview);
    const all = buildSlides(hasGoogle, deckData, hasGA);
    let filtered = all;
    if (!hasGoogle) filtered = filtered.filter(s => s.section !== 2);
    if (!hasGA) filtered = filtered.filter(s => s.section !== 5);
    return filtered;
  }, [selectedClient, selectedGoogleCustomerId, deckData]);
  const slides = useMemo(() => staticSlides, [staticSlides]);

  // ── Slide editor hook (elements / tools / drag) ───────────────────────────
  // Use a unified index: for AI slides, offset by 1000 to avoid collision with static slide indices
  const isOnAiSlide = currentSlide >= slides.length + customSlides.length && aiDynamicSlides.length > 0;
  const aiSlideIndex = currentSlide - slides.length - customSlides.length;
  const editorSlideIndex = isOnAiSlide ? 1000 + aiSlideIndex : currentSlide;
  // When editingMaster is ON, the editor reads/writes masterElements (which
  // render under every slide). Otherwise it reads/writes the current slide's
  // per-slide element list.
  const slideEditor = useSlideEditor(
    canvasRef,
    editingMaster ? masterElements : (slideElements[editorSlideIndex] ?? []),
    (els) => {
      if (editingMaster) setMasterElements(els);
      else setSlideElements((prev) => ({ ...prev, [editorSlideIndex]: els }));
    }
  );

  const currentSlideId = currentSlide < slides.length
    ? (slides[currentSlide]?.id ?? `slide-${currentSlide}`)
    : currentSlide < slides.length + customSlides.length
      ? (customSlides[currentSlide - slides.length]?.id ?? `custom-${currentSlide}`)
      : (aiDynamicSlides[currentSlide - slides.length - customSlides.length]?.id ?? `ai-${currentSlide}`);
  const currentSlideNote = slideNotes[currentSlideId] ?? "";

  const slidesWithNotesCount = useMemo(
    () => [...slides, ...customSlides].filter(s => !!slideNotes[s.id]).length,
    [slides, customSlides, slideNotes]
  );

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

      if (realData) {
        setDeckData(realData);
        setDataSource(source);
        setDataSourceReason(source === "mock" ? (reason ?? "Données de démonstration") : null);
      } else {
        setDeckData(null);
        setDataSource("mock");
        setDataSourceReason(reason ?? "Relay non connecté — vérifiez que le relay tourne sur localhost:3457");
      }

      // Check if AI mode is requested (via URL param or user prompt)
      const isAiMode = hasPrompt || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "ai");

      if (isAiMode) {
        // AI mode: generate dynamic slides with kpis/insights via Anthropic
        setAiSlidesMode(true);
        setCustomSlides([]);

        if (realData) {
          setIsGeneratingAi(true);
          setAiGenerateError(null);
          try {
            // Read sections and budgets from URL params if present
            const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
            const sectionsParam = urlParams?.get("sections");
            const sections = sectionsParam ? sectionsParam.split(",") : ["global", "google", "meta", "budget", "learnings"];
            const budgetsParam = urlParams?.get("budgets");
            const budgets = budgetsParam ? JSON.parse(budgetsParam) : {};

            const genRes = await fetch("/api/deck/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                customerId: effectiveClient.id,
                platform: effectiveClient.platform ?? "both",
                metaAccountId: effectiveClient.metaAccountId,
                googleCustomerId: effectiveClient.googleCustomerId,
                dateRange: { startDate: period.startDate, endDate: period.endDate, label: period.label },
                sections,
                context: prompt || undefined,
                budgets,
              }),
            });

            if (genRes.ok) {
              const genJson = await genRes.json() as { slides?: SlideData[] };
              if (genJson.slides && genJson.slides.length > 0) {
                setAiDynamicSlides(genJson.slides);
              } else {
                // Fallback: build slides from the real deck data client-side
                const fallbackSlides = buildSlidesFromDeckData(realData);
                if (fallbackSlides.length > 0) {
                  setAiDynamicSlides(fallbackSlides);
                } else {
                  setAiGenerateError("L'IA n'a retourné aucune slide.");
                }
              }
            } else {
              const errText = await genRes.text().catch(() => `Erreur ${genRes.status}`);
              // Fallback: build slides from the real deck data
              const fallbackSlides = buildSlidesFromDeckData(realData);
              if (fallbackSlides.length > 0) {
                setAiDynamicSlides(fallbackSlides);
                console.warn("[deck] AI generate failed, using client-side fallback:", errText);
              } else {
                setAiGenerateError(errText || `Erreur ${genRes.status}`);
              }
            }
          } catch (err) {
            // Fallback: build slides from the real deck data
            if (realData) {
              const fallbackSlides = buildSlidesFromDeckData(realData);
              if (fallbackSlides.length > 0) {
                setAiDynamicSlides(fallbackSlides);
                console.warn("[deck] AI generate error, using client-side fallback:", err);
              } else {
                setAiGenerateError(err instanceof Error ? err.message : String(err));
              }
            } else {
              setAiGenerateError(err instanceof Error ? err.message : String(err));
            }
          } finally {
            setIsGeneratingAi(false);
          }
        } else {
          // No real data at all — show error
          setAiGenerateError("Aucune donnée disponible. Vérifiez la connexion Meta/Google Ads.");
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
          metaAccountId: selectedClient.metaAccountId,
          googleCustomerId: selectedClient.googleCustomerId,
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
    // Always use generateDeck which handles both static and AI mode
    // (AI mode is detected from URL param mode=ai or from userContext)
    generateDeck(selectedClient, selectedPeriod, userContext || undefined, selectedGoogleCustomerId || undefined);
  }, [selectedClient, clientsLoading, generateDeck, handleGenerateAiDeck, selectedPeriod, userContext, selectedGoogleCustomerId]);

  const handleExportPptx = async () => {
    setIsExporting(true);
    try {
      let blob: Blob;
      let filename: string;

      if (deckData) {
        // Export static slides (+ AI slides if any)
        blob = await exportDeckToPptx(deckData, customSlides, droppedBlocks, slideElements, aiDynamicSlides.length > 0 ? aiDynamicSlides : undefined, blockStyles, masterElements);
        filename = `MBR_${deckData.client.name.replace(/\s+/g, "_")}_${deckData.period.month}.pptx`;
      } else if (aiDynamicSlides.length > 0) {
        // Export AI-only slides
        blob = await exportAiSlidesToPptx(aiDynamicSlides);
        filename = `AI_Deck_${new Date().toISOString().slice(0, 10)}.pptx`;
      } else {
        alert("Aucun deck à exporter.");
        return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
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
    if (!deckData && aiDynamicSlides.length === 0) return;
    setIsPrintingPdf(true);
  }, [deckData, aiDynamicSlides.length]);

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
      const insertAt = isCustom ? (currentSlide - slides.length) + 1 : 0;
      const next = [...prev.slice(0, insertAt), newSlide, ...prev.slice(insertAt)];
      setTimeout(() => setCurrentSlide(slides.length + insertAt), 50);
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
      const isOnCustom = currentSlide >= slides.length && currentSlide < slides.length + prev.length;
      const insertAt = isOnCustom ? (currentSlide - slides.length) + 1 : 0;
      const next = [...prev.slice(0, insertAt), newSlide, ...prev.slice(insertAt)];
      setTimeout(() => setCurrentSlide(slides.length + insertAt), 50);
      return next;
    });
    showToast(`✅ Slide "${label}" ajoutée`);
  }, [currentSlide, slides.length, showToast]);

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
    // Template dropped on the filmstrip → create a new custom slide
    const tplContent = e.dataTransfer.getData("application/deck-template");
    if (tplContent) {
      const label = tplContent.match(/^##?\s+(.+)/m)?.[1] || "Template";
      handleAddCustomSlide(label, tplContent);
      setFilmstripDragging(null);
      setFilmstripDropTarget(null);
      return;
    }
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
  }, [filmstripDragging, slides.length, showToast, handleAddCustomSlide]);

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

  const totalSlideCount = slides.length + customSlides.length + aiDynamicSlides.length;
  const goToSlide = (idx: number) => {
    const newIdx = Math.max(0, Math.min(totalSlideCount - 1, idx));
    if (newIdx !== currentSlide) {
      setSlideTransition("fade-out");
      setTimeout(() => {
        setCurrentSlide(newIdx);
        setSlideTransition("fade-in");
        setTimeout(() => setSlideTransition("none"), 200);
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

  // ── Scroll active command palette item into view ─────────────────────────
  useEffect(() => {
    if (!commandPaletteOpen || !commandPaletteListRef.current) return;
    const container = commandPaletteListRef.current;
    const active = container.querySelector(`[data-palette-idx="${commandPaletteIndex}"]`);
    if (active) {
      (active as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [commandPaletteIndex, commandPaletteOpen]);

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
        if (e.key === "g" && now - lastGTimeRef.current < 400) {
          // gg → first slide
          goToSlide(0);
          lastGTimeRef.current = 0;
        } else if (e.key === "G") {
          // G → last slide
          goToSlide(totalSlideCount - 1);
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
  }, [deckGenerated, currentSlide, slides, customSlides.length, aiDynamicSlides.length, totalSlideCount, notePanelOpen, setNotePanelOpen, handleExportCsvNotes, handleExportPdf, setShowOnlyWithNotes, commandPaletteOpen, shortcutHelpOpen, showToast]);

  // ── Drag & drop handlers ─────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOverCanvas(true);
  };

  /** Map an absolute page slide index to its kind ("standard"/"custom"/"ai") and local index. */
  const resolveSlideKind = (absIdx: number) =>
    resolveSlideKindPure(absIdx, { standard: slides.length, custom: customSlides.length });

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverCanvas(false);

    // Handle image file drops — add as slide editor elements
    const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (imageFiles.length > 0 && editMode) {
      imageFiles.forEach((file) => {
        slideEditor.handleImageUpload(file);
      });
      return;
    }

    // Handle deck-template drops (from AI panel templates)
    // Behaviour: drop on the canvas overlays the template as a DroppedBlock on
    // the current slide (works on both standard and custom slides). To create
    // a brand-new slide, drop on the filmstrip instead.
    const templateContent = e.dataTransfer.getData("application/deck-template");
    if (templateContent) {
      const canvas = canvasRef.current;
      let xPct = 5, yPct = 12;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        xPct = Math.max(0, Math.min(50, ((e.clientX - rect.left) / rect.width) * 100 - 25));
        yPct = Math.max(0, Math.min(50, ((e.clientY - rect.top) / rect.height) * 100 - 20));
      }
      const { kind, localIdx } = resolveSlideKind(currentSlide);
      const newBlock: DroppedBlock = {
        id: crypto.randomUUID(),
        content: templateContent,
        slideIndex: currentSlide,
        kind, localIdx,
        x: xPct,
        y: yPct,
        w: 50,
        h: 40,
      };
      setDroppedBlocks((prev) => [...prev, newBlock]);
      setSelectedBlockId(newBlock.id);
      return;
    }

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
        const { kind, localIdx } = resolveSlideKind(currentSlide);
        const newBlock: DroppedBlock = {
          id: crypto.randomUUID(),
          content: data.content,
          slideIndex: currentSlide,
          kind, localIdx,
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

  // Snap guides rendered on the canvas while dragging a block.
  // Hold Alt to bypass snapping entirely.
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });

  useEffect(() => {
    if (!draggingBlock) { setSnapGuides({ x: null, y: null }); return; }
    const canvas = canvasRef.current;
    const onMove = (e: MouseEvent) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dx = ((e.clientX - draggingBlock.startX) / rect.width) * 100;
      const dy = ((e.clientY - draggingBlock.startY) / rect.height) * 100;
      const rawX = Math.max(0, Math.min(65, draggingBlock.origX + dx));
      const rawY = Math.max(0, Math.min(70, draggingBlock.origY + dy));

      const draggedBlock = droppedBlocks.find(b => b.id === draggingBlock.id);
      const otherBlocks = droppedBlocks
        .filter(b => b.slideIndex === (draggedBlock?.slideIndex ?? currentSlide) && b.id !== draggingBlock.id)
        .map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h ?? 30 }));
      const w = draggedBlock?.w ?? 30;
      const h = draggedBlock?.h ?? 30;

      const snapEnabled = !e.altKey;
      const { x, y, guideX, guideY } = snapRect(rawX, rawY, w, h, otherBlocks, snapEnabled);
      setSnapGuides({ x: guideX, y: guideY });
      setDroppedBlocks(prev => prev.map(b => b.id === draggingBlock.id
        ? { ...b, x: Math.max(0, Math.min(65, x)), y: Math.max(0, Math.min(70, y)) }
        : b
      ));
    };
    const onUp = () => { setDraggingBlock(null); setSnapGuides({ x: null, y: null }); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [draggingBlock, droppedBlocks, currentSlide]);

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
    const isOnCustom = currentSlide >= slides.length && currentSlide < slides.length + customSlides.length;
    const insertAt = isOnCustom ? (currentSlide - slides.length) + 1 : 0;
    setCustomSlides((prev) => [...prev.slice(0, insertAt), newSlide, ...prev.slice(insertAt)]);
    goToSlide(slides.length + insertAt);
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
    const aiCount = aiDynamicSlides.filter(ai => {
      if (q && !ai.title.toLowerCase().includes(q)) return false;
      return true;
    }).length;
    return stdCount + csCount + aiCount;
  }, [filmstripSearch, showOnlyWithNotes, slides, customSlides, slideNotes, aiDynamicSlides]);

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
            ) : clientsFetchError ? (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                <p className="text-sm font-semibold text-red-700 mb-1">Erreur de chargement</p>
                <p className="text-xs text-red-600 mb-2">{clientsFetchError}</p>
                <button
                  onClick={() => {
                    setClientsFetchError(null);
                    setClientsLoading(true);
                    fetch("/api/deck/clients")
                      .then((r) => r.json())
                      .then((data: { clients: DeckClient[]; needsAuth?: boolean; metaNeedsReconnect?: boolean }) => {
                        if (data.needsAuth) { setClientsNeedAuth(true); return; }
                        if (data.metaNeedsReconnect) setMetaNeedsReconnect(true);
                        if (data.clients?.length > 0) { setClients(data.clients); setSelectedClient(data.clients[0]); }
                      })
                      .catch((err) => setClientsFetchError(err instanceof Error ? err.message : "Erreur réseau"))
                      .finally(() => setClientsLoading(false));
                  }}
                  className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg text-white bg-red-600 hover:bg-red-700 transition-all"
                >
                  Réessayer
                </button>
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
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {clients.map((c) => {
                  const sources = [
                    c.metaAccountId ? "Meta" : "",
                    c.googleCustomerId ? "GAds" : "",
                    c.gaPropertyId ? "GA" : "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name.replace(/\s*\(\d+\)\s*$/, "")}{sources ? ` [${sources}]` : ""}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* Connected sources badges */}
          {selectedClient && (
            <div className="flex items-center gap-1.5 mb-3">
              {selectedClient.metaAccountId && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: "#1877F2" }}>Meta</span>
              )}
              {selectedClient.googleCustomerId && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: "#4285F4" }}>Google Ads</span>
              )}
              {selectedClient.gaPropertyId && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: "#34A853" }}>GA4</span>
              )}
              {!selectedClient.metaAccountId && !selectedClient.googleCustomerId && !selectedClient.gaPropertyId && (
                <span className="text-[10px] text-gray-400">Aucune source connectée</span>
              )}
            </div>
          )}

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

          {/* Google Ads auto-matched from client — no manual selector needed */}

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
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {periods.map((p) => (
                <option key={p.month} value={p.month}>
                  {p.label}
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
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
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

  // ── Relay error — no data (but not in AI mode with slides already loaded) ─
  if (deckGenerated && !deckData && !(aiDynamicSlides.length > 0 || isGeneratingAi)) {
    const isServerError = dataSourceReason?.startsWith("Erreur serveur");
    const isNetworkError = dataSourceReason?.includes("fetch") || dataSourceReason?.includes("TypeError") || dataSourceReason?.includes("NetworkError");
    const errorTitle = isServerError
      ? "Erreur serveur"
      : isNetworkError
      ? "Erreur réseau"
      : "Relay non connecté";
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-950 text-white gap-4 p-8">
        <div className="text-5xl">{isServerError ? "🔴" : isNetworkError ? "🌐" : "⚠️"}</div>
        <h2 className="text-xl font-semibold">{errorTitle}</h2>
        <p className="text-gray-400 text-center max-w-md text-sm">
          {dataSourceReason ?? "Impossible de récupérer les données. Vérifiez que le relay OpenClaw tourne sur localhost:3457 et réessayez."}
        </p>
        <div className="flex gap-3 mt-4">
          <button
            onClick={() => {
              if (selectedClient) generateDeck(selectedClient, selectedPeriod, userContext || undefined, selectedGoogleCustomerId || undefined);
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
          >
            Réessayer
          </button>
          <button
            onClick={() => setDeckGenerated(false)}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
          >
            ← Retour
          </button>
        </div>
      </div>
    );
  }

  // ── Deck viewer — Split layout ─────────────────────────────────────────
  if (!deckData && !(aiDynamicSlides.length > 0 || isGeneratingAi)) return null;

  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">
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
            {clients.map((cl) => {
              const srcs = [
                cl.metaAccountId ? "Meta" : "",
                cl.googleCustomerId ? "GAds" : "",
                cl.gaPropertyId ? "GA" : "",
              ].filter(Boolean).join(" · ");
              return (
                <option key={cl.id} value={cl.id}>
                  {cl.name}{srcs ? ` [${srcs}]` : ""}
                </option>
              );
            })}
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

        {/* Slide counter */}
        <span className="text-xs text-gray-400 flex-shrink-0">
          Slide {currentSlide + 1} / {totalSlideCount}
        </span>

        {/* Theme picker */}
        <div className="flex items-center gap-1.5 flex-shrink-0" title="Palette de couleurs du deck">
          <div
            className="w-4 h-4 rounded-sm border border-gray-300 flex-shrink-0"
            style={{ background: `linear-gradient(135deg, ${deckTheme.primary} 0%, ${deckTheme.accent} 60%, ${deckTheme.accentAlt} 100%)` }}
          />
          <select
            value={themeId}
            onChange={(e) => setThemeId(e.target.value)}
            className="text-xs text-gray-600 bg-transparent border-none focus:outline-none cursor-pointer pr-4"
          >
            {DECK_THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white flex-shrink-0"
          style={{ backgroundColor: deckTheme.primary }}
        >
          {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Générer
        </button>

        {/* Draft save status */}
        <span
          className="text-[10px] text-gray-400 select-none flex-shrink-0 tabular-nums"
          title="Sauvegarde automatique sur le serveur (se synchronise entre appareils)"
        >
          {draftStatus === "loading" && "↓ chargement…"}
          {draftStatus === "saving" && "↑ sauvegarde…"}
          {draftStatus === "saved" && "✓ sauvegardé"}
          {draftStatus === "error" && <span className="text-red-400">⚠ offline</span>}
        </span>

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
          disabled={!deckData && aiDynamicSlides.length === 0}
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

        {/* Export Google Slides — downloads PPTX then opens Google Slides for import */}
        <button
          onClick={async () => {
            if (!deckData && aiDynamicSlides.length === 0) { alert("Aucun deck à exporter."); return; }
            setIsExporting(true);
            try {
              let blob: Blob;
              let filename: string;
              if (deckData) {
                blob = await exportDeckToPptx(deckData, customSlides, droppedBlocks, slideElements, aiDynamicSlides.length > 0 ? aiDynamicSlides : undefined, blockStyles, masterElements);
                filename = `MBR_${deckData.client.name.replace(/\s+/g, "_")}_${deckData.period.month}.pptx`;
              } else {
                blob = await exportAiSlidesToPptx(aiDynamicSlides);
                filename = `AI_Deck_${new Date().toISOString().slice(0, 10)}.pptx`;
              }

              // Download the PPTX file
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 10000);

              // Open Google Slides — user imports the downloaded PPTX
              setTimeout(() => {
                window.open("https://docs.google.com/presentation/u/0/create", "_blank");
              }, 1000);

              showToast("PPTX téléchargé ! Dans Google Slides : Fichier → Importer des diapositives → Importer → sélectionner le fichier .pptx");
            } catch (err) {
              console.error("Google Slides export failed:", err);
              alert("Erreur : " + (err instanceof Error ? err.message : String(err)));
            } finally {
              setIsExporting(false);
            }
          }}
          disabled={isExporting}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors text-white flex-shrink-0"
          style={{ backgroundColor: deckTheme.primary }}
        >
          <Download className="w-3.5 h-3.5" />
          Google Slides
        </button>

        {/* AI panel toggle */}
        <button
          onClick={() => setShowAiPanel((v) => !v)}
          title={showAiPanel ? "Masquer l'assistant IA" : "Afficher l'assistant IA"}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors flex-shrink-0 ${
            showAiPanel
              ? "bg-purple-100 text-purple-700 hover:bg-purple-200"
              : "bg-gray-100 hover:bg-gray-200 text-gray-700"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          {showAiPanel ? "IA ▶" : "IA ◀"}
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

        {/* Master-layout toggle — only when editing is on */}
        {editMode && (
          <button
            onClick={() => setEditingMaster((v) => !v)}
            title={editingMaster ? "Revenir à la slide courante" : "Éditer le master (calque appliqué à toutes les slides)"}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors flex-shrink-0 ${
              editingMaster ? "bg-violet-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"
            }`}
          >
            {editingMaster ? "Master ON" : "Master"}
          </button>
        )}

        {/* Push selection to master (when not editing master) */}
        {editMode && !editingMaster && slideEditor.selectedIds.length > 0 && (
          <button
            onClick={() => {
              const sel = new Set(slideEditor.selectedIds);
              const current = slideElements[editorSlideIndex] ?? [];
              const toMove = current.filter((el) => sel.has(el.id));
              if (toMove.length === 0) return;
              setMasterElements((m) => [...m, ...toMove]);
              setSlideElements((prev) => ({
                ...prev,
                [editorSlideIndex]: current.filter((el) => !sel.has(el.id)),
              }));
              slideEditor.setSelectedIds([]);
            }}
            title="Déplacer la sélection vers le master (visible sur toutes les slides)"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors flex-shrink-0 bg-gray-100 hover:bg-gray-200 text-gray-700"
          >
            → Master
          </button>
        )}
      </div>

      {/* ── Split layout: Slides (left) + AI Panel (right) ───────────────── */}
      <DeckDataProvider value={deckData}>
      <SlideStyleContext.Provider value={{ getStyle: getTextStyle, setStyle: setTextStyle, periodLabel: selectedPeriod?.label, theme: deckTheme }}>
      <div className="flex-1 flex overflow-hidden">

        {/* ── LEFT: Filmstrip + Slide Viewer (60-65%) ───────────────────── */}
        <div className="flex-1 flex overflow-hidden" style={{ flex: showAiPanel ? "0 0 62%" : "1 1 100%" }}>

          <Filmstrip
            slides={slides}
            customSlides={customSlides}
            aiDynamicSlides={aiDynamicSlides}
            sectionSlides={sectionSlides}
            currentSlide={currentSlide}
            totalSlideCount={totalSlideCount}
            goToSlide={goToSlide}
            activeFilmstripItemRef={activeFilmstripItemRef}
            slideNotes={slideNotes}
            slidesWithNotesCount={slidesWithNotesCount}
            showOnlyWithNotes={showOnlyWithNotes}
            setShowOnlyWithNotes={setShowOnlyWithNotes}
            filmstripSearch={filmstripSearch}
            setFilmstripSearch={setFilmstripSearch}
            filmstripSearchRef={filmstripSearchRef}
            filmstripResultCount={filmstripResultCount}
            filmstripDragging={filmstripDragging}
            filmstripDropTarget={filmstripDropTarget}
            setFilmstripDropTarget={setFilmstripDropTarget}
            handleFilmstripDragStart={handleFilmstripDragStart}
            handleFilmstripDragOver={handleFilmstripDragOver}
            handleFilmstripDrop={handleFilmstripDrop}
            handleFilmstripDragEnd={handleFilmstripDragEnd}
            aiSlidesMode={aiSlidesMode}
            addCustomSlide={addCustomSlide}
            showAddSlideMenu={showAddSlideMenu}
            setShowAddSlideMenu={setShowAddSlideMenu}
            handleAddCustomSlide={handleAddCustomSlide}
          />

          {/* Slide preview */}
          <div
            className="flex-1 flex flex-col items-center justify-center p-4 overflow-auto"
            ref={slideContainerRef}
            onClick={(e) => {
              // Only clear selection when clicking empty space, not when a
              // child element (rect, text, block) bubbles its click up.
              if (e.target === e.currentTarget) {
                setSelectedBlockId(null);
                slideEditor.setSelectedId(null);
              }
            }}
          >
            <>
            {/* Edit toolbar — outside canvas so it doesn't affect % position calculations */}
            <div className="w-full max-w-3xl mb-0">
              <SlideEditorToolbar
                activeTool={slideEditor.activeTool}
                onToolChange={slideEditor.setActiveTool}
                selectedElement={slideEditor.selectedElement}
                onUpdateElement={(patch) => {
                  // When 1 selected → patch just that element; when 2+ → apply to all (bulk style).
                  if (slideEditor.selectedIds.length > 1) {
                    slideEditor.updateSelected(patch);
                  } else if (slideEditor.selectedElement) {
                    slideEditor.updateElWithHistory(slideEditor.selectedElement.id, patch);
                  }
                }}
                onDeleteElement={slideEditor.deleteSelected}
                onDuplicateElement={slideEditor.duplicateSelected}
                onBringToFront={slideEditor.bringToFront}
                onSendToBack={slideEditor.sendToBack}
                onUndo={slideEditor.undo}
                onRedo={slideEditor.redo}
                canUndo={slideEditor.canUndo}
                canRedo={slideEditor.canRedo}
                onImageUpload={slideEditor.handleImageUpload}
                selectionCount={slideEditor.selectedIds.length}
                onAlign={slideEditor.alignSelected}
                onDistribute={slideEditor.distributeSelected}
                onGroup={slideEditor.groupSelected}
                onUngroup={slideEditor.ungroupSelected}
                onCopy={slideEditor.copySelected}
                onPaste={slideEditor.pasteClipboard}
                onAskAi={() => setAskAiFromSelection(true)}
              />
            </div>

            {/* 16:9 canvas */}
            <div
              className="w-full max-w-3xl relative"
              style={{
                opacity: slideTransition === "fade-out" ? 0 : 1,
                transform: slideTransition === "fade-out" ? "scale(0.97)" : slideTransition === "fade-in" ? "scale(1)" : "scale(1)",
                transition: slideTransition === "none" ? "none" : "opacity 150ms ease-out, transform 150ms ease-out",
                cursor: editMode ? slideEditor.canvasCursor : "default",
              }}
              ref={canvasRef}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragLeave={(e) => { if (!canvasRef.current?.contains(e.relatedTarget as Node)) setIsDragOverCanvas(false); }}
              onClick={editMode ? slideEditor.handleCanvasClick : undefined}
              onMouseDown={editMode ? slideEditor.handleCanvasMouseDown : undefined}
            >
              {/* Snap guides */}
              {editMode && (slideEditor.activeGuides.vertical.length > 0 || slideEditor.activeGuides.horizontal.length > 0) && (
                <div className="absolute inset-0 pointer-events-none z-40">
                  {slideEditor.activeGuides.vertical.map((v, i) => (
                    <div key={`v${i}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${v}%`, width: 1, background: "#ff00aa", boxShadow: "0 0 0 0.5px #ff00aa" }} />
                  ))}
                  {slideEditor.activeGuides.horizontal.map((h, i) => (
                    <div key={`h${i}`} style={{ position: "absolute", left: 0, right: 0, top: `${h}%`, height: 1, background: "#ff00aa", boxShadow: "0 0 0 0.5px #ff00aa" }} />
                  ))}
                </div>
              )}
              {/* Drop overlay */}
              {isDragOverCanvas && (
                <div className="absolute inset-0 z-50 pointer-events-none rounded-lg border-4 border-violet-500 bg-violet-500/10 flex items-center justify-center">
                  <div className="bg-violet-600 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg">
                    {editMode ? "📷 Déposer l'image sur le canvas" : "📥 Déposer pour créer un slide"}
                  </div>
                </div>
              )}
              {/* Snap guides — rendered while dragging a block onto the canvas grid */}
              {draggingBlock && (
                <>
                  {snapGuides.x !== null && (
                    <div
                      className="absolute top-0 bottom-0 pointer-events-none z-40"
                      style={{ left: `${snapGuides.x}%`, width: 1, background: "#ec4899", boxShadow: "0 0 4px #ec4899" }}
                    />
                  )}
                  {snapGuides.y !== null && (
                    <div
                      className="absolute left-0 right-0 pointer-events-none z-40"
                      style={{ top: `${snapGuides.y}%`, height: 1, background: "#ec4899", boxShadow: "0 0 4px #ec4899" }}
                    />
                  )}
                  {/* Faint 5% grid dots to hint that snapping is active */}
                  {snapGuides.x === null && snapGuides.y === null && (
                    <div
                      className="absolute inset-0 pointer-events-none z-30 opacity-30"
                      style={{
                        backgroundImage: `radial-gradient(circle, #94a3b8 0.5px, transparent 0.5px)`,
                        backgroundSize: `${SNAP_GRID_STEP}% ${SNAP_GRID_STEP}%`,
                      }}
                    />
                  )}
                </>
              )}
              {/* Slide content */}
              {currentSlide < slides.length && deckData ? (
                slides[currentSlide].render(deckData, currentSlide + 1, {
                  onEdit: handleInlineEdit,
                  getOverride: getSlideOverride,
                })
              ) : currentSlide < slides.length + customSlides.length ? (
                // Custom slide
                (() => {
                  const cs = customSlides[currentSlide - slides.length];
                  const isEditingThis = editingCustomSlideId === cs?.id;
                  return cs ? (
                    <div className="relative" style={{ paddingBottom: "56.25%" }}>
                      <div className={`absolute inset-0 rounded-lg shadow-sm flex flex-col overflow-hidden bg-white border border-gray-200`}>
                        {/* Toolbar */}
                        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
                          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Slide IA</span>
                          {isEditingThis ? (
                            <input
                              type="text"
                              value={cs.label}
                              onChange={(e) => setCustomSlides(prev => prev.map((s, i) => i === currentSlide - slides.length ? { ...s, label: e.target.value } : s))}
                              className="text-sm font-semibold text-gray-800 bg-transparent border-none focus:outline-none flex-1"
                              placeholder="Titre de la slide"
                            />
                          ) : (
                            <span className="text-sm font-semibold text-gray-700 flex-1 truncate">{cs.label}</span>
                          )}
                          <button
                            onClick={() => setEditingCustomSlideId(isEditingThis ? null : cs.id)}
                            className="text-xs px-2 py-0.5 rounded transition-colors bg-gray-100 text-gray-600 hover:bg-gray-200"
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
              ) : (
                // AI Dynamic slide
                (() => {
                  const aiIdx = currentSlide - slides.length - customSlides.length;
                  const aiSlide = aiDynamicSlides[aiIdx];
                  return aiSlide ? (
                    <div className="relative z-0" style={{
                      pointerEvents: slideEditor.activeTool !== "select" || (slideElements[editorSlideIndex] ?? []).length > 0 ? "none" : "auto"
                    }}>
                      <DynamicSlide
                        slide={aiSlide}
                        slideNumber={currentSlide + 1}
                      />
                    </div>
                  ) : null;
                })()
              )}

              {/* Layout master — render under every slide. Editable only when editingMaster=ON */}
              {editMode && masterElements.length > 0 && (
                <div className="absolute inset-0 z-5" style={{ pointerEvents: editingMaster ? "auto" : "none" }}>
                  {masterElements.map((el) => (
                    <SlideElementItem
                      key={`master-${el.id}`}
                      el={el}
                      isSelected={editingMaster && slideEditor.selectedIds.includes(el.id)}
                      isEditing={editingMaster && slideEditor.editingId === el.id}
                      onMouseDown={(e) => editingMaster && slideEditor.handleElementMouseDown(e, el)}
                      onDoubleClick={(e) => editingMaster && slideEditor.handleElementDoubleClick(e, el)}
                      onTextChange={(text) => editingMaster && slideEditor.updateEl(el.id, { text })}
                      onTableChange={(tableData) => editingMaster && slideEditor.updateEl(el.id, { tableData })}
                      onBlur={() => slideEditor.setEditingId(null)}
                      onResizeMouseDown={(e) => editingMaster && slideEditor.handleResizeMouseDown(e, el)}
                    />
                  ))}
                </div>
              )}

              {/* Slide editor elements — positioned ON the canvas */}
              {editMode && !editingMaster && (slideElements[editorSlideIndex] ?? []).length > 0 && (
                <div className="absolute inset-0 z-10">
                  {(slideElements[editorSlideIndex] ?? []).map((el) => (
                    <SlideElementItem
                      key={el.id}
                      el={el}
                      isSelected={slideEditor.selectedIds.includes(el.id)}
                      isEditing={slideEditor.editingId === el.id}
                      onMouseDown={(e) => slideEditor.handleElementMouseDown(e, el)}
                      onDoubleClick={(e) => slideEditor.handleElementDoubleClick(e, el)}
                      onTextChange={(text) => slideEditor.updateEl(el.id, { text })}
                      onTableChange={(tableData) => slideEditor.updateEl(el.id, { tableData })}
                      onBlur={() => slideEditor.commitTextEdit()}
                      onResizeMouseDown={(e, handle) => slideEditor.handleResizeMouseDown(e, el, handle)}
                    />
                  ))}
                </div>
              )}

              {/* Marquee selection overlay */}
              {editMode && slideEditor.marquee && (
                <div
                  className="absolute pointer-events-none z-40 border border-[#2CA6F9] bg-[#2CA6F9]/10"
                  style={{
                    left: `${slideEditor.marquee.x}%`,
                    top: `${slideEditor.marquee.y}%`,
                    width: `${slideEditor.marquee.w}%`,
                    height: `${slideEditor.marquee.h}%`,
                  }}
                />
              )}

              {/* Live snap guides while dragging an editor element */}
              {editMode && slideEditor.snapGuide.x !== null && (
                <div
                  className="absolute top-0 bottom-0 pointer-events-none z-40"
                  style={{ left: `${slideEditor.snapGuide.x}%`, width: 1, background: "#ec4899", boxShadow: "0 0 4px #ec4899" }}
                />
              )}
              {editMode && slideEditor.snapGuide.y !== null && (
                <div
                  className="absolute left-0 right-0 pointer-events-none z-40"
                  style={{ top: `${slideEditor.snapGuide.y}%`, height: 1, background: "#ec4899", boxShadow: "0 0 4px #ec4899" }}
                />
              )}

              {/* Overlay blocks — positioned ON the canvas */}
              <DroppedBlocksLayer
                blocks={currentSlideBlocks}
                selectedBlockId={selectedBlockId}
                setSelectedBlockId={setSelectedBlockId}
                blockStyles={blockStyles}
                setBlockStyles={setBlockStyles}
                draggingBlock={draggingBlock}
                handleBlockMouseDown={handleBlockMouseDown}
                removeBlock={removeBlock}
                canvasRef={canvasRef}
                setDroppedBlocks={setDroppedBlocks}
              />
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
                disabled={currentSlide === totalSlideCount - 1}
                className="p-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </button>

              {/* Slide counter */}
              <span className="text-xs text-gray-400 ml-1 tabular-nums select-none">
                {currentSlide + 1} / {totalSlideCount}
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
          </div>
        </div>

        {/* ── RIGHT: AI Panel (38%) ─────────────────────────────────────── */}
        {showAiPanel && <div style={{ flex: "0 0 38%" }} className="h-full overflow-hidden">
          <AIPanel
            deckData={deckData}
            currentSlideIndex={currentSlide}
            currentSlideLabel={currentSlide < slides.length ? (slides[currentSlide]?.label ?? "") : currentSlide < slides.length + customSlides.length ? (customSlides[currentSlide - slides.length]?.label ?? "") : (aiDynamicSlides[currentSlide - slides.length - customSlides.length]?.title ?? "")}
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
            onGenerateAiSlides={(userPrompt: string) => {
              if (!selectedClient) return;
              fetch("/api/deck/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  customerId: selectedClient.id,
                  platform: selectedClient.platform ?? "both",
                  dateRange: { startDate: selectedPeriod.startDate, endDate: selectedPeriod.endDate, label: selectedPeriod.label },
                  sections: ["global", "google", "meta", "budget", "learnings"],
                  context: userPrompt,
                }),
              })
                .then(res => res.json())
                .then((json: { slides?: SlideData[] }) => {
                  if (json.slides && json.slides.length > 0) {
                    setAiDynamicSlides(json.slides);
                    // Navigate to the first AI slide (appended after static + custom)
                    goToSlide(slides.length + customSlides.length);
                  }
                })
                .catch(console.error);
            }}
            selectedElements={slideEditor.selectedElements}
            askAiFromSelection={askAiFromSelection}
            onAskAiConsumed={() => setAskAiFromSelection(false)}
            onApplyDeckPatches={(patches) => {
              // Apply each patch to the current slide's editor elements in sequence.
              setSlideElements((prev) => {
                const current = prev[editorSlideIndex] ?? [];
                let next = [...current];
                for (const p of patches) {
                  if (p.action === "update") {
                    const ids = new Set(p.ids);
                    next = next.map((el) => (ids.has(el.id) ? { ...el, ...p.patch } : el));
                  } else if (p.action === "insert") {
                    const base: SlideElement = {
                      x: 20, y: 20, w: 30, h: 10,
                      fillColor: "transparent",
                      strokeColor: "#0944A1",
                      strokeWidth: 2,
                      opacity: 1,
                      ...p.element,
                      id: crypto.randomUUID(),
                    };
                    next = [...next, base];
                  } else if (p.action === "delete") {
                    const ids = new Set(p.ids);
                    next = next.filter((el) => !ids.has(el.id));
                  }
                }
                return { ...prev, [editorSlideIndex]: next };
              });
            }}
          />
        </div>}
      </div>
      </SlideStyleContext.Provider>
      </DeckDataProvider>

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
              <div className="max-h-72 overflow-y-auto" ref={commandPaletteListRef}>
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
                        data-palette-idx={i}
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
