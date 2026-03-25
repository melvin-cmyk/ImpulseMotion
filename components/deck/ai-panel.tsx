"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Loader2,
  Bot,
  Wrench,
  Sparkles,
} from "lucide-react";
import { streamChat, type ChatMessage, type StreamEvent } from "@/lib/relay-client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DeckData } from "@/lib/deck-data";

// ── Types ────────────────────────────────────────────────────────────────────

interface AIPanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; id: string }[];
  toolResults?: { id: string; content: string; is_error: boolean }[];
  isStreaming?: boolean;
  isFetchResponse?: boolean;
}

interface AIPanelProps {
  deckData: DeckData | null;
  currentSlideIndex: number;
  currentSlideLabel: string;
  onSlideUpdate?: (slideIndex: number, field: string, newValue: string) => void;
  onRefreshDeckData?: () => void;
  onExportPptx?: () => void;
  onExportPdf?: () => void;
  onShareDeck?: () => string;
  onResetDeck?: () => void;
  onAddCustomSlide?: (label: string, content: string) => void;
  onDuplicateSlide?: () => void;
  onMoveSlide?: (direction: "up" | "down") => void;
  onRenameSlide?: (newLabel: string) => void;
  onDeleteSlide?: () => void;
}

// ── Slash command suggestions ────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: "/fetch meta", desc: "Récupérer les données Meta Ads via MCP" },
  { cmd: "/fetch google", desc: "Récupérer les données Google Ads via MCP" },
  { cmd: "/generate learnings", desc: "Générer les learnings à partir des données" },
  { cmd: "/add slide learnings", desc: "Ajouter une slide Learnings au deck" },
  { cmd: "/add slide next-steps", desc: "Ajouter une slide Next Steps au deck" },
  { cmd: "/add slide highlights", desc: "Ajouter une slide Highlights au deck" },
  { cmd: "/add slide table", desc: "Ajouter une slide Tableau de données au deck" },
  { cmd: "/add slide kpi", desc: "Ajouter une slide KPIs au deck" },
  { cmd: "/add slide blank", desc: "Ajouter une slide vierge au deck" },
  { cmd: "/analyze slide", desc: "Analyser la slide actuelle et suggérer des améliorations" },
  { cmd: "/suggest next-steps", desc: "Suggérer des actions prioritaires basées sur la performance" },
  { cmd: "/summarize deck", desc: "Rédiger un résumé exécutif du deck en 3 phrases" },
  { cmd: "/export pptx", desc: "Exporter le deck en fichier PowerPoint (.pptx)" },
  { cmd: "/export pdf", desc: "Exporter le deck en PDF (impression navigateur, toutes slides)" },
  { cmd: "/share deck", desc: "Copier un lien partageable vers ce deck (client + période)" },
  { cmd: "/duplicate slide", desc: "Dupliquer la slide actuelle comme nouveau customSlide" },
  { cmd: "/move up", desc: "Déplacer la slide actuelle vers le haut (customSlides uniquement)" },
  { cmd: "/move down", desc: "Déplacer la slide actuelle vers le bas (customSlides uniquement)" },
  { cmd: "/rename slide", desc: "Renommer la slide actuelle (ex: /rename slide Mon titre)" },
  { cmd: "/delete slide", desc: "Supprimer la slide actuelle (customSlides uniquement)" },
  { cmd: "/reset deck", desc: "Effacer tous les overrides et slides personnalisées" },
];

const SLIDE_TEMPLATES: Record<string, { label: string; content: string }> = {
  learnings: {
    label: "Learnings",
    content: "# Learnings\n\n1. **Learning 1** — description de l'insight\n2. **Learning 2** — description de l'insight\n3. **Learning 3** — description de l'insight",
  },
  "next-steps": {
    label: "Next Steps",
    content: "# Next Steps\n\n1. ✅ **Action 1** — impact attendu (Owner)\n2. ✅ **Action 2** — impact attendu (Owner)\n3. ✅ **Action 3** — impact attendu (Owner)",
  },
  highlights: {
    label: "Highlights",
    content: "# Highlights du mois\n\n| Métrique | Valeur | vs M-1 |\n|----------|--------|--------|\n| ROAS | — | — |\n| Spend | — | — |\n| Conversions | — | — |",
  },
  table: {
    label: "Tableau de données",
    content: "# Tableau de données\n\n| Plateforme | Spend | ROAS | CTR | CPA |\n|-----------|-------|------|-----|-----|\n| Google | — | — | — | — |\n| Meta | — | — | — | — |\n| **Total** | — | — | — | — |",
  },
  kpi: {
    label: "KPIs clés",
    content: "# KPIs clés\n\n- **Spend :** —\n- **ROAS :** —\n- **CTR :** —\n- **CPA :** —\n- **Nouvelles acquisitions :** —",
  },
  blank: {
    label: "Slide personnalisée",
    content: "# Nouveau slide\n\nAjoutez votre contenu ici.",
  },
};

// ── Component ────────────────────────────────────────────────────────────────

export function AIPanel({
  deckData,
  currentSlideIndex,
  currentSlideLabel,
  onSlideUpdate,
  onRefreshDeckData,
  onExportPptx,
  onExportPdf,
  onShareDeck,
  onResetDeck,
  onAddCustomSlide,
  onDuplicateSlide,
  onMoveSlide,
  onRenameSlide,
  onDeleteSlide,
}: AIPanelProps) {
  const [messages, setMessages] = useState<AIPanelMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    setShowSlashMenu(input.startsWith("/") && !input.includes(" "));
  }, [input]);

  const buildSystemContext = (): string => {
    if (!deckData) return "Aucun deck n'est encore généré.";
    const total = deckData.globalTable.find((r) => r.platform === "Total");
    return [
      `Client: ${deckData.client.name} (${deckData.client.industry})`,
      `Période: ${deckData.period.label} vs ${deckData.previousPeriod.label}`,
      `Slide sélectionnée: #${currentSlideIndex + 1} — ${currentSlideLabel}`,
      `Total Spend: €${total?.current.spend.toLocaleString("fr-FR")}`,
      `Total Revenue: €${total?.current.revenue.toLocaleString("fr-FR")}`,
      `Blended ROAS: ${total?.current.roas.toFixed(2)}×`,
      `Google Campaigns: ${deckData.googleCampaigns.map((c) => c.name).join(", ")}`,
      `Meta Campaigns: ${deckData.metaCampaigns.map((c) => c.name).join(", ")}`,
    ].join("\n");
  };

  const handleSlashCommand = (cmd: string): string => {
    switch (cmd) {
      case "/fetch meta":
        return "Fetch Meta Ads data for the last 30 days: spend, impressions, clicks, CPM, CPC, CTR, ROAS, conversions per campaign. Use the MCP Meta Ads tools to retrieve this data and present it in a table format with key metrics.";
      case "/fetch google":
        return "Fetch Google Ads data for the last 30 days: spend, impressions, clicks, CPM, CPC, CTR, ROAS, conversions per campaign. Use the MCP Google Ads tools to retrieve this data and present it in a table format with key metrics.";
      case "/generate learnings":
        if (!deckData) return "Génère les learnings du mois. (Aucune donnée disponible — génère d'abord le deck)";
        return `À partir des données suivantes, génère 4-5 learnings clés pour le Monthly Business Review de ${deckData.client.name} (${deckData.period.label}):\n\n` +
          `- Google Spend: €${deckData.googleOverview.spend.toLocaleString("fr-FR")}, ROAS: ${deckData.googleOverview.roas.toFixed(2)}×\n` +
          `- Meta Spend: €${deckData.metaOverview.spend.toLocaleString("fr-FR")}, ROAS: ${deckData.metaOverview.roas.toFixed(2)}×\n` +
          `- Top créative: ${deckData.topCreatives[0]?.name} (ROAS ${deckData.topCreatives[0]?.roas}×)\n` +
          `- NC total: ${deckData.ncTable.find((r) => r.platform === "Total")?.current.newClients}\n\n` +
          `Rédige en français, style analytique, avec des chiffres précis. Format: liste numérotée.`;
      case "/add slide":
        return "Quel type de slide souhaites-tu ajouter ? (learnings, next-steps, table, highlights, etc.)";
      case "/analyze slide":
        if (!deckData)
          return "Analyse la slide actuelle et propose des améliorations. (Génère d'abord le deck pour une analyse précise)";
        return (
          `Analyse en détail la slide #${currentSlideIndex + 1} — "${currentSlideLabel}" du deck ` +
          `de ${deckData.client.name} (${deckData.period.label}).\n\n` +
          `Contexte disponible :\n${buildSystemContext()}\n\n` +
          `1. Identifie les points forts et faiblesses du contenu de cette slide.\n` +
          `2. Propose 2-3 améliorations concrètes (chiffres manquants, formulation, insight à ajouter).\n` +
          `3. Signale si un KPI est anormal et explique pourquoi (benchmark secteur).\n` +
          `Réponds en français, sois direct et actionnable.`
        );
      case "/suggest next-steps":
        if (!deckData)
          return "Génère les next steps recommandés. (Génère d'abord le deck pour des recommandations précises)";
        return (
          `En te basant sur les performances de ${deckData.client.name} (${deckData.period.label}), ` +
          `génère une liste de 5 next steps prioritaires pour le mois prochain.\n\n` +
          `Données clés :\n${buildSystemContext()}\n\n` +
          `Format attendu : liste numérotée, chaque item commence par un verbe d'action, ` +
          `inclut un impact attendu et un owner suggéré (ex: "Équipe Acquisition", "Creative Studio"). ` +
          `Priorise par impact potentiel sur le ROAS. Réponds en français.`
        );
      case "/summarize deck":
        if (!deckData)
          return "Génère un résumé exécutif du deck. (Génère d'abord le deck)";
        return (
          `Rédige un résumé exécutif en exactement 3 phrases du Monthly Business Review de ` +
          `${deckData.client.name} pour ${deckData.period.label}.\n\n` +
          `Données :\n${buildSystemContext()}\n\n` +
          `Structure : (1) Synthèse de la performance globale avec les 2 chiffres les plus importants. ` +
          `(2) Point d'attention principal (risque ou opportunité). ` +
          `(3) Action prioritaire recommandée pour le prochain mois. ` +
          `Ton : analytique, direct, adapté à une présentation C-level. Réponds en français.`
        );
      default:
        return cmd;
    }
  };

  const handleSubmit = async () => {
    let text = input.trim();
    if (!text || isLoading) return;

    // /export pptx — direct action, no AI stream
    if (text.startsWith("/export pptx")) {
      setInput("");
      setShowSlashMenu(false);
      const exportMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: "/export pptx",
      };
      if (!deckData) {
        setMessages((prev) => [
          ...prev,
          exportMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Aucun deck généré — génère d'abord le deck avant d'exporter." },
        ]);
        return;
      }
      if (onExportPptx) {
        setMessages((prev) => [
          ...prev,
          exportMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⬇️ Export PPTX en cours… Le téléchargement va démarrer." },
        ]);
        onExportPptx();
      } else {
        setMessages((prev) => [
          ...prev,
          exportMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Export non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /export pdf — direct action, no AI stream
    if (text.startsWith("/export pdf")) {
      setInput("");
      setShowSlashMenu(false);
      const exportMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: "/export pdf",
      };
      if (!deckData) {
        setMessages((prev) => [
          ...prev,
          exportMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Aucun deck généré — génère d'abord le deck avant d'exporter." },
        ]);
        return;
      }
      if (onExportPdf) {
        setMessages((prev) => [
          ...prev,
          exportMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "🖨️ Export PDF en cours… La boîte de dialogue d'impression va s'ouvrir (toutes les slides, format A4 paysage)." },
        ]);
        onExportPdf();
      } else {
        setMessages((prev) => [
          ...prev,
          exportMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Export PDF non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /share deck — direct action, no AI stream
    if (text.startsWith("/share deck")) {
      setInput("");
      setShowSlashMenu(false);
      const shareMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: "/share deck",
      };
      if (!deckData) {
        setMessages((prev) => [
          ...prev,
          shareMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Aucun deck généré — génère d'abord le deck avant de partager." },
        ]);
        return;
      }
      if (onShareDeck) {
        const url = onShareDeck();
        setMessages((prev) => [
          ...prev,
          shareMsg,
          { id: crypto.randomUUID(), role: "assistant", content: `🔗 Lien copié :\n\`${url}\`` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          shareMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Partage non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /add slide [type] — direct action, no AI stream
    if (text.startsWith("/add slide ")) {
      const slideType = text.replace("/add slide ", "").trim().toLowerCase();
      setInput("");
      setShowSlashMenu(false);
      const addMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      };
      const template = SLIDE_TEMPLATES[slideType];
      if (!template) {
        const available = Object.keys(SLIDE_TEMPLATES).join(", ");
        setMessages((prev) => [
          ...prev,
          addMsg,
          { id: crypto.randomUUID(), role: "assistant", content: `⚠️ Type de slide inconnu : \`${slideType}\`\n\nTypes disponibles : ${available}` },
        ]);
        return;
      }
      if (onAddCustomSlide) {
        onAddCustomSlide(template.label, template.content);
        setMessages((prev) => [
          ...prev,
          addMsg,
          { id: crypto.randomUUID(), role: "assistant", content: `✅ Slide **${template.label}** ajoutée au deck — accès direct via le filmstrip.` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          addMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Ajout de slide non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /duplicate slide — direct action, no AI stream
    if (text.startsWith("/duplicate slide")) {
      setInput("");
      setShowSlashMenu(false);
      const dupMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: "/duplicate slide",
      };
      if (onDuplicateSlide) {
        onDuplicateSlide();
        setMessages((prev) => [
          ...prev,
          dupMsg,
          { id: crypto.randomUUID(), role: "assistant", content: `📋 Slide **${currentSlideLabel}** dupliquée — accessible dans le filmstrip.` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          dupMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Duplication non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /move up | /move down — direct action, no AI stream
    if (text.startsWith("/move up") || text.startsWith("/move down")) {
      const direction = text.startsWith("/move up") ? "up" : "down";
      setInput("");
      setShowSlashMenu(false);
      const moveMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text.startsWith("/move up") ? "/move up" : "/move down",
      };
      if (onMoveSlide) {
        onMoveSlide(direction);
        setMessages((prev) => [
          ...prev,
          moveMsg,
          { id: crypto.randomUUID(), role: "assistant", content: `↕️ Slide déplacée vers le ${direction === "up" ? "haut" : "bas"}.` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          moveMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Déplacement non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /rename slide [new title] — direct action, no AI stream
    if (text.startsWith("/rename slide ")) {
      const newLabel = text.replace("/rename slide ", "").trim();
      setInput("");
      setShowSlashMenu(false);
      const renameMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      };
      if (!newLabel) {
        setMessages((prev) => [
          ...prev,
          renameMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Précise un nouveau titre : `/rename slide Mon Titre`" },
        ]);
        return;
      }
      if (onRenameSlide) {
        onRenameSlide(newLabel);
        setMessages((prev) => [
          ...prev,
          renameMsg,
          { id: crypto.randomUUID(), role: "assistant", content: `✏️ Slide renommée en **"${newLabel}"**.` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          renameMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Renommage non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /delete slide — direct action, no AI stream
    if (text.startsWith("/delete slide")) {
      setInput("");
      setShowSlashMenu(false);
      const deleteMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: "/delete slide",
      };
      if (onDeleteSlide) {
        onDeleteSlide();
        setMessages((prev) => [
          ...prev,
          deleteMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "🗑️ Slide supprimée." },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          deleteMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Suppression non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    // /reset deck — direct action, no AI stream
    if (text.startsWith("/reset deck")) {
      setInput("");
      setShowSlashMenu(false);
      const resetMsg: AIPanelMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: "/reset deck",
      };
      if (onResetDeck) {
        onResetDeck();
        setMessages((prev) => [
          ...prev,
          resetMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "♻️ Deck réinitialisé — tous les overrides et slides personnalisées ont été effacés." },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          resetMsg,
          { id: crypto.randomUUID(), role: "assistant", content: "⚠️ Reset non disponible dans ce contexte." },
        ]);
      }
      return;
    }

    const originalInput = text;
    const isFetchCommand = text.startsWith("/fetch meta") || text.startsWith("/fetch google");
    const matchedCmd = SLASH_COMMANDS.find((sc) => text.startsWith(sc.cmd));
    if (matchedCmd) {
      text = handleSlashCommand(matchedCmd.cmd);
    }

    const userMsg: AIPanelMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: originalInput,
    };

    const assistantMsg: AIPanelMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      toolCalls: [],
      toolResults: [],
      isStreaming: true,
      isFetchResponse: isFetchCommand,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setShowSlashMenu(false);
    setIsLoading(true);

    const abort = new AbortController();
    abortRef.current = abort;

    const systemCtx = buildSystemContext();
    const history: ChatMessage[] = [
      { role: "user" as const, content: `[Contexte du deck]\n${systemCtx}\n\n[Instruction]\n${text}` },
      ...messages
        .filter((m) => m.content)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    try {
      let finalContent = "";
      await streamChat(
        history,
        (event: StreamEvent) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };

            switch (event.type) {
              case "delta":
                last.content += event.text || "";
                finalContent = last.content;
                break;
              case "content":
                if (!last.content) last.content = event.text || "";
                finalContent = last.content;
                break;
              case "tool_call":
                last.toolCalls = [
                  ...(last.toolCalls || []),
                  { name: event.name || "unknown", id: event.id || "" },
                ];
                break;
              case "tool_result":
                last.toolResults = [
                  ...(last.toolResults || []),
                  { id: event.id || "", content: event.content || "", is_error: event.is_error || false },
                ];
                break;
              case "error":
                last.content += `\n\n**Erreur:** ${event.message}`;
                finalContent = last.content;
                break;
            }

            updated[updated.length - 1] = last;
            return updated;
          });
        },
        abort.signal
      );

    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          const last = { ...updated[updated.length - 1] };
          last.content += `\n\n**Erreur de connexion:** ${(err as Error).message}`;
          updated[updated.length - 1] = last;
          return updated;
        });
      }
    } finally {
      setMessages((prev) => {
        const updated = [...prev];
        const last = { ...updated[updated.length - 1] };
        last.isStreaming = false;
        updated[updated.length - 1] = last;
        return updated;
      });
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const formatToolName = (name: string) =>
    name
      .replace("mcp__meta-ads-impulse__", "Meta: ")
      .replace("mcp__mcp-google-ads__", "GAds: ")
      .replace("mcp__mcp-google-analytics__", "GA: ")
      .replace(/1$/, "");

  // ── Drag & drop helpers ──────────────────────────────────────────────────

  const hasDataContent = (content: string): boolean => {
    // Détecte si le message contient des tableaux, listes de métriques, ou données structurées
    return (
      content.includes("|") || // Tableau markdown
      /(\d+[%€×]|\d+\.\d+)/g.test(content) || // Métriques (nombres avec unités)
      /^[\s]*[-*]\s+\w+/m.test(content) // Listes à puces
    );
  };

  const handleDragStart = (e: React.DragEvent, content: string) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/json", JSON.stringify({
      type: "data-block",
      content: content,
    }));
  };

  return (
    <div className="flex flex-col h-full bg-[#0B1120] border-l border-gray-800">
      {/* Panel header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center">
          <Bot className="w-3.5 h-3.5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xs font-semibold text-white truncate">Assistant IA</h2>
          <p className="text-[10px] text-gray-500 truncate">
            {deckData ? `${deckData.client.name} · ${deckData.period.label}` : "En attente du deck…"}
          </p>
        </div>
        {deckData && (
          <div className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-violet-600/20 text-violet-400 font-medium">
            Slide {currentSlideIndex + 1}
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-700/20 flex items-center justify-center mb-3">
              <Sparkles className="w-6 h-6 text-violet-400" />
            </div>
            <h3 className="text-sm font-semibold text-white mb-1">Assistant IA</h3>
            <p className="text-xs text-gray-500 mb-4">
              Tape <code className="text-violet-400 font-mono text-[11px]">/fetch meta</code> pour charger les données Meta Ads
            </p>
            <div className="w-full space-y-1.5">
              {SLASH_COMMANDS.map((sc) => (
                <button
                  key={sc.cmd}
                  onClick={() => setInput(sc.cmd)}
                  className="w-full text-left text-[11px] text-gray-400 border border-gray-800 rounded-lg px-3 py-2 hover:border-violet-600 hover:text-gray-200 transition-colors"
                >
                  <span className="text-violet-400 font-mono">{sc.cmd}</span>
                  <span className="ml-2 text-gray-600">— {sc.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === "user" ? (
              <div className="flex justify-end">
                <div className="max-w-[90%] bg-violet-600 rounded-xl rounded-tr-sm px-3 py-2">
                  <p className="text-xs text-white whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 group">
                <div className="w-5 h-5 rounded-md bg-violet-600/20 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-3 h-3 text-violet-400" />
                </div>
                <div className="flex-1 min-w-0 relative">
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.toolCalls.map((tc, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                          <Wrench className="w-2.5 h-2.5" />
                          <span className="truncate">{formatToolName(tc.name)}</span>
                          {msg.toolResults?.find((r) => r.id === tc.id) ? (
                            <span className="text-green-500">done</span>
                          ) : msg.isStreaming ? (
                            <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {msg.isFetchResponse && !msg.isStreaming && onRefreshDeckData && (
                    <button
                      onClick={onRefreshDeckData}
                      className="mb-2 w-full flex items-center justify-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors text-white"
                      style={{ backgroundColor: "#0944A1" }}
                    >
                      <Sparkles className="w-3 h-3" />
                      Mettre à jour les slides avec ces données
                    </button>
                  )}

                  {msg.content && hasDataContent(msg.content) && !msg.isStreaming && (
                    <div
                      draggable
                      onDragStart={(e) => handleDragStart(e, msg.content)}
                      className="cursor-grab active:cursor-grabbing"
                    >
                      <div
                        className="absolute -left-6 top-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Glisser vers la slide"
                      >
                        <div className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-violet-400">
                          <span className="text-sm leading-none">⠿</span>
                        </div>
                      </div>
                      <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed [&_p]:mb-1.5 [&_li]:mb-0.5 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_table]:text-[10px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}

                  {msg.content && !hasDataContent(msg.content) && (
                    <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed [&_p]:mb-1.5 [&_li]:mb-0.5 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_table]:text-[10px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  )}

                  {msg.isStreaming && !msg.content && !msg.toolCalls?.length && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Chargement depuis MCP…</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Slash command popup */}
      {showSlashMenu && (
        <div className="mx-4 mb-2 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
          {SLASH_COMMANDS.filter((sc) => sc.cmd.startsWith(input)).map((sc) => (
            <button
              key={sc.cmd}
              onClick={() => {
                setInput(sc.cmd + " ");
                setShowSlashMenu(false);
                inputRef.current?.focus();
              }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-gray-800 transition-colors flex items-center gap-2"
            >
              <span className="text-violet-400 font-mono">{sc.cmd}</span>
              <span className="text-gray-500 truncate">{sc.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="flex-shrink-0 border-t border-gray-800 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message ou /commande…"
            rows={1}
            className="flex-1 resize-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-600 transition-colors"
            style={{ minHeight: "36px", maxHeight: "80px" }}
            onInput={(e) => {
              const t = e.target as HTMLTextAreaElement;
              t.style.height = "auto";
              t.style.height = Math.min(t.scrollHeight, 80) + "px";
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isLoading}
            className="flex-shrink-0 w-8 h-8 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-40 flex items-center justify-center transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5 text-white" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
